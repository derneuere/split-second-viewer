// .logicinfo parser/writer — Split/Second Catnip track-logic metadata.
//
// Ported faithfully from the (tested) custom python parser + wiki/format-logicinfo.html.
// Big-endian (PS3). A fixed 288-byte (0x120) struct: a 12-byte header, a
// 0x54-byte body of interleaved constant field-name CRCs and five per-track
// float fields, a 188-byte zero-fill region, and a 4-byte sentinel footer.
//
//   Header (12 bytes):
//     uint16[2] version    = (3, 0)         @ 0x00  (00 03 00 00)
//     uint32    magic      = 0xCDAB0DF0     @ 0x04
//     uint32    payloadLen = 0x114 (= size - 12) @ 0x08
//
//   Body: (field-name-hash, value) interleave — five named float fields. The
//   five per-track floats sit at 0x34, 0x3C, 0x44, 0x4C, 0x54 (val0..val4);
//   note val3 == val0 in every shipped file, so only four are distinct.
//
//   Footer: uint32 0xBADCADDE @ 0x11C.
//
// Because almost the whole record is constant and the chunk-internal CRC layout
// is only partially understood, the faithful round-trip is achieved by keeping
// the full 288 raw bytes and surfacing the decoded fields on top. The writer is
// therefore byte-exact (it re-emits the preserved bytes, patching the five
// per-track floats). Marked PARTIAL: only the five floats + header/footer are
// interpreted; the interleaved CRC words are kept verbatim.
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

export const LOGICINFO_SIZE = 0x120; // 288
export const LOGICINFO_MAGIC = 0xcdab0df0;
export const LOGICINFO_FOOTER = 0xbadcadde;

/** Byte offsets of the five per-track float fields. */
export const VAL_OFFSETS = [0x34, 0x3c, 0x44, 0x4c, 0x54] as const;

export type ParsedLogicInfo = {
	versionMajor: number;
	versionMinor: number;
	magic: number;
	payloadLen: number;
	footer: number;
	/** The five per-track floats (val0..val4); val3 == val0 in shipped data. */
	vals: number[];
	/** True when the size, magic, payloadLen and footer all match the spec. */
	headerOk: boolean;
	/** Whole 288-byte file kept verbatim for byte-exact round-trip. */
	raw: number[];
};

export function parseLogicInfo(raw: Uint8Array): ParsedLogicInfo {
	if (raw.byteLength !== LOGICINFO_SIZE) {
		throw new Error(
			`logicinfo: expected ${LOGICINFO_SIZE} bytes, got ${raw.byteLength}`,
		);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const versionMajor = r.readU16();
	const versionMinor = r.readU16();
	const magic = r.readU32();
	const payloadLen = r.readU32();
	const vals = VAL_OFFSETS.map((off) => {
		r.seek(off);
		return r.readF32();
	});
	r.seek(0x11c);
	const footer = r.readU32();

	const headerOk =
		magic === LOGICINFO_MAGIC &&
		footer === LOGICINFO_FOOTER &&
		payloadLen === LOGICINFO_SIZE - 12;

	return {
		versionMajor,
		versionMinor,
		magic,
		payloadLen,
		footer,
		vals,
		headerOk,
		raw: Array.from(raw),
	};
}

export function writeLogicInfo(model: ParsedLogicInfo): Uint8Array {
	// Re-emit the preserved bytes verbatim, then patch the five per-track floats
	// so edits to `vals` survive a round-trip while the (partially-decoded) CRC
	// interleave and zero-fill stay byte-identical.
	const w = new BinWriter(LOGICINFO_SIZE, false /* big-endian */);
	w.writeBytes(Uint8Array.from(model.raw));
	for (let i = 0; i < VAL_OFFSETS.length; i++) {
		w.seek(VAL_OFFSETS[i]);
		w.writeF32(model.vals[i]);
	}
	w.seek(LOGICINFO_SIZE);
	return w.bytes.slice();
}
