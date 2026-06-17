import { describe, expect, it } from 'vitest';
import { entitiesHandler } from '../entities';
import {
	parseEntities,
	writeEntities,
	HEADER_SIZE,
	RECORD_SIZE,
	NAME_FIELD_WIDTH,
} from '../../../entities';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: ENTS v3, count=1, one Entity_StartPosition_Player1 record with
// position (-1512.30, 9.31, 321.57), scale (1,1,1), identity rotation, index 1.0.
function buildInline(): Uint8Array {
	const buf = new ArrayBuffer(HEADER_SIZE + RECORD_SIZE);
	const dv = new DataView(buf);
	const bytes = new Uint8Array(buf);
	let o = 0;
	bytes.set([0x45, 0x4e, 0x54, 0x53], 0); o = 4; // "ENTS"
	dv.setUint32(o, 0); o += 4; // reserved0
	dv.setUint32(o, 3); o += 4; // version
	dv.setUint32(o, 1); o += 4; // count
	o += 16; // reserved pad → 0x20
	const name = 'Entity_StartPosition_Player1';
	for (let i = 0; i < name.length; i++) bytes[o + i] = name.charCodeAt(i);
	o += NAME_FIELD_WIDTH; // name[33], rest already NUL
	// floats from +0x21
	const floats = [-1512.30, 9.31, 321.57, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1.0];
	for (const v of floats) { dv.setFloat32(o, v); o += 4; }
	return bytes;
}
const INLINE_BYTES = buildInline();

const REAL_FIXTURE = 'Environments/Levels/Downtown/Subtracks/A/Downtown.entities';

describe('entities parser', () => {
	it('parses the ENTS header and a 97-byte transform record (inline)', () => {
		const m = parseEntities(INLINE_BYTES);
		expect(m.magic).toBe('ENTS');
		expect(m.version).toBe(3);
		expect(m.count).toBe(1);
		expect(m.sizeLawOk).toBe(true);
		const r0 = m.records[0];
		expect(r0.name).toBe('Entity_StartPosition_Player1');
		expect(r0.position[0]).toBeCloseTo(-1512.30, 1);
		expect(r0.position[1]).toBeCloseTo(9.31, 2);
		expect(r0.position[2]).toBeCloseTo(321.57, 1);
		expect(r0.scale).toEqual([1, 1, 1]);
		expect(r0.index).toBeCloseTo(1.0, 5);
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeEntities(parseEntities(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects bad magic', () => {
		const bad = INLINE_BYTES.slice();
		bad[0] = 0x00;
		expect(() => parseEntities(bad)).toThrow(/bad magic/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips a REAL .entities from the devkit',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = entitiesHandler.parseRaw(raw, ssCtx());
			expect(m.magic).toBe('ENTS');
			expect(m.version).toBe(3);
			expect(m.count).toBe(8); // 8 player start positions
			expect(raw.byteLength).toBe(808); // 32 + 8*97
			expect(m.sizeLawOk).toBe(true);
			// record 0 = Player1 at the wiki coordinates, index 1.0
			expect(m.records[0].name).toBe('Entity_StartPosition_Player1');
			expect(m.records[0].position[0]).toBeCloseTo(-1512.30, 1);
			expect(m.records[0].index).toBeCloseTo(1.0, 5);
			// indices cover 1..8
			const indices = m.records.map((r) => Math.round(r.index)).sort((a, b) => a - b);
			expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
			const out = entitiesHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);
});
