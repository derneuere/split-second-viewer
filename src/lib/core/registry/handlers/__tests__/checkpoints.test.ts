import { describe, expect, it } from 'vitest';
import { checkpointsHandler } from '../checkpoints';
import {
	parseCheckpoints,
	CHECKPOINTS_BEGIN_TAG,
	CHECKPOINTS_END_TAG,
	CHECKPOINTS_VERSION,
} from '../../../checkpoints';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: the documented 12-byte header (version 3.0, beginTag
// CDAB0DF0, bodySize=8) followed by an 8-byte body holding one float and one
// closing BADCADDE sentinel.
const INLINE_BYTES = new Uint8Array([
	0x00, 0x03, 0x00, 0x00, // version 0x00030000
	0xcd, 0xab, 0x0d, 0xf0, // beginTag
	0x00, 0x00, 0x00, 0x08, // bodySize = 8
	0x49, 0x39, 0xa9, 0x9a, // body float (760473.6) — first payload word per wiki
	0xba, 0xdc, 0xad, 0xde, // closing end-object sentinel
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.checkpoints';

describe('checkpoints parser', () => {
	it('decodes the documented 12-byte header (inline fixture)', () => {
		const m = parseCheckpoints(INLINE_BYTES);
		expect(m.version).toBe(CHECKPOINTS_VERSION);
		expect(m.beginTag).toBe(CHECKPOINTS_BEGIN_TAG);
		expect(m.bodySize).toBe(8);
		expect(m.headerValid).toBe(true);
		expect(m.body.length).toBe(8);
		expect(m.endSentinelCount).toBe(1);
	});

	it('rejects a body-size mismatch', () => {
		const bad = INLINE_BYTES.slice(0, 16); // drops the sentinel → 4 body bytes < 8
		expect(() => parseCheckpoints(bad)).toThrow(/bodySize/);
	});

	it('flags an invalid header (wrong begin tag)', () => {
		const m = parseCheckpoints(
			new Uint8Array([
				0x00, 0x03, 0x00, 0x00,
				0xde, 0xad, 0xbe, 0xef, // wrong begin tag
				0x00, 0x00, 0x00, 0x04,
				0xba, 0xdc, 0xad, 0xde,
			]),
		);
		expect(m.headerValid).toBe(false);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses the REAL Downtown route-A .checkpoints',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = checkpointsHandler.parseRaw(raw, ssCtx());
			// Wiki: every route is exactly 348 bytes; bodySize 0x150 = 336 = 348-12.
			expect(raw.byteLength).toBe(348);
			expect(m.version).toBe(CHECKPOINTS_VERSION);
			expect(m.beginTag).toBe(CHECKPOINTS_BEGIN_TAG);
			expect(m.bodySize).toBe(0x150);
			expect(m.headerValid).toBe(true);
			expect(m.body.length).toBe(336);
			// File ends with three stacked BADCADDE sentinels.
			expect(m.endSentinelCount).toBeGreaterThanOrEqual(3);
			// Sanity: the last body word is the closing sentinel.
			const tail =
				(m.body[332] << 24) | (m.body[333] << 16) | (m.body[334] << 8) | m.body[335];
			expect(tail >>> 0).toBe(CHECKPOINTS_END_TAG);
		},
	);
});
