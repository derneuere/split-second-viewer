// .names parser/writer — counted NUL-terminated string list.
//
// Layout (near-text; endianness n/a): a single leading ASCII count DIGIT, then
// a 0x00 separator, then that many NUL-terminated ASCII strings, in index
// order. Used for short fixed enumerations — most commonly
// LightRigs/LightRigNames.names (a level's time-of-day light-rig names). The
// count is a literal text digit (e.g. '3' = 0x33), so as observed it only
// encodes 0–9. Ported from the verified Python parser and wiki/format-names.html.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinWriter } from './binary/BinWriter';

/** A counted list of NUL-terminated names (e.g. light-rig names). */
export type ParsedNames = {
	/** The leading ASCII count digit value (0–9). */
	count: number;
	/** N NUL-terminated ASCII names, in index order. length === count. */
	names: string[];
};

export function parseNames(raw: Uint8Array): ParsedNames {
	if (raw.byteLength < 2) {
		throw new Error(`names: ${raw.byteLength} bytes is too small (need count digit + separator)`);
	}
	const digit = raw[0];
	if (digit < 0x30 || digit > 0x39) {
		throw new Error(
			`names: leading byte 0x${digit.toString(16)} is not an ASCII count digit ('0'-'9')`,
		);
	}
	const count = digit - 0x30;
	if (raw[1] !== 0x00) {
		throw new Error(`names: byte[1] 0x${raw[1].toString(16)} is not the 0x00 separator`);
	}

	// Split the remaining bytes on NUL. Drop a single trailing empty produced by
	// the final terminator.
	const names: string[] = [];
	let start = 2;
	for (let i = 2; i < raw.byteLength; i++) {
		if (raw[i] === 0x00) {
			names.push(decodeAscii(raw, start, i));
			start = i + 1;
		}
	}
	// Any bytes after the last NUL with no terminator (defensive): include them.
	if (start < raw.byteLength) names.push(decodeAscii(raw, start, raw.byteLength));

	return { count, names };
}

export function writeNames(model: ParsedNames): Uint8Array {
	// The on-disk count is the leading ASCII digit; trust model.names.length so
	// the writer stays consistent with the payload.
	const n = model.names.length;
	if (n > 9) {
		throw new Error(`names: ${n} entries cannot be encoded as a single ASCII count digit (0-9)`);
	}
	const w = new BinWriter(2 + n * 8, false);
	w.writeU8(0x30 + n); // count digit
	w.writeU8(0x00); // separator
	for (const name of model.names) w.writeCString(name);
	return w.bytes.slice();
}

function decodeAscii(raw: Uint8Array, start: number, end: number): string {
	return new TextDecoder('latin1').decode(raw.subarray(start, end));
}
