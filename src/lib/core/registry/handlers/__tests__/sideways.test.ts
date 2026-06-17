import { describe, expect, it } from 'vitest';
import { sidewaysHandler } from '../sideways';
import { parseSideways, writeSideways } from '../../../sideways';
import { ssCtx } from '../../handler';
import {
	hasSample,
	readSample,
	listSamplesByExt,
	readFileBytes,
} from '@/test/dataRoot';

// Inline fixture mirroring the wiki Downtown route-A head: 7 links, links 0-5
// empty (count 0), link 6 has count=2 → (244, 231).
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x07, // linkCount = 7
	0x00,                   // link[0] count 0
	0x00,                   // link[1] count 0
	0x00,                   // link[2] count 0
	0x00,                   // link[3] count 0
	0x00,                   // link[4] count 0
	0x00,                   // link[5] count 0
	0x02, 0x00, 0xf4, 0x00, 0xe7, // link[6] count 2 → 0x00f4=244, 0x00e7=231
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.sideways';

describe('sideways parser', () => {
	it('parses BE count + variable per-link records (inline fixture)', () => {
		const m = parseSideways(INLINE_BYTES);
		expect(m.linkCount).toBe(7);
		expect(m.links.length).toBe(7);
		for (let i = 0; i < 6; i++) expect(m.links[i].count).toBe(0);
		expect(m.links[6].count).toBe(2);
		expect(m.links[6].linkIndices).toEqual([244, 231]);
	});

	it('round-trips byte-exact (inline fixture)', () => {
		const out = writeSideways(parseSideways(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('throws when record framing overruns the buffer', () => {
		// linkCount 1 but the single record claims 3 uint16 it cannot supply.
		const bad = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x03, 0x00, 0x01]);
		expect(() => parseSideways(bad)).toThrow();
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips the REAL Downtown route-A .sideways',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = sidewaysHandler.parseRaw(raw, ssCtx());
			// Wiki: 283 links, file 833 bytes, link[6] -> (244, 231).
			expect(raw.byteLength).toBe(833);
			expect(m.linkCount).toBe(283);
			expect(m.links.length).toBe(283);
			expect(m.links[0].count).toBe(0);
			expect(m.links[6].linkIndices).toEqual([244, 231]);
			const out = sidewaysHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	const ALL = listSamplesByExt('.sideways');
	it.skipIf(ALL.length === 0)(
		`sideways round-trips real sample byte-for-byte (${ALL.length} files)`,
		() => {
			const ctx = ssCtx();
			const failures: string[] = [];
			for (const abs of ALL) {
				const raw = readFileBytes(abs);
				const out = sidewaysHandler.writeRaw!(sidewaysHandler.parseRaw(raw, ctx), ctx);
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
