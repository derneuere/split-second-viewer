// .sectorInfo parser — Split/Second per-level streaming / visibility partition.
//
// Ported from the (tested-header) python probes + wiki/format-sectors.html.
// Big-endian floats/ints, but embedded strings are UTF-16LE (unusual for this
// big-endian title). PARTIAL: the 12-byte header and the q###-tag sector count
// are SOLVED and verified (the q### tag scan equals the header sectorCount on
// every level: Downtown 128, docks 148, Graveyard 213, nem_storm 43). The
// per-chunk field order (AABB / index lists / name) is NOT yet fully resolved,
// so this parser decodes the header + enumerates the sector chunk tags and
// their byte offsets only — it deliberately does not over-claim the chunk body.
//
//   Header:
//     float32 constA      = 1.9200 (3f f5 c2 8f), constant across all levels
//     float32 constB      = 300.0  (43 96 00 00), constant
//     uint32  sectorCount @ 0x08   == count of q### tags (Confirmed)
//     char[4] chunkTag0   @ 0x0C   = "q000"
//     ... UTF-16LE source path + per-sector q### chunks ...
//
// Read-only handler (no writer): the chunk internals aren't decoded, so a faithful
// byte round-trip isn't possible — the Hex fallback covers the undecoded body.
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';

export const SECTOR_CONST_A = 1.92;
export const SECTOR_CONST_B = 300.0;

export type SectorChunk = {
	/** ASCII chunk tag, e.g. "q000". Ids may be sparse (Downtown runs q000..q132). */
	tag: string;
	/** Absolute byte offset of the tag within the file. */
	offset: number;
};

export type ParsedSectorInfo = {
	constA: number;
	constB: number;
	sectorCount: number;
	chunkTag0: string;
	/** Best-effort UTF-16LE source path embedded after the header (may be empty). */
	srcPath: string;
	/** Every q### sector chunk tag found, in file order. */
	chunks: SectorChunk[];
	/** True when the q### tag scan count equals the header sectorCount. */
	countMatches: boolean;
};

/** Scan for ASCII 'q' followed by three ASCII digits ("q000".."q999"). */
function scanQTags(b: Uint8Array): SectorChunk[] {
	const chunks: SectorChunk[] = [];
	for (let p = 0; p + 4 <= b.byteLength; p++) {
		if (b[p] !== 0x71) continue; // 'q'
		const d0 = b[p + 1];
		const d1 = b[p + 2];
		const d2 = b[p + 3];
		if (
			d0 >= 0x30 && d0 <= 0x39 &&
			d1 >= 0x30 && d1 <= 0x39 &&
			d2 >= 0x30 && d2 <= 0x39
		) {
			chunks.push({ tag: String.fromCharCode(0x71, d0, d1, d2), offset: p });
		}
	}
	return chunks;
}

/** Decode a NUL-terminated UTF-16LE string starting at `start`, skipping a leading 0x0000 word. */
function decodeUtf16le(b: Uint8Array, start: number): string {
	let s = start;
	// Skip a leading NUL word (the chunk-tag's trailing zero pad before the path).
	while (s + 1 < b.byteLength && b[s] === 0 && b[s + 1] === 0) s += 2;
	let e = s;
	while (e + 1 < b.byteLength && !(b[e] === 0 && b[e + 1] === 0)) e += 2;
	const slice = b.subarray(s, e);
	return new TextDecoder('utf-16le').decode(slice);
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
	const chunkTag0 = r.readFixedString(4);
	const srcPath = decodeUtf16le(raw, 0x10);
	const chunks = scanQTags(raw);
	const countMatches = chunks.length === sectorCount;
	return { constA, constB, sectorCount, chunkTag0, srcPath, chunks, countMatches };
}
