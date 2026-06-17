// .crcs parser/writer — the WORKED trivial example.
//
// A .crcs file is a headerless flat big-endian uint32[] of texture-name CRC
// dependencies. N = filesize / 4. This module is pure: it imports only the
// binary helpers and NEVER the registry (acyclic rule, see handler.ts).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** Texture-name CRC dependency list. */
export type ParsedCrcs = { crcs: number[] };

export function parseCrcs(raw: Uint8Array): ParsedCrcs {
	if (raw.byteLength % 4 !== 0) {
		throw new Error(`crcs: ${raw.byteLength} bytes is not a multiple of 4`);
	}
	// Copy by byteOffset: extractResourceRaw may hand back a view over a larger
	// buffer (the whole .ark / file), so slice to this member's window.
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const n = raw.byteLength / 4;
	const crcs: number[] = new Array(n);
	for (let i = 0; i < n; i++) crcs[i] = r.readU32();
	return { crcs };
}

export function writeCrcs(model: ParsedCrcs): Uint8Array {
	const w = new BinWriter(model.crcs.length * 4, false /* big-endian */);
	for (const c of model.crcs) w.writeU32(c >>> 0);
	return w.bytes.slice();
}
