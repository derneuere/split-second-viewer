// .shaderinst parser — Crayon2 per-mesh shader-instance bindings (SDRI/INSS).
//
// Binds concrete mesh instances to material combos and supplies instance-specific
// constant overrides (paint colour, emissive index, decals). Shares the "SDRI"
// container magic with .mcl but is a different inner dialect. Big-endian (PS3).
// Layout per the RE wiki (wiki/format-shaders.html, .shaderinst section):
//
//   0x00  char[4]  magic       "SDRI" (53 44 52 49)
//   0x04  u32      version     8 in every sample
//   0x08  char[4]  blk_magic   "INSS"
//   0x0C  u32      node_count  number of instance records (== "unnamed" count)
//   ...   node_count instance records, each:
//         u32 inst_crc; u32 nameLen char[] node_name ("unnamed");
//         u32 comboLen  char[] combo_crc ("0x0882fbc1");  overrides[...]
//
// Header + per-node inst_crc / node_name / combo_crc are decoded with confidence
// (node_count is byte-proven == count of "unnamed" strings). The override
// sub-structure after each combo_crc is wiki-Partial; the override NAMES are
// recovered by scanning, but their value layout is not asserted.
//
// Pure module: binary helpers only, never the registry.

import { BinReader } from './binary/BinReader';

export const SHADERINST_MAGIC = new Uint8Array([0x53, 0x44, 0x52, 0x49]); // "SDRI"
const INSS = 0x494e5353; // "INSS"
const INSE = 0x494e5345; // "INSE"

/** One mesh-instance binding record. */
export type ShaderInstNode = {
	/** Per-node instance/object CRC (binary 32-bit). */
	instCrc: number;
	/** Length-prefixed node name ("unnamed" in samples). */
	nodeName: string;
	/** The material-combo CRC string this node binds to, e.g. "0x0882fbc1". */
	comboCrc: string;
	/** Override constant names recovered after the combo CRC (values are Partial). */
	overrideNames: string[];
};

export type ParsedShaderInst = {
	version: number;
	/** node_count from the INSS chunk header (== instance record count). */
	nodeCount: number;
	nodes: ShaderInstNode[];
	/** True if the file's last 4 bytes are the "INSE" terminator. */
	hasEndTag: boolean;
	/** True if every declared node was walked without overrun. */
	fullyParsed: boolean;
	byteLength: number;
};

function checkMagic(raw: Uint8Array): void {
	if (raw.byteLength < 0x10) {
		throw new Error(`shaderinst: too small (${raw.byteLength} bytes, need >= 16)`);
	}
	for (let i = 0; i < 4; i++) {
		if (raw[i] !== SHADERINST_MAGIC[i]) {
			const got = [...raw.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
			throw new Error(`shaderinst: bad magic ${got} (expected 53 44 52 49 "SDRI")`);
		}
	}
}

function readLenString(r: BinReader): string {
	const len = r.readU32();
	if (len > 0x1000 || r.position + len > r.length) {
		throw new Error(`shaderinst: implausible string length ${len} at 0x${r.position.toString(16)}`);
	}
	const bytes = r.readBytes(len);
	let end = bytes.indexOf(0);
	if (end < 0) end = bytes.length;
	return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

/** Read a length-prefixed string at `off`, or null if it isn't a plausible one. */
function lenStringAt(
	raw: Uint8Array,
	off: number,
	maxLen = 64,
): { str: string; next: number } | null {
	if (off + 4 > raw.byteLength) return null;
	const len =
		((raw[off] << 24) | (raw[off + 1] << 16) | (raw[off + 2] << 8) | raw[off + 3]) >>> 0;
	if (len < 1 || len > maxLen || off + 4 + len > raw.byteLength) return null;
	const ns = off + 4;
	for (let k = 0; k < len - 1; k++) {
		const c = raw[ns + k];
		if (c < 0x20 || c > 0x7e) return null;
	}
	if (raw[ns + len - 1] !== 0x00) return null;
	return { str: new TextDecoder('latin1').decode(raw.subarray(ns, ns + len - 1)), next: ns + len };
}

/**
 * Resync to the next instance record start. A node record is a 32-bit inst_crc
 * followed by a length-prefixed node name, then a length-prefixed combo CRC of
 * the form "0x........". That name+CRC signature uniquely distinguishes a node
 * boundary from the override parameter names that follow it (which are NOT
 * followed by a "0x…" string). Returns the inst_crc offset, or -1 at EOF/INSE.
 */
function findNextRecord(raw: Uint8Array, from: number): number {
	const limit = raw.byteLength - 4;
	for (let off = from; off <= limit; off++) {
		if (
			raw[off] === 0x49 && raw[off + 1] === 0x4e &&
			raw[off + 2] === 0x53 && raw[off + 3] === 0x45 // "INSE"
		) {
			return -1;
		}
		if (off < 4) continue; // need room for the preceding inst_crc word
		const nameRec = lenStringAt(raw, off, 64);
		if (!nameRec || nameRec.str.length === 0) continue;
		const crcRec = lenStringAt(raw, nameRec.next, 32);
		if (!crcRec || !/^0x[0-9a-fA-F]+$/.test(crcRec.str)) continue;
		return off - 4; // back up to the inst_crc word
	}
	return -1;
}

/** Collect length-prefixed printable names within [start,end). */
function collectNames(raw: Uint8Array, start: number, end: number): string[] {
	const names: string[] = [];
	let off = start;
	while (off + 4 <= end) {
		const len =
			(raw[off] << 24) | (raw[off + 1] << 16) | (raw[off + 2] << 8) | raw[off + 3];
		if (len >= 2 && len <= 128 && off + 4 + len <= end) {
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

export function parseShaderInst(raw: Uint8Array): ParsedShaderInst {
	checkMagic(raw);
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);

	r.skip(4); // "SDRI"
	const version = r.readU32();
	const blk = r.readU32();
	if (blk !== INSS) {
		throw new Error(`shaderinst: expected "INSS" at 0x08, got 0x${blk.toString(16)}`);
	}
	const nodeCount = r.readU32();

	const hasEndTag =
		raw.byteLength >= 4 &&
		new DataView(raw.buffer, raw.byteOffset + raw.byteLength - 4, 4).getUint32(0, false) === INSE;

	const nodes: ShaderInstNode[] = [];
	let fullyParsed = true;
	let cursor = r.position; // 0x10

	for (let i = 0; i < nodeCount; i++) {
		// Each record starts with inst_crc then a node-name length-prefixed string.
		const recStart = findNextRecord(raw, cursor);
		if (recStart < 0) { fullyParsed = false; break; }
		r.seek(recStart);
		const instCrc = r.readU32();
		let nodeName: string;
		let comboCrc: string;
		try {
			nodeName = readLenString(r);
			comboCrc = readLenString(r);
		} catch {
			fullyParsed = false;
			break;
		}
		// Override block runs until the next record's inst_crc (or the INSE tag).
		const nextStart = findNextRecord(raw, r.position);
		const blockEnd = nextStart < 0 ? raw.byteLength - 4 : nextStart;
		const overrideNames = collectNames(raw, r.position, blockEnd);
		nodes.push({ instCrc, nodeName, comboCrc, overrideNames });
		cursor = nextStart < 0 ? raw.byteLength : nextStart;
	}

	return {
		version,
		nodeCount,
		nodes,
		hasEndTag,
		fullyParsed: fullyParsed && nodes.length === nodeCount,
		byteLength: raw.byteLength,
	};
}
