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
import { Boxes, Download, Grid3x3, AlertTriangle, Image as ImageIcon, Palette } from 'lucide-react';
import * as THREE from 'three';

import type { ParsedModel, ModelMesh } from '@/lib/core/model';
import type { ResourceHandler } from '@/lib/core/registry/handler';
import { buildMaterials, type BuiltMaterials, type SubmeshMaterial } from '@/lib/core/material';
import type { DecodedTexture } from '@/lib/core/textures';
import { useWorkspace } from '@/context/WorkspaceContext';
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
	geom.computeBoundingSphere();
	geom.computeBoundingBox();
	return geom;
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
	const { selection, getResourceBytes } = useWorkspace();
	const [built, setBuilt] = useState<BuiltMaterials | null>(null);

	// The loose path of the selected .model. Materials resolve for any loose,
	// directory-backed selection whose siblings live in the same directory.
	const modelPath =
		selection?.ref.kind === 'loose' && /\.model$/i.test(selection.ref.looseId)
			? selection.ref.looseId
			: null;

	useEffect(() => {
		let cancelled = false;
		setBuilt(null);
		if (!modelPath) return;

		const looseRef = (looseId: string): ResourceRef => ({ kind: 'loose', looseId });
		const load = async (ext: string): Promise<Uint8Array | null> => {
			try {
				return await getResourceBytes(looseRef(swapExt(modelPath, ext)));
			} catch {
				return null;
			}
		};

		void (async () => {
			const [textures, shaderinst, shaders, texCrcs, streamtex] = await Promise.all([
				load('.textures'),
				load('.shaderinst'),
				load('.shaders'),
				load('.tex.crcs'),
				load('.streamtex'),
			]);
			if (cancelled) return;
			// Nothing material-bearing alongside this model — leave null (flat render).
			if (!shaderinst && !textures) return;
			try {
				const result = buildMaterials({
					textures,
					shaderinst,
					shaders,
					texCrcs,
					streamtex,
					submeshCount,
				});
				if (!cancelled) setBuilt(result);
			} catch {
				if (!cancelled) setBuilt(null);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [modelPath, submeshCount, getResourceBytes]);

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
	const triangleMeshes = useMemo(() => renderMeshes.filter((m) => !m.points), [renderMeshes]);
	const pointMeshes = useMemo(() => renderMeshes.filter((m) => m.points), [renderMeshes]);

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
					{materials && materials.submeshes.length > 0 && (
						<>
							{' · '}
							{materials.submeshes.filter((s) => s.diffuseTexture).length} textured
						</>
					)}
				</span>
				<div className="ml-auto flex items-center gap-2">
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
