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
import { Boxes, Download, Grid3x3, AlertTriangle } from 'lucide-react';
import * as THREE from 'three';

import type { ParsedModel, ModelMesh } from '@/lib/core/model';
import type { ResourceHandler } from '@/lib/core/registry/handler';
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
};

/** Narrow the opaque model to a ParsedModel with at least the fields we read. */
function asParsedModel(model: unknown): ParsedModel | null {
	if (!model || typeof model !== 'object') return null;
	const m = model as Partial<ParsedModel>;
	if (!Array.isArray(m.meshes)) return null;
	return m as ParsedModel;
}

/**
 * Convert a decoded ModelMesh into typed arrays suitable for a BufferGeometry.
 * A base .model often has indices but no positions (the section table is not yet
 * resolved); such meshes are not renderable and are filtered out by the caller.
 */
function toRenderMesh(mesh: ModelMesh): RenderMesh | null {
	if (!mesh.positions || mesh.positions.length < 9) return null; // need >=3 verts
	const positions = Float32Array.from(mesh.positions);
	const vertexCount = positions.length / 3;
	// Use the explicit triangle indices when present & in range; otherwise draw
	// the vertex stream as a non-indexed point/triangle soup fallback.
	let indices: Uint32Array;
	if (mesh.indices && mesh.indices.length >= 3) {
		const valid = mesh.indices.every((i) => i >= 0 && i < vertexCount);
		indices = valid
			? Uint32Array.from(mesh.indices)
			: Uint32Array.from({ length: vertexCount }, (_, i) => i);
	} else {
		indices = Uint32Array.from({ length: vertexCount }, (_, i) => i);
	}
	return { positions, indices, vertexCount };
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

export function MeshViewer({ model, raw, handler }: MeshViewerProps) {
	const [wireframe, setWireframe] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	const objectUrlRef = useRef<string | null>(null);

	const parsed = useMemo(() => asParsedModel(model), [model]);

	const renderMeshes = useMemo<RenderMesh[]>(() => {
		if (!parsed) return [];
		const out: RenderMesh[] = [];
		for (const mesh of parsed.meshes) {
			const rm = toRenderMesh(mesh);
			if (rm) out.push(rm);
		}
		return out;
	}, [parsed]);

	const geometry = useMemo(() => buildGeometry(renderMeshes), [renderMeshes]);

	// Dispose the GPU geometry when it is replaced/unmounted.
	useEffect(() => {
		return () => {
			geometry?.dispose();
		};
	}, [geometry]);

	// Revoke any object URL we created for the glTF download.
	useEffect(() => {
		return () => {
			if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
		};
	}, []);

	const handleExport = async () => {
		if (renderMeshes.length === 0) return;
		setExporting(true);
		setExportError(null);
		try {
			const glb = await exportGlb(renderMeshes);
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

	if (!geometry || renderMeshes.length === 0) {
		// Base .model commonly decodes indices but no positions (the per-section
		// vertex table is still unmapped) — explain rather than show a void.
		const isBase = parsed.kind === 'model';
		return (
			<Placeholder
				icon={<Boxes className="h-8 w-8" />}
				title="No renderable geometry"
				detail={
					isBase
						? 'This base .model decoded node/bounds metadata but no vertex positions ' +
						  '(the per-section vertex format lives in the still-unmapped node tree). ' +
						  'Open its .model.stream twin to view high-LOD geometry.'
						: 'The stream payload contained no decodable vertex positions.'
				}
			/>
		);
	}

	const tris = triCount(geometry);
	const verts = geometry.getAttribute('position').count;

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-2">
				<Boxes className="h-4 w-4 text-accent" />
				<span className="text-sm font-medium">
					{parsed.kind === 'stream' ? 'Model stream' : 'Model'}
				</span>
				<span className="text-xs text-muted-foreground">
					{verts.toLocaleString()} verts · {Math.round(tris).toLocaleString()} tris
				</span>
				<div className="ml-auto flex items-center gap-2">
					<Button
						variant={wireframe ? 'default' : 'outline'}
						size="sm"
						onClick={() => setWireframe((w) => !w)}
						title="Toggle wireframe"
					>
						<Grid3x3 className="h-4 w-4" />
						Wireframe
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={handleExport}
						disabled={exporting}
						title="Export glTF (.glb)"
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
					<mesh geometry={geometry}>
						<meshStandardMaterial
							color="#b9bcc4"
							metalness={0.1}
							roughness={0.8}
							wireframe={wireframe}
							side={THREE.DoubleSide}
							flatShading={false}
						/>
					</mesh>
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
