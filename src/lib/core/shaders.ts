// .shaders parser — Crayon2 shader-set register blocks (SHDR container).
//
// The engine-side material-combo metadata: named constant/sampler binding tables
// that the Crayon2 renderer uses to patch the clean RSX microcode (which lives in
// the paired .fxc) at load time. Big-endian (PS3). Layout per the RE wiki
// (wiki/format-shaders.html):
//
//   0x00  char[4]  magic        "SHDR" (53 48 44 52)
//   0x04  u32      version      6 in every sample
//   0x08  u32      combo_count  number of shader/material-combo records
//   0x0C  u32      name_len     length of set_name incl. terminator
//   0x10  char[]   set_name     set-level CRC string, e.g. "0xe4249692"
//                               (byte-identical to the paired .fxc set_name)
//   ...   combo_count records, each:
//         "HDRB" + reserved + counts + combiner table + const table + "HDRE"
//         + "SDRS" u32(0) "SDRE"  (empty vertex slot)
//         + "SDRS" u32(0) "SDRE"  (empty fragment slot)
//         + u32 len + char[] combo_crc  ("0x618d6dad")
//
// The header and the per-record combo CRC names are decoded with confidence;
// the interior const-table field order is wiki-Partial, so we recover the
// combiner/constant NAMES by walking the markers rather than asserting a stride.
//
// Pure module: binary helpers only, never the registry.

import { BinReader } from './binary/BinReader';

export const SHADERS_MAGIC = new Uint8Array([0x53, 0x48, 0x44, 0x52]); // "SHDR"
const HDRB = 0x48445242;
const HDRE = 0x48445245;

/** One shader/material-combo record. */
export type ShaderCombo = {
	/** Absolute file offset of this record's HDRB marker. */
	offset: number;
	/** Length-prefixed CRC string for this combo, e.g. "0x618d6dad". */
	comboCrc: string;
	/** Named constant/sampler/combiner symbols recovered from the HDRB block. */
	symbols: string[];
};

export type ParsedShaders = {
	version: number;
	/** combo_count from the header (== HDRB markers == paired .fxc count). */
	comboCount: number;
	/** Set-level CRC string (the join key with the paired .fxc). */
	setName: string;
	combos: ShaderCombo[];
	byteLength: number;
};

function checkMagic(raw: Uint8Array): void {
	if (raw.byteLength < 0x10) {
		throw new Error(`shaders: too small (${raw.byteLength} bytes, need >= 16)`);
	}
	for (let i = 0; i < 4; i++) {
		if (raw[i] !== SHADERS_MAGIC[i]) {
			const got = [...raw.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
			throw new Error(`shaders: bad magic ${got} (expected 53 48 44 52 "SHDR")`);
		}
	}
}

/** Collect every length-prefixed printable ASCII name within [start,end). */
function collectNames(raw: Uint8Array, start: number, end: number): string[] {
	const names: string[] = [];
	let off = start;
	while (off + 4 <= end) {
		const len =
			(raw[off] << 24) | (raw[off + 1] << 16) | (raw[off + 2] << 8) | raw[off + 3];
		if (len >= 2 && len <= 128 && off + 4 + len <= end) {
			const ns = off + 4;
			// names start with a digit (CRC "0x…") or a letter
			let printable =
				(raw[ns] >= 0x30 && raw[ns] <= 0x39) || (raw[ns] >= 0x41 && raw[ns] <= 0x7a);
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

/** Find the next occurrence of a 4-byte tag at/after `from`, or -1. */
function findTag(raw: Uint8Array, tag: number, from: number): number {
	const b0 = (tag >>> 24) & 0xff, b1 = (tag >>> 16) & 0xff, b2 = (tag >>> 8) & 0xff, b3 = tag & 0xff;
	for (let i = from; i + 4 <= raw.byteLength; i++) {
		if (raw[i] === b0 && raw[i + 1] === b1 && raw[i + 2] === b2 && raw[i + 3] === b3) return i;
	}
	return -1;
}

export function parseShaders(raw: Uint8Array): ParsedShaders {
	checkMagic(raw);
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);

	r.skip(4); // "SHDR"
	const version = r.readU32();
	const comboCount = r.readU32();
	const nameLen = r.readU32();
	if (nameLen > 0x100 || r.position + nameLen > raw.byteLength) {
		throw new Error(`shaders: implausible name_len ${nameLen}`);
	}
	const nameBytes = r.readBytes(nameLen);
	let nend = nameBytes.indexOf(0);
	if (nend < 0) nend = nameBytes.length;
	const setName = new TextDecoder('latin1').decode(nameBytes.subarray(0, nend));

	// Walk the HDRB...HDRE records. Between one record's HDRE and the next HDRB
	// (or EOF) sit the two empty SDRS/SDRE slots and the combo CRC string; the
	// HDRB..HDRE span carries the combiner/constant symbol names.
	const combos: ShaderCombo[] = [];
	let cursor = r.position;
	for (let i = 0; i < comboCount; i++) {
		const hb = findTag(raw, HDRB, cursor);
		if (hb < 0) break;
		const he = findTag(raw, HDRE, hb + 4);
		if (he < 0) break;
		const symbols = collectNames(raw, hb + 4, he);
		// The combo CRC is the length-prefixed string after the two SDRS/SDRE slots,
		// i.e. before the next HDRB (or EOF). Grab the last name in that gap. NOTE:
		// the FINAL record may omit its trailing CRC (the file ends "SDRE\0END"),
		// in which case comboCrc is "".
		const nextHb = findTag(raw, HDRB, he + 4);
		const gapEnd = nextHb < 0 ? raw.byteLength : nextHb;
		const gapNames = collectNames(raw, he + 4, gapEnd);
		const comboCrc = gapNames.length > 0 ? gapNames[gapNames.length - 1] : '';
		combos.push({ offset: hb, comboCrc, symbols });
		cursor = nextHb < 0 ? raw.byteLength : nextHb;
	}

	return { version, comboCount, setName, combos, byteLength: raw.byteLength };
}
