// .parts parser — vehicle PART HIERARCHY (PARTIAL).
//
// One per car under Vehicles/Bodies/<Car>/<Car>.parts. A big-endian
// typed/indexed array describing the body-panel / wheel part hierarchy used for
// damage/deform. The file opens with two header words:
//
//   0x00 u32 count        (e.g. 5)
//   0x04 u32 elementSize   (e.g. 0x2e = 46 for Musclecar_01, 0x25 for Supercar)
//
// followed by a node list mixing BE u32 index/flag fields, 0xFFFFFFFF
// terminators, child-index lists, and float32 transform blocks (an identity-ish
// 4x4 matrix — 3f800000 on the diagonal — plus a part offset vector). NOTE the
// header `elementSize` is NOT a uniform per-record stride for the whole file
// (8 + count*elementSize != filesize), so the per-node record framing is not
// yet pinned. We therefore decode the two confirmed header words and surface
// the remaining payload as a flat big-endian u32 array (and a float32 view of
// the same words) for inspection. Marked PARTIAL. Ported from the verified
// Python probe and TOOLING-TODO.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';

/** Vehicle part-hierarchy table (header solid, body not yet field-decoded). */
export type ParsedParts = {
	/** Leading record count (0x00). */
	count: number;
	/** Declared element size word (0x04). Not a uniform whole-file stride. */
	elementSize: number;
	/** Number of u32 words in the payload after the 8-byte header. */
	wordCount: number;
	/** Payload words read as big-endian uint32 (length === wordCount). */
	words: number[];
	/** Same payload words reinterpreted as big-endian float32 (for transforms). */
	floats: number[];
	/** True when the file length is a whole number of 4-byte words. */
	wordAligned: boolean;
};

export function parseParts(raw: Uint8Array): ParsedParts {
	if (raw.byteLength < 8) {
		throw new Error(`parts: ${raw.byteLength} bytes is too small for the 8-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const count = r.readU32();
	const elementSize = r.readU32();

	const payloadBytes = raw.byteLength - 8;
	const wordAligned = payloadBytes % 4 === 0;
	const wordCount = Math.floor(payloadBytes / 4);

	const words: number[] = new Array(wordCount);
	const floats: number[] = new Array(wordCount);
	// Read u32 + reinterpret the same 4 bytes as f32 without re-seeking twice.
	const fr = new BinReader(
		raw.buffer.slice(raw.byteOffset + 8, raw.byteOffset + 8 + wordCount * 4),
		false,
	);
	for (let i = 0; i < wordCount; i++) {
		words[i] = r.readU32();
		floats[i] = fr.readF32();
	}

	return { count, elementSize, wordCount, words, floats, wordAligned };
}
