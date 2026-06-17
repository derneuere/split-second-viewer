// .linkorigins parser/writer — TrackLogic per-link arc-length origins.
//
// Layout (big-endian, PS3): a uint32 linkCount, then one float32 per link. File
// size is exactly 4 + count*4. The floats rise roughly monotonically along the
// route and are the arc-length distance (metres) at which each link begins on
// the spline. The count matches "Total Links" in Track.sideways and the link
// count in Track.sideways/.linkorigins. Ported from the verified Python parser
// and wiki/format-route.html.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** Per-link arc-length origins for one route. */
export type ParsedLinkOrigins = {
	linkCount: number;
	/** One float32 per link, in link order. length === linkCount. */
	origins: number[];
};

export function parseLinkOrigins(raw: Uint8Array): ParsedLinkOrigins {
	if (raw.byteLength < 4) {
		throw new Error(`linkorigins: ${raw.byteLength} bytes is too small for the count`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const linkCount = r.readU32();
	const expected = 4 + linkCount * 4;
	if (raw.byteLength !== expected) {
		throw new Error(
			`linkorigins: size ${raw.byteLength} != 4 + ${linkCount}*4 (${expected})`,
		);
	}
	const origins: number[] = new Array(linkCount);
	for (let i = 0; i < linkCount; i++) origins[i] = r.readF32();
	return { linkCount, origins };
}

export function writeLinkOrigins(model: ParsedLinkOrigins): Uint8Array {
	const w = new BinWriter(4 + model.origins.length * 4, false /* big-endian */);
	w.writeU32(model.origins.length >>> 0);
	for (const v of model.origins) w.writeF32(v);
	return w.bytes.slice();
}
