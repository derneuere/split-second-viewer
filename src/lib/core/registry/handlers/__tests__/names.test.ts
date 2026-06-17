import { describe, expect, it } from 'vitest';
import { namesHandler } from '../names';
import { parseNames, writeNames } from '../../../names';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: the real Downtown LightRigNames.names — '3' 0x00 then
// midday\0 sunrise\0 sunset\0.
const INLINE_BYTES = new Uint8Array([
	0x33, 0x00, // '3' + separator
	0x6d, 0x69, 0x64, 0x64, 0x61, 0x79, 0x00, // "midday"
	0x73, 0x75, 0x6e, 0x72, 0x69, 0x73, 0x65, 0x00, // "sunrise"
	0x73, 0x75, 0x6e, 0x73, 0x65, 0x74, 0x00, // "sunset"
]);

const REAL_FIXTURE = 'Environments/Levels/Downtown/LightRigs/LightRigNames.names';

describe('names parser', () => {
	it('parses count digit + NUL list (inline fixture)', () => {
		const m = parseNames(INLINE_BYTES);
		expect(m.count).toBe(3);
		expect(m.names).toEqual(['midday', 'sunrise', 'sunset']);
	});

	it('round-trips byte-exact (inline fixture)', () => {
		const out = writeNames(parseNames(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects a non-digit leading byte', () => {
		expect(() => parseNames(new Uint8Array([0x41, 0x00, 0x78, 0x00]))).toThrow(/count digit/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips the REAL Downtown LightRigNames.names',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = namesHandler.parseRaw(raw, ssCtx());
			expect(m.count).toBe(3);
			expect(m.names).toEqual(['midday', 'sunrise', 'sunset']);
			// count digit matches entry count.
			expect(m.names.length).toBe(m.count);
			const out = namesHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);
});
