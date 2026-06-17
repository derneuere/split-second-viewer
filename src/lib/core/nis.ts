// .nis parser/writer — Split/Second TrackLogic / AITrack route manifest.
//
// Despite the "Non-Interactive Sequence"-sounding extension this is NOT a
// cutscene script: it is the AITrack route table that lives under
// Event/RACING/TrackLogic/<A-D>/Track.nis. Ported faithfully from the
// (tested) parse_nis.py and wiki/format-nis.html. Big-endian (PS3):
//
//   uint8  magic        = 0x69 ('i'), constant across all 18 files
//   uint8  recordCount
//   recordCount × record {
//     uint16 segmentId        (big-endian)
//     char[] zoneCode         (NUL-terminated ASCII)
//     uint8  flag             (0 or 1)
//   }
//
// Empty Nemesis boss tracks ship a 2-byte stub (69 00). The full byte stream is
// consumed with zero leftover bytes (verified on all 18 files in the build).
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

export const NIS_MAGIC = 0x69; // ASCII 'i'

export type NisRecord = {
	segmentId: number;
	zoneCode: string;
	flag: number;
};

export type ParsedNis = {
	magic: number;
	recordCount: number;
	records: NisRecord[];
	/** Bytes consumed by the parse; should equal raw.byteLength on a clean file. */
	bytesConsumed: number;
};

export function parseNis(raw: Uint8Array): ParsedNis {
	if (raw.byteLength < 2) {
		throw new Error(`nis: ${raw.byteLength} bytes is too small for the 2-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const magic = r.readU8();
	if (magic !== NIS_MAGIC) {
		throw new Error(
			`nis: bad magic 0x${magic.toString(16).padStart(2, '0')} (expected 0x69 'i')`,
		);
	}
	const recordCount = r.readU8();
	const records: NisRecord[] = new Array(recordCount);
	for (let i = 0; i < recordCount; i++) {
		const segmentId = r.readU16();
		const zoneCode = r.readCString(); // consumes the NUL terminator
		const flag = r.readU8();
		records[i] = { segmentId, zoneCode, flag };
	}
	return { magic, recordCount, records, bytesConsumed: r.position };
}

export function writeNis(model: ParsedNis): Uint8Array {
	const w = new BinWriter(64, false /* big-endian */);
	w.writeU8(NIS_MAGIC);
	w.writeU8(model.records.length & 0xff);
	for (const rec of model.records) {
		w.writeU16(rec.segmentId >>> 0);
		w.writeCString(rec.zoneCode); // writes bytes + NUL terminator
		w.writeU8(rec.flag & 0xff);
	}
	return w.bytes.slice();
}
