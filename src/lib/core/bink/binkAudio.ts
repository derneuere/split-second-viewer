// Pure-TypeScript Bink audio decoder (binkaudio_dct + binkaudio_rdft).
//
// Faithful port of the FFmpeg-derived xoreos audio path (Bink::BinkAudioTrack in
// src/video/bink.cpp + Bink::initAudioTrack). Decodes the embedded audio track to
// interleaved 16-bit PCM, entirely in the browser. The float DSP (FFT/RDFT/DCT)
// lives in dsp.ts.
//
// Bink audio is float-based: the spectral coefficients are inverse-transformed in
// floating point, then windowed/overlap-added and quantised to int16. The decode
// is bit-accurate at the *bitstream* level (same Huffman/quantiser), but the
// final PCM is NOT guaranteed bit-identical to FFmpeg, because FFmpeg uses a
// SIMD float FFT with a different operation order and rounding; expect a
// perceptually-inaudible ≤1-LSB difference on a fraction of samples.

import { binkCriticalFreqs } from './binkData';
import { BinkBitReader } from './bitReader';
import { DCT, DCTType, RDFT, RDFTType } from './dsp';

const AUD_STEREO = 0x2000;
const AUD_DCT = 0x1000;

const RLE_LENGTH_TAB = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 32, 64];

function floatToInt16(x: number): number {
	// Round half to even (matches ffmpeg's lrintf default rounding).
	let v = Math.round(x);
	if (Math.abs(x - Math.trunc(x)) === 0.5) {
		const f = Math.floor(x);
		v = f % 2 === 0 ? f : f + 1;
	}
	return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

type FrameInfo = { offset: number; size: number };

export type BinkAudioResult = {
	/** Interleaved signed-16-bit PCM. */
	pcm: Int16Array;
	sampleRate: number;
	channels: number;
};

export class BinkAudio {
	readonly hasAudio: boolean;
	readonly trackCount: number;
	readonly outSampleRate: number;
	readonly outChannels: number;

	private readonly raw: Uint8Array;
	private readonly dv: DataView;
	private readonly frames: FrameInfo[] = [];
	private readonly trackIndex: number;
	private readonly audioTrackCount: number;

	// Per-track decode state (for the selected track).
	private readonly codecDCT: boolean = false;
	private channels = 0;
	private frameLen = 0;
	private overlapLen = 0;
	private blockSize = 0;
	private root = 0;
	private bands: Int32Array = new Int32Array(0);
	private bandCount = 0;
	private coeffs: Float32Array = new Float32Array(0);
	private outF: Float32Array = new Float32Array(0); // reusable interleaved float output
	private prevCoeffs: Float32Array = new Float32Array(0); // overlap tail, kept in float
	private first = true;
	private dct: DCT | null = null;
	private rdft: RDFT | null = null;

	constructor(raw: Uint8Array, trackIndex = 0) {
		this.raw = raw;
		this.dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		this.trackIndex = trackIndex;

		let p = 4; // skip FourCC
		const u32 = () => {
			const v = this.dv.getUint32(p, true) >>> 0;
			p += 4;
			return v;
		};
		const u16 = () => {
			const v = this.dv.getUint16(p, true);
			p += 2;
			return v;
		};

		u32(); // file size
		const frameCount = u32();
		u32(); // largest frame
		p += 4; // frames again
		u32(); // width
		u32(); // height
		u32(); // fps num
		u32(); // fps den
		u32(); // video flags
		const audioTrackCount = u32();
		this.audioTrackCount = audioTrackCount;
		this.trackCount = audioTrackCount;

		let sampleRate = 0;
		let flags = 0;
		if (audioTrackCount > 0) {
			p += 4 * audioTrackCount; // max packet sizes
			const rates: number[] = [];
			const flagList: number[] = [];
			for (let i = 0; i < audioTrackCount; i++) {
				rates.push(u16());
				flagList.push(u16());
			}
			p += 4 * audioTrackCount; // track ids
			const idx = Math.min(trackIndex, audioTrackCount - 1);
			sampleRate = rates[idx];
			flags = flagList[idx];
		}

		// Frame offset table.
		for (let i = 0; i < frameCount; i++) {
			let off = u32();
			off &= ~1;
			this.frames.push({ offset: off, size: 0 });
			if (i !== 0) this.frames[i - 1].size = off - this.frames[i - 1].offset;
		}
		if (frameCount > 0) {
			this.frames[frameCount - 1].size = raw.byteLength - this.frames[frameCount - 1].offset;
		}

		this.hasAudio = audioTrackCount > 0;
		if (!this.hasAudio) {
			this.codecDCT = false;
			this.outSampleRate = 0;
			this.outChannels = 0;
			return;
		}

		this.codecDCT = (flags & AUD_DCT) !== 0;
		const init = this.initTrack(sampleRate, flags);
		this.outSampleRate = init.outSampleRate;
		this.outChannels = init.outChannels;
	}

	/** initAudioTrack — set up frame geometry, bands and the inverse transform. */
	private initTrack(sampleRateIn: number, flags: number): { outSampleRate: number; outChannels: number } {
		let channels = flags & AUD_STEREO ? 2 : 1;
		const codecDCT = (flags & AUD_DCT) !== 0;

		let frameLenBits: number;
		if (sampleRateIn < 22050) frameLenBits = 9;
		else if (sampleRateIn < 44100) frameLenBits = 10;
		else frameLenBits = 11;

		let frameLen = 1 << frameLenBits;

		const outSampleRate = sampleRateIn;
		const outChannels = channels;

		let sampleRate = sampleRateIn;
		if (!codecDCT) {
			// RDFT interleaves samples; fold stereo into one doubled-rate channel.
			if (channels === 2) frameLenBits++;
			sampleRate *= channels;
			frameLen *= channels;
			channels = 1;
		}

		this.channels = channels;
		this.frameLen = frameLen;
		this.overlapLen = frameLen / 16;
		this.blockSize = (frameLen - this.overlapLen) * channels;
		this.root = 2.0 / Math.sqrt(frameLen);

		const sampleRateHalf = Math.floor((sampleRate + 1) / 2);

		let bandCount = 1;
		for (; bandCount < 25; bandCount++) {
			if (sampleRateHalf <= binkCriticalFreqs[bandCount - 1]) break;
		}
		this.bandCount = bandCount;

		const bands = new Int32Array(bandCount + 1);
		bands[0] = 1;
		for (let i = 1; i < bandCount; i++) {
			bands[i] = Math.floor((binkCriticalFreqs[i - 1] * (frameLen / 2)) / sampleRateHalf);
		}
		bands[bandCount] = frameLen / 2;
		this.bands = bands;

		this.coeffs = new Float32Array(channels * frameLen);
		this.outF = new Float32Array(channels * frameLen);
		this.prevCoeffs = new Float32Array(this.overlapLen * channels);
		this.first = true;

		if (codecDCT) this.dct = new DCT(frameLenBits, DCTType.DCT_III);
		else this.rdft = new RDFT(frameLenBits, RDFTType.DFT_C2R);

		return { outSampleRate, outChannels };
	}

	/** Decode the whole selected audio track to interleaved int16 PCM. */
	decodeAll(): BinkAudioResult {
		if (!this.hasAudio) return { pcm: new Int16Array(0), sampleRate: 0, channels: 0 };

		const chunks: Int16Array[] = [];
		let total = 0;

		for (const frame of this.frames) {
			let pos = frame.offset;
			let frameSize = frame.size;
			let audioPacketLength = 0;
			let found = false;

			for (let i = 0; i < this.audioTrackCount; i++) {
				audioPacketLength = this.dv.getUint32(pos, true) >>> 0;
				pos += 4;
				frameSize -= 4;
				if (audioPacketLength > frameSize) throw new Error('Bink audio: packet too big for frame');
				frameSize -= audioPacketLength;
				if (i !== this.trackIndex) {
					pos += audioPacketLength;
					continue;
				}
				found = true;
				break;
			}

			if (!found || audioPacketLength < 4) continue;

			// First 4 bytes of the packet are a sample-count field; the rest is the bitstream.
			const packetStart = pos;
			const bits = new BinkBitReader(this.raw, packetStart + 4, packetStart + audioPacketLength);

			while (bits.pos() < bits.size()) {
				const block = this.audioBlock(bits);
				chunks.push(block);
				total += block.length;
				const rem = bits.pos() & 0x1f;
				if (rem) bits.skip(32 - rem);
			}
		}

		const pcm = new Int16Array(total);
		let o = 0;
		for (const c of chunks) {
			pcm.set(c, o);
			o += c.length;
		}
		return { pcm, sampleRate: this.outSampleRate, channels: this.outChannels };
	}

	/** Decode one audio block; returns blockSize interleaved int16 samples.
	 *
	 * Following FFmpeg: the overlap-add window is applied in FLOATING POINT and the
	 * clamp/round to int16 happens LAST (so a peak that exceeds full-scale clips
	 * flat, rather than being clamped before the crossfade). `count` is a power of
	 * two, so the float `/count` equals FFmpeg's historical `>> log2(count)`. */
	private audioBlock(bits: BinkBitReader): Int16Array {
		if (this.codecDCT) this.audioBlockDCT(bits);
		else this.audioBlockRDFT(bits);

		const frameLen = this.frameLen;
		const channels = this.channels;
		const coeffs = this.coeffs;
		const outF = this.outF;

		if (channels === 2) {
			for (let i = 0; i < frameLen; i++) {
				outF[2 * i] = coeffs[i];
				outF[2 * i + 1] = coeffs[frameLen + i];
			}
		} else {
			for (let i = 0; i < frameLen; i++) outF[i] = coeffs[i];
		}

		const count = this.overlapLen * channels;
		if (!this.first) {
			const prev = this.prevCoeffs;
			for (let i = 0; i < count; i++) {
				outF[i] = (prev[i] * (count - i) + outF[i] * i) / count;
			}
		}

		// Save this block's (un-overlapped) tail for the next block's crossfade.
		for (let i = 0; i < count; i++) this.prevCoeffs[i] = outF[this.blockSize + i];
		this.first = false;

		const out = new Int16Array(this.blockSize);
		for (let i = 0; i < this.blockSize; i++) out[i] = floatToInt16(outF[i]);
		return out;
	}

	private audioBlockDCT(bits: BinkBitReader): void {
		bits.skip(2);
		const frameLen = this.frameLen;
		for (let ch = 0; ch < this.channels; ch++) {
			const coeffs = this.coeffs.subarray(ch * frameLen, (ch + 1) * frameLen);
			this.readAudioCoeffs(bits, coeffs);
			coeffs[0] /= 0.5;
			this.dct!.calc(coeffs);
			const scale = frameLen / 2.0;
			for (let j = 0; j < frameLen; j++) coeffs[j] *= scale;
		}
	}

	private audioBlockRDFT(bits: BinkBitReader): void {
		const frameLen = this.frameLen;
		for (let ch = 0; ch < this.channels; ch++) {
			const coeffs = this.coeffs.subarray(ch * frameLen, (ch + 1) * frameLen);
			this.readAudioCoeffs(bits, coeffs);
			this.rdft!.calc(coeffs);
		}
	}

	private getFloat(bits: BinkBitReader): number {
		const power = bits.getBits(5);
		let f = bits.getBits(23) * Math.pow(2, power - 23);
		if (bits.getBit()) f = -f;
		return f;
	}

	private readAudioCoeffs(bits: BinkBitReader, coeffs: Float32Array): void {
		const frameLen = this.frameLen;
		const bands = this.bands;
		const root = this.root;

		coeffs[0] = this.getFloat(bits) * root;
		coeffs[1] = this.getFloat(bits) * root;

		const quant = new Float32Array(25);
		for (let i = 0; i < this.bandCount; i++) {
			const value = bits.getBits(8);
			quant[i] = Math.exp(Math.min(value, 95) * 0.15289164787221953823) * root;
		}

		let q = 0.0;
		let k = 0;
		for (k = 0; bands[k] < 1; k++) q = quant[k];

		let i = 2;
		while (i < frameLen) {
			let j: number;
			if (bits.getBit()) j = i + RLE_LENGTH_TAB[bits.getBits(4)] * 8;
			else j = i + 8;
			if (j > frameLen) j = frameLen;

			const width = bits.getBits(4);
			if (width === 0) {
				for (let x = i; x < j; x++) coeffs[x] = 0;
				i = j;
				while (bands[k] * 2 < i) q = quant[k++];
			} else {
				while (i < j) {
					if (bands[k] * 2 === i) q = quant[k++];
					const coeff = bits.getBits(width);
					if (coeff) {
						if (bits.getBit()) coeffs[i] = -q * coeff;
						else coeffs[i] = q * coeff;
					} else {
						coeffs[i] = 0.0;
					}
					i++;
				}
			}
		}
	}
}
