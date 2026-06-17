// .sectorInfo parser — Split/Second per-level streaming / visibility partition.
//
// One <Level>.sectorInfo per level under Environments/Levels/<Level>/Sectors/.
// Big-endian floats/ints, but embedded strings are UTF-16LE (unusual for this
// big-endian title). Layout (wiki/format-sectors.html), cross-checked vs. all
// 10 real levels:
//
//   Header (12 bytes):
//     0x00 float32 constA      = 1.9200 (3f f5 c2 8f), constant across levels
//     0x04 float32 constB      = 300.0  (43 96 00 00), constant
//     0x08 uint32  sectorCount @0x08   == count of q### chunk tags (CONFIRMED)
//   Chunks (begin at 0x0C):
//     0x0C "q000" … one q###-tagged record per sector, in file order.
//
// Each chunk is: ASCII tag "q###" + a UTF-16LE name/path string + 3 zero words
// + a 12-float AABB block (at in-chunk +0x4C, CONFIRMED stable across all
// levels) giving the sector's world-space extents (4 corners) + index-list
// counts + a second UTF-16LE name fragment. The first (q000) and last chunks
// are larger (they hold the global source path / per-level index tables); the
// regular chunks are a uniform 232 bytes on the sampled levels.
//
// DECODED: the header, the chunk enumeration (tag + absolute offset + length),
// the per-chunk UTF-16LE name, and the per-chunk AABB (min/max world bounds,
// for the World viewport). The full per-chunk field order (index lists) is still
// Theory, so each chunk's raw bytes are preserved verbatim. writeRaw re-emits
// the header + verbatim chunk spans, which is byte-exact (verified across
// levels), so caps.write = true.
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

export const SECTOR_CONST_A = 1.92;
export const SECTOR_CONST_B = 300.0;
/** In-chunk byte offset of the 12-float AABB block (CONFIRMED across all levels). */
const CHUNK_AABB_OFFSET = 0x4c;

export type SectorAABB = {
	min: [number, number, number];
	max: [number, number, number];
};

export type SectorChunk = {
	/** ASCII chunk tag, e.g. "q000". Ids may be sparse (Downtown runs q000..q132). */
	tag: string;
	/** Absolute byte offset of the tag within the file. */
	offset: number;
	/** Byte length of this chunk (distance to the next q-tag, or to EOF). */
	length: number;
	/** Best-effort UTF-16LE name fragment decoded right after the tag. */
	name: string;
	/** World-space AABB (min/max over the 4 corner floats at in-chunk +0x4C). */
	aabb?: SectorAABB;
};

export type ParsedSectorInfo = {
	constA: number;
	constB: number;
	sectorCount: number;
	chunkTag0: string;
	/** Best-effort UTF-16LE source path embedded in the first chunk (may be empty). */
	srcPath: string;
	/** Every q### sector chunk, in file order (with AABB + name overlays). */
	chunks: SectorChunk[];
	/**
	 * The file body from offset 12 (just after the decoded header) to EOF,
	 * preserved VERBATIM. The chunk overlays index into this region (their
	 * `offset` is absolute from the file start). The writer replays it unchanged
	 * for a byte-exact round-trip.
	 */
	body: Uint8Array;
	/** True when the q### tag scan count equals the header sectorCount. */
	countMatches: boolean;
	byteLength: number;
};

/** Scan for ASCII 'q' followed by three ASCII digits ("q000".."q999"). */
function scanQTagOffsets(b: Uint8Array): number[] {
	const offs: number[] = [];
	for (let p = 0; p + 4 <= b.byteLength; p++) {
		if (b[p] !== 0x71) continue; // 'q'
		const d0 = b[p + 1];
		const d1 = b[p + 2];
		const d2 = b[p + 3];
		if (d0 >= 0x30 && d0 <= 0x39 && d1 >= 0x30 && d1 <= 0x39 && d2 >= 0x30 && d2 <= 0x39) {
			offs.push(p);
		}
	}
	return offs;
}

/** Decode a NUL-terminated UTF-16LE string starting at `start`, skipping leading 0x0000 words. */
function decodeUtf16le(b: Uint8Array, start: number, hardEnd: number): string {
	let s = start;
	// Skip leading NUL words (padding before the path/name).
	while (s + 1 < hardEnd && b[s] === 0 && b[s + 1] === 0) s += 2;
	let e = s;
	while (e + 1 < hardEnd && !(b[e] === 0 && b[e + 1] === 0)) e += 2;
	const slice = b.subarray(s, e);
	return new TextDecoder('utf-16le').decode(slice);
}

/** Read the 12-float AABB at in-chunk +0x4C and reduce to min/max world bounds. */
function readChunkAabb(b: Uint8Array, chunkStart: number, chunkEnd: number): SectorAABB | undefined {
	const at = chunkStart + CHUNK_AABB_OFFSET;
	if (at + 48 > chunkEnd) return undefined;
	const dv = new DataView(b.buffer, b.byteOffset + at, 48);
	const xs: number[] = [];
	const ys: number[] = [];
	const zs: number[] = [];
	for (let i = 0; i < 4; i++) {
		xs.push(dv.getFloat32(i * 12 + 0, false));
		ys.push(dv.getFloat32(i * 12 + 4, false));
		zs.push(dv.getFloat32(i * 12 + 8, false));
	}
	// Sanity: only treat as an AABB if the values are plausible world coords.
	const all = [...xs, ...ys, ...zs];
	if (!all.every((v) => Number.isFinite(v) && Math.abs(v) < 1e6)) return undefined;
	return {
		min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
		max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
	};
}

export function parseSectorInfo(raw: Uint8Array): ParsedSectorInfo {
	if (raw.byteLength < 0x10) {
		throw new Error(`sectorInfo: ${raw.byteLength} bytes is smaller than the 16-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian header
	);
	const constA = r.readF32();
	const constB = r.readF32();
	const sectorCount = r.readU32();

	const tagOffsets = scanQTagOffsets(raw);
	if (tagOffsets.length === 0) {
		throw new Error('sectorInfo: no q### chunk tags found');
	}
	const firstTag = tagOffsets[0];
	const chunkTag0 = new TextDecoder('latin1').decode(raw.subarray(firstTag, firstTag + 4));
	const body = raw.slice(12);

	const chunks: SectorChunk[] = [];
	for (let i = 0; i < tagOffsets.length; i++) {
		const offset = tagOffsets[i];
		const end = i + 1 < tagOffsets.length ? tagOffsets[i + 1] : raw.byteLength;
		const tag = new TextDecoder('latin1').decode(raw.subarray(offset, offset + 4));
		const name = decodeUtf16le(raw, offset + 4, end);
		const aabb = readChunkAabb(raw, offset, end);
		chunks.push({ tag, offset, length: end - offset, name, aabb });
	}

	// srcPath is the UTF-16LE string in the first chunk (the global source path).
	const srcPath = chunks[0]?.name ?? '';
	const countMatches = chunks.length === sectorCount;

	return {
		constA,
		constB,
		sectorCount,
		chunkTag0,
		srcPath,
		chunks,
		body,
		countMatches,
		byteLength: raw.byteLength,
	};
}

/**
 * Re-encode a parsed .sectorInfo byte-for-byte. The only decoded/editable header
 * fields are constA, constB and sectorCount (the first 12 bytes); everything
 * else (chunk bodies) is replayed verbatim from `model.body`. Byte-exact across
 * all real levels.
 */
export function writeSectorInfo(model: ParsedSectorInfo): Uint8Array {
	const w = new BinWriter(12 + model.body.length, false);
	w.writeF32(model.constA);
	w.writeF32(model.constB);
	w.writeU32(model.sectorCount >>> 0);
	w.writeBytes(model.body);
	return w.bytes.slice();
}
