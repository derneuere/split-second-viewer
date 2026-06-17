// MeshViewer — decoded-mesh viewport (category "mesh").
//
// Renders a parsed .model / .model.stream (see src/lib/core/model.ts) as a
// THREE.BufferGeometry inside a @react-three/fiber <Canvas> with drei
// <OrbitControls>. Auto-fits the camera to the mesh bounds, offers a wireframe
// toggle, and exports the geometry to a binary glTF (.glb) via
// @gltf-transform/core.
//
// Props contract (shared by all viewers): { model, raw, handler }. The model is
// whatever the matched handler's parseRaw produced — here a ParsedModel. The
// component tolerates a missing/partial model (no geometry) by rendering a
// graceful message instead of an empty canvas.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Document, WebIO, type Accessor } from '@gltf-transform/core';
import { Boxes, Download, Grid3x3, AlertTriangle, Image as ImageIcon, Palette, Eye, EyeOff } from 'lucide-react';
import * as THREE from 'three';

import type { ParsedModel, ModelMesh, ModelBounds } from '@/lib/core/model';
import type { ResourceHandler } from '@/lib/core/registry/handler';
import { buildMaterials, type BuiltMaterials, type SubmeshMaterial } from '@/lib/core/material';
import type { DecodedTexture } from '@/lib/core/textures';
import { useWorkspace, type TreeNode } from '@/context/WorkspaceContext';
import type { ResourceRef } from '@/lib/core/types';
import { Button } from '@/components/ui/button';

/** Shared viewer props. `model` is the matched handler's parseRaw output. */
export type MeshViewerProps = {
	model: unknown;
	raw: Uint8Array | null;
	handler?: ResourceHandler | undefined;
};

/** A submesh whose positions are renderable (non-empty, index-bounded). */
type RenderMesh = {
	positions: Float32Array;
	indices: Uint32Array;
	vertexCount: number;
	/** Per-vertex UVs (u,v…) when the source buffer carried them. */
	uv?: Float32Array;
	/** Submesh index in node order — the key into the resolved materials. */
	submeshIndex: number;
	/**
	 * True when the source mesh has NO real triangle topology (positions only —
	 * e.g. the skinned .model variant, whose index buffer is stripped from the
	 * file). Such a mesh is drawn as a POINT CLOUD: drawing it as triangles would
	 * connect unrelated vertices into a shattered spike soup (the AA_*Shockwave /
	 * Bell206B bug). `indices` is then the identity 0..n-1 used only for the point
	 * draw / glTF export, not a triangle list.
	 */
	points?: boolean;
};

/** Display modes the toolbar toggles between. */
type ViewMode = 'textured' | 'flat' | 'wireframe';

/** Narrow the opaque model to a ParsedModel with at least the fields we read. */
function asParsedModel(model: unknown): ParsedModel | null {
	if (!model || typeof model !== 'object') return null;
	const m = model as Partial<ParsedModel>;
	if (!Array.isArray(m.meshes)) return null;
	return m as ParsedModel;
}

/** A Havok packfile model carries `shapes[]` (collision) — used for labelling. */
type HavokLikeModel = {
	shapes?: { className: string; geometryComplete?: boolean }[];
	hasGeometry?: boolean;
};
function asHavokModel(model: unknown): HavokLikeModel | null {
	if (!model || typeof model !== 'object') return null;
	const m = model as HavokLikeModel;
	return Array.isArray(m.shapes) ? m : null;
}

/** A bone with a world-space origin + parent index, used for line-segment draw. */
type DrawBone = { index: number; parent: number; name?: string; pos: [number, number, number] };

/**
 * Pull skeleton bones from a ParsedSkel (or any model carrying a `skeleton`
 * array of {index,parent,pos}). Returns [] when none are present.
 */
function asDrawBones(model: unknown): DrawBone[] {
	if (!model || typeof model !== 'object') return [];
	const m = model as { skeleton?: unknown };
	if (!Array.isArray(m.skeleton)) return [];
	const out: DrawBone[] = [];
	for (const b of m.skeleton as DrawBone[]) {
		if (b && Array.isArray(b.pos) && b.pos.length === 3 && b.pos.every((v) => Number.isFinite(v))) {
			out.push(b);
		}
	}
	return out;
}

/** Build a THREE line-segment geometry connecting each bone to its parent. */
function buildSkeletonGeometry(bones: DrawBone[]): THREE.BufferGeometry | null {
	if (bones.length === 0) return null;
	const byIndex = new Map<number, DrawBone>();
	for (const b of bones) byIndex.set(b.index, b);
	const pts: number[] = [];
	for (const b of bones) {
		const parent = byIndex.get(b.parent);
		if (!parent) continue;
		pts.push(parent.pos[0], parent.pos[1], parent.pos[2]);
		pts.push(b.pos[0], b.pos[1], b.pos[2]);
	}
	const geom = new THREE.BufferGeometry();
	if (pts.length === 0) {
		// No edges (single root) — fall back to a point per joint.
		const flat = bones.flatMap((b) => b.pos as number[]);
		geom.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
	} else {
		geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
	}
	geom.computeBoundingSphere();
	geom.computeBoundingBox();
	return geom;
}

/**
 * Convert a decoded ModelMesh into typed arrays suitable for a BufferGeometry.
 * A base .model often has indices but no positions (the section table is not yet
 * resolved); such meshes are not renderable and are filtered out by the caller.
 */
function toRenderMesh(mesh: ModelMesh, submeshIndex: number): RenderMesh | null {
	if (!mesh.positions || mesh.positions.length < 9) return null; // need >=3 verts
	const positions = Float32Array.from(mesh.positions);
	const vertexCount = positions.length / 3;
	// Decide between a TRIANGLE mesh and a POINT CLOUD. A mesh is drawn as points
	// whenever it has no usable triangle topology: either no indices at all (the
	// skinned .model variant, whose index buffer is stripped — see model.ts) or
	// indices that are out of range. Fabricating a sequential [0,1,2,…] triangle
	// list for such meshes is exactly what produced the radiating "spike soup"
	// (AA_HelicopterShockwave, AA_Bell206B): it connects unrelated disc vertices
	// into giant triangles. A clean point cloud is the honest, non-broken result.
	const hasTriangles =
		!!mesh.indices && mesh.indices.length >= 3 && mesh.indices.every((i) => i >= 0 && i < vertexCount);
	const points = !hasTriangles;
	// For a point cloud the index is just the identity (used by the point draw and
	// the glTF export); for a triangle mesh it is the real triangle list.
	const indices = hasTriangles
		? Uint32Array.from(mesh.indices)
		: Uint32Array.from({ length: vertexCount }, (_, i) => i);
	// Carry UVs through when the decoder recovered them (float32 P3+UV buffers).
	let uv: Float32Array | undefined;
	if (mesh.uv && mesh.uv.length === vertexCount * 2) {
		uv = Float32Array.from(mesh.uv);
	}
	return { positions, indices, vertexCount, uv, submeshIndex, points };
}

/**
 * An axis-aligned "core body" box, in the decoded-vertex coordinate frame, used to
 * cull out-of-body-space stray triangles before rendering / auto-fitting.
 */
export type CoreBox = { min: [number, number, number]; max: [number, number, number] };

/** Inclusive point-in-box test (a triangle survives only if ALL its verts pass). */
function inBox(box: CoreBox, x: number, y: number, z: number): boolean {
	return (
		x >= box.min[0] &&
		x <= box.max[0] &&
		y >= box.min[1] &&
		y <= box.max[1] &&
		z >= box.min[2] &&
		z <= box.max[2]
	);
}

/** The p-th percentile of an already-sorted ascending array (clamped index). */
function percentileSorted(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
	return sorted[i];
}

/** True when a header AABB is usable as a box (finite, non-degenerate on all axes). */
function isPlausibleBox(b: ModelBounds): b is NonNullable<ModelBounds> {
	if (!b) return false;
	const ok = [...b.min, ...b.max].every((v) => Number.isFinite(v));
	if (!ok) return false;
	return (
		b.max[0] - b.min[0] > 1e-4 &&
		b.max[1] - b.min[1] > 1e-4 &&
		b.max[2] - b.min[2] > 1e-4
	);
}

/**
 * Compute a robust "core body" box for a set of TRIANGLE meshes, in the decoded
 * vertex frame, used both to cull out-of-body-space stray triangles and to drive
 * AutoFit. This is the brief's fix for the Musclecar_01 "dagger + spike" artifact:
 * a small minority of faithfully-decoded auxiliary flat-fan triangles live in a
 * different local frame and reach far out (x≈4.73, y≈-4.11 vs the real body ±~2.5
 * m), mixed WITHIN submeshes. AutoFit over the full extent then frames empty space.
 *
 * Strategy (in priority order), all per-axis:
 *   1. The model header AABB (`headerBounds`) IF it is plausible (finite,
 *      non-degenerate) AND it is genuinely TIGHTER than the full vertex extent on
 *      at least one axis (so it would actually constrain). In Split/Second the
 *      decoded `model.bounds` is the full vertex extent (it bakes in the strays),
 *      so this branch is for models whose header box is a real, tighter culling
 *      box in the same frame.
 *   2. Otherwise a percentile box: per axis the [p1, p99] inter-percentile range,
 *      re-centred and widened by `margin` (~1.3). The 1%-tail trim drops the rare
 *      far outliers (the fans) while the margin keeps the whole real body. For a
 *      clean mesh with no outliers p1/p99 ≈ min/max, so the box ≈ the full extent
 *      and NOTHING is culled — props and point clouds are unaffected.
 *
 * Returns `null` when there are no triangle vertices to bound.
 */
export function computeCoreBox(
	meshes: RenderMesh[],
	headerBounds: ModelBounds = null,
	margin = 1.3,
): CoreBox | null {
	// Gather per-axis vertex coordinates that participate in triangles.
	const xs: number[] = [];
	const ys: number[] = [];
	const zs: number[] = [];
	for (const m of meshes) {
		if (m.points) continue; // point clouds carry no triangles to cull
		const p = m.positions;
		for (let i = 0; i + 2 < p.length; i += 3) {
			const x = p[i];
			const y = p[i + 1];
			const z = p[i + 2];
			if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
			xs.push(x);
			ys.push(y);
			zs.push(z);
		}
	}
	if (xs.length === 0) return null;
	xs.sort((a, b) => a - b);
	ys.sort((a, b) => a - b);
	zs.sort((a, b) => a - b);
	const fullMin: [number, number, number] = [xs[0], ys[0], zs[0]];
	const fullMax: [number, number, number] = [
		xs[xs.length - 1],
		ys[ys.length - 1],
		zs[zs.length - 1],
	];

	// 1. A plausible header AABB that is tighter than the full extent on some axis
	//    (a real, in-frame culling box) is preferred — clamped to the full extent so
	//    a too-large header can never EXPAND the box (which would cull nothing).
	if (isPlausibleBox(headerBounds)) {
		const tighter =
			headerBounds.min[0] > fullMin[0] + 1e-4 ||
			headerBounds.min[1] > fullMin[1] + 1e-4 ||
			headerBounds.min[2] > fullMin[2] + 1e-4 ||
			headerBounds.max[0] < fullMax[0] - 1e-4 ||
			headerBounds.max[1] < fullMax[1] - 1e-4 ||
			headerBounds.max[2] < fullMax[2] - 1e-4;
		if (tighter) {
			return {
				min: [
					Math.max(headerBounds.min[0], fullMin[0]),
					Math.max(headerBounds.min[1], fullMin[1]),
					Math.max(headerBounds.min[2], fullMin[2]),
				],
				max: [
					Math.min(headerBounds.max[0], fullMax[0]),
					Math.min(headerBounds.max[1], fullMax[1]),
					Math.min(headerBounds.max[2], fullMax[2]),
				],
			};
		}
	}

	// 2. Percentile box: [p1, p99] re-centred and widened by `margin`, then clamped
	//    to the full extent (the box never reaches beyond real geometry). For a
	//    clean mesh p1/p99 ≈ min/max → box ≈ full extent → no culling.
	const axisBox = (sorted: number[], fMin: number, fMax: number): [number, number] => {
		const lo = percentileSorted(sorted, 1);
		const hi = percentileSorted(sorted, 99);
		const c = (lo + hi) / 2;
		const half = ((hi - lo) / 2) * margin;
		return [Math.max(c - half, fMin), Math.min(c + half, fMax)];
	};
	const bx = axisBox(xs, fullMin[0], fullMax[0]);
	const by = axisBox(ys, fullMin[1], fullMax[1]);
	const bz = axisBox(zs, fullMin[2], fullMax[2]);
	return { min: [bx[0], by[0], bz[0]], max: [bx[1], by[1], bz[1]] };
}

/**
 * Per-triangle cull a list of triangle meshes to a core box: a triangle survives
 * only if ALL THREE of its vertices fall inside the box. Returns NEW RenderMesh
 * objects (positions reused; indices filtered) plus the count of culled triangles.
 * Point meshes are passed through untouched. Because the fans are mixed WITHIN
 * submeshes (specific index ranges), this is a per-triangle filter, not a
 * per-submesh drop.
 *
 * SAFETY: if the box would remove a LARGE fraction of triangles (>= `maxCullFrac`,
 * default 25%) the mesh almost certainly has no isolated outliers — it is just
 * legitimately spread — so we cull NOTHING and report 0. This keeps the fix honest:
 * it only ever trims a small stray minority, never mutilates real geometry.
 */
export function cullTrianglesToCore(
	meshes: RenderMesh[],
	box: CoreBox | null,
	maxCullFrac = 0.25,
): { meshes: RenderMesh[]; culled: number } {
	if (!box) return { meshes, culled: 0 };
	// First pass: count what the box would remove (so the safety gate sees the total).
	let totalTris = 0;
	let wouldCull = 0;
	for (const m of meshes) {
		if (m.points) continue;
		const p = m.positions;
		const idx = m.indices;
		for (let t = 0; t + 2 < idx.length; t += 3) {
			totalTris++;
			const a = idx[t];
			const b = idx[t + 1];
			const c = idx[t + 2];
			const keep =
				inBox(box, p[a * 3], p[a * 3 + 1], p[a * 3 + 2]) &&
				inBox(box, p[b * 3], p[b * 3 + 1], p[b * 3 + 2]) &&
				inBox(box, p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
			if (!keep) wouldCull++;
		}
	}
	// No outliers, or too many would go — leave the geometry untouched.
	if (wouldCull === 0 || (totalTris > 0 && wouldCull / totalTris >= maxCullFrac)) {
		return { meshes, culled: 0 };
	}
	// Second pass: rebuild the filtered index lists.
	const out: RenderMesh[] = [];
	let culled = 0;
	for (const m of meshes) {
		if (m.points) {
			out.push(m);
			continue;
		}
		const p = m.positions;
		const idx = m.indices;
		const kept: number[] = [];
		for (let t = 0; t + 2 < idx.length; t += 3) {
			const a = idx[t];
			const b = idx[t + 1];
			const c = idx[t + 2];
			const keep =
				inBox(box, p[a * 3], p[a * 3 + 1], p[a * 3 + 2]) &&
				inBox(box, p[b * 3], p[b * 3 + 1], p[b * 3 + 2]) &&
				inBox(box, p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
			if (keep) kept.push(a, b, c);
			else culled++;
		}
		out.push({ ...m, indices: Uint32Array.from(kept) });
	}
	return { meshes: out, culled };
}

/**
 * Build a single un-indexed THREE point-cloud geometry from the positions of all
 * supplied meshes. Used both to DRAW point-only meshes (skinned .model variant,
 * topology stripped) and to provide a bounding sphere for AutoFit. Never builds a
 * triangle index, so it can never produce the spike soup.
 */
function buildPointsGeometry(meshes: RenderMesh[]): THREE.BufferGeometry | null {
	if (meshes.length === 0) return null;
	let totalVerts = 0;
	for (const m of meshes) totalVerts += m.positions.length / 3;
	if (totalVerts === 0) return null;
	const positions = new Float32Array(totalVerts * 3);
	let vOff = 0;
	for (const m of meshes) {
		positions.set(m.positions, vOff * 3);
		vOff += m.positions.length / 3;
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geom.computeBoundingSphere();
	geom.computeBoundingBox();
	return geom;
}

/** Build merged THREE geometry from all renderable submeshes (for display). */
function buildGeometry(meshes: RenderMesh[]): THREE.BufferGeometry | null {
	if (meshes.length === 0) return null;
	// Merge by concatenating vertices and rebasing indices — one geometry keeps
	// the scene/auto-fit simple and avoids per-mesh component churn.
	let totalVerts = 0;
	let totalIdx = 0;
	for (const m of meshes) {
		totalVerts += m.positions.length / 3;
		totalIdx += m.indices.length;
	}
	const positions = new Float32Array(totalVerts * 3);
	const indices = new Uint32Array(totalIdx);
	let vOff = 0;
	let iOff = 0;
	for (const m of meshes) {
		positions.set(m.positions, vOff * 3);
		for (let i = 0; i < m.indices.length; i++) indices[iOff + i] = m.indices[i] + vOff;
		vOff += m.positions.length / 3;
		iOff += m.indices.length;
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geom.setIndex(new THREE.BufferAttribute(indices, 1));
	geom.computeVertexNormals();
	// Bound only the vertices actually REFERENCED by the (possibly culled) index
	// buffer, not every position. THREE's computeBoundingSphere/Box ignore the
	// index and span all positions — which would re-include the stray verts we just
	// culled from the triangle list, re-inflating AutoFit (the whole point of the
	// cull is to frame the car). When no triangles were culled this equals the full
	// extent, so clean models are unaffected.
	setIndexedBounds(geom, positions, indices);
	return geom;
}

/**
 * Set a geometry's boundingBox + boundingSphere from ONLY the vertices referenced
 * by `indices` (a triangle list). Used so AutoFit frames the drawn surface, not
 * orphaned positions left behind by the core-box cull. Falls back to all positions
 * when the index list is empty.
 */
function setIndexedBounds(
	geom: THREE.BufferGeometry,
	positions: Float32Array,
	indices: Uint32Array,
): void {
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity,
		mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	let any = false;
	const consider = (vi: number) => {
		const x = positions[vi * 3];
		const y = positions[vi * 3 + 1];
		const z = positions[vi * 3 + 2];
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
		any = true;
		if (x < mnx) mnx = x;
		if (y < mny) mny = y;
		if (z < mnz) mnz = z;
		if (x > mxx) mxx = x;
		if (y > mxy) mxy = y;
		if (z > mxz) mxz = z;
	};
	if (indices.length > 0) for (let i = 0; i < indices.length; i++) consider(indices[i]);
	else for (let vi = 0; vi < positions.length / 3; vi++) consider(vi);
	if (!any) {
		geom.computeBoundingSphere();
		geom.computeBoundingBox();
		return;
	}
	const box = new THREE.Box3(
		new THREE.Vector3(mnx, mny, mnz),
		new THREE.Vector3(mxx, mxy, mxz),
	);
	geom.boundingBox = box;
	const center = box.getCenter(new THREE.Vector3());
	// Radius = max distance from the box centre to any referenced vertex.
	let r2 = 0;
	const acc = (vi: number) => {
		const dx = positions[vi * 3] - center.x;
		const dy = positions[vi * 3 + 1] - center.y;
		const dz = positions[vi * 3 + 2] - center.z;
		if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return;
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 > r2) r2 = d2;
	};
	if (indices.length > 0) for (let i = 0; i < indices.length; i++) acc(indices[i]);
	else for (let vi = 0; vi < positions.length / 3; vi++) acc(vi);
	geom.boundingSphere = new THREE.Sphere(center, Math.sqrt(r2));
}

/** Build one THREE geometry per submesh (so each keeps its own UVs + material). */
function buildSubmeshGeometry(m: RenderMesh): THREE.BufferGeometry {
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
	geom.setIndex(new THREE.BufferAttribute(m.indices, 1));
	if (m.uv && m.uv.length === (m.positions.length / 3) * 2) {
		geom.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
	}
	geom.computeVertexNormals();
	geom.computeBoundingSphere();
	geom.computeBoundingBox();
	return geom;
}

/**
 * Wrap a decoded RGBA8 texture (top mip) in a THREE.DataTexture suitable for a
 * standard material's `map`. Flips V (the .textures decoder hands rows top-down;
 * glTF/THREE sample bottom-up) and enables wrap + sRGB so the albedo reads true.
 */
function makeDiffuseTexture(decoded: DecodedTexture): THREE.DataTexture | null {
	if (!decoded.rgba) return null;
	// DataTexture wants a Uint8Array; copy out of the Uint8ClampedArray. Build the
	// buffer explicitly (`.buffer` is ArrayBufferLike, which can be a
	// SharedArrayBuffer under DOM lib typings) and `.set` the clamped bytes in.
	const data = new Uint8Array(decoded.rgba.length);
	data.set(decoded.rgba);
	const tex = new THREE.DataTexture(data, decoded.width, decoded.height, THREE.RGBAFormat);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.flipY = true;
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.generateMipmaps = true;
	tex.anisotropy = 4;
	tex.needsUpdate = true;
	return tex;
}

/** Position the camera so the whole bounding sphere fits the current frustum. */
function AutoFit({ geometry }: { geometry: THREE.BufferGeometry }) {
	const { camera } = useThree();
	const controls = useThree((s) => s.controls) as unknown as
		| { target: THREE.Vector3; update: () => void }
		| null;

	useEffect(() => {
		const sphere = geometry.boundingSphere;
		if (!sphere) return;
		const { center, radius } = sphere;
		const r = radius > 0 && Number.isFinite(radius) ? radius : 1;
		const cam = camera as THREE.PerspectiveCamera;
		const fov = (cam.fov ?? 50) * (Math.PI / 180);
		const dist = (r / Math.sin(fov / 2)) * 1.3;
		cam.near = Math.max(dist / 1000, 0.001);
		cam.far = dist * 1000;
		cam.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
		cam.lookAt(center);
		cam.updateProjectionMatrix();
		if (controls) {
			controls.target.copy(center);
			controls.update();
		}
		// re-fit whenever the geometry identity changes
	}, [geometry, camera, controls]);

	return null;
}

/** Encode the renderable meshes as a binary glTF (.glb) byte buffer. */
async function exportGlb(meshes: RenderMesh[]): Promise<Uint8Array> {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const scene = doc.createScene('split-second-model');
	const material = doc
		.createMaterial('material')
		.setBaseColorFactor([0.72, 0.74, 0.78, 1])
		.setMetallicFactor(0.1)
		.setRoughnessFactor(0.8)
		.setDoubleSided(true);

	meshes.forEach((m, i) => {
		const pos: Accessor = doc
			.createAccessor(`positions_${i}`)
			.setType('VEC3')
			.setArray(m.positions)
			.setBuffer(buffer);
		const idx: Accessor = doc
			.createAccessor(`indices_${i}`)
			.setType('SCALAR')
			.setArray(m.indices)
			.setBuffer(buffer);
		const prim = doc
			.createPrimitive()
			.setAttribute('POSITION', pos)
			.setIndices(idx)
			.setMaterial(material);
		// Carry UVs into the glTF when the decoder recovered them, so the export
		// keeps texture coordinates for downstream texturing.
		if (m.uv && m.uv.length === (m.positions.length / 3) * 2) {
			const tex: Accessor = doc
				.createAccessor(`texcoord_${i}`)
				.setType('VEC2')
				.setArray(m.uv)
				.setBuffer(buffer);
			prim.setAttribute('TEXCOORD_0', tex);
		}
		const mesh = doc.createMesh(`mesh_${i}`).addPrimitive(prim);
		const node = doc.createNode(`node_${i}`).setMesh(mesh);
		scene.addChild(node);
	});

	const io = new WebIO();
	return io.writeBinary(doc);
}

function triCount(geometry: THREE.BufferGeometry): number {
	const idx = geometry.getIndex();
	return idx ? idx.count / 3 : geometry.getAttribute('position').count / 3;
}

/** Swap the trailing extension on a loose path: ".../foo.model" -> ".../foo.textures". */
function swapExt(looseId: string, newExt: string): string {
	const dot = looseId.lastIndexOf('.');
	const base = dot >= 0 ? looseId.slice(0, dot) : looseId;
	return base + newExt;
}

/** The base name (no directory, no extension) of a loose path: ".../Musclecar_01.model" -> "Musclecar_01". */
function baseNameOf(looseId: string): string {
	const slash = Math.max(looseId.lastIndexOf('/'), looseId.lastIndexOf('\\'));
	const file = slash >= 0 ? looseId.slice(slash + 1) : looseId;
	const dot = file.lastIndexOf('.');
	return dot >= 0 ? file.slice(0, dot) : file;
}

/**
 * Discover same-directory, same-base ".textures" siblings of a model from the
 * workspace tree (directory-backed). A car body keeps its livery + damage maps in
 * SUFFIXED siblings ("<base>_bodyPaint.textures", "<base>_damageMap.textures")
 * rather than the plain "<base>.textures". We return every loose path matching
 * "<base>_<suffix>.textures" in the model's directory, EXCLUDING:
 *   - the plain "<base>.textures" (loaded separately as the base container)
 *   - any "*_low.textures" / "*.low.textures" low-res variant
 *
 * Walks the unified `tree` (the enumerated directory structure); returns [] for a
 * drag-drop / in-memory selection that isn't directory-backed (no harm — the base
 * "<base>.textures" still loads via the standard path).
 */
function findTextureSiblings(tree: TreeNode[], modelPath: string): string[] {
	const slash = Math.max(modelPath.lastIndexOf('/'), modelPath.lastIndexOf('\\'));
	const dir = slash >= 0 ? modelPath.slice(0, slash) : '';
	const base = baseNameOf(modelPath);
	// Match "<dir>/<base>_<suffix>.textures" (suffix non-empty), not low-res.
	const lowerBase = base.toLowerCase();
	const lowerDir = dir.toLowerCase();

	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (node: TreeNode) => {
		if (node.ref?.kind === 'loose') {
			const id = node.ref.looseId;
			const idLower = id.toLowerCase();
			const sl = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\'));
			const nodeDir = (sl >= 0 ? id.slice(0, sl) : '').toLowerCase();
			if (
				nodeDir === lowerDir &&
				idLower.endsWith('.textures') &&
				!idLower.endsWith('.low.textures') &&
				!idLower.endsWith('_low.textures')
			) {
				const fileBase = baseNameOf(id).toLowerCase();
				// "<base>_<something>" but not the plain "<base>".
				if (fileBase.startsWith(lowerBase + '_') && fileBase !== lowerBase && !seen.has(id)) {
					seen.add(id);
					out.push(id);
				}
			}
		}
		for (const c of node.children ?? []) visit(c);
	};
	for (const n of tree) visit(n);
	// Stable order with the body-paint container first so the livery fallback in
	// buildMaterials draws from it (it sorts before _damageMap alphabetically).
	out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return out;
}

/**
 * Load the current .model's sibling material assets (.textures / .shaderinst /
 * .shaders / .tex.crcs / .streamtex) from the workspace and resolve per-submesh
 * materials via buildMaterials. This is the STANDARD texturing path: ANY loose,
 * directory-backed .model whose material siblings sit in the same folder gets
 * textured by default (vehicles, props, the helicopter — all the same code path,
 * no special cases). Returns null while loading, when the selection isn't a loose
 * .model, or when no .shaderinst/.textures siblings exist (so the viewer falls
 * back to the flat material). `submeshCount` lets buildMaterials report whether
 * the submesh count matched the shaderinst node count.
 */
function useSiblingMaterials(submeshCount: number): BuiltMaterials | null {
	const { selection, getResourceBytes, tree } = useWorkspace();
	const [built, setBuilt] = useState<BuiltMaterials | null>(null);

	// The loose path of the selected .model. Materials resolve for any loose,
	// directory-backed selection whose siblings live in the same directory.
	const modelPath =
		selection?.ref.kind === 'loose' && /\.model$/i.test(selection.ref.looseId)
			? selection.ref.looseId
			: null;

	// Same-directory, same-base suffixed ".textures" siblings (car bodies:
	// _bodyPaint = livery, _damageMap = damage overlay). Discovered from the
	// directory-backed tree; joined as a stable string so the effect re-runs only
	// when the discovered set actually changes (not on every tree identity).
	const siblingKey = useMemo(
		() => (modelPath ? findTextureSiblings(tree, modelPath).join('\n') : ''),
		[tree, modelPath],
	);

	useEffect(() => {
		let cancelled = false;
		setBuilt(null);
		if (!modelPath) return;

		const looseRef = (looseId: string): ResourceRef => ({ kind: 'loose', looseId });
		const load = async (looseId: string): Promise<Uint8Array | null> => {
			try {
				return await getResourceBytes(looseRef(looseId));
			} catch {
				return null;
			}
		};
		const loadExt = (ext: string) => load(swapExt(modelPath, ext));

		void (async () => {
			const siblingPaths = siblingKey ? siblingKey.split('\n') : [];
			const [textures, shaderinst, shaders, texCrcs, streamtex] = await Promise.all([
				loadExt('.textures'),
				loadExt('.shaderinst'),
				loadExt('.shaders'),
				loadExt('.tex.crcs'),
				loadExt('.streamtex'),
			]);
			// Load the discovered suffixed siblings (car livery + damage maps).
			const extraTextures = await Promise.all(siblingPaths.map((p) => load(p)));
			if (cancelled) return;
			// Nothing material-bearing alongside this model — leave null (flat render).
			if (!shaderinst && !textures && extraTextures.every((b) => !b)) return;
			try {
				const result = buildMaterials({
					textures,
					extraTextures,
					shaderinst,
					shaders,
					texCrcs,
					streamtex,
					submeshCount,
					baseName: baseNameOf(modelPath),
				});
				if (!cancelled) setBuilt(result);
			} catch {
				if (!cancelled) setBuilt(null);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [modelPath, siblingKey, submeshCount, getResourceBytes]);

	return built;
}

/**
 * Render each submesh with its resolved material. The textured path uses a
 * MeshStandardMaterial with the submesh's diffuse DataTexture UV-mapped; submeshes
 * without a diffuse fall back to their base colour (or a neutral grey). The flat
 * path drops the texture (base colour / grey only). Wireframe overlays edges.
 */
function TexturedSubmeshes({
	meshes,
	materials,
	mode,
}: {
	meshes: RenderMesh[];
	materials: BuiltMaterials;
	mode: ViewMode;
}) {
	// Build geometries + diffuse textures once per mesh/material set; dispose on swap.
	const entries = useMemo(() => {
		return meshes.map((m) => {
			const geom = buildSubmeshGeometry(m);
			const mat: SubmeshMaterial | undefined =
				materials.submeshes.length > 0
					? materials.submeshes[Math.min(m.submeshIndex, materials.submeshes.length - 1)]
					: undefined;
			const hasUv = !!geom.getAttribute('uv');
			const diffuse =
				mode === 'textured' && hasUv && mat?.diffuseTexture
					? makeDiffuseTexture(mat.diffuseTexture)
					: null;
			// DXT1 albedo bodies (heli, barrels, skycrane) are effectively opaque —
			// render them in the opaque queue so double-sided geometry doesn't z-fight
			// through the transparent sort. DXT5/DXT3 maps can carry smooth alpha
			// (glass, decals), so those blend. Either way an alphaTest cutout drops
			// fully-transparent texels without needing the blend path.
			const fmt = mat?.diffuseTexture?.format;
			const smoothAlpha = fmt === 'DXT5' || fmt === 'DXT3';
			const base = mat?.params.baseColor;
			const color = base
				? new THREE.Color(base[0], base[1], base[2])
				: new THREE.Color('#b9bcc4');
			return { geom, diffuse, color, smoothAlpha };
		});
	}, [meshes, materials, mode]);

	useEffect(() => {
		return () => {
			for (const e of entries) {
				e.geom.dispose();
				e.diffuse?.dispose();
			}
		};
	}, [entries]);

	return (
		<>
			{entries.map((e, i) => (
				<mesh key={i} geometry={e.geom}>
					<meshStandardMaterial
						map={e.diffuse ?? null}
						color={e.diffuse ? '#ffffff' : e.color}
						metalness={0.1}
						roughness={0.78}
						wireframe={mode === 'wireframe'}
						side={THREE.DoubleSide}
						transparent={!!e.diffuse && e.smoothAlpha}
						alphaTest={e.diffuse ? 0.01 : 0}
					/>
				</mesh>
			))}
		</>
	);
}

export function MeshViewer({ model, raw, handler }: MeshViewerProps) {
	const [viewMode, setViewMode] = useState<ViewMode>('textured');
	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	// "Show stray parts" — when OFF (default) we render the culled CORE geometry so
	// the camera frames the car; when ON we render the full faithful geometry. Only
	// surfaced when culling actually removed triangles (see strayTriCount below).
	const [showStray, setShowStray] = useState(false);
	const objectUrlRef = useRef<string | null>(null);

	const parsed = useMemo(() => asParsedModel(model), [model]);
	const havok = useMemo(() => asHavokModel(model), [model]);
	const bones = useMemo(() => asDrawBones(model), [model]);
	const skeletonGeom = useMemo(() => buildSkeletonGeometry(bones), [bones]);

	// Dispose the skeleton geometry when replaced/unmounted.
	useEffect(() => {
		return () => {
			skeletonGeom?.dispose();
		};
	}, [skeletonGeom]);

	const renderMeshes = useMemo<RenderMesh[]>(() => {
		if (!parsed) return [];
		const out: RenderMesh[] = [];
		// IMPORTANT: keep the ORIGINAL submesh index (node order) so it maps to the
		// resolved material, even when an earlier submesh had no geometry.
		parsed.meshes.forEach((mesh, idx) => {
			const rm = toRenderMesh(mesh, idx);
			if (rm) out.push(rm);
		});
		return out;
	}, [parsed]);

	// Split surfaces (real triangle topology) from point clouds (positions only —
	// the skinned .model variant, whose index buffer is stripped). Point meshes
	// are drawn as <points>, NEVER fabricated into triangles (the spike-soup bug).
	const allTriangleMeshes = useMemo(() => renderMeshes.filter((m) => !m.points), [renderMeshes]);
	const pointMeshes = useMemo(() => renderMeshes.filter((m) => m.points), [renderMeshes]);

	// CORE-BOX CULL: a small minority of faithfully-decoded triangles (Musclecar_01
	// auxiliary flat fans) live in a different local frame and reach far past the
	// real body, mixed WITHIN submeshes. They blow up AutoFit (the "dagger + spike"
	// artifact) even though ~99% of the body is a correct shell. We compute a robust
	// CORE box and per-triangle cull anything outside it (positions are the faithful
	// decode — we only HIDE the strays, never mutate the parser). For clean models
	// (props, point clouds) the box ≈ full extent so nothing is culled.
	const coreBox = useMemo(
		() => computeCoreBox(allTriangleMeshes, parsed?.bounds ?? null),
		[allTriangleMeshes, parsed],
	);
	const culled = useMemo(
		() => cullTrianglesToCore(allTriangleMeshes, coreBox),
		[allTriangleMeshes, coreBox],
	);
	const strayTriCount = culled.culled;
	const hasStray = strayTriCount > 0;
	// Render the CORE meshes by default; the full faithful set when "Show stray
	// parts" is ON. When nothing was culled both are the same array.
	const triangleMeshes = showStray ? allTriangleMeshes : culled.meshes;

	// Resolve per-submesh materials from the sibling .textures/.shaderinst/etc.
	const materials = useSiblingMaterials(parsed?.meshes.length ?? 0);

	// A textured render is possible only when materials resolved AND at least one
	// renderable submesh both has UVs and a diffuse texture.
	const canTexture = useMemo(() => {
		if (!materials || materials.submeshes.length === 0) return false;
		return renderMeshes.some((m) => {
			if (!m.uv) return false;
			const mat = materials.submeshes[Math.min(m.submeshIndex, materials.submeshes.length - 1)];
			return !!mat?.diffuseTexture;
		});
	}, [materials, renderMeshes]);

	// If textures aren't available, never sit in 'textured' mode.
	const effectiveMode: ViewMode = viewMode === 'textured' && !canTexture ? 'flat' : viewMode;

	// Surface geometry (merged triangle meshes) and point-cloud geometry (point
	// meshes) are built separately so each renders with the right primitive.
	const geometry = useMemo(() => buildGeometry(triangleMeshes), [triangleMeshes]);
	const pointsGeometry = useMemo(() => buildPointsGeometry(pointMeshes), [pointMeshes]);
	// AutoFit and the "has geometry" guard need a sphere over EVERYTHING; reuse the
	// surface geometry when present, else the point cloud.
	const fitGeometry = geometry ?? pointsGeometry;

	// Dispose the GPU geometries when they are replaced/unmounted.
	useEffect(() => {
		return () => {
			geometry?.dispose();
		};
	}, [geometry]);
	useEffect(() => {
		return () => {
			pointsGeometry?.dispose();
		};
	}, [pointsGeometry]);

	// Revoke any object URL we created for the glTF download.
	useEffect(() => {
		return () => {
			if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
		};
	}, []);

	const handleExport = async () => {
		// Export real triangle surfaces only; point-cloud meshes (skinned variant,
		// topology stripped) have no triangle list worth writing to glTF.
		if (triangleMeshes.length === 0) return;
		setExporting(true);
		setExportError(null);
		try {
			const glb = await exportGlb(triangleMeshes);
			// Copy into a standalone ArrayBuffer for a clean Blob (avoids SAB typing).
			const bytes = new Uint8Array(glb.byteLength);
			bytes.set(glb);
			const blob = new Blob([bytes], { type: 'model/gltf-binary' });
			if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
			const url = URL.createObjectURL(blob);
			objectUrlRef.current = url;
			const a = document.createElement('a');
			a.href = url;
			a.download = `${handler?.key ?? 'model'}.glb`;
			document.body.appendChild(a);
			a.click();
			a.remove();
		} catch (err) {
			setExportError(String((err as Error)?.message ?? err));
		} finally {
			setExporting(false);
		}
	};

	// --- Graceful fallbacks -------------------------------------------------

	if (!parsed) {
		// A .skel parses to a bone hierarchy (no meshes[]) — draw it as a skeleton.
		if (skeletonGeom && bones.length > 0) {
			return (
				<SkeletonScene
					geometry={skeletonGeom}
					boneCount={bones.length}
					hasEdges={bones.some((b) => bones.some((p) => p.index === b.parent))}
				/>
			);
		}
		return (
			<Placeholder
				icon={<AlertTriangle className="h-8 w-8" />}
				title="No mesh model"
				detail={
					raw
						? 'The selected resource did not parse into a renderable model.'
						: 'No data selected.'
				}
			/>
		);
	}

	if (!fitGeometry || renderMeshes.length === 0) {
		// Base .model commonly decodes indices but no positions (the per-section
		// vertex table is still unmapped) — explain rather than show a void.
		const isBase = parsed.kind === 'model';
		const detail = havok
			? 'This Havok packfile carries no recoverable collision geometry — its ' +
			  'triangle-mesh vertex/index buffers are SERIALIZE_IGNORED (not written to ' +
			  'disk). Vehicle .mainColl/.phys convex hulls do render; level .hkColl shows ' +
			  'only an AABB box. See the field inspector for the decoded physics fields.'
			: isBase
				? 'This base .model decoded node/bounds metadata but no vertex positions ' +
				  '(the per-section vertex format lives in the still-unmapped node tree). ' +
				  'Open its .model.stream twin to view high-LOD geometry.'
				: 'The stream payload contained no decodable vertex positions.';
		return (
			<Placeholder
				icon={<Boxes className="h-8 w-8" />}
				title="No renderable geometry"
				detail={detail}
			/>
		);
	}

	const tris = geometry ? triCount(geometry) : 0;
	const surfaceVerts = geometry ? geometry.getAttribute('position').count : 0;
	const pointVerts = pointsGeometry ? pointsGeometry.getAttribute('position').count : 0;
	const verts = surfaceVerts + pointVerts;
	// A model with no triangle surface at all (skinned variant, topology stripped)
	// is labelled as a point cloud so the "0 tris" reads as intentional, not broken.
	const pointsOnly = !geometry && pointVerts > 0;

	// Honest disclosure of the core-box cull: how many faithfully-decoded triangles
	// are hidden (default) or shown. Rendered only when culling actually removed any.
	const strayInfo = hasStray ? (
		<span title="Out-of-body-space auxiliary triangles, hidden by default so the car frames correctly. The decoded data is not lost — toggle Show stray parts to reveal them.">
			{' · '}
			{strayTriCount.toLocaleString()} stray tris {showStray ? 'shown' : 'hidden'}
		</span>
	) : null;

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-2">
				<Boxes className="h-4 w-4 text-accent" />
				<span className="text-sm font-medium">
					{havok
						? 'Collision'
						: pointsOnly
							? 'Point cloud'
							: parsed.kind === 'stream'
								? 'Model stream'
								: 'Model'}
				</span>
				<span className="text-xs text-muted-foreground">
					{verts.toLocaleString()} verts
					{pointsOnly
						? ' · points only (no topology)'
						: ` · ${Math.round(tris).toLocaleString()} tris`}
						{strayInfo}
					{materials && materials.submeshes.length > 0 && (
						<>
							{' · '}
							{materials.submeshes.filter((s) => s.diffuseTexture).length} textured
						</>
					)}
				</span>
				<div className="ml-auto flex items-center gap-2">
					{/* Show-stray toggle — only when culling actually removed triangles.
						    OFF (default) renders the framed core body; ON reveals the faithful
						    full geometry including the out-of-frame auxiliary strips. */}
						{hasStray && (
							<Button
								variant={showStray ? 'default' : 'outline'}
								size="sm"
								onClick={() => setShowStray((v) => !v)}
								title={
									showStray
										? 'Hide stray parts (frame the car body)'
										: 'Show stray parts (reveal hidden out-of-body geometry)'
								}
							>
								{showStray ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
								Show stray parts
							</Button>
						)}
						{/* Render-mode toggle: textured / flat / wireframe. */}
					<div className="flex items-center overflow-hidden rounded-md border border-border">
						<Button
							variant={effectiveMode === 'textured' ? 'default' : 'ghost'}
							size="sm"
							className="rounded-none border-0"
							onClick={() => setViewMode('textured')}
							disabled={!canTexture}
							title={
								canTexture
									? 'Textured (diffuse maps)'
									: 'No diffuse textures resolved for this model'
							}
						>
							<ImageIcon className="h-4 w-4" />
							Textured
						</Button>
						<Button
							variant={effectiveMode === 'flat' ? 'default' : 'ghost'}
							size="sm"
							className="rounded-none border-0"
							onClick={() => setViewMode('flat')}
							title="Flat shaded"
						>
							<Palette className="h-4 w-4" />
							Flat
						</Button>
						<Button
							variant={effectiveMode === 'wireframe' ? 'default' : 'ghost'}
							size="sm"
							className="rounded-none border-0"
							onClick={() => setViewMode('wireframe')}
							title="Wireframe"
						>
							<Grid3x3 className="h-4 w-4" />
							Wireframe
						</Button>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={handleExport}
						disabled={exporting || triangleMeshes.length === 0}
						title={
							triangleMeshes.length === 0
								? 'No triangle surface to export (point cloud only)'
								: 'Export glTF (.glb)'
						}
					>
						<Download className="h-4 w-4" />
						{exporting ? 'Exporting…' : 'Export glTF'}
					</Button>
				</div>
			</div>

			{exportError && (
				<div className="border-b border-destructive/50 bg-destructive/10 px-3 py-1 text-xs text-destructive">
					Export failed: {exportError}
				</div>
			)}

			{/* 3D canvas */}
			<div className="relative min-h-0 flex-1">
				<Canvas
					camera={{ position: [3, 2, 3], fov: 50, near: 0.01, far: 5000 }}
					dpr={[1, 2]}
					gl={{ antialias: true }}
				>
					<color attach="background" args={['#0b0e14']} />
					<ambientLight intensity={0.6} />
					<directionalLight position={[5, 10, 7]} intensity={1.1} />
					<directionalLight position={[-5, -3, -7]} intensity={0.4} />
					{/* SURFACE meshes (real triangle topology). Point-only meshes are
					    excluded here and drawn as a point cloud below — drawing them as
					    triangles would connect unrelated vertices into spike soup. */}
					{geometry &&
						(materials && materials.submeshes.length > 0 ? (
							// Per-submesh render with resolved materials (textured / flat /
							// wireframe). Each submesh keeps its own UVs + diffuse map.
							<TexturedSubmeshes
								meshes={triangleMeshes}
								materials={materials}
								mode={effectiveMode}
							/>
						) : (
							// No materials resolved — single merged mesh, flat or wireframe.
							<mesh geometry={geometry}>
								<meshStandardMaterial
									color="#b9bcc4"
									metalness={0.1}
									roughness={0.8}
									wireframe={effectiveMode === 'wireframe'}
									side={THREE.DoubleSide}
									flatShading={false}
								/>
							</mesh>
						))}
					{/* POINT-CLOUD meshes (skinned .model variant — topology stripped).
					    Point size scales with the model's bounding-sphere radius so the
					    cloud reads cleanly at any scale (a ~0.17u disc and a ~15u heli). */}
					{pointsGeometry && (
						<points geometry={pointsGeometry}>
							<pointsMaterial
								color="#8fd3ff"
								size={Math.max(
									(pointsGeometry.boundingSphere?.radius ?? 1) * 0.012,
									0.001,
								)}
								sizeAttenuation
							/>
						</points>
					)}
					{/* Paired skeleton overlay (when a .skel rig is attached). */}
					{skeletonGeom && (
						<lineSegments geometry={skeletonGeom}>
							<lineBasicMaterial color="#5ad1ff" />
						</lineSegments>
					)}
					<gridHelper args={[10, 10, '#2a3040', '#1a1f2b']} />
					<OrbitControls makeDefault enableDamping dampingFactor={0.1} />
					<AutoFit geometry={fitGeometry} />
				</Canvas>
			</div>
		</div>
	);
}

/** Standalone skeleton viewport for a .skel rig (no paired mesh). */
function SkeletonScene({
	geometry,
	boneCount,
	hasEdges,
}: {
	geometry: THREE.BufferGeometry;
	boneCount: number;
	hasEdges: boolean;
}) {
	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-2">
				<Boxes className="h-4 w-4 text-accent" />
				<span className="text-sm font-medium">Skeleton</span>
				<span className="text-xs text-muted-foreground">
					{boneCount.toLocaleString()} bone{boneCount === 1 ? '' : 's'}
				</span>
			</div>
			<div className="relative min-h-0 flex-1">
				<Canvas camera={{ position: [3, 2, 3], fov: 50, near: 0.01, far: 5000 }} dpr={[1, 2]}>
					<color attach="background" args={['#0b0e14']} />
					<ambientLight intensity={0.8} />
					{hasEdges ? (
						<lineSegments geometry={geometry}>
							<lineBasicMaterial color="#5ad1ff" />
						</lineSegments>
					) : (
						<points geometry={geometry}>
							<pointsMaterial color="#5ad1ff" size={0.08} sizeAttenuation />
						</points>
					)}
					<gridHelper args={[10, 10, '#2a3040', '#1a1f2b']} />
					<OrbitControls makeDefault enableDamping dampingFactor={0.1} />
					<AutoFit geometry={geometry} />
				</Canvas>
			</div>
		</div>
	);
}

function Placeholder({
	icon,
	title,
	detail,
}: {
	icon: React.ReactNode;
	title: string;
	detail: string;
}) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
			{icon}
			<p className="text-sm font-medium text-foreground">{title}</p>
			<p className="max-w-md text-xs leading-relaxed">{detail}</p>
		</div>
	);
}

export default MeshViewer;
