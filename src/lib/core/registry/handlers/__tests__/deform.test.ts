import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deformHandler } from '../deform';
import { parseDeform, writeDeform } from '../../../deform';
import { ssCtx } from '../../handler';
import { DATA_ROOT, hasDataRoot, hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a minimal valid DFM2 "chassis-style" file (no footer).
//   header: magic, A=2 verts, B=2, C=1, D=1 part-group, E=0, F=0, G=0
//   then 2 vec4 BE float32 vertices (w=1.0), then a 100-byte part-group record
//   named "HUB_FR" running to EOF.
function buildInlineDeform(): Uint8Array {
	const headerAndVerts = new Uint8Array(0x20 + 2 * 16);
	const dv = new DataView(headerAndVerts.buffer);
	headerAndVerts.set([0x44, 0x46, 0x4d, 0x02], 0); // magic "DFM" + 0x02
	dv.setUint32(0x04, 2, false); // vertexCount A
	dv.setUint32(0x08, 2, false); // countB
	dv.setUint32(0x0c, 1, false); // edgeCount C
	dv.setUint32(0x10, 1, false); // partGroupCount D
	dv.setUint32(0x14, 0, false); // countE
	dv.setUint32(0x18, 0, false); // countF (chassis: no footer)
	dv.setUint32(0x1c, 0, false); // countG
	dv.setFloat32(0x20, 0.5, false);
	dv.setFloat32(0x24, 0.25, false);
	dv.setFloat32(0x28, -0.5, false);
	dv.setFloat32(0x2c, 1.0, false);
	dv.setFloat32(0x30, 1.0, false);
	dv.setFloat32(0x34, 0.0, false);
	dv.setFloat32(0x38, 2.0, false);
	dv.setFloat32(0x3c, 1.0, false);

	const pg = new Uint8Array(100);
	pg.set(new TextEncoder().encode('HUB_FR'), 0);

	const out = new Uint8Array(headerAndVerts.length + pg.length);
	out.set(headerAndVerts, 0);
	out.set(pg, headerAndVerts.length);
	return out;
}

const INLINE = buildInlineDeform();
const REAL_BODY = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.deform';
const REAL_CHASSIS = 'Vehicles/Chassis/Coupe/Coupe.deform';

/** Enumerate every real .deform under Vehicles/{Bodies,Chassis}. */
function allDeformFiles(): string[] {
	if (!hasDataRoot) return [];
	const out: string[] = [];
	for (const sub of ['Bodies', 'Chassis']) {
		const dir = path.join(DATA_ROOT, 'Vehicles', sub);
		if (!fs.existsSync(dir)) continue;
		for (const car of fs.readdirSync(dir)) {
			const cdir = path.join(dir, car);
			if (!fs.statSync(cdir).isDirectory()) continue;
			for (const f of fs.readdirSync(cdir)) {
				if (f.toLowerCase().endsWith('.deform')) out.push(path.join(cdir, f));
			}
		}
	}
	return out;
}

describe('deform parser', () => {
	it('decodes the DFM2 header and vertex cage (inline fixture)', () => {
		const m = parseDeform(INLINE);
		expect(m.header.version).toBe(2);
		expect(m.header.vertexCount).toBe(2);
		expect(m.header.edgeCount).toBe(1);
		expect(m.header.partGroupCount).toBe(1);
		expect(m.vertices).toHaveLength(2);
		expect(m.vertices[0]).toEqual({ x: 0.5, y: 0.25, z: -0.5, w: 1 });
		expect(m.vertices[1]).toEqual({ x: 1, y: 0, z: 2, w: 1 });
	});

	it('recovers the named part-group record (inline fixture)', () => {
		const m = parseDeform(INLINE);
		expect(m.partGroups).toHaveLength(1);
		expect(m.partGroups[0].name).toBe('HUB_FR');
		expect(m.hasFooter).toBe(false);
	});

	it('round-trips the inline fixture byte-for-byte', () => {
		const out = writeDeform(parseDeform(INLINE));
		expect(Array.from(out)).toEqual(Array.from(INLINE));
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[0] = 0xff;
		expect(() => parseDeform(bad)).toThrow(/bad magic/);
	});

	it('describe() summarizes verts and part-groups', () => {
		const s = deformHandler.describe(parseDeform(INLINE));
		expect(s).toContain('2 verts');
		expect(s).toContain('HUB_FR');
	});

	it.skipIf(!hasSample(REAL_BODY))(
		'parses a REAL Musclecar_01.deform from the devkit',
		() => {
			const raw = readSample(REAL_BODY);
			const m = deformHandler.parseRaw(raw, ssCtx());
			expect(m.header.version).toBe(2);
			expect(m.header.vertexCount).toBe(284);
			expect(m.header.edgeCount).toBe(1700);
			expect(m.header.partGroupCount).toBe(25);
			expect(m.header.countF).toBe(6);
			expect(m.header.countG).toBe(1);
			expect(0x20 + m.header.vertexCount * 16).toBe(0x11e0);
			expect(m.vertices).toHaveLength(284);
			expect(m.vertices[0].x).toBeCloseTo(0.8835, 3);
			expect(m.vertices[0].w).toBe(1);
			expect(m.hasFooter).toBe(true);
			expect(m.partGroups).toHaveLength(25);
			expect(m.partGroups.every((g) => g.name.length > 0)).toBe(true);
		},
	);

	it.skipIf(!hasSample(REAL_CHASSIS))(
		'parses a REAL chassis Coupe.deform (no footer)',
		() => {
			const raw = readSample(REAL_CHASSIS);
			const m = deformHandler.parseRaw(raw, ssCtx());
			expect(m.header.vertexCount).toBe(61);
			expect(m.header.partGroupCount).toBe(17);
			expect(m.hasFooter).toBe(false);
			expect(m.partGroups).toHaveLength(17);
		},
	);

	it.skipIf(!hasDataRoot)(
		'deform round-trips real sample byte-for-byte',
		() => {
			const files = allDeformFiles();
			expect(files.length).toBeGreaterThan(0);
			for (const f of files) {
				const buf = fs.readFileSync(f);
				const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
				const out = deformHandler.writeRaw!(deformHandler.parseRaw(raw, ssCtx()), ssCtx());
				expect(Array.from(out), `round-trip mismatch for ${f}`).toEqual(Array.from(raw));
			}
		},
	);
});
