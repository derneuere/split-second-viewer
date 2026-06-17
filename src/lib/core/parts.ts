// .parts parser — vehicle PART HIERARCHY.
//
// One per car under Vehicles/Bodies/<Car>/<Car>.parts. A big-endian
// typed/indexed table describing the body-panel / wheel part hierarchy used for
// damage/deform. The file opens with two header words:
//
//   0x00 u32 count        leading record count (e.g. 5)
//   0x04 u32 elementSize  declared element size (0x2e=46 Musclecar_01, 0x25=37 Supercar)
//
// followed by a payload mixing BE u32 index/flag fields, 0xFFFFFFFF terminators,
// child-index lists, and float32 TRANSFORM BLOCKS. Each transform block is a
// 12-float (48-byte) affine: three rows of [diag, *, *, *] where the diagonal
// words are 0x3F800000 (1.0) and the final three words of the block are the
// part's offset vector (x,y,z). Example from Musclecar_01 @0x60:
//
//   3f800000 00000000 00000000 00000000   row0  (1, 0, 0, 0)
//   3f800000 00000000 00000000 00000000   row1  (1, 0, 0, 0)
//   3f800000 3f5f48b4 3f129b09 3f1d6c4a   row2  (1, ox, oy, oz)  offset≈(0.872,0.573,0.615)
//
// The header `elementSize` is NOT a uniform whole-file stride (8 + count*esz !=
// filesize), and the per-node record framing is variable/recursive (index lists
// of varying length, optional transforms), so the exact node boundaries are not
// pinned. We therefore: (1) decode the two confirmed header words; (2) surface
// the payload as both a big-endian u32 array and a float32 view; (3) overlay the
// recognizable 12-float transform blocks (offset vector extracted) for the
// viewer; and (4) preserve the payload verbatim so the writer round-trips
// byte-for-byte regardless of the unresolved node framing.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

const ONE_BITS = 0x3f800000; // float32 1.0

/** A 12-float (48-byte) affine transform block found in the payload. */
export type PartTransform = {
	/** Absolute file offset of the transform block (the first diagonal word). */
	offset: number;
	/** The 12 float32 values of the block, in file order. */
	matrix: number[];
	/** The part offset vector (last three words of the block): (x, y, z). */
	offsetVec: [number, number, number];
};

/** Vehicle part-hierarchy table (header + transform overlay; node framing not pinned). */
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
	/** Recognized 12-float transform blocks (4x3 affine) with extracted offsets. */
	transforms: PartTransform[];
	/** Count of 0xFFFFFFFF terminator words in the payload. */
	terminatorCount: number;
	/** True when the file length is a whole number of 4-byte words. */
	wordAligned: boolean;
};

/**
 * Scan the payload for 12-float transform blocks. A block is recognized by its
 * three diagonal words being exactly 0x3F800000 (1.0) at relative word offsets
 * 0, 4 and 8 within the block. Blocks are non-overlapping; the offset vector is
 * the last three floats.
 */
function scanTransforms(words: number[], floats: number[], payloadBase: number): PartTransform[] {
	const out: PartTransform[] = [];
	for (let i = 0; i + 12 <= words.length; ) {
		if (words[i] === ONE_BITS && words[i + 4] === ONE_BITS && words[i + 8] === ONE_BITS) {
			const matrix = floats.slice(i, i + 12);
			out.push({
				offset: payloadBase + i * 4,
				matrix,
				offsetVec: [floats[i + 9], floats[i + 10], floats[i + 11]],
			});
			i += 12; // non-overlapping
		} else {
			i += 1;
		}
	}
	return out;
}

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
	// Reinterpret the same 4 bytes as both u32 and f32.
	const fr = new BinReader(
		raw.buffer.slice(raw.byteOffset + 8, raw.byteOffset + 8 + wordCount * 4),
		false,
	);
	let terminatorCount = 0;
	for (let i = 0; i < wordCount; i++) {
		const w = r.readU32();
		words[i] = w;
		floats[i] = fr.readF32();
		if (w === 0xffffffff) terminatorCount++;
	}

	const transforms = scanTransforms(words, floats, 8);

	return {
		count,
		elementSize,
		wordCount,
		words,
		floats,
		transforms,
		terminatorCount,
		wordAligned,
	};
}

/**
 * Re-encode a parsed .parts byte-for-byte: header (count, elementSize) followed
 * by the payload words. Byte-exact because the payload is replayed verbatim from
 * `words` (the transform overlay is derived, never re-serialized). Any sub-word
 * trailing bytes (when !wordAligned) are not representable here — such files
 * never occur in the sample set, and parse keeps wordAligned=false so the writer
 * is not advertised for them.
 */
export function writeParts(model: ParsedParts): Uint8Array {
	const w = new BinWriter(8 + model.words.length * 4, false);
	w.writeU32(model.count >>> 0);
	w.writeU32(model.elementSize >>> 0);
	for (const word of model.words) w.writeU32(word >>> 0);
	return w.bytes.slice();
}
