// Tests for the MeshViewer core-box cull that makes multi-buffer car bodies
// (flagship: Musclecar_01) FRAME + RENDER as a car.
//
// Background: the Musclecar_01.model decodes FAITHFULLY (4 half-float P4 buffers,
// ~34843 verts, positions correct, textured). BUT a small minority of triangles
// are auxiliary "flat fan" strips that live in a DIFFERENT local frame and reach
// far out (x≈4.73, y≈-4.11 vs the real body ±~2.5 m). They are MIXED WITHIN
// submeshes (specific vertex ranges), not separable as whole submeshes. Under the
// viewer's AutoFit (which fits the bounding sphere over EVERYTHING) those few far
// verts blow up the frame → the "dagger + spike" artifact, even though ~99% of the
// body is a correct car shell.
//
// The viewer-side fix (no parser change): compute a robust CORE BOX and per-triangle
// cull anything outside it, applying the SAME core geometry to the rendered mesh and
// the AutoFit sphere. computeCoreBox / cullTrianglesToCore are the pure helpers under
// test here; the suite asserts the brief's acceptance criteria directly against the
// faithful parser output (synthetic for the always-on cases, real files when the
// devkit is present).

import { describe, expect, it } from 'vitest';
import { parseModel, type ModelMesh } from '@/lib/core/model';
import {
	computeCoreBox,
	cullTrianglesToCore,
	type CoreBox,
} from '../MeshViewer';
import { DATA_ROOT, hasDataRoot, readSample } from '@/test/dataRoot';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Minimal RenderMesh shims (mirror MeshViewer.toRenderMesh's triangle/point split
// closely enough for the pure helpers — they only read positions/indices/points).
// ---------------------------------------------------------------------------
type RM = {
	positions: Float32Array;
	indices: Uint32Array;
	vertexCount: number;
	submeshIndex: number;
	points?: boolean;
};

function triMesh(positions: number[], indices: number[], submeshIndex = 0): RM {
	const p = Float32Array.from(positions);
	return {
		positions: p,
		indices: Uint32Array.from(indices),
		vertexCount: p.length / 3,
		submeshIndex,
		points: false,
	};
}

/** Convert a decoded ModelMesh to the RenderMesh shape the helpers consume. */
function toRM(mesh: ModelMesh, submeshIndex: number): RM {
	const positions = Float32Array.from(mesh.positions);
	const vc = positions.length / 3;
	const hasTri =
		mesh.indices.length >= 3 && mesh.indices.every((i) => i >= 0 && i < vc);
	const indices = hasTri
		? Uint32Array.from(mesh.indices)
		: Uint32Array.from({ length: vc }, (_, i) => i);
	return { positions, indices, vertexCount: vc, submeshIndex, points: !hasTri };
}

function triCount(meshes: RM[]): number {
	return meshes.reduce((s, m) => s + (m.points ? 0 : m.indices.length / 3), 0);
}

function boxCoversExtent(box: CoreBox, meshes: RM[]): boolean {
	for (const m of meshes) {
		if (m.points) continue;
		const p = m.positions;
		for (let i = 0; i + 2 < p.length; i += 3) {
			if (
				p[i] < box.min[0] - 1e-6 ||
				p[i] > box.max[0] + 1e-6 ||
				p[i + 1] < box.min[1] - 1e-6 ||
				p[i + 1] > box.max[1] + 1e-6 ||
				p[i + 2] < box.min[2] - 1e-6 ||
				p[i + 2] > box.max[2] + 1e-6
			)
				return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// computeCoreBox — robust core-body box
// ---------------------------------------------------------------------------

describe('computeCoreBox', () => {
	it('returns the full extent for a clean mesh with no outliers (nothing to cull)', () => {
		// A small cube: every vertex is "core"; the box should cover all of it.
		const pos = [
			-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
		];
		const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4];
		const m = triMesh(pos, idx);
		const box = computeCoreBox([m], null);
		expect(box).not.toBeNull();
		expect(boxCoversExtent(box!, [m])).toBe(true);
		const res = cullTrianglesToCore([m], box);
		expect(res.culled).toBe(0);
	});

	it('returns null when there are no triangle vertices (point cloud only)', () => {
		const pc: RM = {
			positions: Float32Array.from([10, 0, 0, 0, 10, 0, 0, 0, 10]),
			indices: Uint32Array.from([0, 1, 2]),
			vertexCount: 3,
			submeshIndex: 0,
			points: true,
		};
		expect(computeCoreBox([pc], null)).toBeNull();
	});

	it('excludes a far outlier vertex from the box (percentile path)', () => {
		// 200 tightly-clustered triangles around the origin, plus ONE far-flung
		// triangle at ~+50 on every axis. The robust box must exclude the outlier.
		const pos: number[] = [];
		const idx: number[] = [];
		for (let i = 0; i < 200; i++) {
			const b = pos.length / 3;
			const cx = (Math.random() - 0.5) * 2;
			const cy = (Math.random() - 0.5) * 2;
			const cz = (Math.random() - 0.5) * 2;
			pos.push(cx, cy, cz, cx + 0.1, cy, cz, cx, cy + 0.1, cz);
			idx.push(b, b + 1, b + 2);
		}
		const fb = pos.length / 3;
		pos.push(50, 50, 50, 50.1, 50, 50, 50, 50.1, 50);
		idx.push(fb, fb + 1, fb + 2);
		const m = triMesh(pos, idx);
		const box = computeCoreBox([m], null);
		expect(box).not.toBeNull();
		// The +50 outlier sits outside the box on every axis.
		expect(box!.max[0]).toBeLessThan(50);
		expect(box!.max[1]).toBeLessThan(50);
		expect(box!.max[2]).toBeLessThan(50);
	});
});

// ---------------------------------------------------------------------------
// cullTrianglesToCore — per-triangle cull + safety gate
// ---------------------------------------------------------------------------

describe('cullTrianglesToCore', () => {
	it('culls a triangle with a far vertex but keeps the body, per-triangle within a submesh', () => {
		// One submesh containing MANY core triangles plus ONE stray triangle reaching
		// far out — the cull must be per-triangle (the fans are mixed within submeshes),
		// not per-submesh, and well under the safety gate (1 of 21 ≈ 4.8%).
		const pos: number[] = [];
		const idx: number[] = [];
		for (let i = 0; i < 20; i++) {
			const b = pos.length / 3;
			pos.push(0, 0, 0, 0.5, 0, 0, 0, 0.5, 0);
			idx.push(b, b + 1, b + 2);
		}
		// stray triangle reaching far out (last 3 verts)
		const sb = pos.length / 3;
		pos.push(0, 0, 0, 0.5, 0, 0, 100, 100, 100);
		idx.push(sb, sb + 1, sb + 2);
		const m = triMesh(pos, idx);
		const box: CoreBox = { min: [-1, -1, -1], max: [1, 1, 1] };
		const res = cullTrianglesToCore([m], box);
		expect(res.culled).toBe(1); // exactly the stray triangle
		expect(res.meshes[0].indices.length).toBe(20 * 3); // every core triangle survives
		// The stray's vertices are no longer referenced by any kept triangle.
		expect(Array.from(res.meshes[0].indices)).not.toContain(sb + 2);
		// Positions are NOT mutated — the decode stays faithful.
		expect(res.meshes[0].positions).toBe(m.positions);
	});

	it('passes point meshes through untouched', () => {
		const pc: RM = {
			positions: Float32Array.from([99, 99, 99]),
			indices: Uint32Array.from([0]),
			vertexCount: 1,
			submeshIndex: 0,
			points: true,
		};
		const box: CoreBox = { min: [-1, -1, -1], max: [1, 1, 1] };
		const res = cullTrianglesToCore([pc], box);
		expect(res.culled).toBe(0);
		expect(res.meshes[0]).toBe(pc);
	});

	it('SAFETY: culls nothing when the box would remove a large fraction', () => {
		// A box that would clip MOST triangles is not an outlier situation — the mesh
		// is just legitimately spread. The gate keeps everything (culled === 0).
		const pos: number[] = [];
		const idx: number[] = [];
		for (let i = 0; i < 100; i++) {
			const b = pos.length / 3;
			const x = i; // spread 0..99
			pos.push(x, 0, 0, x + 0.1, 0, 0, x, 0.1, 0);
			idx.push(b, b + 1, b + 2);
		}
		const m = triMesh(pos, idx);
		const tinyBox: CoreBox = { min: [-1, -1, -1], max: [5, 1, 1] }; // clips ~95%
		const res = cullTrianglesToCore([m], tinyBox);
		expect(res.culled).toBe(0);
		// The gate leaves the original mesh array untouched (same reference, all tris).
		expect(res.meshes[0]).toBe(m);
		expect(triCount(res.meshes)).toBe(100);
	});

	it('returns the input unchanged when the box is null', () => {
		const m = triMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
		const res = cullTrianglesToCore([m], null);
		expect(res.culled).toBe(0);
		expect(res.meshes).toEqual([m]);
	});
});

// ---------------------------------------------------------------------------
// Real-file acceptance (skipped without the devkit) — the brief's verify list.
// ---------------------------------------------------------------------------

const CAR = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.model';
const BARRELS = 'Generic/Models/NemTruckBarrels_Mid/NemTruckBarrels_Mid.model';

/** First existing PointLight.model under a level's ReflectionMap/Lights. */
function findPointLight(): string | null {
	if (!hasDataRoot) return null;
	const levels = path.join(DATA_ROOT, 'Environments', 'Levels');
	if (!fs.existsSync(levels)) return null;
	for (const lvl of fs.readdirSync(levels)) {
		const f = path.join(lvl, 'ReflectionMap', 'Lights', 'PointLight.model');
		if (fs.existsSync(path.join(levels, f))) return path.join('Environments', 'Levels', f);
	}
	return null;
}

/** First existing skinned AA model (point-cloud render) under Powerplays/Animations. */
function findSkinned(name: string): string | null {
	if (!hasDataRoot) return null;
	const root = path.join(DATA_ROOT, 'Powerplays', 'Animations');
	if (!fs.existsSync(root)) return null;
	let found: string | null = null;
	const walk = (dir: string) => {
		if (found) return;
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (found) return;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.toLowerCase() === name.toLowerCase()) found = p;
		}
	};
	walk(root);
	return found ? path.relative(DATA_ROOT, found) : null;
}

function meshesOf(rel: string): { tri: RM[]; pc: RM[]; bounds: ReturnType<typeof parseModel>['bounds'] } {
	const m = parseModel(readSample(rel));
	const rms = m.meshes.map((mesh, i) => toRM(mesh, i));
	return { tri: rms.filter((r) => !r.points), pc: rms.filter((r) => r.points), bounds: m.bounds };
}

describe.skipIf(!hasDataRoot)('core-box cull on REAL files (devkit)', () => {
	it('Musclecar_01: core box frames the body (~±2.5 m) and culls a small fan fraction', () => {
		const { tri, bounds } = meshesOf(CAR);
		expect(tri.length).toBeGreaterThan(0);
		const box = computeCoreBox(tri, bounds);
		expect(box).not.toBeNull();
		// The body is ~±2.5 m; the box must be tight (well under the stray reach of
		// x≈4.73 / y≈-4.11) on the X and Y axes.
		expect(box!.max[0]).toBeLessThan(3); // excludes x≈4.73 fan
		expect(box!.min[1]).toBeGreaterThan(-3); // excludes y≈-4.11 fan
		// Every box side stays within a sane car envelope (no axis blows past ±4 m).
		for (let k = 0; k < 3; k++) {
			expect(box!.max[k] - box!.min[k]).toBeLessThan(8);
		}
		const total = triCount(tri);
		const res = cullTrianglesToCore(tri, box);
		// A small minority is culled (the fans) — present but well under 10%.
		expect(res.culled).toBeGreaterThan(0);
		expect(res.culled / total).toBeLessThan(0.1);
		// The bulk of the body survives.
		expect(triCount(res.meshes) / total).toBeGreaterThan(0.9);
	});

	it('NemTruckBarrels_Mid: clean prop culls ~0 triangles', () => {
		const { tri, bounds } = meshesOf(BARRELS);
		expect(tri.length).toBeGreaterThan(0);
		const box = computeCoreBox(tri, bounds);
		expect(box).not.toBeNull();
		const res = cullTrianglesToCore(tri, box);
		expect(res.culled).toBe(0);
	});

	it('PointLight: clean prop culls ~0 triangles', () => {
		const rel = findPointLight();
		if (!rel) return;
		const { tri, bounds } = meshesOf(rel);
		const box = computeCoreBox(tri, bounds);
		const res = cullTrianglesToCore(tri, box);
		expect(res.culled).toBe(0);
	});

	it('AA_Bell206B: skinned model is a point cloud, unaffected by culling', () => {
		const rel = findSkinned('AA_Bell206B.model');
		if (!rel) return;
		const { tri, pc, bounds } = meshesOf(rel);
		expect(pc.length).toBeGreaterThan(0); // renders as a point cloud
		expect(tri.length).toBe(0); // no triangle topology to cull
		expect(computeCoreBox(tri, bounds)).toBeNull();
	});

	it('AA_HelicopterShockwave: skinned model is a point cloud, unaffected by culling', () => {
		const rel = findSkinned('AA_HelicopterShockwave.model');
		if (!rel) return;
		const { tri, pc, bounds } = meshesOf(rel);
		expect(pc.length).toBeGreaterThan(0);
		expect(tri.length).toBe(0);
		expect(computeCoreBox(tri, bounds)).toBeNull();
	});
});
