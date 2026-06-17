import { describe, expect, it } from 'vitest';
import { splitLengthHandler } from '../splitlength';
import { parseSplitLength, writeSplitLength } from '../../../splitlength';
import { ssCtx } from '../../handler';
import {
	hasSample,
	readSample,
	listSamplesByExt,
	readFileBytes,
} from '@/test/dataRoot';

// Inline fixture: count=3, then 1.0, 1.0874, 1.0742 (the Downtown route-A head).
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x03, // sectionCount = 3
	0x3f, 0x80, 0x00, 0x00, // 1.0
	0x3f, 0x8b, 0x1a, 0xa1, // 1.0874...
	0x3f, 0x89, 0x80, 0xa8, // 1.0742...
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.splitlength';

describe('splitlength parser', () => {
	it('parses BE uint32 count + float32[] (inline fixture)', () => {
		const m = parseSplitLength(INLINE_BYTES);
		expect(m.sectionCount).toBe(3);
		expect(m.splitLengths.length).toBe(3);
		// 0x3f8b1aa1 = 1.08675 (wiki rounds it to ~1.087); 0x3f8980a8 = 1.07425.
		expect(m.splitLengths[0]).toBeCloseTo(1.0, 5);
		expect(m.splitLengths[1]).toBeCloseTo(1.0868, 3);
		expect(m.splitLengths[2]).toBeCloseTo(1.0742, 3);
	});

	it('round-trips byte-exact (inline fixture)', () => {
		const out = writeSplitLength(parseSplitLength(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects a size-law violation', () => {
		// count says 3 sections (needs 16 bytes) but only 8 bytes present.
		const bad = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x3f, 0x80, 0x00, 0x00]);
		expect(() => parseSplitLength(bad)).toThrow(/size/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips the REAL Downtown route-A .splitlength',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = splitLengthHandler.parseRaw(raw, ssCtx());
			// Wiki: Downtown A = 19 sections, 80 bytes (4 + 19*4).
			expect(raw.byteLength).toBe(80);
			expect(m.sectionCount).toBe(19);
			expect(m.splitLengths.length).toBe(19);
			expect(m.splitLengths[0]).toBeCloseTo(1.0, 5);
			expect(m.splitLengths[1]).toBeCloseTo(1.0868, 3);
			const out = splitLengthHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	const ALL = listSamplesByExt('.splitlength');
	it.skipIf(ALL.length === 0)(
		`splitlength round-trips real sample byte-for-byte (${ALL.length} files)`,
		() => {
			const ctx = ssCtx();
			const failures: string[] = [];
			for (const abs of ALL) {
				const raw = readFileBytes(abs);
				const out = splitLengthHandler.writeRaw!(splitLengthHandler.parseRaw(raw, ctx), ctx);
				if (!bytesEqual(out, raw)) failures.push(`${abs} (len ${out.length} vs ${raw.length})`);
			}
			expect(failures).toEqual([]);
			expect(ALL.length).toBeGreaterThan(1);
		},
	);
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
