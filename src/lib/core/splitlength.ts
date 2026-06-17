// .splitlength parser/writer — TrackLogic per-section split lengths.
//
// Layout (big-endian, PS3): a uint32 sectionCount, then one float32 per
// section. File size is exactly 4 + count*4. Values cluster around 1.0 and
// read as per-section length multipliers / split weights used by the HUD split
// timer and the AI distUpSection calculation. Ported from the verified Python
// parser (splitsecond _tools) and wiki/format-route.html.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** Per-section split-length weights for one route. */
export type ParsedSplitLength = {
	sectionCount: number;
	/** One float32 per section, in section order. length === sectionCount. */
	splitLengths: number[];
};

export function parseSplitLength(raw: Uint8Array): ParsedSplitLength {
	if (raw.byteLength < 4) {
		throw new Error(`splitlength: ${raw.byteLength} bytes is too small for the count`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const sectionCount = r.readU32();
	const expected = 4 + sectionCount * 4;
	if (raw.byteLength !== expected) {
		throw new Error(
			`splitlength: size ${raw.byteLength} != 4 + ${sectionCount}*4 (${expected})`,
		);
	}
	const splitLengths: number[] = new Array(sectionCount);
	for (let i = 0; i < sectionCount; i++) splitLengths[i] = r.readF32();
	return { sectionCount, splitLengths };
}

export function writeSplitLength(model: ParsedSplitLength): Uint8Array {
	const w = new BinWriter(4 + model.splitLengths.length * 4, false /* big-endian */);
	w.writeU32(model.splitLengths.length >>> 0);
	for (const v of model.splitLengths) w.writeF32(v);
	return w.bytes.slice();
}
