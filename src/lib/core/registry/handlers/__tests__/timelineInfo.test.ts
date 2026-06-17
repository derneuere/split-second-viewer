import { describe, expect, it } from 'vitest';
import { timelineInfoHandler } from '../timelineInfo';
import { parseTimelineInfo, writeTimelineInfo } from '../../../timelineInfo';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: the wiki's 44-byte UI/Frontend Light.timelineInfo — version=1,
// count=3, the same controllerHash 0x5C504456A4B1A2DF repeated with indices 0,1,2.
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x01, // version = 1
	0x00, 0x00, 0x00, 0x03, // count = 3
	0x5c, 0x50, 0x44, 0x56, 0xa4, 0xb1, 0xa2, 0xdf, 0x00, 0x00, 0x00, 0x00, // rec0 idx 0
	0x5c, 0x50, 0x44, 0x56, 0xa4, 0xb1, 0xa2, 0xdf, 0x00, 0x00, 0x00, 0x01, // rec1 idx 1
	0x5c, 0x50, 0x44, 0x56, 0xa4, 0xb1, 0xa2, 0xdf, 0x00, 0x00, 0x00, 0x02, // rec2 idx 2
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Subtracks/A/Particles/TimelineParticles/Light/Light.timelineInfo';
const REAL_EMPTY =
	'Environments/Levels/Downtown/Particles/TimelineParticles/Flare/Flare.timelineInfo';

describe('timelineInfo parser', () => {
	it('parses version, count, and u64-hash/index records (inline)', () => {
		const m = parseTimelineInfo(INLINE_BYTES);
		expect(m.version).toBe(1);
		expect(m.count).toBe(3);
		expect(m.sizeLawOk).toBe(true);
		expect(m.records[0].controllerHash).toBe('0x5c504456a4b1a2df');
		expect(m.records[0].index).toBe(0);
		expect(m.records[2].index).toBe(2); // last index == count-1
		// the same hash recurs
		expect(m.records[1].controllerHash).toBe(m.records[0].controllerHash);
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeTimelineInfo(parseTimelineInfo(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('parses an empty 8-byte header-only file', () => {
		const m = parseTimelineInfo(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]));
		expect(m.count).toBe(0);
		expect(m.records).toHaveLength(0);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips a REAL .timelineInfo from the devkit',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = timelineInfoHandler.parseRaw(raw, ssCtx());
			expect(m.version).toBe(1);
			expect(raw.byteLength).toBe(8 + m.count * 12); // size law
			expect(m.sizeLawOk).toBe(true);
			// indices are the exact sequence 0..count-1
			for (let i = 0; i < m.count; i++) expect(m.records[i].index).toBe(i);
			const out = timelineInfoHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	it.skipIf(!hasSample(REAL_EMPTY))('parses the REAL empty Flare.timelineInfo', () => {
		const raw = readSample(REAL_EMPTY);
		const m = timelineInfoHandler.parseRaw(raw, ssCtx());
		expect(m.count).toBe(0);
		expect(raw.byteLength).toBe(8);
	});
});
