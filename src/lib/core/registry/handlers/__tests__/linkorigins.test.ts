import { describe, expect, it } from 'vitest';
import { linkOriginsHandler } from '../linkorigins';
import { parseLinkOrigins, writeLinkOrigins } from '../../../linkorigins';
import { ssCtx } from '../../handler';
import {
	hasSample,
	readSample,
	listSamplesByExt,
	readFileBytes,
} from '@/test/dataRoot';

// Inline fixture: count=3, then 189.43, 221.19, 239.18 (Downtown route-A head).
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x03, // linkCount = 3
	0x43, 0x3d, 0x6c, 0xed, // 189.4255
	0x43, 0x5d, 0x30, 0x42, // 221.1885
	0x43, 0x6f, 0x2c, 0xf5, // 239.1756
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.linkorigins';

describe('linkorigins parser', () => {
	it('parses BE uint32 count + float32[] (inline fixture)', () => {
		const m = parseLinkOrigins(INLINE_BYTES);
		expect(m.linkCount).toBe(3);
		expect(m.origins.length).toBe(3);
		expect(m.origins[0]).toBeCloseTo(189.43, 1);
		expect(m.origins[1]).toBeCloseTo(221.19, 1);
		expect(m.origins[2]).toBeCloseTo(239.18, 1);
	});

	it('round-trips byte-exact (inline fixture)', () => {
		const out = writeLinkOrigins(parseLinkOrigins(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects a size-law violation', () => {
		const bad = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x43, 0x3d, 0x6c, 0xed]);
		expect(() => parseLinkOrigins(bad)).toThrow(/size/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips the REAL Downtown route-A .linkorigins',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = linkOriginsHandler.parseRaw(raw, ssCtx());
			// Wiki: Downtown A = 283 links, 1136 bytes (4 + 283*4).
			expect(raw.byteLength).toBe(1136);
			expect(m.linkCount).toBe(283);
			expect(m.origins.length).toBe(283);
			expect(m.origins[0]).toBeCloseTo(189.43, 1);
			// origins rise roughly monotonically.
			expect(m.origins.at(-1)!).toBeGreaterThan(m.origins[0]);
			const out = linkOriginsHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	const ALL = listSamplesByExt('.linkorigins');
	it.skipIf(ALL.length === 0)(
		`linkorigins round-trips real sample byte-for-byte (${ALL.length} files)`,
		() => {
			const ctx = ssCtx();
			const failures: string[] = [];
			for (const abs of ALL) {
				const raw = readFileBytes(abs);
				const out = linkOriginsHandler.writeRaw!(linkOriginsHandler.parseRaw(raw, ctx), ctx);
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
