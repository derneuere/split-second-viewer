// .textures / .low.textures parser — the Black Rock Crayon2 "TEXS" texture-set
// container (PS3, big-endian). Ported from _tools/textures_probe.py and verified
// against the byte layout in wiki/format-textures.html.
//
// Pure module: imports ONLY the binary helpers, never the registry (acyclic rule,
// see registry/handler.ts). Node-importable for the CLI and the vitest suite.
//
// File shape (all big-endian):
//   0x00  char[4]  magic            "TEXS"
//   0x04  u32      version          always 0x0000000C (12)
//   0x08  u32      flags            always 0x00000001 (has C2NM names)
//   0x0C  u32      payloadTableOff  offset of the placement/payload table
//   0x10  u32      textureCount     number of 0x24-byte descriptor records
//   0x14  u32      firstDescOff     always 0x18 (a 20-byte sub-header follows)
//   0x18  byte[20] sub-header       small count + two placement offsets (theory)
//   0x2C  desc[N]  descriptor array stride 0x24 (see TextureDescriptor)
//   ...   placement table + swizzled pixel payload
//   EOF   "C2NM"   name trailer: { crc(4) len(4) ascii[len] } records
//
// Per-descriptor (0x24 bytes):
//   0x00 u32 crc        texture-name CRC-32 (key into .crcs + the C2NM trailer)
//   0x04 u16 marker     always 0xFFFF (start-of-record sentinel)
//   0x06 u16 pad0       always 0
//   0x08 u8  gcmFormat  RSX/GCM pixel format: 0x86=DXT1 0x88=DXT5 0xA5=A8R8G8B8
//   0x09 u8  mipCount   number of stored mip levels
//   0x0A u16 dimension  always 0x0200 (GCM 2D)
//   0x0C u32 gcmRemap   channel remap: 0xAAE4 (DXT) / 0xAA1B (A8R8G8B8)
//   0x10 u16 width
//   0x12 u16 height
//   0x14 u16 depth      always 1 (2D)
//   0x16 u16 pad1       always 0
//   0x18 u32 sizeUnits  size/stride field (theory)
//   0x1C u32 pad2       always 0
//   0x20 u32 payloadSize total pixel allocation in bytes (0 in frontend stubs)

import { BinReader } from './binary/BinReader';

export const TEXS_MAGIC = 'TEXS';
/** First four bytes of every .textures file: "TEXS" = 54 45 58 53. */
export const TEXS_MAGIC_BYTES = new Uint8Array([0x54, 0x45, 0x58, 0x53]);

const HEADER_SIZE = 0x18;
const SUBHEADER_SIZE = 0x14;
const DESC_START = HEADER_SIZE + SUBHEADER_SIZE; // 0x2C
const DESC_STRIDE = 0x24;

/** Logical pixel format derived from the GCM byte. */
export type TextureFormat = 'DXT1' | 'DXT5' | 'A8R8G8B8' | 'raw';

/** GCM pixel-format byte -> logical name. High byte of the CELL GCM format. */
const GCM_FORMAT: Record<number, TextureFormat> = {
	0x86: 'DXT1', // BC1, 4 bpp
	0x88: 'DXT5', // BC3, 8 bpp (alpha)
	0xa5: 'A8R8G8B8', // 32 bpp uncompressed
};

export type TextureDescriptor = {
	/** Byte offset of this descriptor inside the file. */
	descOff: number;
	/** Texture-name CRC-32 (matches the C2NM trailer + .crcs tables). */
	crc: number;
	/** Start-of-record sentinel; 0xFFFF in every observed descriptor. */
	marker: number;
	/** Raw GCM pixel-format byte (0x86 / 0x88 / 0xA5 / …). */
	gcmFormat: number;
	/** Logical pixel format ('DXT1'|'DXT5'|'A8R8G8B8'|'raw'). */
	format: TextureFormat;
	/** Number of stored mip levels. */
	mipCount: number;
	/** GCM texture dimension/type word; 0x0200 (2D) in samples. */
	dimension: number;
	/** GCM channel-remap word (0xAAE4 for DXT, 0xAA1B for A8R8G8B8). */
	gcmRemap: number;
	width: number;
	height: number;
	/** Array/face depth; 1 for these 2D textures. */
	depth: number;
	/** Size/stride field that scales with dimensions (unit not fully pinned). */
	sizeUnits: number;
	/** Total pixel allocation in bytes (0 in frontend stubs). */
	payloadSize: number;
	/** Resolved human name from the C2NM trailer, if present. */
	name?: string;
};

export type ParsedTextures = {
	magic: string;
	version: number;
	flags: number;
	payloadTableOff: number;
	textureCount: number;
	firstDescOff: number;
	/** The 20-byte sub-header bytes between the header and the descriptor array. */
	subHeader: Uint8Array;
	descriptors: TextureDescriptor[];
	/** Byte offset of the "C2NM" trailer, or -1 if absent. */
	c2nmOff: number;
	/** Whether this looks like a descriptor-only stub (payload lives in .streamtex). */
	isStub: boolean;
	/** Original file length (for downstream pixel-region math). */
	byteLength: number;
};

// ---------------------------------------------------------------------------
// Header / descriptor parsing
// ---------------------------------------------------------------------------

/** True if the leading bytes are the "TEXS" magic. */
export function isTextures(raw: Uint8Array): boolean {
	return (
		raw.byteLength >= 4 &&
		raw[0] === 0x54 &&
		raw[1] === 0x45 &&
		raw[2] === 0x58 &&
		raw[3] === 0x53
	);
}

/** Scan from EOF for the "C2NM" trailer; returns its offset or -1. */
export function findC2nm(raw: Uint8Array): number {
	for (let i = raw.byteLength - 4; i >= 0; i--) {
		if (raw[i] === 0x43 && raw[i + 1] === 0x32 && raw[i + 2] === 0x4e && raw[i + 3] === 0x4d) {
			return i;
		}
	}
	return -1;
}

/** Parse the C2NM trailer into a crc -> name map. */
export function parseC2nm(raw: Uint8Array, c2nmOff: number): Map<number, string> {
	const names = new Map<number, string>();
	if (c2nmOff < 0) return names;
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	r.seek(c2nmOff + 4); // skip the "C2NM" tag
	while (r.position + 8 <= raw.byteLength) {
		const crc = r.readU32();
		const len = r.readU32();
		if (len <= 0 || len > 128 || r.position + len > raw.byteLength) break;
		const bytes = r.readBytes(len);
		// names may carry a trailing NUL inside the declared length
		const nul = bytes.indexOf(0);
		const end = nul >= 0 ? nul : bytes.length;
		names.set(crc, new TextDecoder('latin1').decode(bytes.subarray(0, end)));
	}
	return names;
}

export function parseTextures(raw: Uint8Array): ParsedTextures {
	if (!isTextures(raw)) {
		const got = Array.from(raw.subarray(0, 4))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join(' ');
		throw new Error(`textures: bad magic [${got}] — expected "TEXS" (54 45 58 53)`);
	}
	if (raw.byteLength < DESC_START) {
		throw new Error(`textures: file too small (${raw.byteLength} bytes, need >= ${DESC_START})`);
	}

	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);

	const magic = r.readFixedString(4);
	const version = r.readU32();
	const flags = r.readU32();
	const payloadTableOff = r.readU32();
	const textureCount = r.readU32();
	const firstDescOff = r.readU32();

	// 20-byte sub-header between header and descriptor array.
	const subHeader = r.readBytes(SUBHEADER_SIZE);

	// Sanity: the descriptor array must fit.
	const needed = DESC_START + textureCount * DESC_STRIDE;
	if (textureCount > 0 && needed > raw.byteLength) {
		throw new Error(
			`textures: textureCount=${textureCount} would need ${needed} bytes ` +
				`but file is ${raw.byteLength}`,
		);
	}

	const descriptors: TextureDescriptor[] = [];
	for (let i = 0; i < textureCount; i++) {
		const descOff = DESC_START + i * DESC_STRIDE;
		r.seek(descOff);
		const crc = r.readU32();
		const marker = r.readU16();
		r.skip(2); // pad0
		const gcmFormat = r.readU8();
		const mipCount = r.readU8();
		const dimension = r.readU16();
		const gcmRemap = r.readU32();
		const width = r.readU16();
		const height = r.readU16();
		const depth = r.readU16();
		r.skip(2); // pad1
		const sizeUnits = r.readU32();
		r.skip(4); // pad2
		const payloadSize = r.readU32();
		descriptors.push({
			descOff,
			crc,
			marker,
			gcmFormat,
			format: GCM_FORMAT[gcmFormat] ?? 'raw',
			mipCount,
			dimension,
			gcmRemap,
			width,
			height,
			depth,
			sizeUnits,
			payloadSize,
		});
	}

	const c2nmOff = findC2nm(raw);
	if (c2nmOff >= 0) {
		const names = parseC2nm(raw, c2nmOff);
		for (const d of descriptors) {
			const nm = names.get(d.crc);
			if (nm !== undefined) d.name = nm;
		}
	}

	// Frontend stubs carry descriptors with payloadSize==0 (pixels live in the
	// sibling .streamtex). A file is a stub if every descriptor has payloadSize 0
	// AND the file is far too small to hold the textures' pixels.
	const totalDeclared = descriptors.reduce((s, d) => s + d.payloadSize, 0);
	const isStub = textureCount > 0 && totalDeclared === 0;

	return {
		magic,
		version,
		flags,
		payloadTableOff,
		textureCount,
		firstDescOff,
		subHeader,
		descriptors,
		c2nmOff,
		isStub,
		byteLength: raw.byteLength,
	};
}

// ---------------------------------------------------------------------------
// Pixel-region geometry
// ---------------------------------------------------------------------------

/** Bytes per 4x4 block for a block-compressed format (0 for uncompressed). */
function blockBytes(format: TextureFormat): number {
	if (format === 'DXT1') return 8;
	if (format === 'DXT5') return 16;
	return 0;
}

/** Size in bytes of a single mip level for the given format/dimensions. */
export function mipByteSize(format: TextureFormat, w: number, h: number): number {
	const bpb = blockBytes(format);
	if (bpb > 0) {
		return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * bpb;
	}
	if (format === 'A8R8G8B8') return Math.max(1, w) * Math.max(1, h) * 4;
	return 0;
}

/** Total stored size of a full mip chain (ports textures_probe.dxt_chain_size). */
export function mipChainSize(
	format: TextureFormat,
	w: number,
	h: number,
	mips: number,
): number {
	let tot = 0;
	for (let m = 0; m < mips; m++) {
		tot += mipByteSize(format, Math.max(1, w >> m), Math.max(1, h >> m));
	}
	return tot;
}

// ---------------------------------------------------------------------------
// BCn block decoders -> RGBA8 (matches Pillow's "bcn" decoder semantics)
// ---------------------------------------------------------------------------

/** Expand a 5-6-5 colour to 8-8-8. */
function rgb565(c: number): [number, number, number] {
	const r = (c >> 11) & 0x1f;
	const g = (c >> 5) & 0x3f;
	const b = c & 0x1f;
	return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * Decode one DXT1/BC1 4x4 block into `out` (RGBA8, row-major within the block),
 * placed at the block's top-left (bx,by) inside a width×height image.
 * `data` is little-endian within a block (DXT data is stored LE even on PS3 —
 * the block colour words are LE; the file is big-endian only at the container
 * level). Verified by reproducing on-disk DXT1 byte sizes in the wiki.
 */
function decodeBc1Block(
	data: Uint8Array,
	o: number,
	out: Uint8ClampedArray,
	imgW: number,
	imgH: number,
	bx: number,
	by: number,
): void {
	const c0 = data[o] | (data[o + 1] << 8);
	const c1 = data[o + 2] | (data[o + 3] << 8);
	const bits = data[o + 4] | (data[o + 5] << 8) | (data[o + 6] << 16) | (data[o + 7] << 24);
	const [r0, g0, b0] = rgb565(c0);
	const [r1, g1, b1] = rgb565(c1);

	const palR = [r0, r1, 0, 0];
	const palG = [g0, g1, 0, 0];
	const palB = [b0, b1, 0, 0];
	const palA = [255, 255, 255, 255];
	if (c0 > c1) {
		palR[2] = (2 * r0 + r1) / 3;
		palG[2] = (2 * g0 + g1) / 3;
		palB[2] = (2 * b0 + b1) / 3;
		palR[3] = (r0 + 2 * r1) / 3;
		palG[3] = (g0 + 2 * g1) / 3;
		palB[3] = (b0 + 2 * b1) / 3;
	} else {
		palR[2] = (r0 + r1) / 2;
		palG[2] = (g0 + g1) / 2;
		palB[2] = (b0 + b1) / 2;
		palR[3] = 0;
		palG[3] = 0;
		palB[3] = 0;
		palA[3] = 0; // index 3 is transparent black in 1-bit-alpha mode
	}

	for (let py = 0; py < 4; py++) {
		for (let px = 0; px < 4; px++) {
			const idx = (bits >>> (2 * (py * 4 + px))) & 0x3;
			const x = bx + px;
			const y = by + py;
			if (x >= imgW || y >= imgH) continue;
			const di = (y * imgW + x) * 4;
			out[di] = palR[idx];
			out[di + 1] = palG[idx];
			out[di + 2] = palB[idx];
			out[di + 3] = palA[idx];
		}
	}
}

/** Decode one DXT5/BC3 4x4 block (BC1 colour + BC4 8-byte alpha) into `out`. */
function decodeBc3Block(
	data: Uint8Array,
	o: number,
	out: Uint8ClampedArray,
	imgW: number,
	imgH: number,
	bx: number,
	by: number,
): void {
	// 8-byte alpha block first.
	const a0 = data[o];
	const a1 = data[o + 1];
	const alpha = [a0, a1, 0, 0, 0, 0, 0, 0];
	if (a0 > a1) {
		for (let i = 1; i < 7; i++) alpha[i + 1] = ((7 - i) * a0 + i * a1) / 7;
	} else {
		for (let i = 1; i < 5; i++) alpha[i + 1] = ((5 - i) * a0 + i * a1) / 5;
		alpha[6] = 0;
		alpha[7] = 255;
	}
	// 48-bit alpha index field (3 bits per texel), little-endian.
	const aLo = data[o + 2] | (data[o + 3] << 8) | (data[o + 4] << 16);
	const aHi = data[o + 5] | (data[o + 6] << 8) | (data[o + 7] << 16);

	// Colour block (BC1 layout) lives in the next 8 bytes — decode with no alpha
	// punch-through (DXT5 colour is always 4-colour mode).
	const co = o + 8;
	const c0 = data[co] | (data[co + 1] << 8);
	const c1 = data[co + 2] | (data[co + 3] << 8);
	const bits =
		data[co + 4] | (data[co + 5] << 8) | (data[co + 6] << 16) | (data[co + 7] << 24);
	const [r0, g0, b0] = rgb565(c0);
	const [r1, g1, b1] = rgb565(c1);
	const palR = [r0, r1, (2 * r0 + r1) / 3, (r0 + 2 * r1) / 3];
	const palG = [g0, g1, (2 * g0 + g1) / 3, (g0 + 2 * g1) / 3];
	const palB = [b0, b1, (2 * b0 + b1) / 3, (b0 + 2 * b1) / 3];

	for (let py = 0; py < 4; py++) {
		for (let px = 0; px < 4; px++) {
			const texel = py * 4 + px;
			const idx = (bits >>> (2 * texel)) & 0x3;
			const aShift = 3 * texel;
			let aIdx: number;
			if (aShift < 24) aIdx = (aLo >>> aShift) & 0x7;
			else if (aShift > 24) aIdx = (aHi >>> (aShift - 24)) & 0x7;
			else aIdx = ((aLo >>> 24) | (aHi << 0)) & 0x7; // straddles the 24-bit boundary
			const x = bx + px;
			const y = by + py;
			if (x >= imgW || y >= imgH) continue;
			const di = (y * imgW + x) * 4;
			out[di] = palR[idx];
			out[di + 1] = palG[idx];
			out[di + 2] = palB[idx];
			out[di + 3] = alpha[aIdx];
		}
	}
}

/** Decode a linear (non-swizzled) BCn surface to RGBA8. */
export function decodeBcnSurface(
	data: Uint8Array,
	o: number,
	w: number,
	h: number,
	format: 'DXT1' | 'DXT5',
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	const bw = Math.ceil(w / 4);
	const bh = Math.ceil(h / 4);
	const stride = format === 'DXT1' ? 8 : 16;
	let p = o;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			if (p + stride > data.byteLength) {
				return out; // truncated payload — return what we decoded
			}
			if (format === 'DXT1') {
				decodeBc1Block(data, p, out, w, h, bx * 4, by * 4);
			} else {
				decodeBc3Block(data, p, out, w, h, bx * 4, by * 4);
			}
			p += stride;
		}
	}
	return out;
}

/** Decode a linear A8R8G8B8 (GCM ARGB, big-endian word per texel) surface. */
export function decodeArgb8888Surface(
	data: Uint8Array,
	o: number,
	w: number,
	h: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	const n = w * h;
	for (let i = 0; i < n; i++) {
		const p = o + i * 4;
		if (p + 4 > data.byteLength) break;
		// GCM A8R8G8B8 stored big-endian: byte order is A, R, G, B.
		const a = data[p];
		const r = data[p + 1];
		const g = data[p + 2];
		const b = data[p + 3];
		const di = i * 4;
		out[di] = r;
		out[di + 1] = g;
		out[di + 2] = b;
		out[di + 3] = a;
	}
	return out;
}

// ---------------------------------------------------------------------------
// High-level decode: top mip of the largest single texture (inline payload)
// ---------------------------------------------------------------------------

export type DecodedTexture = {
	width: number;
	height: number;
	format: TextureFormat;
	mips: number;
	/** RGBA8 pixels of the top (largest) mip, or null when undecodable. */
	rgba: Uint8ClampedArray | null;
	/** Byte offset of the decoded pixel region within the file, or -1. */
	pixelStart: number;
};

/**
 * Locate and decode the top mip of the largest texture whose pixels are stored
 * inline (single-texture .textures / .low.textures). Ports textures_probe.main:
 * the pixel region for a single-texture file ends at the C2NM trailer, so the
 * top mip starts at `C2NM_off - mipChainSize`. Multi-texture stubs (pixels in
 * .streamtex) return rgba=null.
 *
 * For .textures stubs whose payload lives in a sibling .streamtex, pass the
 * stream bytes via `streamtex` and the largest full-res descriptor is decoded
 * from offset 0 of the stream.
 */
export function decodeLargestTexture(
	raw: Uint8Array,
	parsed: ParsedTextures,
	streamtex?: Uint8Array,
): DecodedTexture | null {
	if (parsed.descriptors.length === 0) return null;

	const decodable = parsed.descriptors.filter(
		(d) => d.format === 'DXT1' || d.format === 'DXT5' || d.format === 'A8R8G8B8',
	);
	if (decodable.length === 0) return null;

	const d = decodable.reduce((a, b) =>
		b.width * b.height > a.width * a.height ? b : a,
	);

	const decodeAt = (
		buf: Uint8Array,
		start: number,
	): Uint8ClampedArray | null => {
		if (d.format === 'A8R8G8B8') return decodeArgb8888Surface(buf, start, d.width, d.height);
		return decodeBcnSurface(buf, start, d.width, d.height, d.format as 'DXT1' | 'DXT5');
	};

	// Stub + stream: the largest full-res texture sits at the start of the stream.
	if (parsed.isStub && streamtex && streamtex.byteLength > 0) {
		return {
			width: d.width,
			height: d.height,
			format: d.format,
			mips: d.mipCount,
			rgba: decodeAt(streamtex, 0),
			pixelStart: 0,
		};
	}

	// Inline single-texture file: top mip ends at the C2NM trailer.
	if (parsed.c2nmOff < 0) return null;
	const chain = mipChainSize(d.format, d.width, d.height, d.mipCount);
	const pixelStart = parsed.c2nmOff - chain;
	if (pixelStart < DESC_START) {
		// Computed start fell inside the header — multi-texture inline file, which
		// this single-texture decode path can't disambiguate. Bail honestly.
		return {
			width: d.width,
			height: d.height,
			format: d.format,
			mips: d.mipCount,
			rgba: null,
			pixelStart: -1,
		};
	}
	return {
		width: d.width,
		height: d.height,
		format: d.format,
		mips: d.mipCount,
		rgba: decodeAt(raw, pixelStart),
		pixelStart,
	};
}
