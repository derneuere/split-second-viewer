// .sideways parser/writer — TrackLogic lateral adjacency table.
//
// Layout (big-endian, PS3): a uint32 linkCount (identical to .linkorigins),
// then one variable-length record per link, in link order. Each record is a
// single uint8 count N followed by N uint16 link indices — the links that run
// alongside the current one (the lanes the AI may slide into when overtaking).
// This decodes Track.sideways.txt byte-for-byte. Ported from the verified
// Python parser and wiki/format-route.html.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** One link's lateral neighbours (link indices, NOT node indices). */
export type SidewaysRecord = {
	/** Number of sideways links (the leading uint8). */
	count: number;
	/** The N laterally-adjacent link indices (uint16 each). length === count. */
	linkIndices: number[];
};

/** Lateral adjacency for an entire route. */
export type ParsedSideways = {
	linkCount: number;
	/** One record per link, in link order. length === linkCount. */
	links: SidewaysRecord[];
};

export function parseSideways(raw: Uint8Array): ParsedSideways {
	if (raw.byteLength < 4) {
		throw new Error(`sideways: ${raw.byteLength} bytes is too small for the count`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const linkCount = r.readU32();
	const links: SidewaysRecord[] = new Array(linkCount);
	for (let i = 0; i < linkCount; i++) {
		const count = r.readU8();
		const linkIndices: number[] = new Array(count);
		for (let j = 0; j < count; j++) linkIndices[j] = r.readU16();
		links[i] = { count, linkIndices };
	}
	// Variable-length records have no size law to assert against the header, but
	// we should have consumed exactly the whole file.
	if (r.position !== raw.byteLength) {
		throw new Error(
			`sideways: consumed ${r.position} of ${raw.byteLength} bytes (record framing mismatch)`,
		);
	}
	return { linkCount, links };
}

export function writeSideways(model: ParsedSideways): Uint8Array {
	const w = new BinWriter(4 + model.links.length * 2, false /* big-endian */);
	w.writeU32(model.links.length >>> 0);
	for (const rec of model.links) {
		w.writeU8(rec.linkIndices.length & 0xff);
		for (const idx of rec.linkIndices) w.writeU16(idx >>> 0);
	}
	return w.bytes.slice();
}
