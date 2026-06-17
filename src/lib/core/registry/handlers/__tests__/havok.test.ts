import { describe, expect, it } from 'vitest';
import { havokHandler } from '../havok';
import {
	parseHavok,
	isHavokPackfile,
	convexHullTriangles,
	aabbBoxMesh,
	HAVOK_MAGIC0,
	HAVOK_MAGIC1,
} from '../../../havok';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// A minimal but byte-valid Havok packfile, generated to match the real layout:
//   userTag=1, fileVersion=5, layoutRules 04 00 01 01, numSections=2,
//   contentsSectionIndex=1 (__data__), contentsClassNameSectionIndex=0,
//   contentsClassNameSectionOffset=37 -> "hkRootLevelContainer".
// __classnames__ holds hkClass / hkClassMember / hkRootLevelContainer.
// (See gen-comment in the parser; bytes verified by parseHavok below.)
const INLINE_BYTES = new Uint8Array([
	87, 224, 224, 87, 16, 192, 192, 16, 0, 0, 0, 1, 0, 0, 0, 5, 4, 0, 1, 1, 0, 0,
	0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 37, 72, 97, 118, 111, 107,
	45, 53, 46, 53, 46, 48, 45, 114, 49, 0, 255, 255, 255, 255, 255, 255, 255,
	255, 255, 95, 95, 99, 108, 97, 115, 115, 110, 97, 109, 101, 115, 95, 95, 0,
	0, 0, 0, 0, 255, 0, 0, 0, 160, 0, 0, 0, 58, 0, 0, 0, 58, 0, 0, 0, 58, 0, 0,
	0, 58, 0, 0, 0, 58, 0, 0, 0, 58, 95, 95, 100, 97, 116, 97, 95, 95, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 224, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0,
	16, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0, 16, 56, 119, 31, 142, 9, 104, 107, 67,
	108, 97, 115, 115, 0, 165, 36, 15, 87, 9, 104, 107, 67, 108, 97, 115, 115,
	77, 101, 109, 98, 101, 114, 0, 245, 152, 163, 78, 9, 104, 107, 82, 111, 111,
	116, 76, 101, 118, 101, 108, 67, 111, 110, 116, 97, 105, 110, 101, 114, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

describe('havok packfile parser', () => {
	it('recognises the magic', () => {
		expect(isHavokPackfile(INLINE_BYTES)).toBe(true);
		expect(isHavokPackfile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
		expect(HAVOK_MAGIC0).toBe(0x57e0e057);
		expect(HAVOK_MAGIC1).toBe(0x10c0c010);
	});

	it('decodes the fixed header (inline fixture)', () => {
		const m = parseHavok(INLINE_BYTES);
		expect(m.header.magic0).toBe(0x57e0e057);
		expect(m.header.magic1).toBe(0x10c0c010);
		expect(m.header.userTag).toBe(1);
		expect(m.header.fileVersion).toBe(5);
		expect(m.header.layoutRules).toEqual([4, 0, 1, 1]);
		expect(m.header.pointerSize).toBe(4);
		expect(m.header.littleEndian).toBe(false);
		expect(m.header.numSections).toBe(2);
		expect(m.header.contentsSectionIndex).toBe(1);
		expect(m.header.contentsClassNameSectionIndex).toBe(0);
		expect(m.header.contentsClassNameSectionOffset).toBe(37);
		expect(m.header.contentsVersion).toBe('Havok-5.5.0-r1');
		expect(m.fileSize).toBe(240);
	});

	it('decodes the section table (inline fixture)', () => {
		const m = parseHavok(INLINE_BYTES);
		expect(m.sections.map((s) => s.tag)).toEqual(['__classnames__', '__data__']);
		const cn = m.sections[0];
		expect(cn.nullByte).toBe(0x000000ff);
		expect(cn.absoluteDataStart).toBe(0xa0);
		expect(cn.endOffset).toBe(58);
		expect(cn.size).toBe(58);
		const data = m.sections[1];
		expect(data.absoluteDataStart).toBe(0xe0);
		expect(data.size).toBe(16);
		// __classnames__ ends exactly where __data__ begins (0xa0 + 0x40-padded).
		expect(cn.absoluteDataStart + cn.size).toBeLessThanOrEqual(data.absoluteDataStart);
	});

	it('enumerates the class registry and resolves the root class (inline fixture)', () => {
		const m = parseHavok(INLINE_BYTES);
		expect(m.classNames.map((c) => c.name)).toEqual([
			'hkClass',
			'hkClassMember',
			'hkRootLevelContainer',
		]);
		expect(m.classNames[0].signature).toBe(0x38771f8e);
		expect(m.classNames[2].signature >>> 0).toBe(0xf598a34e);
		expect(m.rootClassName).toBe('hkRootLevelContainer');
	});

	it('rejects a non-Havok blob', () => {
		expect(() => havokHandler.parseRaw(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), ssCtx())).toThrow(
			/magic|Havok/i,
		);
	});

	it('describe() summarizes root + sections + class count', () => {
		const m = parseHavok(INLINE_BYTES);
		const d = havokHandler.describe(m);
		expect(d).toContain('Havok-5.5.0-r1');
		expect(d).toContain('hkRootLevelContainer');
		expect(d).toContain('3 classes');
		expect(d).toContain('2 sections');
	});

	// ---- REAL devkit samples ----

	const PHYS = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.phys';
	it.skipIf(!hasSample(PHYS))(
		'decodes a REAL .phys packfile (hkpPhysicsSystem root, 62208 B)',
		() => {
			const raw = readSample(PHYS);
			const m = havokHandler.parseRaw(raw, ssCtx());
			expect(m.fileSize).toBe(62208);
			expect(m.header.userTag).toBe(5);
			expect(m.header.fileVersion).toBe(5);
			expect(m.header.contentsVersion).toBe('Havok-5.5.0-r1');
			expect(m.header.numSections).toBe(3);
			expect(m.sections.map((s) => s.tag)).toEqual([
				'__classnames__',
				'__types__',
				'__data__',
			]);
			// Section arithmetic from the wiki: classnames @0xD0, types @0x480,
			// data @0x51A0; data.absoluteDataStart + data.size == fileSize.
			const cn = m.sections[0];
			const types = m.sections[1];
			const data = m.sections[2];
			expect(cn.absoluteDataStart).toBe(0xd0);
			expect(cn.absoluteDataStart + cn.endOffset).toBe(types.absoluteDataStart);
			expect(types.absoluteDataStart).toBe(0x480);
			expect(data.absoluteDataStart).toBe(0x51a0);
			expect(data.absoluteDataStart + data.endOffset).toBe(m.fileSize);
			// 41 registered classes per the wiki; root is hkpPhysicsSystem.
			expect(m.classNames.length).toBe(41);
			expect(m.classNames[0].name).toBe('hkClass');
			expect(m.rootClassName).toBe('hkpPhysicsSystem');
			expect(m.header.contentsClassNameSectionOffset).toBe(0xac);
		},
	);

	const MAINCOLL = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.mainColl';
	it.skipIf(!hasSample(MAINCOLL))(
		'decodes a REAL .mainColl packfile (hkRootLevelContainer root, 4992 B)',
		() => {
			const raw = readSample(MAINCOLL);
			const m = havokHandler.parseRaw(raw, ssCtx());
			expect(m.fileSize).toBe(4992);
			expect(m.header.userTag).toBe(1);
			expect(m.rootClassName).toBe('hkRootLevelContainer');
			expect(m.header.contentsClassNameSectionOffset).toBe(0x4b);
			expect(m.sections.length).toBe(3);
		},
	);

	const HKCOLL = 'Environments/Levels/Downtown/Physics/Downtown.hkColl';
	it.skipIf(!hasSample(HKCOLL))(
		'decodes a REAL level .hkColl packfile',
		() => {
			const raw = readSample(HKCOLL);
			const m = havokHandler.parseRaw(raw, ssCtx());
			expect(m.header.magic0).toBe(0x57e0e057);
			expect(m.header.contentsVersion).toBe('Havok-5.5.0-r1');
			expect(m.classNames.length).toBeGreaterThan(0);
			expect(m.rootClassName && m.rootClassName.length).toBeGreaterThan(0);
		},
	);
});

// ---------------------------------------------------------------------------
// Geometry triangulation helpers (synthetic — no devkit needed)
// ---------------------------------------------------------------------------

describe('convexHullTriangles', () => {
	it('triangulates a unit cube into a closed manifold (12 tris, F = 2V-4)', () => {
		const cube: number[] = [];
		for (const x of [-1, 1])
			for (const y of [-1, 1]) for (const z of [-1, 1]) cube.push(x, y, z);
		const idx = convexHullTriangles(cube);
		expect(idx.length / 3).toBe(12); // 8 verts -> 2*8-4 = 12 triangles
		// every undirected edge shared by exactly two triangles (closed hull)
		const edge = new Map<string, number>();
		for (let t = 0; t < idx.length; t += 3) {
			const tri = [idx[t], idx[t + 1], idx[t + 2]];
			for (let e = 0; e < 3; e++) {
				const a = tri[e];
				const b = tri[(e + 1) % 3];
				const k = a < b ? `${a}_${b}` : `${b}_${a}`;
				edge.set(k, (edge.get(k) ?? 0) + 1);
			}
		}
		for (const c of edge.values()) expect(c).toBe(2);
		// all indices in range
		for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
		for (const i of idx) expect(i).toBeLessThan(8);
	});

	it('returns [] for fewer than 4 points and for coplanar points', () => {
		expect(convexHullTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0])).toEqual([]); // triangle
		// 4 coplanar points (all z=0)
		expect(convexHullTriangles([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])).toEqual([]);
	});

	it('aabbBoxMesh builds 8 verts / 12 tris around a center', () => {
		const box = aabbBoxMesh([10, 0, -5], [2, 3, 4]);
		expect(box.vertexCount).toBe(8);
		expect(box.indices.length / 3).toBe(12);
		// X coordinates span center ± half-extent
		const xs = box.positions.filter((_, i) => i % 3 === 0);
		expect(Math.min(...xs)).toBeCloseTo(8);
		expect(Math.max(...xs)).toBeCloseTo(12);
	});
});

// ---------------------------------------------------------------------------
// Collision geometry from REAL devkit samples
// ---------------------------------------------------------------------------

describe('havok collision geometry (real samples)', () => {
	const MAINCOLL = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.mainColl';
	it.skipIf(!hasSample(MAINCOLL))(
		'extracts the 4 named convex hulls with real vertices from a .mainColl',
		() => {
			const m = parseHavok(readSample(MAINCOLL));
			const hulls = m.shapes.filter((s) => s.className === 'hkpConvexVerticesShape');
			expect(hulls.length).toBe(4);
			// Positionally labelled by the four documented target hull names.
			expect(hulls.map((h) => h.name)).toEqual([
				'Vs_Environment',
				'Vs_Object',
				'Vs_Vehicle',
				'Core',
			]);
			// Every hull recovers real vertices and triangulates to a solid mesh.
			expect(m.hasGeometry).toBe(true);
			for (const h of hulls) {
				expect(h.geometryComplete).toBe(true);
				expect(h.mesh).toBeDefined();
				expect(h.mesh!.vertexCount).toBe(h.numVertices);
				expect(h.mesh!.positions.length).toBe(h.numVertices! * 3);
				expect(h.mesh!.indices.length).toBeGreaterThanOrEqual(3);
			}
			// First hull's first vertex is the byte-traced (-1.045, 0.314, -2.106).
			const v = hulls[0].mesh!.positions;
			expect(v[0]).toBeCloseTo(-1.045, 2);
			expect(v[1]).toBeCloseTo(0.314, 2);
			expect(v[2]).toBeCloseTo(-2.106, 2);
		},
	);

	const PHYS = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.phys';
	it.skipIf(!hasSample(PHYS))(
		'extracts convex hull geometry + hkpMaterial friction/restitution from a .phys',
		() => {
			const m = parseHavok(readSample(PHYS));
			const hulls = m.shapes.filter((s) => s.className === 'hkpConvexVerticesShape');
			expect(hulls.length).toBeGreaterThan(4);
			expect(m.meshes.length).toBeGreaterThan(0);
			// __types__ reflection decoded the hkpMaterial member layout.
			const mat = m.types.find((t) => t.name === 'hkpMaterial');
			expect(mat).toBeDefined();
			expect(mat!.members.map((x) => x.name)).toEqual([
				'responseType',
				'friction',
				'restitution',
			]);
			// And the data values match the wiki-confirmed Havok defaults.
			const fric = m.fields.find((f) => f.name === 'friction');
			const rest = m.fields.find((f) => f.name === 'restitution');
			expect(fric?.value).toBeCloseTo(0.5, 3);
			expect(rest?.value).toBeCloseTo(0.4, 3);
		},
	);

	const TLCOLL = 'Environments/Levels/Downtown/Subtracks/A/tl.hkColl';
	it.skipIf(!hasSample(TLCOLL))(
		'reports a level .hkColl extended mesh as AABB-box-only (triangle buffers absent)',
		() => {
			const m = parseHavok(readSample(TLCOLL));
			const ext = m.shapes.filter((s) => s.className === 'hkpExtendedMeshShape');
			expect(ext.length).toBe(1);
			const s = ext[0];
			// Subpart metadata IS recovered (subpart count + per-subpart tri/vert sums)…
			expect(s.subpartCount).toBeGreaterThan(0);
			expect(s.numTriangles).toBeGreaterThan(0);
			// …but the triangle vertex/index buffers are SERIALIZE_IGNORED, so the
			// only renderable geometry is the AABB box (8 verts), honestly partial.
			expect(s.geometryComplete).toBe(false);
			expect(s.mesh?.vertexCount).toBe(8);
			expect(s.aabbHalfExtents).toBeDefined();
		},
	);

	const CLCOLL = 'Environments/Levels/Downtown/Common/cl.hkColl';
	it.skipIf(!hasSample(CLCOLL))(
		'parses the empty cl.hkColl placeholder with no geometry',
		() => {
			const m = parseHavok(readSample(CLCOLL));
			// cl.hkColl is a placeholder hkpPhysicsData with no shapes.
			expect(m.shapes.length).toBe(0);
			expect(m.hasGeometry).toBe(false);
		},
	);
});
