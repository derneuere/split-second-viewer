// .fxc parser — Crayon2 compiled-effect container (RSX microcode + symbol table).
//
// The compiled-shader half of the Crayon2 material system: the "clean shader"
// RSX vertex+fragment program binaries the .shaders register blocks patch. The
// microcode itself is NV40/RSX GPU bytecode and is OPAQUE — only the container
// framing is decoded. Big-endian (PS3). Layout per the RE wiki
// (wiki/format-fxc.html):
//
//   0x00  char[4]  magic        "\0FXC" (00 46 58 43 — leading NUL)
//   0x04  u32      version      1 in every sample
//   0x08  u32      combo_count  number of compiled combos (== paired .shaders)
//   0x0C  u32      name_len     length of set_name incl. terminator
//   0x10  char[]   set_name     set-level CRC, e.g. "0xe4249692"
//                               (byte-identical to the paired .shaders set_name)
//   ...   combo_count compiled combos (symbol table + RSX microcode), opaque
//   EOF   "END"    file terminator
//
// Only the header + the trailing "END" tag are asserted; the per-combo microcode
// is surfaced as a single opaque byte range. We also recover the leading engine
// uniform symbol NAMES (Trans, TransViewProj, WorldCameraPos, …) best-effort for
// the describe() summary, since those are legible length-prefixed ASCII.
//
// Pure module: binary helpers only, never the registry.

import { BinReader } from './binary/BinReader';

export const FXC_MAGIC = new Uint8Array([0x00, 0x46, 0x58, 0x43]); // "\0FXC"
const END_TAG = new Uint8Array([0x45, 0x4e, 0x44]); // "END"

export type ParsedFxc = {
	version: number;
	/** combo_count from the header (== paired .shaders combo count). */
	comboCount: number;
	/** Set-level CRC string (the join key with the paired .shaders). */
	setName: string;
	/** Byte range [offset,offset+length) of the opaque per-combo microcode body. */
	microcode: { offset: number; length: number };
	/** Engine uniform symbol names recovered from the head of the combo body. */
	symbols: string[];
	/** True if the file ends with the "END" terminator. */
	hasEndTag: boolean;
	byteLength: number;
};

function checkMagic(raw: Uint8Array): void {
	if (raw.byteLength < 0x10) {
		throw new Error(`fxc: too small (${raw.byteLength} bytes, need >= 16)`);
	}
	for (let i = 0; i < 4; i++) {
		if (raw[i] !== FXC_MAGIC[i]) {
			const got = [...raw.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
			throw new Error(`fxc: bad magic ${got} (expected 00 46 58 43 "\\0FXC")`);
		}
	}
}

/** Collect a handful of leading length-prefixed printable symbol names. */
function collectSymbols(raw: Uint8Array, start: number, max: number): string[] {
	const names: string[] = [];
	let off = start;
	// scan a bounded window (symbol tables sit at the head of each combo body)
	const end = Math.min(raw.byteLength - 4, start + 0x800);
	while (off + 4 <= end && names.length < max) {
		const len =
			(raw[off] << 24) | (raw[off + 1] << 16) | (raw[off + 2] << 8) | raw[off + 3];
		if (len >= 3 && len <= 64 && off + 4 + len <= raw.byteLength) {
			const ns = off + 4;
			let printable = raw[ns] >= 0x41 && raw[ns] <= 0x7a;
			for (let k = 0; k < len - 1 && printable; k++) {
				const c = raw[ns + k];
				if (c < 0x20 || c > 0x7e) printable = false;
			}
			if (printable && raw[ns + len - 1] === 0x00) {
				names.push(new TextDecoder('latin1').decode(raw.subarray(ns, ns + len - 1)));
				off = ns + len;
				continue;
			}
		}
		off++;
	}
	return names;
}

export function parseFxc(raw: Uint8Array): ParsedFxc {
	checkMagic(raw);
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);

	r.skip(4); // "\0FXC"
	const version = r.readU32();
	const comboCount = r.readU32();
	const nameLen = r.readU32();
	if (nameLen > 0x100 || r.position + nameLen > raw.byteLength) {
		throw new Error(`fxc: implausible name_len ${nameLen}`);
	}
	const nameBytes = r.readBytes(nameLen);
	let nend = nameBytes.indexOf(0);
	if (nend < 0) nend = nameBytes.length;
	const setName = new TextDecoder('latin1').decode(nameBytes.subarray(0, nend));

	const bodyStart = r.position;
	const hasEndTag =
		raw.byteLength >= 3 &&
		raw[raw.byteLength - 3] === END_TAG[0] &&
		raw[raw.byteLength - 2] === END_TAG[1] &&
		raw[raw.byteLength - 1] === END_TAG[2];
	const bodyEnd = hasEndTag ? raw.byteLength - 3 : raw.byteLength;

	const symbols = collectSymbols(raw, bodyStart, 12);

	return {
		version,
		comboCount,
		setName,
		microcode: { offset: bodyStart, length: Math.max(0, bodyEnd - bodyStart) },
		symbols,
		hasEndTag,
		byteLength: raw.byteLength,
	};
}
