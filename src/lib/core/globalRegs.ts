// .global_regs parser — Black Rock's global shader-register table.
//
// Big-endian (PS3). Chunked layout, verified against default.global_regs:
//
//   off 0x00  'FREG'                       FourCC magic
//   off 0x04  u32 version            = 1
//   off 0x08  'GLBB'                       sub-chunk magic ("global block")
//   off 0x0C  u32 recordCount        = 0x200 (512) — matches the parsed count
//   off 0x10  u32 field2             = 0x5DC (1500) — register-storage size hint
//   off 0x14  record[recordCount]          the register descriptor table
//
// Each record:
//   u32 nameLen                            = strlen + 1 (includes the NUL)
//   char name[]                            NUL-terminated, then NUL-padded so the
//                                          following separator lands correctly
//   u32 separator         = 0xFFFFFFFF     a reliable sentinel between fields
//   u32 type                               register type/slot code (1,2,3,4,8,…)
//
// The name padding is NOT a clean pad-to-4 (e.g. a 14-char name occupies an
// 18-byte region), so the parser advances past the trailing NULs to the
// 0xFFFFFFFF sentinel rather than guessing a stride — this parses all 512
// records exactly and lands on the record count from the GLBB header.
//
// After the descriptor table comes a large register-value/storage payload
// (~43 KB in default.global_regs) that is NOT yet decoded; we expose its
// byte offset/length and mark the format PARTIAL on that payload.
//
// Pure module: imports only the binary helpers, NEVER the registry.

import { BinReader } from './binary/BinReader';

const FREG = 0x46524547; // 'FREG'
const GLBB = 0x474c4242; // 'GLBB'
const SENTINEL = 0xffffffff;

export type GlobalReg = {
	/** Register name, e.g. 'light_ambient', 'WorldCameraPos'. */
	name: string;
	/** Type/slot code that follows the 0xFFFFFFFF sentinel. */
	type: number;
};

export type ParsedGlobalRegs = {
	version: number;
	/** Record count from the GLBB header (== regs.length when consistent). */
	recordCount: number;
	/** Second GLBB header word (register-storage size hint, 0x5DC observed). */
	storageHint: number;
	regs: GlobalReg[];
	/** Absolute byte offset where the undecoded register-value payload begins. */
	payloadOffset: number;
	/** Length of the undecoded trailing payload in bytes. */
	payloadLength: number;
	/** True if the descriptor table consumed exactly recordCount records. */
	tableConsistent: boolean;
};

export function parseGlobalRegs(raw: Uint8Array): ParsedGlobalRegs {
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	if (raw.byteLength < 0x14) throw new Error('global_regs: too small for FREG/GLBB header');
	const freg = r.readU32();
	if (freg !== FREG) {
		throw new Error(`global_regs: bad magic 0x${freg.toString(16)} (expected 'FREG')`);
	}
	const version = r.readU32();
	const glbb = r.readU32();
	if (glbb !== GLBB) {
		throw new Error(`global_regs: bad sub-chunk 0x${glbb.toString(16)} (expected 'GLBB')`);
	}
	const recordCount = r.readU32();
	const storageHint = r.readU32();

	const regs: GlobalReg[] = [];
	const total = raw.byteLength;
	let consistent = true;

	for (let idx = 0; idx < recordCount; idx++) {
		if (r.position + 4 > total) {
			consistent = false;
			break;
		}
		const nameLen = r.readU32();
		if (nameLen < 1 || nameLen > 256 || r.position + nameLen > total) {
			consistent = false;
			break;
		}
		const nameStart = r.position;
		// Read the C-string (stops at the first NUL).
		let end = nameStart;
		while (end < total && raw[end] !== 0) end++;
		const name = new TextDecoder('latin1').decode(raw.subarray(nameStart, end));
		// Advance past NUL padding to the 0xFFFFFFFF sentinel.
		let sep = end;
		while (sep + 4 <= total && (readU32BE(raw, sep) >>> 0) !== SENTINEL) sep++;
		if (sep + 8 > total) {
			consistent = false;
			break;
		}
		const type = readU32BE(raw, sep + 4) >>> 0;
		regs.push({ name, type });
		r.seek(sep + 8);
	}

	if (regs.length !== recordCount) consistent = false;

	return {
		version,
		recordCount,
		storageHint,
		regs,
		payloadOffset: r.position,
		payloadLength: Math.max(0, total - r.position),
		tableConsistent: consistent,
	};
}

function readU32BE(buf: Uint8Array, off: number): number {
	return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}
