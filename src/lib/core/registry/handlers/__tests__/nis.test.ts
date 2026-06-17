import { describe, expect, it } from 'vitest';
import { nisHandler } from '../nis';
import { parseNis, writeNis } from '../../../nis';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a 2-record .nis modelled on the wiki's Downtown/A hex:
//   magic 'i' (0x69), count=2, then {id, "PA03-1", 1} and {id, "PP08-1", 1}.
const INLINE_BYTES = new Uint8Array([
	0x69, // magic 'i'
	0x02, // record_count = 2
	0x00, 0x01, // segment_id = 1
	0x50, 0x41, 0x30, 0x33, 0x2d, 0x31, 0x00, // "PA03-1\0"
	0x01, // flag = 1
	0x00, 0x02, // segment_id = 2
	0x50, 0x50, 0x30, 0x38, 0x2d, 0x31, 0x00, // "PP08-1\0"
	0x01, // flag = 1
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.nis';

describe('nis parser', () => {
	it('parses magic, count, and id/string/flag records (inline)', () => {
		const m = parseNis(INLINE_BYTES);
		expect(m.magic).toBe(0x69);
		expect(m.recordCount).toBe(2);
		expect(m.records[0]).toEqual({ segmentId: 1, zoneCode: 'PA03-1', flag: 1 });
		expect(m.records[1]).toEqual({ segmentId: 2, zoneCode: 'PP08-1', flag: 1 });
		// clean parse: no leftover bytes
		expect(m.bytesConsumed).toBe(INLINE_BYTES.byteLength);
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeNis(parseNis(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('parses an empty Nemesis stub (69 00)', () => {
		const m = parseNis(new Uint8Array([0x69, 0x00]));
		expect(m.recordCount).toBe(0);
		expect(m.records).toHaveLength(0);
	});

	it('rejects bad magic', () => {
		expect(() => parseNis(new Uint8Array([0x00, 0x00]))).toThrow(/bad magic/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips a REAL Track.nis from the devkit',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = nisHandler.parseRaw(raw, ssCtx());
			expect(m.magic).toBe(0x69);
			expect(m.recordCount).toBe(10); // wiki: Downtown/A = 10 records
			expect(m.bytesConsumed).toBe(raw.byteLength); // zero leftover bytes
			// wiki: record 0 = id 1, "PA03-1", flag 1
			expect(m.records[0]).toEqual({ segmentId: 1, zoneCode: 'PA03-1', flag: 1 });
			// flags are only ever 0 or 1
			for (const r of m.records) expect(r.flag === 0 || r.flag === 1).toBe(true);
			const out = nisHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);
});
