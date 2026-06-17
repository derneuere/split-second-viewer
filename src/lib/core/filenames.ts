// .filenames / dirlist parser/writer — headerless NUL-terminated string list.
//
// Layout (near-text; endianness n/a): a bare run of NUL-terminated ASCII
// strings with NO count header, read to EOF. Two near-identical uses:
//   - .filenames: the human-readable name of each sub-texture in a paired UI
//     .textures atlas, in array order (index = position in the list).
//   - dirlist: NUL-terminated relative paths (Windows-style '\' separators)
//     naming a folder's contents.
// Both are structurally identical: split on 0x00 to EOF. Ported from the
// verified Python parser and wiki/format-names.html.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinWriter } from './binary/BinWriter';

/** A headerless list of NUL-terminated names/paths (index = position). */
export type ParsedFileNames = {
	/** Consecutive NUL-terminated ASCII entries, in array order. */
	names: string[];
};

export function parseFileNames(raw: Uint8Array): ParsedFileNames {
	const names: string[] = [];
	let start = 0;
	for (let i = 0; i < raw.byteLength; i++) {
		if (raw[i] === 0x00) {
			names.push(new TextDecoder('latin1').decode(raw.subarray(start, i)));
			start = i + 1;
		}
	}
	// Trailing bytes after the last NUL with no terminator (defensive).
	if (start < raw.byteLength) {
		names.push(new TextDecoder('latin1').decode(raw.subarray(start, raw.byteLength)));
	}
	return { names };
}

export function writeFileNames(model: ParsedFileNames): Uint8Array {
	let size = 0;
	for (const n of model.names) size += n.length + 1;
	const w = new BinWriter(Math.max(16, size), false);
	for (const name of model.names) w.writeCString(name);
	return w.bytes.slice();
}
