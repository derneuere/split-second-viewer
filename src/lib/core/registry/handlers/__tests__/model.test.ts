import { describe, expect, it } from 'vitest';
import { modelHandler } from '../model';
import {
	parseModel,
	parseModelStream,
	parseModelBase,
	parseModelSkinned,
	expandStrips,
	triangleCount,
	MODEL_MAGIC,
	MODEL_MAGIC_SKINNED,
	isModelMagic,
	isSkinnedMagic,
} from '../../../model';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// ---------------------------------------------------------------------------
// Helpers to build inline fixtures.
// ---------------------------------------------------------------------------

/** Encode a finite value as IEEE-754 binary16 (sufficient for 0,±1,±0.5 etc). */
function encodeHalf(val: number): number {
	if (val === 0) return Object.is(val, -0) ? 0x8000 : 0;
	const f = new Float32Array([val]);
	const u = new Uint32Array(f.buffer)[0];
	const sign = (u >>> 16) & 0x8000;
	const exp = ((u >>> 23) & 0xff) - 127 + 15;
	const mant = u & 0x7fffff;
	if (exp <= 0) return sign; // flush tiny to signed zero (fine for test values)
	if (exp >= 31) return sign | 0x7c00;
	return sign | (exp << 10) | (mant >> 13);
}

/** Build a minimal .model.stream: 12-byte header + 4 half4 verts + one strip. */
function buildInlineStream(): Uint8Array {
	const verts: [number, number, number][] = [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
		[1, 1, 0],
	];
	const idx = [0, 1, 2, 3, 0xffff];
	const total = 12 + verts.length * 16 + idx.length * 2;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, 0, false); // dword0
	dv.setUint32(4, total - 12, false); // dword1 = size-12
	dv.setUint32(8, 0, false); // dword2
	let p = 12;
	for (const v of verts) {
		dv.setUint16(p, encodeHalf(v[0]), false);
		dv.setUint16(p + 2, encodeHalf(v[1]), false);
		dv.setUint16(p + 4, encodeHalf(v[2]), false);
		dv.setUint16(p + 6, encodeHalf(1), false); // w = 1.0
		p += 16; // remaining 8 bytes (normal/etc) stay zero
	}
	for (const i of idx) {
		dv.setUint16(p, i, false);
		p += 2;
	}
	return buf;
}

/**
 * Build a minimal base .model: magic + node header + an AABB float pair + a
 * dense trailing 16-bit triangle-strip index block (>=3 restarts so the
 * tail-cluster detector accepts it).
 */
function buildInlineBaseModel(): Uint8Array {
	// Layout: [0..0x0c) header, [0x10..0x30) AABB rows, padding, then indices.
	const header = 0x10;
	const aabbAt = 0x10;
	const idxAt = 0x40;
	// Three short strips, each terminated by 0xFFFF (=> >=3 restarts).
	const idx = [0, 1, 2, 3, 0xffff, 1, 2, 3, 4, 0xffff, 2, 3, 4, 5, 0xffff];
	const total = idxAt + idx.length * 2;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, MODEL_MAGIC, false); // 02 00 00 08
	dv.setUint32(4, 1, false); // node_count
	dv.setUint32(8, header, false); // tree_offset
	// AABB min row (x,y,z,w=1) then max row (w=1)
	const min = [-2, -3, -4];
	const max = [5, 6, 7];
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + i * 4, min[i], false);
	dv.setFloat32(aabbAt + 12, 1, false);
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + 16 + i * 4, max[i], false);
	dv.setFloat32(aabbAt + 28, 1, false);
	let p = idxAt;
	for (const i of idx) {
		dv.setUint16(p, i, false);
		p += 2;
	}
	return buf;
}

/**
 * Build a minimal SKINNED .model (magic 02 01 00 08): header + an AABB float
 * pair + one 0x48 vertex-buffer record (two 0x24 sub-records sharing a vertex
 * count — a stride-12 float32-P3 position stream + a stride-8 aux stream),
 * followed by the position data laid 16-aligned after the table. Mirrors the
 * real container shape (AA_Bell206B.model) closely enough to exercise the
 * skinned decode path end-to-end.
 */
function buildInlineSkinnedModel(): Uint8Array {
	const aabbAt = 0x10;
	const tableAt = 0x40;
	const vcount = 4;
	const posStride = 12;
	const posSize = vcount * posStride; // 0x30
	const auxStride = 8;
	const auxSize = vcount * auxStride; // 0x20
	// Position data placed 16-aligned just past the 0x48 record.
	const dataAt = (tableAt + 0x48 + 15) & ~15;
	const verts: [number, number, number][] = [
		[-1, -2, -3],
		[1, 0, 0],
		[0, 2, 0],
		[1.5, 0, 3],
	];
	const total = dataAt + posSize + auxSize;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, MODEL_MAGIC_SKINNED, false); // 02 01 00 08
	dv.setUint32(4, 1, false); // node_count
	dv.setUint32(8, 0x10, false); // tree_offset
	// AABB min/max rows (w = 1) — extents must enclose the verts above.
	const mn = [-1, -2, -3];
	const mx = [1.5, 2, 3];
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + i * 4, mn[i], false);
	dv.setFloat32(aabbAt + 12, 1, false);
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + 16 + i * 4, mx[i], false);
	dv.setFloat32(aabbAt + 28, 1, false);
	// 0x48 record = sub-record A (position) + sub-record B (aux).
	dv.setUint32(tableAt + 0x00, posSize, false);
	dv.setUint32(tableAt + 0x04, posStride, false);
	dv.setUint32(tableAt + 0x08, vcount, false);
	dv.setUint32(tableAt + 0x24, auxSize, false);
	dv.setUint32(tableAt + 0x28, auxStride, false);
	dv.setUint32(tableAt + 0x2c, vcount, false);
	// Position data (float32 P3).
	let p = dataAt;
	for (const v of verts) {
		dv.setFloat32(p, v[0], false);
		dv.setFloat32(p + 4, v[1], false);
		dv.setFloat32(p + 8, v[2], false);
		p += posStride;
	}
	return buf;
}

const INLINE_STREAM = buildInlineStream();
const INLINE_BASE = buildInlineBaseModel();
const INLINE_SKINNED = buildInlineSkinnedModel();

const REAL_STREAM =
	'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.model.stream';
const REAL_BASE =
	'Environments/Levels/airport_test_03/ReflectionMap/Lights/PointLight.model';
// Skinned/animated variant (magic 02 01 00 08) — the brief's worked example.
const REAL_SKINNED =
	'Powerplays/Animations/airport_test_03/AA/AA_Bell206B.model';
// Largest skinned sample (1.9 MB, 54 sections) — performance + scale check.
const REAL_SKINNED_BIG =
	'Powerplays/Animations/Downtown/Post/PA03_Heli_tunnel_Roof_MPo.model';

describe('model parser — strip expansion', () => {
	it('expands a tri-strip into a triangle list with winding flip', () => {
		// strip 0,1,2,3 -> (0,1,2) then (2,1,3) [flipped] ; 0xFFFF restarts
		const u16 = (() => {
			const arr = [0, 1, 2, 3, 0xffff];
			const buf = new Uint8Array(arr.length * 2);
			const dv = new DataView(buf.buffer);
			arr.forEach((v, i) => dv.setUint16(i * 2, v, false));
			return (p: number) => dv.getUint16(p, false);
		})();
		const tris = expandStrips(u16, 0, 10, 4);
		expect(tris).toEqual([0, 1, 2, 2, 1, 3]);
	});

	it('flips winding consistently across a longer strip', () => {
		const arr = [0, 1, 2, 3, 4, 0xffff];
		const buf = new Uint8Array(arr.length * 2);
		const dv = new DataView(buf.buffer);
		arr.forEach((v, i) => dv.setUint16(i * 2, v, false));
		const u16 = (p: number) => dv.getUint16(p, false);
		// (0,1,2) even, (2,1,3) odd, (2,3,4) even
		expect(expandStrips(u16, 0, arr.length * 2, 5)).toEqual([0, 1, 2, 2, 1, 3, 2, 3, 4]);
	});

	it('drops degenerate triangles and out-of-range indices', () => {
		const arr = [0, 0, 1, 2, 0xffff, 5, 6, 7]; // first tri degenerate (0,0,1); 5/6/7 out of range
		const buf = new Uint8Array(arr.length * 2);
		const dv = new DataView(buf.buffer);
		arr.forEach((v, i) => dv.setUint16(i * 2, v, false));
		const u16 = (p: number) => dv.getUint16(p, false);
		const tris = expandStrips(u16, 0, arr.length * 2, 3);
		// (0,0,1) degenerate -> dropped; odd tri (1,0,2) ok; second strip all >= limit -> dropped
		expect(tris).toEqual([1, 0, 2]);
	});
});

describe('model.stream parser', () => {
	it('decodes the 12-byte header + half-float positions (inline)', () => {
		const m = parseModelStream(INLINE_STREAM);
		expect(m.kind).toBe('stream');
		expect(m.streamPayloadLen).toBe(INLINE_STREAM.byteLength - 12);
		expect(m.meshes).toHaveLength(1);
		expect(m.meshes[0].vertexCount).toBe(4);
		expect(m.meshes[0].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
	});

	it('expands the strip to triangles and computes bounds (inline)', () => {
		const m = parseModelStream(INLINE_STREAM);
		expect(m.meshes[0].indices).toEqual([0, 1, 2, 2, 1, 3]);
		// strip 0,1,2,3 -> (0,1,2) then (2,1,3)
		expect(triangleCount(m)).toBe(2);
		expect(m.bounds).not.toBeNull();
		expect(m.bounds!.min).toEqual([0, 0, 0]);
		expect(m.bounds!.max).toEqual([1, 1, 0]);
	});

	it('auto-detects a stream via parseModel (dword1 == size-12)', () => {
		const m = parseModel(INLINE_STREAM);
		expect(m.kind).toBe('stream');
	});
});

describe('base .model parser', () => {
	it('decodes the header + AABB bounds; no section table -> no meshes (inline)', () => {
		const m = parseModelBase(INLINE_BASE);
		expect(m.kind).toBe('model');
		expect(m.magic).toBe(MODEL_MAGIC);
		expect(m.nodeCount).toBe(1);
		expect(m.bounds).not.toBeNull();
		expect(m.bounds!.min).toEqual([-2, -3, -4]);
		expect(m.bounds!.max).toEqual([5, 6, 7]);
		// This synthetic file has no vertex/index section table, so the decode is
		// honest about producing no geometry (and flags partial).
		expect(m.meshes).toHaveLength(0);
		expect(m.partial).toBe(true);
	});

	it('rejects a bad magic', () => {
		const bad = new Uint8Array(0x40);
		new DataView(bad.buffer).setUint32(0, 0xdeadbeef, false);
		expect(() => parseModelBase(bad)).toThrow(/bad magic/);
	});

	it('auto-detects a base model via parseModel (magic 02 00 00 08)', () => {
		const m = parseModel(INLINE_BASE);
		expect(m.kind).toBe('model');
	});

	it('describe() summarizes the model', () => {
		const m = parseModelBase(INLINE_BASE);
		expect(modelHandler.describe(m)).toContain('model:');
		expect(modelHandler.describe(m)).toContain('bounds');
	});
});

describe('model magic helpers', () => {
	it('distinguishes the standard and skinned magics', () => {
		expect(isModelMagic(MODEL_MAGIC)).toBe(true);
		expect(isModelMagic(MODEL_MAGIC_SKINNED)).toBe(true); // 02 xx 00 08 family
		expect(isSkinnedMagic(MODEL_MAGIC_SKINNED)).toBe(true);
		expect(isSkinnedMagic(MODEL_MAGIC)).toBe(false);
		expect(isSkinnedMagic(0xdeadbeef)).toBe(false);
	});
});

describe('skinned .model parser', () => {
	it('decodes the 0x48 VB record -> a float32-P3 position buffer (inline)', () => {
		const m = parseModelSkinned(INLINE_SKINNED);
		expect(m.kind).toBe('model');
		expect(m.magic).toBe(MODEL_MAGIC_SKINNED);
		expect(m.nodeCount).toBe(1);
		// One section: 4 verts, positions only (skinned topology not recoverable).
		expect(m.meshes).toHaveLength(1);
		const mesh = m.meshes[0];
		expect(mesh.format).toBe('float');
		expect(mesh.stride).toBe(12);
		expect(mesh.vertexCount).toBe(4);
		expect(mesh.positions).toEqual([-1, -2, -3, 1, 0, 0, 0, 2, 0, 1.5, 0, 3]);
		// No index buffer in this variant -> empty indices, partial decode.
		expect(mesh.indices).toEqual([]);
		expect(m.partial).toBe(true);
		expect(triangleCount(m)).toBe(0);
		// Decoded-vertex AABB.
		expect(m.bounds).not.toBeNull();
		expect(m.bounds!.min).toEqual([-1, -2, -3]);
		expect(m.bounds!.max).toEqual([1.5, 2, 3]);
	});

	it('routes the skinned magic through parseModel and parseModelBase', () => {
		expect(parseModel(INLINE_SKINNED).magic).toBe(MODEL_MAGIC_SKINNED);
		// parseModelBase delegates to the skinned path when it sees 02 01 00 08.
		expect(parseModelBase(INLINE_SKINNED).meshes).toHaveLength(1);
	});
});

describe('model parser — REAL devkit samples', () => {
	it.skipIf(!hasSample(REAL_STREAM))(
		'decodes a REAL .model.stream (Musclecar_01)',
		() => {
			const raw = readSample(REAL_STREAM);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('stream');
			// dword1 == filesize-12 (confirmed across the Musclecar stream set)
			expect(m.streamPayloadLen).toBe(raw.byteLength - 12);
			const mesh = m.meshes[0];
			// real geometry: tens of thousands of verts and triangles
			expect(mesh.vertexCount).toBeGreaterThan(10000);
			expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
			expect(mesh.indices.length).toBeGreaterThan(1000);
			// every triangle index is in range
			let maxI = 0;
			for (const i of mesh.indices) if (i > maxI) maxI = i;
			expect(maxI).toBeLessThan(mesh.vertexCount);
			// bounds are finite
			expect(m.bounds).not.toBeNull();
			for (const v of [...m.bounds!.min, ...m.bounds!.max]) {
				expect(Number.isFinite(v)).toBe(true);
			}
		},
	);

	it.skipIf(!hasSample(REAL_BASE))(
		'decodes a REAL base .model with float-format geometry (PointLight)',
		() => {
			const raw = readSample(REAL_BASE);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			expect(m.magic).toBe(MODEL_MAGIC);
			expect(m.nodeCount).toBe(1);
			// One section: a 5x5 quad grid (25 verts, P3+UV full-float).
			expect(m.meshes).toHaveLength(1);
			const mesh = m.meshes[0];
			expect(mesh.format).toBe('float');
			expect(mesh.vertexCount).toBe(25);
			expect(mesh.positions.length).toBe(25 * 3);
			expect(mesh.uv?.length).toBe(25 * 2);
			expect(mesh.indices.length).toBeGreaterThanOrEqual(3);
			expect(mesh.indices.every((i) => i >= 0 && i < mesh.vertexCount)).toBe(true);
			// First vertex of the grid is the -0.5,-0.5 corner.
			expect(mesh.positions[0]).toBeCloseTo(-0.5, 3);
			expect(mesh.positions[1]).toBeCloseTo(-0.5, 3);
			// Decoded-vertex AABB is the symmetric ±0.5 box from the wiki.
			expect(m.bounds).not.toBeNull();
			expect(m.bounds!.min[0]).toBeCloseTo(-0.5, 3);
			expect(m.bounds!.max[0]).toBeCloseTo(0.5, 3);
		},
	);

	const REAL_BASE_CAR = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.model';
	it.skipIf(!hasSample(REAL_BASE_CAR))(
		'decodes a REAL base car .model via its section tables (Musclecar_01)',
		() => {
			const raw = readSample(REAL_BASE_CAR);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			// The in-race car body has no .model.stream: geometry lives in the base
			// .model's vertex-buffer + draw-call section tables.
			expect(m.meshes.length).toBeGreaterThanOrEqual(2);
			let totalVerts = 0;
			let totalTris = 0;
			for (const mesh of m.meshes) {
				expect(mesh.format).toBe('half');
				expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
				// every triangle index is in range for its own buffer
				expect(mesh.indices.every((i) => i >= 0 && i < mesh.vertexCount)).toBe(true);
				totalVerts += mesh.vertexCount;
				totalTris += mesh.indices.length / 3;
			}
			expect(totalVerts).toBeGreaterThan(10000);
			expect(totalTris).toBeGreaterThan(5000);
			expect(m.bounds).not.toBeNull();
			for (const v of [...m.bounds!.min, ...m.bounds!.max]) {
				expect(Number.isFinite(v)).toBe(true);
			}
			// Car-body extent: a few metres in each axis, not astronomically large.
			expect(m.bounds!.max[2] - m.bounds!.min[2]).toBeGreaterThan(1);
			expect(m.bounds!.max[2] - m.bounds!.min[2]).toBeLessThan(50);
		},
	);

	// Regression for the "renders weirdly" bug. Musclecar_02 was scrambled by the
	// old "smallest fitting buffer" heuristic, which mis-bound ~10 of its 39 draw
	// calls to the wrong vertex buffer. The node-tree binding table fixes it: every
	// triangle index must be in range for the buffer it is bound to.
	const REAL_BASE_CAR2 = 'Vehicles/Bodies/Musclecar_02/Musclecar_02.model';
	it.skipIf(!hasSample(REAL_BASE_CAR2))(
		'decodes Musclecar_02 with the EXACT draw->buffer binding (no scrambled geometry)',
		() => {
			const raw = readSample(REAL_BASE_CAR2);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			// Four vertex buffers, plenty of geometry — like Musclecar_01.
			expect(m.meshes.length).toBe(4);
			let totalVerts = 0;
			let totalTris = 0;
			for (const mesh of m.meshes) {
				expect(mesh.format).toBe('half');
				expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
				// THE fix: every triangle index is in range for its OWN buffer. With the
				// old heuristic this was violated (indices referenced the wrong buffer).
				expect(mesh.indices.every((i) => i >= 0 && i < mesh.vertexCount)).toBe(true);
				totalVerts += mesh.vertexCount;
				totalTris += mesh.indices.length / 3;
			}
			// Comparable scale to Musclecar_01 (a full car body).
			expect(totalVerts).toBeGreaterThan(10000);
			expect(totalTris).toBeGreaterThan(5000);
			// Bounds match the header AABB scale (a few metres per axis).
			expect(m.bounds).not.toBeNull();
			for (const v of [...m.bounds!.min, ...m.bounds!.max]) {
				expect(Number.isFinite(v)).toBe(true);
			}
			expect(m.bounds!.max[2] - m.bounds!.min[2]).toBeGreaterThan(1);
			expect(m.bounds!.max[2] - m.bounds!.min[2]).toBeLessThan(50);
			// Every buffer that received any draw call must have triangles (the
			// binding distributes draws across all four buffers, not just buf0).
			const buffersWithTris = m.meshes.filter((mesh) => mesh.indices.length > 0).length;
			expect(buffersWithTris).toBeGreaterThanOrEqual(3);
		},
	);

	// A couple of airport sobj props (PhysicsInstances). These have a VB table + an
	// IB/draw table + the binding table; they must decode to plausible, in-range
	// geometry (never garbage). One of them is a prop the old heuristic mis-bound.
	const REAL_PROP_TRESSLE =
		'Environments/Objects/PhysicsInstances/tressle_2/tressle_2.model';
	const REAL_PROP_BENCH =
		'Environments/Objects/PhysicsInstances/airport_bench_01/airport_bench_01.model';
	for (const rel of [REAL_PROP_TRESSLE, REAL_PROP_BENCH]) {
		it.skipIf(!hasSample(rel))(`decodes an airport sobj prop cleanly (${rel.split('/').pop()})`, () => {
			const raw = readSample(rel);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			expect(m.meshes.length).toBeGreaterThanOrEqual(1);
			let totalTris = 0;
			for (const mesh of m.meshes) {
				expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
				// Never emit garbage: every index in range for its own buffer.
				expect(mesh.indices.every((i) => i >= 0 && i < mesh.vertexCount)).toBe(true);
				totalTris += mesh.indices.length / 3;
				for (const c of mesh.positions) {
					expect(Number.isFinite(c)).toBe(true);
					expect(Math.abs(c)).toBeLessThan(1e4);
				}
			}
			// A real prop has at least a handful of triangles.
			expect(totalTris).toBeGreaterThanOrEqual(2);
			expect(m.bounds).not.toBeNull();
		});
	}

	it.skipIf(!hasSample(REAL_SKINNED))(
		'decodes a REAL skinned .model (0x02010008) into per-section position buffers (AA_Bell206B)',
		() => {
			const raw = readSample(REAL_SKINNED);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			expect(m.magic).toBe(MODEL_MAGIC_SKINNED);
			// The brief's worked example: two 0x48 VB records (vc=16 and vc=688).
			expect(m.meshes.length).toBe(2);
			let totalVerts = 0;
			for (const mesh of m.meshes) {
				// Skinned positions are full float32 P3 (NOT half-floats).
				expect(mesh.format).toBe('float');
				expect(mesh.stride).toBe(12);
				expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
				// Topology isn't recoverable from this container -> positions only.
				expect(mesh.indices).toEqual([]);
				// Positions are finite and in a sane metric range.
				for (const c of mesh.positions) {
					expect(Number.isFinite(c)).toBe(true);
					expect(Math.abs(c)).toBeLessThan(1000);
				}
				totalVerts += mesh.vertexCount;
			}
			expect(totalVerts).toBe(704); // 16 + 688
			// Honest partial flag (no triangles decoded).
			expect(m.partial).toBe(true);
			expect(triangleCount(m)).toBe(0);
			// Cross-check: the decoded combined AABB extents match the header AABB
			// (the engine permutes axes, so compare SORTED extents).
			expect(m.bounds).not.toBeNull();
			const ext = [
				m.bounds!.max[0] - m.bounds!.min[0],
				m.bounds!.max[1] - m.bounds!.min[1],
				m.bounds!.max[2] - m.bounds!.min[2],
			].sort((a, b) => a - b);
			// Header AABB extents for AA_Bell206B ≈ [3.9, 12.6, 14.6].
			expect(ext[0]).toBeCloseTo(3.9, 0);
			expect(ext[1]).toBeCloseTo(12.6, 0);
			expect(ext[2]).toBeCloseTo(14.6, 0);
			// The per-section descriptors recover the EXPECTED triangle count even
			// though the index data is absent: small=24 + big=2274 indices = 766 tris.
			// The note must surface that the topology was stripped, not undecoded.
			expect(m.note).toBeDefined();
			expect(m.note).toMatch(/2 mesh section/);
			expect(m.note).toMatch(/766 triangle/);
			expect(m.note).toMatch(/index buffer is absent/);
		},
	);

	it.skipIf(!hasSample(REAL_SKINNED_BIG))(
		'decodes the LARGEST skinned .model (1.9 MB, 54 sections) (PA03_Heli_tunnel_Roof_MPo)',
		() => {
			const raw = readSample(REAL_SKINNED_BIG);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			expect(m.magic).toBe(MODEL_MAGIC_SKINNED);
			// Many sections, tens of thousands of verts, all positions only.
			expect(m.meshes.length).toBeGreaterThan(20);
			let totalVerts = 0;
			for (const mesh of m.meshes) {
				expect(mesh.format).toBe('float');
				expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
				expect(mesh.indices).toEqual([]);
				totalVerts += mesh.vertexCount;
			}
			expect(totalVerts).toBeGreaterThan(50000);
			expect(m.partial).toBe(true);
			// Decoded bounds are finite and physically plausible (a large set piece).
			expect(m.bounds).not.toBeNull();
			for (const v of [...m.bounds!.min, ...m.bounds!.max]) {
				expect(Number.isFinite(v)).toBe(true);
				expect(Math.abs(v)).toBeLessThan(5000);
			}
		},
	);
});
