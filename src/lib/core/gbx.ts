// .gbx parser/writer — Split/Second per-light-rig override / extras table.
//
// NOT the Nadeo/TrackMania "GameBox" format (those start with an ASCII 'GBX'
// magic). This is Black Rock's big-endian light-rig override table that sits
// under LightRigs/<preset>/<preset>.gbx. Ported faithfully from the tested
// parse_gbx.py + gbx_floats.py and wiki/format-nis.html (.gbx section).
//
// Big-endian (PS3):
//   uint32 recordCount
//   recordCount × record {
//     uint32 typeHash
//     uint32 typeLen ; char[typeLen] typeName     ("Ambient Light" | "Prop Draw Distance")
//     uint32 nameHash
//     uint32 nameLen ; char[nameLen] instanceName
//     float32 values[FLOATS_PER_RECORD]
//   }
//
// Empirically every record type carries exactly 12 big-endian float32 (a 3×3
// basis matrix row-major + a 3-float position vector for "Ambient Light";
// "Prop Draw Distance" reuses the same 12-float stride). Verified to consume
// the populated files (Downtown/sunset 212 B / 2 recs, Graveyard/midday 491 B /
// 5 recs) to exactly EOF with zero leftover bytes. 13 of 18 files are 4-byte
// empty stubs (recordCount == 0).
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** Fixed number of trailing big-endian float32 per record (verified). */
export const FLOATS_PER_RECORD = 12;

export type GbxRecord = {
	typeHash: number;
	typeName: string;
	nameHash: number;
	instanceName: string;
	/** 12 big-endian float32: 3×3 basis (row-major) + 3-float position. */
	values: number[];
};

export type ParsedGbx = {
	recordCount: number;
	records: GbxRecord[];
	/** Bytes consumed; equals raw.byteLength on a clean file. */
	bytesConsumed: number;
};

export function parseGbx(raw: Uint8Array): ParsedGbx {
	if (raw.byteLength < 4) {
		throw new Error(`gbx: ${raw.byteLength} bytes is too small for the 4-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const recordCount = r.readU32();
	const records: GbxRecord[] = new Array(recordCount);
	for (let i = 0; i < recordCount; i++) {
		const typeHash = r.readU32();
		const typeLen = r.readU32();
		const typeName = r.readFixedString(typeLen);
		const nameHash = r.readU32();
		const nameLen = r.readU32();
		const instanceName = r.readFixedString(nameLen);
		const values: number[] = new Array(FLOATS_PER_RECORD);
		for (let f = 0; f < FLOATS_PER_RECORD; f++) values[f] = r.readF32();
		records[i] = { typeHash, typeName, nameHash, instanceName, values };
	}
	return { recordCount, records, bytesConsumed: r.position };
}

export function writeGbx(model: ParsedGbx): Uint8Array {
	const w = new BinWriter(256, false /* big-endian */);
	w.writeU32(model.records.length >>> 0);
	for (const rec of model.records) {
		w.writeU32(rec.typeHash >>> 0);
		const typeBytes = latin1(rec.typeName);
		w.writeU32(typeBytes.length >>> 0);
		w.writeBytes(typeBytes);
		w.writeU32(rec.nameHash >>> 0);
		const nameBytes = latin1(rec.instanceName);
		w.writeU32(nameBytes.length >>> 0);
		w.writeBytes(nameBytes);
		// Pad/truncate the value list to the fixed stride so the writer is total.
		for (let f = 0; f < FLOATS_PER_RECORD; f++) w.writeF32(rec.values[f] ?? 0);
	}
	return w.bytes.slice();
}

/** Encode an ASCII/latin1 string to raw bytes (the strings here are pure ASCII). */
function latin1(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
	return out;
}
