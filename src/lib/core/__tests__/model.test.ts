import { describe, expect, it } from 'vitest';
import { parseModel, parseModelBase, MODEL_MAGIC } from '../model';
import { hasSample, readSample } from '@/test/dataRoot';

// ---------------------------------------------------------------------------
// Per-vertex UV (texcoord) decode for FLOAT-format .model vertex buffers.
//
// The cooked Crayon2/Havok vertex interleaves position, a unit normal, optional
// tangent/colour lanes and a float2 texcoord — and the texcoord is NOT at a
// fixed offset. The Bell206B helicopter BODY (stride 32) SPLITS its UV across
// the leading lane (U @0) and the trailing lane (V @28), with the unit normal
// occupying bytes 16–27. The previous decoder assumed the UV sat contiguously at
// posOffset+12 and so read the NORMAL columns as the UV — yielding a spurious
// symmetric [-1,1] range (≈50 % negative) instead of a [0,1] tiling band. These
// tests pin the statistical UV-column detector that fixes it (model.ts owns UV
// range/quality; the material WP only asserts the UVs are finite + small).
// ---------------------------------------------------------------------------

/**
 * Build a single-buffer FLOAT base .model whose vertex layout mirrors the heli
 * body: [U @0, position3 @4, normal3 @16, V @28] at stride 32. The header AABB
 * equals the position extent so the float-format probe anchors posOffset = 4;
 * the UV detector must then pick the split @0 / @28 lanes, NOT the unit normal
 * at @16/@20 that a "UV == posOffset+12" rule would grab.
 */
function buildSplitUVModel(): Uint8Array {
	const aabbAt = 0x10;
	const tableAt = 0x40;
	const stride = 32;
	// rows: U, px, py, pz, nx, ny, nz, V  (normals are unit vectors)
	const verts: number[][] = [
		[0.0, -2, -3, -4, 1, 0, 0, 0.0],
		[0.25, 5, -3, -4, 0, 1, 0, 0.1],
		[0.5, 5, 6, -4, 0, 0, 1, 0.5],
		[0.75, -2, 6, 7, -1, 0, 0, 0.9],
		[1.0, 5, 6, 7, 0, -1, 0, 1.0],
		[0.4, -2, -3, 7, 0, 0, -1, 0.7],
	];
	const vcount = verts.length;
	const size = vcount * stride; // 6*32 = 192 (already a 16-byte multiple)
	const dataAt = tableAt + 0x24; // float data begins at the VB-table end
	const total = dataAt + size;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, MODEL_MAGIC, false);
	dv.setUint32(4, 1, false);
	dv.setUint32(8, 0x10, false);
	// AABB min/max rows (w = 1) — equal to the position extent.
	const mn = [-2, -3, -4];
	const mx = [5, 6, 7];
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + i * 4, mn[i], false);
	dv.setFloat32(aabbAt + 12, 1, false);
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + 16 + i * 4, mx[i], false);
	dv.setFloat32(aabbAt + 28, 1, false);
	// VB table: one 0x24 record {size, stride, vcount, …}.
	dv.setUint32(tableAt + 0, size, false);
	dv.setUint32(tableAt + 4, stride, false);
	dv.setUint32(tableAt + 8, vcount, false);
	// Vertex data.
	let p = dataAt;
	for (const v of verts) {
		for (let k = 0; k < 8; k++) dv.setFloat32(p + k * 4, v[k], false);
		p += stride;
	}
	return buf;
}

describe('model UV decode — split-lane texcoord (synthetic)', () => {
	it('recovers the U @0 / V @28 split around the unit normal (not the normal at @16)', () => {
		const m = parseModelBase(buildSplitUVModel());
		expect(m.meshes).toHaveLength(1);
		const mesh = m.meshes[0];
		expect(mesh.format).toBe('float');
		expect(mesh.stride).toBe(32);
		expect(mesh.vertexCount).toBe(6);
		// Positions come from @4/@8/@12 (unchanged by the UV fix).
		expect(mesh.positions).toEqual([-2, -3, -4, 5, -3, -4, 5, 6, -4, -2, 6, 7, 5, 6, 7, -2, -3, 7]);
		// THE fix: UVs come from the two split texcoord lanes (@0 and @28) around the
		// unit normal — NOT the normal columns at @16/@20 (which would give
		// 1,0 / 0,1 / 0,0 / -1,0 …). Per the engine's U/V convention the decoder emits
		// [U, V] = [higher offset @28, lower offset @0] (see detectUVOffsets), i.e. each
		// vertex's pair is (@28-lane, @0-lane).
		expect(mesh.uv).toBeDefined();
		expect(mesh.uv!.length).toBe(6 * 2);
		const expected = [0.0, 0.0, 0.1, 0.25, 0.5, 0.5, 0.9, 0.75, 1.0, 1.0, 0.7, 0.4];
		mesh.uv!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
	});

	it('never picks the unit-normal columns as UV (regression guard)', () => {
		const m = parseModelBase(buildSplitUVModel());
		const uv = m.meshes[0].uv!;
		// A unit-normal column is symmetric about 0 (≈ half its samples negative);
		// a real texcoord here is entirely within [0,1]. Assert the latter.
		expect(uv.every((v) => v >= -1e-6 && v <= 1 + 1e-6)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// REAL devkit helicopter (Helicopter_Bell206B_01). The body is the largest
// vertex buffer (13 052 verts, stride 32). Its UV must decode to a sane,
// mostly-unit tiling range so the diffuse samples correctly.
// ---------------------------------------------------------------------------
const HELI = 'Generic/Models/Helicopter_Bell206B_01/Helicopter_Bell206B_01';
const heliPresent = hasSample(`${HELI}.model`);

describe('model UV decode — REAL devkit helicopter body (Helicopter_Bell206B_01)', () => {
	it.skipIf(!heliPresent)('decodes the body UVs to a sane, mostly-[0,1] tiling range', () => {
		const model = parseModel(readSample(`${HELI}.model`));
		// The body is the largest mesh by vertex count.
		const body = model.meshes.reduce((a, b) => (b.vertexCount > a.vertexCount ? b : a));
		expect(body.format).toBe('float');
		expect(body.vertexCount).toBeGreaterThan(10000);

		// Every vertex carries a UV.
		expect(body.uv).toBeDefined();
		expect(body.uv!.length).toBe(body.vertexCount * 2);

		// Tally the texcoord distribution.
		let finite = 0;
		let in01 = 0;
		let negative = 0;
		let maxAbs = 0;
		for (const v of body.uv!) {
			if (!Number.isFinite(v)) continue;
			finite++;
			if (v >= 0 && v <= 1) in01++;
			if (v < 0) negative++;
			if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
		}
		const total = body.uv!.length;

		// (1) All components finite and small-magnitude (no half-float misread — the
		//     failure mode that produced values in the thousands). 64 matches the
		//     material WP's relaxed bound; rare seam/decal verts tile a little wide.
		expect(finite).toBe(total);
		expect(maxAbs).toBeLessThanOrEqual(64);

		// (2) The decode is a real [0,1] tiling texcoord, not the old normal-as-UV
		//     read (which was symmetric about 0, ≈50 % negative) and not a position
		//     column (which sprawls across [-10, 6]). The vast majority sit in [0,1].
		expect(in01 / total).toBeGreaterThanOrEqual(0.95);
		expect(negative / total).toBeLessThan(0.05);

		// (3) Positions are untouched by the UV fix — still a finite, metric-scale
		//     body (a few metres per axis), matching the header AABB.
		expect(body.positions.length).toBe(body.vertexCount * 3);
		for (const c of body.positions) {
			expect(Number.isFinite(c)).toBe(true);
			expect(Math.abs(c)).toBeLessThan(100);
		}
	});
});
