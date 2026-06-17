// .track parser/writer — Split/Second TrackTivity telemetry / driving path.
//
// Ported faithfully from _tools/parse_track.py (and the Kaitai .ksy twin), per
// wiki/format-track.html. The on-disk layout is, big-endian (PS3 PowerPC):
//
//   uint32  recordCount
//   recordCount × TrackSegment { float32 start.x,start.y,start.z, end.x,end.y,end.z }  (24 bytes)
//
// Size law: filesize == 4 + recordCount * 24, with no footer and no padding.
// Each record is a directed line segment (A→B); within a continuous "stroke"
// the end of record N equals the start of record N+1, so a reader can recover
// polyline strokes by splitting whenever record[i].start != record[i-1].end.
//
// Pure module: imports ONLY the binary helpers, never the registry (acyclic).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** A single 24-byte directed segment: two world-space XYZ points. */
export type TrackSegment = {
	start: [number, number, number];
	end: [number, number, number];
};

export type ParsedTrack = {
	recordCount: number;
	records: TrackSegment[];
	/** True when filesize == 4 + recordCount * 24 (the documented size law). */
	sizeLawOk: boolean;
};

const RECORD_SIZE = 24;

export function parseTrack(raw: Uint8Array): ParsedTrack {
	if (raw.byteLength < 4) {
		throw new Error(`track: ${raw.byteLength} bytes is too small for a 4-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const recordCount = r.readU32();
	const expected = 4 + recordCount * RECORD_SIZE;
	const sizeLawOk = expected === raw.byteLength;
	if (raw.byteLength < expected) {
		throw new Error(
			`track: recordCount ${recordCount} needs ${expected} bytes but file is ${raw.byteLength}`,
		);
	}
	const records: TrackSegment[] = new Array(recordCount);
	for (let i = 0; i < recordCount; i++) {
		const sx = r.readF32();
		const sy = r.readF32();
		const sz = r.readF32();
		const ex = r.readF32();
		const ey = r.readF32();
		const ez = r.readF32();
		records[i] = { start: [sx, sy, sz], end: [ex, ey, ez] };
	}
	return { recordCount, records, sizeLawOk };
}

export function writeTrack(model: ParsedTrack): Uint8Array {
	const w = new BinWriter(4 + model.records.length * RECORD_SIZE, false /* big-endian */);
	w.writeU32(model.records.length >>> 0);
	for (const seg of model.records) {
		w.writeF32(seg.start[0]);
		w.writeF32(seg.start[1]);
		w.writeF32(seg.start[2]);
		w.writeF32(seg.end[0]);
		w.writeF32(seg.end[1]);
		w.writeF32(seg.end[2]);
	}
	return w.bytes.slice();
}

/**
 * Split the flat segment array into polyline strokes: a new stroke begins
 * whenever record[i].start != record[i-1].end ("pen-up" jumps). Each stroke is
 * a list of points (vertices), suitable for drawing as a connected line.
 */
export function trackStrokes(model: ParsedTrack): [number, number, number][][] {
	const strokes: [number, number, number][][] = [];
	let prevEnd: [number, number, number] | null = null;
	let current: [number, number, number][] | null = null;
	for (const seg of model.records) {
		const chains =
			prevEnd !== null &&
			seg.start[0] === prevEnd[0] &&
			seg.start[1] === prevEnd[1] &&
			seg.start[2] === prevEnd[2];
		if (!chains) {
			current = [seg.start.slice() as [number, number, number]];
			strokes.push(current);
		}
		current!.push(seg.end.slice() as [number, number, number]);
		prevEnd = seg.end;
	}
	return strokes;
}
