// .timelineInfo parser/writer — Split/Second Catnip timeline-particle index.
//
// Ported faithfully from the (tested) custom python parser + wiki/format-timeline.html.
// Big-endian (PS3). An 8-byte header followed by `count` fixed 12-byte records.
// It maps timeline-particle events to slots in the sibling .emitterControllers
// file via a 64-bit name hash + a sequential index.
//
//   Header (8 bytes):
//     uint32 version  (always 1)
//     uint32 count
//
//   Record (12 bytes):
//     uint64 controllerHash   (64-bit name hash, big-endian)
//     uint32 index            (0..count-1, strictly increasing)
//
//   Size law: filesize == 8 + count * 12 (verified across all 88 files).
//
// The 64-bit hash is exposed as a hex string AND as a bigint so the model stays
// JSON-serializable while preserving the exact value.
//
// Pure module: imports ONLY the binary helpers, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

export const HEADER_SIZE = 8;
export const RECORD_SIZE = 12;

export type TimelineRecord = {
	/** 64-bit controller name hash as a 0x-prefixed 16-hex-digit string. */
	controllerHash: string;
	index: number;
};

export type ParsedTimelineInfo = {
	version: number;
	count: number;
	records: TimelineRecord[];
	/** True when filesize == 8 + count * 12 (the documented size law). */
	sizeLawOk: boolean;
};

function u64ToHex(v: bigint): string {
	return '0x' + (v & 0xffffffffffffffffn).toString(16).padStart(16, '0');
}

export function parseTimelineInfo(raw: Uint8Array): ParsedTimelineInfo {
	if (raw.byteLength < HEADER_SIZE) {
		throw new Error(`timelineInfo: ${raw.byteLength} bytes is smaller than the 8-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const version = r.readU32();
	const count = r.readU32();
	const expected = HEADER_SIZE + count * RECORD_SIZE;
	const sizeLawOk = expected === raw.byteLength;
	if (raw.byteLength < expected) {
		throw new Error(
			`timelineInfo: count ${count} needs ${expected} bytes but file is ${raw.byteLength}`,
		);
	}
	const records: TimelineRecord[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const hash = r.readU64();
		const index = r.readU32();
		records[i] = { controllerHash: u64ToHex(hash), index };
	}
	return { version, count, records, sizeLawOk };
}

export function writeTimelineInfo(model: ParsedTimelineInfo): Uint8Array {
	const total = HEADER_SIZE + model.records.length * RECORD_SIZE;
	const w = new BinWriter(total, false /* big-endian */);
	w.writeU32(model.version >>> 0);
	w.writeU32(model.records.length >>> 0);
	for (const rec of model.records) {
		w.writeU64(BigInt(rec.controllerHash) & 0xffffffffffffffffn);
		w.writeU32(rec.index >>> 0);
	}
	return w.bytes.slice();
}
