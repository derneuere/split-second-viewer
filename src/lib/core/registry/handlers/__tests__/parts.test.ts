import { describe, expect, it } from 'vitest';
import { partsHandler } from '../parts';
import { parseParts } from '../../../parts';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture mirroring the Musclecar_01.parts head: count=5, elementSize=46,
// then a few payload words including the 0xFFFFFFFF marker and a 1.0 float.
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x05, // count = 5
	0x00, 0x00, 0x00, 0x2e, // elementSize = 0x2e = 46
	0x00, 0x00, 0x00, 0x00, // payload[0] = 0
	0xff, 0xff, 0xff, 0xff, // payload[1] = 0xFFFFFFFF marker
	0x3f, 0x80, 0x00, 0x00, // payload[2] = 1.0f
]);

const REAL_FIXTURE = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.parts';

describe('parts parser (partial: header solid, body raw)', () => {
	it('decodes the 8-byte header + payload words (inline fixture)', () => {
		const m = parseParts(INLINE_BYTES);
		expect(m.count).toBe(5);
		expect(m.elementSize).toBe(0x2e);
		expect(m.wordCount).toBe(3);
		expect(m.words).toEqual([0x00000000, 0xffffffff, 0x3f800000]);
		expect(m.wordAligned).toBe(true);
		// the third word reinterpreted as float32 is 1.0.
		expect(m.floats[2]).toBeCloseTo(1.0, 6);
	});

	it('rejects a buffer too small for the header', () => {
		expect(() => parseParts(new Uint8Array([0, 0, 0]))).toThrow(/too small/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses the REAL Musclecar_01.parts header',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = partsHandler.parseRaw(raw, ssCtx());
			// Confirmed header from the hex probe: count=5, elementSize=0x2e, 2328 bytes.
			expect(raw.byteLength).toBe(2328);
			expect(m.count).toBe(5);
			expect(m.elementSize).toBe(0x2e);
			expect(m.wordCount).toBe((2328 - 8) / 4);
			expect(m.wordAligned).toBe(true);
			// the file mixes 0xFFFFFFFF markers and 1.0 (0x3f800000) transform floats.
			expect(m.words).toContain(0xffffffff);
			expect(m.words).toContain(0x3f800000);
		},
	);
});
