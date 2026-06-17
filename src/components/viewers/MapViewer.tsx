// MapViewer — whole-level viewport. Decodes EVERY geometry member of a level's
// Static+Stream .ark pair and places them in ONE @react-three/fiber scene, so
// airport_test_03 (and any level) renders as a complete map.
//
// WORLD PLACEMENT (see src/lib/core/levelGeometry.ts header for the full RE):
//   Level .ark geometry is authored PRE-TRANSFORMED into world space — each
//   member's vertices already carry their final world coordinates, so the viewer
//   just decodes each member and renders it at its native position. There is no
//   per-object transform table to apply; the `.entities` transforms cover only
//   dynamic / spawn entities, not the static level mesh.
//
// PERFORMANCE: hundreds of members are MERGED into at most two BufferGeometries
// (one "clean" mesh, one "suspect" mesh) so the whole level is two draw calls,
// not hundreds — large levels (1M+ verts) stay interactive.
//
// HONESTY: model.ts decodes the Static `.sobj` shells well but mis-reads the
// Stream `.geo` high-LOD vertex streams as half-floats, spiking their coordinates
// to ±65504. Those parts are FLAGGED suspect by the loader, dimmed here, and
// toggleable — and the coverage note states exactly how much of the scene is
// affected. model.ts fixes land in a parallel work package.
//
// Props contract mirrors the other viewers: { model, raw, handler } where the
// MapViewer's `model` is a prepared LevelGeometry (built by the dispatcher when
// the user picks "Render whole level"). Tolerates a missing / empty model.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { Boxes, Eye, EyeOff, AlertTriangle, Map as MapIcon } from 'lucide-react';
import * as THREE from 'three';

import type { LevelGeometry, LevelPart } from '@/lib/core/levelGeometry';
import { Button } from '@/components/ui/button';

export type MapViewerProps = {
	/** Prepared whole-level geometry, or null/undefined while not yet built. */
	model?: LevelGeometry | null;
	/** Unused (kept for the shared viewer props contract). */
	raw?: Uint8Array | null;
	/** Unused here. */
	handler?: unknown;
};

/** Structural guard: is this opaque model a prepared LevelGeometry? */
export function isLevelGeometry(model: unknown): model is LevelGeometry {
	return (
		!!model &&
		typeof model === 'object' &&
		Array.isArray((model as Partial<LevelGeometry>).parts) &&
		typeof (model as Partial<LevelGeometry>).decodedCount === 'number'
	);
}

/**
 * Merge a set of level parts into ONE BufferGeometry (concatenated vertices with
 * rebased triangle indices). Returns null when the set is empty. This is what
 * keeps a several-hundred-member level to a single draw call.
 */
function mergeParts(parts: LevelPart[]): THREE.BufferGeometry | null {
	if (parts.length === 0) return null;
	let totalVerts = 0;
	let totalIdx = 0;
	for (const p of parts) {
		totalVerts += p.positions.length / 3;
		totalIdx += p.indices.length;
	}
	if (totalVerts === 0) return null;
	const positions = new Float32Array(totalVerts * 3);
	// 32-bit indices: a whole level easily exceeds the 16-bit vertex ceiling.
	const indices = new Uint32Array(totalIdx);
	let vOff = 0;
	let iOff = 0;
	for (const p of parts) {
		positions.set(p.positions, vOff * 3);
		for (let i = 0; i < p.indices.length; i++) indices[iOff + i] = p.indices[i] + vOff;
		vOff += p.positions.length / 3;
		iOff += p.indices.length;
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geom.setIndex(new THREE.BufferAttribute(indices, 1));
	geom.computeVertexNormals();
	geom.computeBoundingSphere();
	geom.computeBoundingBox();
	return geom;
}

/** Center + radius of the level's clean-part bounds (for camera framing). */
type Framing = { center: [number, number, number]; radius: number };

function framingFromBounds(bounds: LevelGeometry['bounds']): Framing {
	if (!bounds) return { center: [0, 0, 0], radius: 100 };
	const center: [number, number, number] = [
		(bounds.min[0] + bounds.max[0]) / 2,
		(bounds.min[1] + bounds.max[1]) / 2,
		(bounds.min[2] + bounds.max[2]) / 2,
	];
	const dx = bounds.max[0] - bounds.min[0];
	const dy = bounds.max[1] - bounds.min[1];
	const dz = bounds.max[2] - bounds.min[2];
	const radius = Math.max(10, Math.hypot(dx, dy, dz) / 2);
	return { center, radius };
}

/** Fit the camera to the level's framing on mount / when it changes. */
function AutoFit({ framing }: { framing: Framing }) {
	const { camera } = useThree();
	const controls = useThree((s) => s.controls) as unknown as
		| { target: THREE.Vector3; update: () => void }
		| null;
	useEffect(() => {
		const { center, radius } = framing;
		const cam = camera as THREE.PerspectiveCamera;
		const fov = (cam.fov ?? 50) * (Math.PI / 180);
		const dist = (radius / Math.sin(fov / 2)) * 1.2;
		cam.near = Math.max(dist / 5000, 0.1);
		cam.far = dist * 50 + 1000;
		// Look down at a slight angle so the level reads as a map.
		cam.position.set(center[0] + dist * 0.5, center[1] + dist * 0.8, center[2] + dist * 0.5);
		cam.lookAt(center[0], center[1], center[2]);
		cam.updateProjectionMatrix();
		if (controls) {
			controls.target.set(center[0], center[1], center[2]);
			controls.update();
		}
	}, [framing, camera, controls]);
	return null;
}

function Empty({ title, detail }: { title: string; detail?: string }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
			<MapIcon className="h-8 w-8" />
			<p className="text-sm font-medium text-foreground">{title}</p>
			{detail && <p className="max-w-lg text-xs leading-relaxed">{detail}</p>}
		</div>
	);
}

export function MapViewer({ model }: MapViewerProps) {
	const [wireframe, setWireframe] = useState(false);
	const [showSuspect, setShowSuspect] = useState(false);

	const level = isLevelGeometry(model) ? model : null;

	const cleanParts = useMemo(() => (level ? level.parts.filter((p) => !p.suspect) : []), [level]);
	const suspectParts = useMemo(() => (level ? level.parts.filter((p) => p.suspect) : []), [level]);

	const cleanGeom = useMemo(() => mergeParts(cleanParts), [cleanParts]);
	const suspectGeom = useMemo(
		() => (showSuspect ? mergeParts(suspectParts) : null),
		[suspectParts, showSuspect],
	);

	// Dispose merged geometry when replaced / unmounted (GPU memory hygiene).
	useEffect(() => () => cleanGeom?.dispose(), [cleanGeom]);
	useEffect(() => () => suspectGeom?.dispose(), [suspectGeom]);

	const framing = useMemo(() => framingFromBounds(level?.bounds ?? null), [level]);

	if (!level) {
		return (
			<Empty
				title="No level geometry"
				detail="Select a level archive and choose “Render whole level” to decode and place every geometry member in one scene."
			/>
		);
	}

	if (level.decodedCount === 0 || (!cleanGeom && !suspectParts.length)) {
		return (
			<Empty
				title="Nothing decodable in this level"
				detail={level.note}
			/>
		);
	}

	// If every clean part was filtered out (all suspect), show suspect by default
	// so the user still sees the level shape rather than an empty void.
	const nothingClean = !cleanGeom;

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/50 px-3 py-2">
				<MapIcon className="h-4 w-4 text-accent" />
				<span className="text-sm font-medium">Whole level</span>
				<span className="text-xs text-muted-foreground">
					{level.decodedCount}/{level.candidateCount} members ·{' '}
					{Math.round(level.totalTriangles).toLocaleString()} tris ·{' '}
					{level.totalVertices.toLocaleString()} verts
				</span>
				{level.suspectCount > 0 && (
					<span
						className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-500"
						title="Members whose decoded coordinates spike to half-float-max (±65504) — a model.ts mis-decode of the Stream .geo vertex streams. Fixes land in a parallel work package."
					>
						<AlertTriangle className="h-3 w-3" />
						{level.suspectCount} suspect
					</span>
				)}
				<div className="ml-auto flex items-center gap-2">
					<Button
						variant={wireframe ? 'default' : 'outline'}
						size="sm"
						onClick={() => setWireframe((w) => !w)}
						title="Toggle wireframe"
					>
						<Boxes className="h-4 w-4" />
						Wireframe
					</Button>
					{level.suspectCount > 0 && (
						<Button
							variant={showSuspect ? 'default' : 'outline'}
							size="sm"
							onClick={() => setShowSuspect((s) => !s)}
							title="Show / hide the suspect (mis-decoded ±65504) members"
						>
							{showSuspect ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
							Suspect
						</Button>
					)}
				</div>
			</div>

			{/* 3D scene */}
			<div className="relative min-h-0 flex-1">
				<Canvas
					camera={{ position: [framing.radius, framing.radius, framing.radius], fov: 50 }}
					dpr={[1, 2]}
					gl={{ antialias: true }}
				>
					<color attach="background" args={['#0b0e14']} />
					<ambientLight intensity={0.7} />
					<directionalLight position={[1, 2, 1]} intensity={1.0} />
					<directionalLight position={[-1, -0.5, -1]} intensity={0.35} />

					<Grid
						args={[framing.radius * 6, framing.radius * 6]}
						sectionColor="#2a3340"
						cellColor="#161c24"
						infiniteGrid
						fadeDistance={framing.radius * 12}
						fadeStrength={1.5}
						position={[framing.center[0], framing.center[1] - framing.radius * 0.5, framing.center[2]]}
					/>

					{cleanGeom && (
						<mesh geometry={cleanGeom}>
							<meshStandardMaterial
								color="#9aa6b5"
								metalness={0.05}
								roughness={0.85}
								wireframe={wireframe}
								side={THREE.DoubleSide}
							/>
						</mesh>
					)}
					{suspectGeom && (
						<mesh geometry={suspectGeom}>
							<meshStandardMaterial
								color="#c9803a"
								metalness={0.0}
								roughness={0.9}
								wireframe={wireframe}
								transparent
								opacity={0.4}
								side={THREE.DoubleSide}
							/>
						</mesh>
					)}

					<OrbitControls makeDefault enableDamping dampingFactor={0.1} />
					<AutoFit framing={framing} />
				</Canvas>

				{/* Coverage note overlay */}
				<div className="pointer-events-none absolute bottom-2 left-2 right-2 max-w-3xl rounded bg-black/55 px-2 py-1 text-[10px] leading-snug text-white/80">
					{nothingClean
						? 'All decoded members are suspect (model.ts half-float mis-decode of the ' +
							'Stream .geo streams). Showing them so the level shape is visible. '
						: ''}
					{level.note}
				</div>
			</div>
		</div>
	);
}

export default MapViewer;
