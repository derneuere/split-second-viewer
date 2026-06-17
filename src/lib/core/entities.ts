// .entities parser/writer — Split/Second Catnip entity-instance table.
//
// Ported faithfully from the (tested) custom python parser + wiki/format-entities.html.
// Big-endian (PS3). A 32-byte ENTS header followed by `count` fixed 97-byte
// records (no offset table, no string pool, no trailing data):
//
//   Header (32 bytes):
//     char[4]  magic    = "ENTS" (45 4E 54 53)
//     uint32   reserved0 (always 0)
//     uint32   version  (3 in this build)
//     uint32   count
//     byte[16] reserved (pad to 0x20, always 0)
//
//   Record (97 bytes):
//     char[33]      name      (NUL-terminated, NUL-padded; field width 0x21)
//     float32[3]    position  (world X,Y,Z)        @ +0x21
//     float32[3]    scale     (per-axis)           @ +0x2D
//     float32[9]    rotation  (row-major 3×3 basis)@ +0x39
//     float32       index     (spawn index 1.0..8.0) @ +0x5D
//
//   Size law: filesize == 0x20 + count * 97  (e.g. 32 + 8*97 = 808).
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

export const ENTITIES_MAGIC = 'ENTS';
/** Magic bytes (big-endian as stored) for .ark member sniffing. */
export const ENTITIES_MAGIC_BYTES = new Uint8Array([0x45, 0x4e, 0x54, 0x53]);

export const HEADER_SIZE = 0x20; // 32
export const RECORD_SIZE = 97; // 0x61
export const NAME_FIELD_WIDTH = 33; // 0x21

export type EntityRecord = {
	/** Trimmed display name (NUL-terminated portion of the 33-byte field). */
	name: string;
	/**
	 * The full 33-byte name field kept verbatim. The shipped files do NOT
	 * zero-pad the field cleanly: e.g. "Entity_StartPosition_Player1" (28 chars)
	 * is followed by NUL,NUL,NUL,NUL then a stray 0x40 at +0x20 (the byte just
	 * before position.x at +0x21). Re-emitting from `name` alone would zero that
	 * byte, so the writer replays these raw bytes to stay byte-exact.
	 */
	nameRaw: number[];
	position: [number, number, number];
	scale: [number, number, number];
	/** Row-major 3×3 basis matrix, flattened (9 floats). */
	rotation: number[];
	index: number;
};

export type ParsedEntities = {
	magic: string;
	reserved0: number;
	version: number;
	count: number;
	records: EntityRecord[];
	/** True when filesize == 32 + count * 97 (the documented size law). */
	sizeLawOk: boolean;
};

export function parseEntities(raw: Uint8Array): ParsedEntities {
	if (raw.byteLength < HEADER_SIZE) {
		throw new Error(`entities: ${raw.byteLength} bytes is smaller than the 32-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const magic = r.readFixedString(4);
	if (magic !== ENTITIES_MAGIC) {
		throw new Error(`entities: bad magic "${magic}" (expected "ENTS")`);
	}
	const reserved0 = r.readU32();
	const version = r.readU32();
	const count = r.readU32();
	r.skip(16); // reserved pad to 0x20

	const expected = HEADER_SIZE + count * RECORD_SIZE;
	const sizeLawOk = expected === raw.byteLength;
	if (raw.byteLength < expected) {
		throw new Error(
			`entities: count ${count} needs ${expected} bytes but file is ${raw.byteLength}`,
		);
	}

	const records: EntityRecord[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const recStart = HEADER_SIZE + i * RECORD_SIZE;
		r.seek(recStart);
		const nameBytes = r.readBytes(NAME_FIELD_WIDTH);
		const nul = nameBytes.indexOf(0);
		const name = new TextDecoder('latin1').decode(
			nameBytes.subarray(0, nul >= 0 ? nul : NAME_FIELD_WIDTH),
		);
		// floats begin at record +0x21 (after the 33-byte name field)
		const position: [number, number, number] = [r.readF32(), r.readF32(), r.readF32()];
		const scale: [number, number, number] = [r.readF32(), r.readF32(), r.readF32()];
		const rotation: number[] = new Array(9);
		for (let k = 0; k < 9; k++) rotation[k] = r.readF32();
		const index = r.readF32();
		records[i] = { name, nameRaw: Array.from(nameBytes), position, scale, rotation, index };
	}
	return { magic, reserved0, version, count, records, sizeLawOk };
}

export function writeEntities(model: ParsedEntities): Uint8Array {
	const total = HEADER_SIZE + model.records.length * RECORD_SIZE;
	const w = new BinWriter(total, false /* big-endian */);
	w.writeFixedString(ENTITIES_MAGIC, 4);
	w.writeU32(model.reserved0 >>> 0);
	w.writeU32(model.version >>> 0);
	w.writeU32(model.records.length >>> 0);
	w.writeZeroes(16);
	for (const rec of model.records) {
		// Replay the verbatim 33-byte name field when we have it (preserves the
		// non-zero pad bytes the exporter leaves behind); otherwise synthesize a
		// NUL-padded field from the display name (for constructed models).
		if (rec.nameRaw && rec.nameRaw.length === NAME_FIELD_WIDTH) {
			w.writeBytes(Uint8Array.from(rec.nameRaw));
		} else {
			w.writeFixedString(rec.name, NAME_FIELD_WIDTH);
		}
		w.writeF32(rec.position[0]);
		w.writeF32(rec.position[1]);
		w.writeF32(rec.position[2]);
		w.writeF32(rec.scale[0]);
		w.writeF32(rec.scale[1]);
		w.writeF32(rec.scale[2]);
		for (let k = 0; k < 9; k++) w.writeF32(rec.rotation[k] ?? 0);
		w.writeF32(rec.index);
	}
	return w.bytes.slice();
}
