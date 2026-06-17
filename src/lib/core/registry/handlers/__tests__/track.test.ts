import { describe, expect, it } from 'vitest';
import { trackHandler } from '../track';
import { parseTrack, writeTrack, trackStrokes } from '../../../track';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: the first 2 records of the wiki's worked example
// TracktivityData_P_PS3-_2010_1_2_19_55_29.track. count=2 then two 24-byte
// segments. Record 0: start=(-197.232,-0.751,-160.0) end=(-197.232,-0.751,-142.683);
// Record 1 starts where record 0 ends (chains). Bytes are big-endian.
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x02, // count = 2
	// record 0
	0xc3, 0x45, 0x3b, 0x6a, // start.x = -197.232
	0xbf, 0x40, 0x26, 0x19, // start.y = -0.751
	0xc3, 0x20, 0x00, 0x00, // start.z = -160.0
	0xc3, 0x45, 0x3b, 0x6a, // end.x   = -197.232
	0xbf, 0x40, 0x26, 0x19, // end.y   = -0.751
	0xc3, 0x0e, 0xae, 0xf6, // end.z   = -142.683
	// record 1 (start == record 0 end → chains)
	0xc3, 0x45, 0x3b, 0x6a,
	0xbf, 0x40, 0x26, 0x19,
	0xc3, 0x0e, 0xae, 0xf6,
	0xc3, 0x44, 0xfc, 0xc4, // end.x  = -196.987
	0xbf, 0x40, 0x26, 0x19,
	0xc3, 0x01, 0xff, 0xff, // end.z  = -129.0
]);

const REAL_FIXTURE = 'TracktivityData_P_PS3-_2010_1_2_19_55_29.track';

describe('track parser', () => {
	it('parses the count and decodes big-endian float32 segments (inline)', () => {
		const m = parseTrack(INLINE_BYTES);
		expect(m.recordCount).toBe(2);
		expect(m.sizeLawOk).toBe(true);
		expect(m.records[0].start[0]).toBeCloseTo(-197.232, 2);
		expect(m.records[0].start[1]).toBeCloseTo(-0.751, 2);
		expect(m.records[0].start[2]).toBeCloseTo(-160.0, 2);
		expect(m.records[0].end[2]).toBeCloseTo(-142.683, 2);
		// chaining: record 1 start == record 0 end
		expect(m.records[1].start).toEqual(m.records[0].end);
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeTrack(parseTrack(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('recovers a single chained stroke', () => {
		const strokes = trackStrokes(parseTrack(INLINE_BYTES));
		expect(strokes).toHaveLength(1);
		// 2 chained segments → 3 points
		expect(strokes[0]).toHaveLength(3);
	});

	it('describe() summarizes count + strokes', () => {
		expect(trackHandler.describe(parseTrack(INLINE_BYTES))).toContain('2 segments');
		expect(trackHandler.describe(parseTrack(INLINE_BYTES))).toContain('1 stroke');
	});

	it('rejects a truncated body', () => {
		const bad = new Uint8Array([0x00, 0x00, 0x00, 0x05, 0x00]); // claims 5 records
		expect(() => parseTrack(bad)).toThrow(/needs/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips a REAL .track from the devkit',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = trackHandler.parseRaw(raw, ssCtx());
			expect(m.recordCount).toBe(67); // wiki: 67 records
			expect(m.sizeLawOk).toBe(true);
			expect(raw.byteLength).toBe(4 + 67 * 24); // 1612
			// record 0 matches the wiki hex breakdown
			expect(m.records[0].start[0]).toBeCloseTo(-197.232, 2);
			expect(m.records[0].start[2]).toBeCloseTo(-160.0, 2);
			expect(m.records[0].end[2]).toBeCloseTo(-142.683, 2);
			// byte-exact round-trip
			const out = trackHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);
});
