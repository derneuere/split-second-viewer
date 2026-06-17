// Pure-TypeScript Bink 1 (BIKf/g/h/i) VIDEO decoder.
//
// This is a faithful port of the FFmpeg-derived xoreos Bink decoder
// (src/video/bink.cpp, GPLv3 / LGPL upstream — see _bink_reference). It decodes
// the proprietary RAD Bink video bitstream entirely in the browser: no ffmpeg,
// no transcoding, no WASM. The container header/frame-table handling mirrors
// xoreos' Bink::load() + decodeNextTrackFrame(); the block decoder mirrors
// Bink::BinkVideoTrack.
//
// Scope: VIDEO only (the path Split/Second's BIKi 1280x720 movies use). Audio
// (binkaudio DCT/RDFT) is a separate decoder and is not handled here — frames
// are played silently. Bink 2 (KB2*) is rejected.
//
// Inter-frames reference the previous frame, so frames MUST be decoded in order
// (the player advances 0,1,2,…; seeking re-decodes from the start).

import {
	binkHuffmanCodes,
	binkHuffmanLengths,
	binkPatterns,
	binkScan,
	binkIntraQuant,
	binkInterQuant,
} from './binkData';
import { BinkBitReader } from './bitReader';
import { BinkHuffman } from './binkHuffman';

// --- FourCCs ----------------------------------------------------------------
const ID_BIKf = fourCC('B', 'I', 'K', 'f');
const ID_BIKg = fourCC('B', 'I', 'K', 'g');
const ID_BIKh = fourCC('B', 'I', 'K', 'h');
const ID_BIKi = fourCC('B', 'I', 'K', 'i');

const VIDEO_FLAG_ALPHA = 0x00100000;
const DC_START_BITS = 11;

function fourCC(a: string, b: string, c: string, d: string): number {
	return (
		(a.charCodeAt(0) << 24) | (b.charCodeAt(0) << 16) | (c.charCodeAt(0) << 8) | d.charCodeAt(0)
	) >>> 0;
}

/** floor(log2(x)) for x >= 1 (Common::intLog2). */
function intLog2(x: number): number {
	return 31 - Math.clz32(x);
}

// --- Data-source bundle ids (order matters; matches xoreos kSource*) ---------
const SRC_BLOCK_TYPES = 0;
const SRC_SUB_BLOCK_TYPES = 1;
const SRC_COLORS = 2;
const SRC_PATTERN = 3;
const SRC_X_OFF = 4;
const SRC_Y_OFF = 5;
const SRC_INTRA_DC = 6;
const SRC_INTER_DC = 7;
const SRC_RUN = 8;
const SRC_MAX = 9;

// --- Block types ------------------------------------------------------------
const BLK_SKIP = 0;
const BLK_SCALED = 1;
const BLK_MOTION = 2;
const BLK_RUN = 3;
const BLK_RESIDUE = 4;
const BLK_INTRA = 5;
const BLK_FILL = 6;
const BLK_INTER = 7;
const BLK_PATTERN = 8;
const BLK_RAW = 9;

const RLE_LENS = [4, 8, 12, 32];

type SmallHuffman = { index: number; symbols: Uint8Array };

type Bundle = {
	countLengths: [number, number];
	countLength: number;
	huffman: SmallHuffman;
	data: Uint8Array;
	dv: DataView;
	dataEnd: number; // byte length of data
	curDec: number; // write cursor (byte index); -1 == exhausted (NULL)
	curPtr: number; // read cursor (byte index)
};

type DecodeContext = {
	destArr: Uint8Array;
	prevArr: Uint8Array;
	destEnd: number;
	prevEnd: number;
	pitch: number;
	dest: number; // index into destArr
	prev: number; // index into prevArr
	blockX: number;
	blockY: number;
	coordMap: Int32Array;
	coordScaledMap1: Int32Array;
	coordScaledMap2: Int32Array;
	coordScaledMap3: Int32Array;
	coordScaledMap4: Int32Array;
};

/** One frame's location within the file. */
type FrameInfo = { offset: number; size: number; keyFrame: boolean };

// --- IDCT (Bink-specific, integer) ------------------------------------------
const A1 = 2896; // (1/sqrt(2)) << 12
const A2 = 2217;
const A3 = 3784;
const A4 = -5352;

/**
 * One 8-point Bink inverse transform. Reads src[sOff + k*sStride] for k=0..7 and
 * writes dest[dOff + k*dStride]. When `round` is set the MUNGE_ROW rounding
 * ((x + 0x7F) >> 8) is applied (the row pass); otherwise raw (the column pass,
 * where dest is an Int16Array so the result is truncated to int16 exactly as the
 * C int16_t temp buffer does).
 */
function idct1d(
	dest: Int16Array | Uint8Array,
	dOff: number,
	dStride: number,
	src: Int16Array,
	sOff: number,
	sStride: number,
	round: boolean,
): void {
	const s0 = src[sOff];
	const s1 = src[sOff + sStride];
	const s2 = src[sOff + 2 * sStride];
	const s3 = src[sOff + 3 * sStride];
	const s4 = src[sOff + 4 * sStride];
	const s5 = src[sOff + 5 * sStride];
	const s6 = src[sOff + 6 * sStride];
	const s7 = src[sOff + 7 * sStride];

	const a0 = s0 + s4;
	const a1 = s0 - s4;
	const a2 = s2 + s6;
	const a3 = (A1 * (s2 - s6)) >> 11;
	const a4 = s5 + s3;
	const a5 = s5 - s3;
	const a6 = s1 + s7;
	const a7 = s1 - s7;

	const b0 = a4 + a6;
	const b1 = (A3 * (a5 + a7)) >> 11;
	const b2 = ((A4 * a5) >> 11) - b0 + b1;
	const b3 = ((A1 * (a6 - a4)) >> 11) - b2;
	const b4 = ((A2 * a7) >> 11) + b3 - b1;

	if (round) {
		dest[dOff] = (a0 + a2 + b0 + 0x7f) >> 8;
		dest[dOff + dStride] = (a1 + a3 - a2 + b2 + 0x7f) >> 8;
		dest[dOff + 2 * dStride] = (a1 - a3 + a2 + b3 + 0x7f) >> 8;
		dest[dOff + 3 * dStride] = (a0 - a2 - b4 + 0x7f) >> 8;
		dest[dOff + 4 * dStride] = (a0 - a2 + b4 + 0x7f) >> 8;
		dest[dOff + 5 * dStride] = (a1 - a3 + a2 - b3 + 0x7f) >> 8;
		dest[dOff + 6 * dStride] = (a1 + a3 - a2 - b2 + 0x7f) >> 8;
		dest[dOff + 7 * dStride] = (a0 + a2 - b0 + 0x7f) >> 8;
	} else {
		dest[dOff] = a0 + a2 + b0;
		dest[dOff + dStride] = a1 + a3 - a2 + b2;
		dest[dOff + 2 * dStride] = a1 - a3 + a2 + b3;
		dest[dOff + 3 * dStride] = a0 - a2 - b4;
		dest[dOff + 4 * dStride] = a0 - a2 + b4;
		dest[dOff + 5 * dStride] = a1 - a3 + a2 - b3;
		dest[dOff + 6 * dStride] = a1 + a3 - a2 - b2;
		dest[dOff + 7 * dStride] = a0 + a2 - b0;
	}
}

function idctCol(temp: Int16Array, dOff: number, block: Int16Array, sOff: number): void {
	if (
		(block[sOff + 8] |
			block[sOff + 16] |
			block[sOff + 24] |
			block[sOff + 32] |
			block[sOff + 40] |
			block[sOff + 48] |
			block[sOff + 56]) === 0
	) {
		const v = block[sOff];
		temp[dOff] = v;
		temp[dOff + 8] = v;
		temp[dOff + 16] = v;
		temp[dOff + 24] = v;
		temp[dOff + 32] = v;
		temp[dOff + 40] = v;
		temp[dOff + 48] = v;
		temp[dOff + 56] = v;
	} else {
		idct1d(temp, dOff, 8, block, sOff, 8, false);
	}
}

/** WORKAROUND from FFmpeg/xoreos: signed >>11 dequant with optional clip. */
function dequant(inVal: number, quant: number, dc: boolean): number {
	let res = (Math.imul(inVal, quant) | 0) >> 11;
	if (!dc) res = res < -32768 ? -32768 : res > 32767 ? 32767 : res;
	return res;
}

export type BinkVideoMeta = {
	id: number;
	fourCC: string;
	width: number;
	height: number;
	frameCount: number;
	fpsNum: number;
	fpsDen: number;
	hasAlpha: boolean;
	audioTrackCount: number;
};

export class BinkVideo {
	readonly width: number;
	readonly height: number;
	readonly frameCount: number;
	readonly fpsNum: number;
	readonly fpsDen: number;
	readonly fourCC: string;

	/** RGBA of the most recently decoded frame (width*height*4). */
	readonly rgba: Uint8ClampedArray;

	private readonly raw: Uint8Array;
	private readonly rawDV: DataView;
	private readonly id: number;
	private readonly swapPlanes: boolean;
	private readonly hasAlpha: boolean;
	private readonly audioTrackCount: number;
	private readonly frames: FrameInfo[] = [];

	private readonly huffman: BinkHuffman[] = [];
	private readonly bundles: Bundle[] = [];
	private readonly colHighHuffman: SmallHuffman[] = [];
	private colLastVal = 0;

	private curPlanes: Uint8Array[] = [];
	private oldPlanes: Uint8Array[] = [];
	private decodedPlanes: Uint8Array[] = []; // last frame's planes, captured before the swap
	private readonly planeW: number[]; // logical width per plane
	private readonly planeH: number[]; // logical height per plane

	private readonly idctTemp = new Int16Array(64);
	private readonly blockBuf = new Int16Array(64);
	private bits!: BinkBitReader;

	// Reusable scratch buffers for the per-block coefficient decoders — hoisted
	// out of readDCTCoeffs/readResidue so the inner loop allocates nothing (those
	// run tens of thousands of times per 720p frame). Every position read in a
	// call is written earlier in the same call, so no per-call clear is needed.
	private readonly dctCoefList = new Int32Array(128);
	private readonly dctModeList = new Int32Array(128);
	private readonly dctCoefIdx = new Int32Array(64);
	private readonly resCoefList = new Int32Array(128);
	private readonly resModeList = new Int32Array(128);
	private readonly resNzCoeff = new Int32Array(64);
	private readonly huffHasSymbol = new Uint8Array(16);
	private huffTmp1 = new Uint8Array(16);
	private huffTmp2 = new Uint8Array(16);

	/** Index of the last frame decoded, or -1. */
	private lastDecoded = -1;

	/** Index of the most recently decoded frame (-1 before the first decode). */
	get currentFrame(): number {
		return this.lastDecoded;
	}

	/** Reset to the pre-first-frame state (clears reference planes) so the next
	 *  decodeFrame() starts a fresh sequential decode from frame 0. */
	reset(): void {
		this.initPlanes();
		this.decodedPlanes = [];
		this.lastDecoded = -1;
	}

	constructor(raw: Uint8Array) {
		this.raw = raw;
		this.rawDV = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

		const id = this.rawDV.getUint32(0, false); // FourCC is big-endian
		this.id = id;
		this.fourCC = String.fromCharCode(
			(id >>> 24) & 0xff,
			(id >>> 16) & 0xff,
			(id >>> 8) & 0xff,
			id & 0xff,
		);
		if (id === fourCC('K', 'B', '2', 'a') || (this.fourCC[0] === 'K' && this.fourCC[1] === 'B')) {
			throw new Error(`Bink 2 (${this.fourCC}) is not supported`);
		}
		if (id !== ID_BIKf && id !== ID_BIKg && id !== ID_BIKh && id !== ID_BIKi) {
			throw new Error(`Not a supported Bink file (FourCC '${this.fourCC}')`);
		}

		let p = 4;
		const u32 = () => {
			const v = this.rawDV.getUint32(p, true);
			p += 4;
			return v >>> 0;
		};
		const u16 = () => {
			const v = this.rawDV.getUint16(p, true);
			p += 2;
			return v;
		};

		/* fileSize  */ u32();
		const frameCount = u32();
		/* largest   */ u32();
		p += 4; // skip (num frames again)

		const width = u32();
		const height = u32();
		const fpsNum = u32();
		const fpsDen = u32();
		if (fpsNum === 0 || fpsDen === 0) throw new Error(`Invalid Bink FPS ${fpsNum}/${fpsDen}`);
		const videoFlags = u32();
		const audioTrackCount = u32();

		this.width = width;
		this.height = height;
		this.frameCount = frameCount;
		this.fpsNum = fpsNum;
		this.fpsDen = fpsDen;
		this.swapPlanes = id === ID_BIKh || id === ID_BIKi;
		this.hasAlpha = (videoFlags & VIDEO_FLAG_ALPHA) !== 0;
		this.audioTrackCount = audioTrackCount;

		if (audioTrackCount > 0) {
			p += 4 * audioTrackCount; // max packet sizes
			p += 4 * audioTrackCount; // sampleRate(16) | flags(16)
			p += 4 * audioTrackCount; // track ids
		}

		// Frame offset table
		for (let i = 0; i < frameCount; i++) {
			let off = u32();
			const keyFrame = (off & 1) !== 0;
			off &= ~1;
			this.frames.push({ offset: off, size: 0, keyFrame });
			if (i !== 0) this.frames[i - 1].size = off - this.frames[i - 1].offset;
		}
		if (frameCount > 0) {
			this.frames[frameCount - 1].size = raw.byteLength - this.frames[frameCount - 1].offset;
		}

		// Plane logical dimensions: Y/A full res, U/V quarter res.
		this.planeW = [width, width >> 1, width >> 1, width];
		this.planeH = [height, height >> 1, height >> 1, height];

		this.rgba = new Uint8ClampedArray(width * height * 4);

		this.initPlanes();
		this.initBundles();
		this.initHuffman();
	}

	meta(): BinkVideoMeta {
		return {
			id: this.id,
			fourCC: this.fourCC,
			width: this.width,
			height: this.height,
			frameCount: this.frameCount,
			fpsNum: this.fpsNum,
			fpsDen: this.fpsDen,
			hasAlpha: this.hasAlpha,
			audioTrackCount: this.audioTrackCount,
		};
	}

	// --- Setup ---------------------------------------------------------------

	private initPlanes(): void {
		const pw = this.width + 32;
		const ph = this.height + 32;
		const sizes = [pw * ph, (pw >> 1) * (ph >> 1), (pw >> 1) * (ph >> 1), pw * ph];
		const fill = [0, 0, 0, 255];
		this.curPlanes = sizes.map((s, i) => new Uint8Array(s).fill(fill[i]));
		this.oldPlanes = sizes.map((s, i) => new Uint8Array(s).fill(fill[i]));
	}

	private initBundles(): void {
		const bw = (this.width + 7) >> 3;
		const bh = (this.height + 7) >> 3;
		const blocks = bw * bh;

		for (let i = 0; i < SRC_MAX; i++) {
			const data = new Uint8Array(blocks * 64);
			this.bundles.push({
				countLengths: [0, 0],
				countLength: 0,
				huffman: { index: 0, symbols: identitySymbols() },
				data,
				dv: new DataView(data.buffer),
				dataEnd: data.length,
				curDec: 0,
				curPtr: 0,
			});
		}

		const cbw = [(this.width + 7) >> 3, (this.width + 15) >> 4];
		const cw = [this.width, this.width >> 1];

		for (let i = 0; i < 2; i++) {
			const width = Math.max(cw[i], 8);
			this.bundles[SRC_BLOCK_TYPES].countLengths[i] = intLog2((width >> 3) + 511) + 1;
			this.bundles[SRC_SUB_BLOCK_TYPES].countLengths[i] = intLog2(((width + 7) >> 4) + 511) + 1;
			this.bundles[SRC_COLORS].countLengths[i] = intLog2(cbw[i] * 64 + 511) + 1;
			this.bundles[SRC_INTRA_DC].countLengths[i] = intLog2((width >> 3) + 511) + 1;
			this.bundles[SRC_INTER_DC].countLengths[i] = intLog2((width >> 3) + 511) + 1;
			this.bundles[SRC_X_OFF].countLengths[i] = intLog2((width >> 3) + 511) + 1;
			this.bundles[SRC_Y_OFF].countLengths[i] = intLog2((width >> 3) + 511) + 1;
			this.bundles[SRC_PATTERN].countLengths[i] = intLog2((cbw[i] << 3) + 511) + 1;
			this.bundles[SRC_RUN].countLengths[i] = intLog2(cbw[i] * 48 + 511) + 1;
		}
	}

	private initHuffman(): void {
		for (let i = 0; i < 16; i++) {
			this.huffman.push(new BinkHuffman(binkHuffmanLengths[i], binkHuffmanCodes[i]));
			this.colHighHuffman.push({ index: 0, symbols: identitySymbols() });
		}
	}

	// --- Per-frame orchestration --------------------------------------------

	/**
	 * Decode frame `index`. Frames must be requested in order; a request that
	 * jumps backwards (or skips ahead) re-decodes sequentially from the start so
	 * inter-frame references stay valid. The result lands in `this.rgba`.
	 */
	decodeFrame(index: number): void {
		if (index < 0 || index >= this.frameCount) throw new Error(`frame ${index} out of range`);
		if (index === this.lastDecoded) return;
		if (index !== this.lastDecoded + 1) {
			// Non-sequential: rebuild from the start so prev-frame state is correct.
			this.initPlanes();
			this.lastDecoded = -1;
			for (let i = 0; i < index; i++) this.decodeOne(i);
		}
		this.decodeOne(index);
	}

	private decodeOne(index: number): void {
		const frame = this.frames[index];
		let pos = frame.offset;
		let frameSize = frame.size;

		// Skip the per-track audio packets to reach the video bitstream.
		for (let i = 0; i < this.audioTrackCount; i++) {
			const audioLen = this.rawDV.getUint32(pos, true) >>> 0;
			pos += 4;
			frameSize -= 4;
			if (audioLen > frameSize) throw new Error('Bink: audio packet too big for frame');
			pos += audioLen;
			frameSize -= audioLen;
		}

		const videoStart = pos;
		const videoEnd = frame.offset + frame.size;
		this.bits = new BinkBitReader(this.raw, videoStart, videoEnd);

		this.decodePacket();
		this.toRGBA();

		// Capture the just-decoded planes (for tests) before swapping references.
		this.decodedPlanes = this.curPlanes;

		// Swap reference planes for the next frame.
		const t = this.curPlanes;
		this.curPlanes = this.oldPlanes;
		this.oldPlanes = t;

		this.lastDecoded = index;
	}

	private decodePacket(): void {
		const bits = this.bits;

		if (this.hasAlpha) {
			if (this.id === ID_BIKi) bits.skip(32);
			this.decodePlane(3, false);
		}

		if (this.id === ID_BIKi) bits.skip(32);

		for (let i = 0; i < 3; i++) {
			const planeIdx = i === 0 || !this.swapPlanes ? i : i ^ 3;
			this.decodePlane(planeIdx, i !== 0);
			if (bits.pos() >= bits.size()) break;
		}
	}

	private decodePlane(planeIdx: number, isChroma: boolean): void {
		const bits = this.bits;
		const W = this.width;
		const H = this.height;

		const blockWidth = isChroma ? (W + 15) >> 4 : (W + 7) >> 3;
		const blockHeight = isChroma ? (H + 15) >> 4 : (H + 7) >> 3;
		const width = this.planeW[planeIdx];
		const height = this.planeH[planeIdx];

		const ctx: DecodeContext = {
			destArr: this.curPlanes[planeIdx],
			prevArr: this.oldPlanes[planeIdx],
			destEnd: width * height,
			prevEnd: width * height,
			pitch: width,
			dest: 0,
			prev: 0,
			blockX: 0,
			blockY: 0,
			coordMap: new Int32Array(64),
			coordScaledMap1: new Int32Array(64),
			coordScaledMap2: new Int32Array(64),
			coordScaledMap3: new Int32Array(64),
			coordScaledMap4: new Int32Array(64),
		};

		const pitch = ctx.pitch;
		for (let i = 0; i < 64; i++) {
			ctx.coordMap[i] = (i & 7) + (i >> 3) * pitch;
			ctx.coordScaledMap1[i] = (i & 7) * 2 + 0 + ((i >> 3) * 2 + 0) * pitch;
			ctx.coordScaledMap2[i] = (i & 7) * 2 + 1 + ((i >> 3) * 2 + 0) * pitch;
			ctx.coordScaledMap3[i] = (i & 7) * 2 + 0 + ((i >> 3) * 2 + 1) * pitch;
			ctx.coordScaledMap4[i] = (i & 7) * 2 + 1 + ((i >> 3) * 2 + 1) * pitch;
		}

		for (let i = 0; i < SRC_MAX; i++) {
			this.bundles[i].countLength = this.bundles[i].countLengths[isChroma ? 1 : 0];
			this.readBundle(i);
		}

		for (ctx.blockY = 0; ctx.blockY < blockHeight; ctx.blockY++) {
			this.readBlockTypes(this.bundles[SRC_BLOCK_TYPES]);
			this.readBlockTypes(this.bundles[SRC_SUB_BLOCK_TYPES]);
			this.readColors(this.bundles[SRC_COLORS]);
			this.readPatterns(this.bundles[SRC_PATTERN]);
			this.readMotionValues(this.bundles[SRC_X_OFF]);
			this.readMotionValues(this.bundles[SRC_Y_OFF]);
			this.readDCS(this.bundles[SRC_INTRA_DC], DC_START_BITS, false);
			this.readDCS(this.bundles[SRC_INTER_DC], DC_START_BITS, true);
			this.readRuns(this.bundles[SRC_RUN]);

			ctx.dest = 8 * ctx.blockY * pitch;
			ctx.prev = 8 * ctx.blockY * pitch;

			for (ctx.blockX = 0; ctx.blockX < blockWidth; ctx.blockX++, ctx.dest += 8, ctx.prev += 8) {
				const blockType = this.getBundleValue(SRC_BLOCK_TYPES);

				if ((ctx.blockY & 1) && blockType === BLK_SCALED) {
					ctx.blockX += 1;
					ctx.dest += 8;
					ctx.prev += 8;
					continue;
				}

				switch (blockType) {
					case BLK_SKIP: this.blockSkip(ctx); break;
					case BLK_SCALED: this.blockScaled(ctx); break;
					case BLK_MOTION: this.blockMotion(ctx); break;
					case BLK_RUN: this.blockRun(ctx); break;
					case BLK_RESIDUE: this.blockResidue(ctx); break;
					case BLK_INTRA: this.blockIntra(ctx); break;
					case BLK_FILL: this.blockFill(ctx); break;
					case BLK_INTER: this.blockInter(ctx); break;
					case BLK_PATTERN: this.blockPattern(ctx); break;
					case BLK_RAW: this.blockRaw(ctx); break;
					default: throw new Error(`Bink: unknown block type ${blockType}`);
				}
			}
		}

		// Next plane data starts at a 32-bit boundary.
		const rem = bits.pos() & 0x1f;
		if (rem) bits.skip(32 - rem);
	}

	// --- Bundle reading ------------------------------------------------------

	private readBundle(source: number): void {
		if (source === SRC_COLORS) {
			for (let i = 0; i < 16; i++) this.readHuffman(this.colHighHuffman[i]);
			this.colLastVal = 0;
		}
		if (source !== SRC_INTRA_DC && source !== SRC_INTER_DC) {
			this.readHuffman(this.bundles[source].huffman);
		}
		this.bundles[source].curDec = 0;
		this.bundles[source].curPtr = 0;
	}

	private readHuffman(huffman: SmallHuffman): void {
		const bits = this.bits;
		huffman.index = bits.getBits(4);

		if (huffman.index === 0) {
			for (let i = 0; i < 16; i++) huffman.symbols[i] = i;
			return;
		}

		if (bits.getBit()) {
			// Symbol selection
			const hasSymbol = this.huffHasSymbol;
			hasSymbol.fill(0);
			let length = bits.getBits(3);
			for (let i = 0; i <= length; i++) {
				huffman.symbols[i] = bits.getBits(4);
				hasSymbol[huffman.symbols[i]] = 1;
			}
			for (let i = 0; i < 16; i++) if (hasSymbol[i] === 0) huffman.symbols[++length] = i;
			return;
		}

		// Symbol shuffling
		let inArr = this.huffTmp1;
		let outArr = this.huffTmp2;
		const depth = bits.getBits(2);
		for (let i = 0; i < 16; i++) inArr[i] = i;

		for (let i = 0; i <= depth; i++) {
			const size = 1 << i;
			for (let j = 0; j < 16; j += size << 1) this.mergeHuffmanSymbols(outArr, j, inArr, j, size);
			const tmp = inArr;
			inArr = outArr;
			outArr = tmp;
		}
		huffman.symbols.set(inArr);
	}

	private mergeHuffmanSymbols(
		dst: Uint8Array,
		dstOff: number,
		src: Uint8Array,
		srcOff: number,
		size: number,
	): void {
		const bits = this.bits;
		let s1 = srcOff;
		let s2 = srcOff + size;
		let size1 = size;
		let size2 = size;
		let d = dstOff;

		do {
			if (!bits.getBit()) {
				dst[d++] = src[s1++];
				size1--;
			} else {
				dst[d++] = src[s2++];
				size2--;
			}
		} while (size1 && size2);

		while (size1-- > 0) dst[d++] = src[s1++];
		while (size2-- > 0) dst[d++] = src[s2++];
	}

	private getHuffmanSymbol(huffman: SmallHuffman): number {
		return huffman.symbols[this.huffman[huffman.index].getSymbol(this.bits)];
	}

	private getBundleValue(source: number): number {
		const b = this.bundles[source];
		if (source < SRC_X_OFF || source === SRC_RUN) {
			return b.data[b.curPtr++];
		}
		if (source === SRC_X_OFF || source === SRC_Y_OFF) {
			const v = b.data[b.curPtr++];
			return (v << 24) >> 24; // int8
		}
		const ret = b.dv.getInt16(b.curPtr, true);
		b.curPtr += 2;
		return ret;
	}

	private readBundleCount(b: Bundle): number {
		if (b.curDec === -1 || b.curDec > b.curPtr) return 0;
		const n = this.bits.getBits(b.countLength);
		if (n === 0) b.curDec = -1;
		return n;
	}

	private readRuns(b: Bundle): void {
		const n = this.readBundleCount(b);
		if (n === 0) return;
		const decEnd = b.curDec + n;
		if (decEnd > b.dataEnd) throw new Error('Bink: run value out of bounds');
		const bits = this.bits;
		if (bits.getBit()) {
			const v = bits.getBits(4);
			b.data.fill(v, b.curDec, decEnd);
			b.curDec = decEnd;
		} else {
			while (b.curDec < decEnd) b.data[b.curDec++] = this.getHuffmanSymbol(b.huffman);
		}
	}

	private readMotionValues(b: Bundle): void {
		const n = this.readBundleCount(b);
		if (n === 0) return;
		const decEnd = b.curDec + n;
		if (decEnd > b.dataEnd) throw new Error('Bink: too many motion values');
		const bits = this.bits;
		if (bits.getBit()) {
			let v = bits.getBits(4);
			if (v) {
				const sign = -bits.getBit();
				v = (v ^ sign) - sign;
			}
			b.data.fill(v & 0xff, b.curDec, decEnd);
			b.curDec = decEnd;
			return;
		}
		do {
			let v = this.getHuffmanSymbol(b.huffman);
			if (v) {
				const sign = -bits.getBit();
				v = (v ^ sign) - sign;
			}
			b.data[b.curDec++] = v & 0xff;
		} while (b.curDec < decEnd);
	}

	private readBlockTypes(b: Bundle): void {
		const n = this.readBundleCount(b);
		if (n === 0) return;
		const decEnd = b.curDec + n;
		if (decEnd > b.dataEnd) throw new Error('Bink: too many block type values');
		const bits = this.bits;
		if (bits.getBit()) {
			const v = bits.getBits(4);
			b.data.fill(v, b.curDec, decEnd);
			b.curDec = decEnd;
			return;
		}
		let last = 0;
		do {
			const v = this.getHuffmanSymbol(b.huffman);
			if (v < 12) {
				last = v;
				b.data[b.curDec++] = v;
			} else {
				const run = RLE_LENS[v - 12];
				b.data.fill(last, b.curDec, b.curDec + run);
				b.curDec += run;
			}
		} while (b.curDec < decEnd);
	}

	private readPatterns(b: Bundle): void {
		const n = this.readBundleCount(b);
		if (n === 0) return;
		const decEnd = b.curDec + n;
		if (decEnd > b.dataEnd) throw new Error('Bink: too many pattern values');
		while (b.curDec < decEnd) {
			let v = this.getHuffmanSymbol(b.huffman);
			v |= this.getHuffmanSymbol(b.huffman) << 4;
			b.data[b.curDec++] = v;
		}
	}

	private readColors(b: Bundle): void {
		const n = this.readBundleCount(b);
		if (n === 0) return;
		const decEnd = b.curDec + n;
		if (decEnd > b.dataEnd) throw new Error('Bink: too many color values');
		const bits = this.bits;

		if (bits.getBit()) {
			this.colLastVal = this.getHuffmanSymbol(this.colHighHuffman[this.colLastVal]);
			let v = this.getHuffmanSymbol(b.huffman);
			v = (this.colLastVal << 4) | v;
			if (this.id !== ID_BIKi) {
				const sign = (v << 24) >> 31;
				v = ((v & 0x7f) ^ sign) - sign;
				v += 0x80;
			}
			b.data.fill(v & 0xff, b.curDec, decEnd);
			b.curDec = decEnd;
			return;
		}

		while (b.curDec < decEnd) {
			this.colLastVal = this.getHuffmanSymbol(this.colHighHuffman[this.colLastVal]);
			let v = this.getHuffmanSymbol(b.huffman);
			v = (this.colLastVal << 4) | v;
			if (this.id !== ID_BIKi) {
				const sign = (v << 24) >> 31;
				v = ((v & 0x7f) ^ sign) - sign;
				v += 0x80;
			}
			b.data[b.curDec++] = v & 0xff;
		}
	}

	private readDCS(b: Bundle, startBits: number, hasSign: boolean): void {
		let length = this.readBundleCount(b);
		if (length === 0) return;
		const bits = this.bits;
		let dest = b.curDec; // byte index into b.data

		let v = bits.getBits(startBits - (hasSign ? 1 : 0));
		if (v && hasSign) {
			const sign = -bits.getBit();
			v = (v ^ sign) - sign;
		}
		b.dv.setInt16(dest, v, true);
		dest += 2;
		length--;

		for (let i = 0; i < length; i += 8) {
			const length2 = Math.min(length - i, 8);
			const bSize = bits.getBits(4);
			if (bSize) {
				for (let j = 0; j < length2; j++) {
					let v2 = bits.getBits(bSize);
					if (v2) {
						const sign = -bits.getBit();
						v2 = (v2 ^ sign) - sign;
					}
					v += v2;
					b.dv.setInt16(dest, v, true);
					dest += 2;
					if (v < -32768 || v > 32767) throw new Error('Bink: DC value out of bounds');
				}
			} else {
				for (let j = 0; j < length2; j++) {
					b.dv.setInt16(dest, v, true);
					dest += 2;
				}
			}
		}

		b.curDec = dest;
	}

	private readDCTCoeffs(block: Int16Array, isIntra: boolean): void {
		const bits = this.bits;
		const coefIdx = this.dctCoefIdx;
		let coefCount = 0;

		let listStart = 64;
		let listEnd = 64;
		const coefList = this.dctCoefList;
		const modeList = this.dctModeList;
		coefList[listEnd] = 4; modeList[listEnd++] = 0;
		coefList[listEnd] = 24; modeList[listEnd++] = 0;
		coefList[listEnd] = 44; modeList[listEnd++] = 0;
		coefList[listEnd] = 1; modeList[listEnd++] = 3;
		coefList[listEnd] = 2; modeList[listEnd++] = 3;
		coefList[listEnd] = 3; modeList[listEnd++] = 3;

		let bitsLeft = bits.getBits(4) - 1;
		for (let mask = 1 << Math.max(bitsLeft, 0); bitsLeft >= 0; mask >>= 1, bitsLeft--) {
			let listPos = listStart;
			while (listPos < listEnd) {
				if (!(modeList[listPos] | coefList[listPos]) || !bits.getBit()) {
					listPos++;
					continue;
				}
				let ccoef = coefList[listPos];
				const mode = modeList[listPos];

				switch (mode) {
					case 0:
						coefList[listPos] = ccoef + 4;
						modeList[listPos] = 1;
					// falls through
					case 2:
						if (mode === 2) {
							coefList[listPos] = 0;
							modeList[listPos++] = 0;
						}
						for (let i = 0; i < 4; i++, ccoef++) {
							if (bits.getBit()) {
								coefList[--listStart] = ccoef;
								modeList[listStart] = 3;
							} else {
								let t: number;
								if (!bitsLeft) {
									t = 1 - (bits.getBit() << 1);
								} else {
									t = bits.getBits(bitsLeft) | mask;
									const sign = -bits.getBit();
									t = (t ^ sign) - sign;
								}
								block[binkScan[ccoef]] = t;
								coefIdx[coefCount++] = ccoef;
							}
						}
						break;
					case 1:
						modeList[listPos] = 2;
						for (let i = 0; i < 3; i++) {
							ccoef += 4;
							coefList[listEnd] = ccoef;
							modeList[listEnd++] = 2;
						}
						break;
					case 3: {
						let t: number;
						if (!bitsLeft) {
							t = 1 - (bits.getBit() << 1);
						} else {
							t = bits.getBits(bitsLeft) | mask;
							const sign = -bits.getBit();
							t = (t ^ sign) - sign;
						}
						block[binkScan[ccoef]] = t;
						coefIdx[coefCount++] = ccoef;
						coefList[listPos] = 0;
						modeList[listPos++] = 0;
						break;
					}
				}
			}
		}

		const quantIdx = bits.getBits(4);
		const quant = isIntra ? binkIntraQuant[quantIdx] : binkInterQuant[quantIdx];
		block[0] = dequant(block[0], quant[0], true);
		for (let i = 0; i < coefCount; i++) {
			const idx = coefIdx[i];
			block[binkScan[idx]] = dequant(block[binkScan[idx]], quant[idx], false);
		}
	}

	private readResidue(block: Int16Array, masksCountIn: number): void {
		const bits = this.bits;
		let masksCount = masksCountIn;
		const nzCoeff = this.resNzCoeff;
		let nzCoeffCount = 0;

		let listStart = 64;
		let listEnd = 64;
		const coefList = this.resCoefList;
		const modeList = this.resModeList;
		coefList[listEnd] = 4; modeList[listEnd++] = 0;
		coefList[listEnd] = 24; modeList[listEnd++] = 0;
		coefList[listEnd] = 44; modeList[listEnd++] = 0;
		coefList[listEnd] = 0; modeList[listEnd++] = 2;

		for (let mask = 1 << bits.getBits(3); mask; mask >>= 1) {
			for (let i = 0; i < nzCoeffCount; i++) {
				if (!bits.getBit()) continue;
				if (block[nzCoeff[i]] < 0) block[nzCoeff[i]] -= mask;
				else block[nzCoeff[i]] += mask;
				masksCount--;
				if (masksCount < 0) return;
			}

			let listPos = listStart;
			while (listPos < listEnd) {
				if (!(coefList[listPos] | modeList[listPos]) || !bits.getBit()) {
					listPos++;
					continue;
				}
				let ccoef = coefList[listPos];
				const mode = modeList[listPos];

				switch (mode) {
					case 0:
						coefList[listPos] = ccoef + 4;
						modeList[listPos] = 1;
					// falls through
					case 2:
						if (mode === 2) {
							coefList[listPos] = 0;
							modeList[listPos++] = 0;
						}
						for (let i = 0; i < 4; i++, ccoef++) {
							if (bits.getBit()) {
								coefList[--listStart] = ccoef;
								modeList[listStart] = 3;
							} else {
								nzCoeff[nzCoeffCount++] = binkScan[ccoef];
								const sign = -bits.getBit();
								block[binkScan[ccoef]] = (mask ^ sign) - sign;
								masksCount--;
								if (masksCount < 0) return;
							}
						}
						break;
					case 1:
						modeList[listPos] = 2;
						for (let i = 0; i < 3; i++) {
							ccoef += 4;
							coefList[listEnd] = ccoef;
							modeList[listEnd++] = 2;
						}
						break;
					case 3: {
						nzCoeff[nzCoeffCount++] = binkScan[ccoef];
						const sign = -bits.getBit();
						block[binkScan[ccoef]] = (mask ^ sign) - sign;
						coefList[listPos] = 0;
						modeList[listPos++] = 0;
						masksCount--;
						if (masksCount < 0) return;
						break;
					}
				}
			}
		}
	}

	// --- Block decoders ------------------------------------------------------

	private blockSkip(ctx: DecodeContext): void {
		const { destArr, prevArr, pitch } = ctx;
		let dest = ctx.dest;
		let prev = ctx.prev;
		for (let j = 0; j < 8; j++, dest += pitch, prev += pitch) {
			for (let k = 0; k < 8; k++) destArr[dest + k] = prevArr[prev + k];
		}
	}

	private blockMotion(ctx: DecodeContext): void {
		const xOff = this.getBundleValue(SRC_X_OFF);
		const yOff = this.getBundleValue(SRC_Y_OFF);
		const { destArr, prevArr, pitch } = ctx;
		let dest = ctx.dest;
		let prev = ctx.prev + yOff * pitch + xOff;
		if (prev < 0 || prev > ctx.prevEnd) {
			throw new Error('Bink: motion copy out of bounds');
		}
		for (let j = 0; j < 8; j++, dest += pitch, prev += pitch) {
			for (let k = 0; k < 8; k++) destArr[dest + k] = prevArr[prev + k];
		}
	}

	private blockRun(ctx: DecodeContext): void {
		const bits = this.bits;
		const scan = binkPatterns[bits.getBits(4)];
		const { destArr, coordMap } = ctx;
		let scanPos = 0;
		let i = 0;
		do {
			const run = this.getBundleValue(SRC_RUN) + 1;
			i += run;
			if (i > 64) throw new Error('Bink: run out of bounds');
			if (bits.getBit()) {
				const v = this.getBundleValue(SRC_COLORS);
				for (let j = 0; j < run; j++) destArr[ctx.dest + coordMap[scan[scanPos++]]] = v;
			} else {
				for (let j = 0; j < run; j++) {
					destArr[ctx.dest + coordMap[scan[scanPos++]]] = this.getBundleValue(SRC_COLORS);
				}
			}
		} while (i < 63);
		if (i === 63) destArr[ctx.dest + coordMap[scan[scanPos]]] = this.getBundleValue(SRC_COLORS);
	}

	private blockResidue(ctx: DecodeContext): void {
		this.blockMotion(ctx);
		const v = this.bits.getBits(7);
		const block = this.blockBuf;
		block.fill(0);
		this.readResidue(block, v);
		const { destArr, pitch } = ctx;
		let dst = ctx.dest;
		let src = 0;
		for (let i = 0; i < 8; i++, dst += pitch, src += 8) {
			for (let j = 0; j < 8; j++) destArr[dst + j] += block[src + j];
		}
	}

	private blockIntra(ctx: DecodeContext): void {
		const block = this.blockBuf;
		block.fill(0);
		block[0] = this.getBundleValue(SRC_INTRA_DC);
		this.readDCTCoeffs(block, true);
		this.idctPut(ctx, block);
	}

	private blockFill(ctx: DecodeContext): void {
		const v = this.getBundleValue(SRC_COLORS);
		const { destArr, pitch } = ctx;
		let dest = ctx.dest;
		for (let i = 0; i < 8; i++, dest += pitch) {
			for (let k = 0; k < 8; k++) destArr[dest + k] = v;
		}
	}

	private blockInter(ctx: DecodeContext): void {
		this.blockMotion(ctx);
		const block = this.blockBuf;
		block.fill(0);
		block[0] = this.getBundleValue(SRC_INTER_DC);
		this.readDCTCoeffs(block, false);
		this.idctAdd(ctx, block);
	}

	private blockPattern(ctx: DecodeContext): void {
		const col0 = this.getBundleValue(SRC_COLORS);
		const col1 = this.getBundleValue(SRC_COLORS);
		const { destArr, pitch } = ctx;
		let dest = ctx.dest;
		for (let i = 0; i < 8; i++, dest += pitch - 8) {
			let v = this.getBundleValue(SRC_PATTERN);
			for (let j = 0; j < 8; j++, v >>= 1) destArr[dest++] = v & 1 ? col1 : col0;
		}
	}

	private blockRaw(ctx: DecodeContext): void {
		const { destArr, pitch } = ctx;
		const b = this.bundles[SRC_COLORS];
		let dest = ctx.dest;
		let data = b.curPtr;
		for (let i = 0; i < 8; i++, dest += pitch, data += 8) {
			for (let k = 0; k < 8; k++) destArr[dest + k] = b.data[data + k];
		}
		b.curPtr += 64;
	}

	private blockScaled(ctx: DecodeContext): void {
		const blockType = this.getBundleValue(SRC_SUB_BLOCK_TYPES);
		switch (blockType) {
			case BLK_RUN: this.blockScaledRun(ctx); break;
			case BLK_INTRA: this.blockScaledIntra(ctx); break;
			case BLK_FILL: this.blockScaledFill(ctx); break;
			case BLK_PATTERN: this.blockScaledPattern(ctx); break;
			case BLK_RAW: this.blockScaledRaw(ctx); break;
			default: throw new Error(`Bink: invalid 16x16 block type ${blockType}`);
		}
		ctx.blockX += 1;
		ctx.dest += 8;
		ctx.prev += 8;
	}

	private blockScaledRun(ctx: DecodeContext): void {
		const bits = this.bits;
		const scan = binkPatterns[bits.getBits(4)];
		const { destArr } = ctx;
		const m1 = ctx.coordScaledMap1;
		const m2 = ctx.coordScaledMap2;
		const m3 = ctx.coordScaledMap3;
		const m4 = ctx.coordScaledMap4;
		const put = (s: number, v: number) => {
			destArr[ctx.dest + m1[s]] = v;
			destArr[ctx.dest + m2[s]] = v;
			destArr[ctx.dest + m3[s]] = v;
			destArr[ctx.dest + m4[s]] = v;
		};
		let scanPos = 0;
		let i = 0;
		do {
			const run = this.getBundleValue(SRC_RUN) + 1;
			i += run;
			if (i > 64) throw new Error('Bink: scaled run out of bounds');
			if (bits.getBit()) {
				const v = this.getBundleValue(SRC_COLORS);
				for (let j = 0; j < run; j++) put(scan[scanPos++], v);
			} else {
				for (let j = 0; j < run; j++) put(scan[scanPos++], this.getBundleValue(SRC_COLORS));
			}
		} while (i < 63);
		if (i === 63) put(scan[scanPos], this.getBundleValue(SRC_COLORS));
	}

	private blockScaledIntra(ctx: DecodeContext): void {
		const block = this.blockBuf;
		block.fill(0);
		block[0] = this.getBundleValue(SRC_INTRA_DC);
		this.readDCTCoeffs(block, true);
		this.idct(block);

		const { destArr, pitch } = ctx;
		let dest1 = ctx.dest;
		let dest2 = ctx.dest + pitch;
		let src = 0;
		for (let j = 0; j < 8; j++, dest1 += (pitch << 1) - 16, dest2 += (pitch << 1) - 16, src += 8) {
			for (let i = 0; i < 8; i++, dest1 += 2, dest2 += 2) {
				const v = block[src + i];
				destArr[dest1] = v;
				destArr[dest1 + 1] = v;
				destArr[dest2] = v;
				destArr[dest2 + 1] = v;
			}
		}
	}

	private blockScaledFill(ctx: DecodeContext): void {
		const v = this.getBundleValue(SRC_COLORS);
		const { destArr, pitch } = ctx;
		let dest = ctx.dest;
		for (let i = 0; i < 16; i++, dest += pitch) {
			for (let k = 0; k < 16; k++) destArr[dest + k] = v;
		}
	}

	private blockScaledPattern(ctx: DecodeContext): void {
		const col0 = this.getBundleValue(SRC_COLORS);
		const col1 = this.getBundleValue(SRC_COLORS);
		const { destArr, pitch } = ctx;
		let dest1 = ctx.dest;
		let dest2 = ctx.dest + pitch;
		for (let j = 0; j < 8; j++, dest1 += (pitch << 1) - 16, dest2 += (pitch << 1) - 16) {
			let v = this.getBundleValue(SRC_PATTERN);
			for (let i = 0; i < 8; i++, dest1 += 2, dest2 += 2, v >>= 1) {
				const c = v & 1 ? col1 : col0;
				destArr[dest1] = c;
				destArr[dest1 + 1] = c;
				destArr[dest2] = c;
				destArr[dest2 + 1] = c;
			}
		}
	}

	private blockScaledRaw(ctx: DecodeContext): void {
		const b = this.bundles[SRC_COLORS];
		const { destArr, pitch } = ctx;
		let dest1 = ctx.dest;
		let dest2 = ctx.dest + pitch;
		for (let j = 0; j < 8; j++, dest1 += (pitch << 1) - 16, dest2 += (pitch << 1) - 16) {
			const row = b.curPtr;
			for (let i = 0; i < 8; i++, dest1 += 2, dest2 += 2) {
				const v = b.data[row + i];
				destArr[dest1] = v;
				destArr[dest1 + 1] = v;
				destArr[dest2] = v;
				destArr[dest2 + 1] = v;
			}
			b.curPtr += 8;
		}
	}

	// --- IDCT wrappers -------------------------------------------------------

	private idct(block: Int16Array): void {
		const temp = this.idctTemp;
		for (let i = 0; i < 8; i++) idctCol(temp, i, block, i);
		for (let i = 0; i < 8; i++) idct1d(block, 8 * i, 1, temp, 8 * i, 1, true);
	}

	private idctPut(ctx: DecodeContext, block: Int16Array): void {
		const temp = this.idctTemp;
		for (let i = 0; i < 8; i++) idctCol(temp, i, block, i);
		for (let i = 0; i < 8; i++) idct1d(ctx.destArr, ctx.dest + i * ctx.pitch, 1, temp, 8 * i, 1, true);
	}

	private idctAdd(ctx: DecodeContext, block: Int16Array): void {
		this.idct(block);
		const { destArr, pitch } = ctx;
		let dest = ctx.dest;
		for (let i = 0; i < 8; i++, dest += pitch) {
			for (let j = 0; j < 8; j++) destArr[dest + j] += block[8 * i + j];
		}
	}

	// --- Output --------------------------------------------------------------

	/** Convert the current YUV(A) planes to RGBA (BT.601 limited range). */
	private toRGBA(): void {
		const W = this.width;
		const H = this.height;
		const y = this.curPlanes[0];
		const u = this.curPlanes[1];
		const v = this.curPlanes[2];
		const cw = W >> 1;
		const out = this.rgba;
		let o = 0;
		for (let j = 0; j < H; j++) {
			const yr = j * W;
			const cr = (j >> 1) * cw;
			for (let i = 0; i < W; i++) {
				const Y = y[yr + i] - 16;
				const U = u[cr + (i >> 1)] - 128;
				const V = v[cr + (i >> 1)] - 128;
				const c298 = 298 * Y;
				out[o] = (c298 + 409 * V + 128) >> 8;
				out[o + 1] = (c298 - 100 * U - 208 * V + 128) >> 8;
				out[o + 2] = (c298 + 516 * U + 128) >> 8;
				out[o + 3] = 255;
				o += 4;
			}
		}
	}

	/** The last decoded YUV planes (for testing against a reference decoder). */
	planes(): { y: Uint8Array; u: Uint8Array; v: Uint8Array; cw: number; ch: number } {
		const p = this.decodedPlanes.length ? this.decodedPlanes : this.curPlanes;
		return {
			y: p[0],
			u: p[1],
			v: p[2],
			cw: this.width >> 1,
			ch: this.height >> 1,
		};
	}
}

function identitySymbols(): Uint8Array {
	const s = new Uint8Array(16);
	for (let i = 0; i < 16; i++) s[i] = i;
	return s;
}
