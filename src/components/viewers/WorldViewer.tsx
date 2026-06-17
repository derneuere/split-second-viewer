// WorldViewer — World / Telemetry viewport for Split/Second.
//
// Renders world-space route + telemetry data in a @react-three/fiber scene with
// a fixed-but-orbitable camera (ADR-0003 fixed-camera habit), plus a small
// scalar series plot (speed/arc-length over sample index) drawn as inline SVG.
//
// Handles handler categories "world" and "telemetry". The shapes it knows how to
// draw come straight from the World handler parser models:
//
//   .track       (ParsedTrack)        — recordCount + records[{start,end}] XYZ
//                                        directed segments → polyline strokes.
//   .linkorigins (ParsedLinkOrigins)  — linkCount + origins[] arc-length metres
//                                        → scalar plot + a 1-D node ladder in 3D.
//   .sideways    (ParsedSideways)     — link adjacency indices, no positions →
//                                        summary panel (nothing to plot in 3D).
//   .checkpoints (ParsedCheckpoints)  — PARTIAL verbatim body → header summary;
//                                        a best-effort float-triple scan is shown
//                                        as points when it finds plausible coords.
//
// Props contract: { model, raw, handler }. The component is self-contained and
// is wired into the central viewport dispatcher by the Integrate stage — it does
// NOT touch any dispatcher itself. It tolerates a missing / partial / wrong-shape
// model and always renders a graceful message rather than throwing.
//
// Dependencies used are all already in package.json: three, @react-three/fiber,
// @react-three/drei. (recharts is intentionally NOT used — it is not a project
// dependency — so the scalar chart is hand-rolled SVG.)

import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Line, OrbitControls, Grid } from '@react-three/drei';

// ---- Minimal structural prop type ------------------------------------------
// We accept the registry ResourceHandler but only depend structurally on the
// fields we read, so this file stays importable without a hard registry edge.
type HandlerLike = {
	key?: string;
	name?: string;
	category?: string;
} | null | undefined;

export type WorldViewerProps = {
	/** Parsed resource model produced by the handler's parseRaw (may be null). */
	model: unknown;
	/** The original resource bytes (used for graceful diagnostics). */
	raw?: Uint8Array | null;
	/** The resolved handler (drives which overlay we draw). */
	handler?: HandlerLike;
};

// ---- Re-declared model shapes (structural; no cross-module import edge) ------
type Vec3 = [number, number, number];
type TrackSegment = { start: Vec3; end: Vec3 };
type TrackModel = { recordCount: number; records: TrackSegment[]; sizeLawOk?: boolean };
type LinkOriginsModel = { linkCount: number; origins: number[] };
type SidewaysRecord = { count: number; linkIndices: number[] };
type SidewaysModel = { linkCount: number; links: SidewaysRecord[] };
type CheckpointsModel = {
	version: number;
	bodySize: number;
	body?: Uint8Array;
	headerValid?: boolean;
	endSentinelCount?: number;
};

// ---- type guards ------------------------------------------------------------
function isVec3(v: unknown): v is Vec3 {
	return (
		Array.isArray(v) &&
		v.length === 3 &&
		typeof v[0] === 'number' &&
		typeof v[1] === 'number' &&
		typeof v[2] === 'number'
	);
}
function isTrack(m: unknown): m is TrackModel {
	return (
		!!m &&
		typeof m === 'object' &&
		Array.isArray((m as TrackModel).records) &&
		(m as TrackModel).records.every((r) => r && isVec3(r.start) && isVec3(r.end))
	);
}
function isLinkOrigins(m: unknown): m is LinkOriginsModel {
	return (
		!!m &&
		typeof m === 'object' &&
		Array.isArray((m as LinkOriginsModel).origins) &&
		(m as LinkOriginsModel).origins.every((n) => typeof n === 'number')
	);
}
function isSideways(m: unknown): m is SidewaysModel {
	return (
		!!m &&
		typeof m === 'object' &&
		Array.isArray((m as SidewaysModel).links) &&
		typeof (m as SidewaysModel).linkCount === 'number'
	);
}
function isCheckpoints(m: unknown): m is CheckpointsModel {
	return (
		!!m &&
		typeof m === 'object' &&
		typeof (m as CheckpointsModel).bodySize === 'number' &&
		typeof (m as CheckpointsModel).version === 'number'
	);
}

// ---- geometry helpers -------------------------------------------------------

/**
 * Split a flat directed-segment list into connected polyline strokes: a new
 * stroke begins whenever segment i's start does not equal segment i-1's end
 * (a "pen-up" jump). Mirrors trackStrokes() in src/lib/core/track.ts so the
 * viewer draws the same stroke decomposition the handler describes.
 */
function strokesFromSegments(records: TrackSegment[]): Vec3[][] {
	const strokes: Vec3[][] = [];
	let prevEnd: Vec3 | null = null;
	let current: Vec3[] | null = null;
	for (const seg of records) {
		const chains =
			prevEnd !== null &&
			seg.start[0] === prevEnd[0] &&
			seg.start[1] === prevEnd[1] &&
			seg.start[2] === prevEnd[2];
		if (!chains || current === null) {
			current = [seg.start];
			strokes.push(current);
		}
		current.push(seg.end);
		prevEnd = seg.end;
	}
	return strokes;
}

type Bounds = {
	min: Vec3;
	max: Vec3;
	center: Vec3;
	radius: number;
};

function computeBounds(points: Vec3[]): Bounds | null {
	if (points.length === 0) return null;
	const min: Vec3 = [Infinity, Infinity, Infinity];
	const max: Vec3 = [-Infinity, -Infinity, -Infinity];
	for (const p of points) {
		for (let k = 0; k < 3; k++) {
			if (p[k] < min[k]) min[k] = p[k];
			if (p[k] > max[k]) max[k] = p[k];
		}
	}
	const center: Vec3 = [
		(min[0] + max[0]) / 2,
		(min[1] + max[1]) / 2,
		(min[2] + max[2]) / 2,
	];
	const dx = max[0] - min[0];
	const dy = max[1] - min[1];
	const dz = max[2] - min[2];
	const radius = Math.max(1e-3, Math.hypot(dx, dy, dz) / 2);
	return { min, max, center, radius };
}

/** Centre points on the origin so the orbit camera frames them regardless of
 *  the absolute PS3 world position (tracks can sit kilometres from origin). */
function recenter(points: Vec3[], center: Vec3): Vec3[] {
	return points.map((p) => [p[0] - center[0], p[1] - center[1], p[2] - center[2]]);
}

// Distinct, color-cycled palette for multiple strokes / overlays.
const STROKE_COLORS = [
	'#4fc3f7',
	'#ffb74d',
	'#81c784',
	'#e57373',
	'#ba68c8',
	'#fff176',
	'#4db6ac',
	'#f06292',
];

// ---- 3D scene ---------------------------------------------------------------

function Scene({
	strokes,
	points,
	bounds,
}: {
	strokes: Vec3[][];
	points: Vec3[];
	bounds: Bounds;
}) {
	// Camera distance scales with the data radius so any track frames nicely.
	const dist = bounds.radius * 2.4 + 1;

	return (
		<>
			<color attach="background" args={['#0b0f14']} />
			<ambientLight intensity={0.8} />
			<directionalLight position={[1, 2, 1]} intensity={0.6} />

			<Grid
				args={[bounds.radius * 4, bounds.radius * 4]}
				sectionColor="#2a3340"
				cellColor="#1a2129"
				infiniteGrid
				fadeDistance={dist * 4}
				fadeStrength={1.5}
				position={[0, -bounds.radius, 0]}
			/>

			{strokes.map((stroke, i) =>
				stroke.length >= 2 ? (
					<Line
						key={`stroke-${i}`}
						points={stroke as [number, number, number][]}
						color={STROKE_COLORS[i % STROKE_COLORS.length]}
						lineWidth={2}
					/>
				) : null,
			)}

			{points.length > 0 && (
				<points>
					<bufferGeometry>
						<bufferAttribute
							attach="attributes-position"
							args={[new Float32Array(points.flat()), 3]}
						/>
					</bufferGeometry>
					<pointsMaterial size={Math.max(0.5, bounds.radius * 0.012)} color="#ffd54f" sizeAttenuation />
				</points>
			)}

			{/* World axes at the data centre for orientation. */}
			<axesHelper args={[bounds.radius * 0.5]} />

			<OrbitControls makeDefault enableDamping dampingFactor={0.1} />
			<perspectiveCamera />
		</>
	);
}

// ---- scalar series plot (hand-rolled SVG) -----------------------------------

function ScalarPlot({
	values,
	label,
	unit,
	width = 520,
	height = 120,
}: {
	values: number[];
	label: string;
	unit?: string;
	width?: number;
	height?: number;
}) {
	const path = useMemo(() => {
		if (values.length === 0) return { d: '', min: 0, max: 0 };
		let min = Infinity;
		let max = -Infinity;
		for (const v of values) {
			if (Number.isFinite(v)) {
				if (v < min) min = v;
				if (v > max) max = v;
			}
		}
		if (!Number.isFinite(min) || !Number.isFinite(max)) return { d: '', min: 0, max: 0 };
		const span = max - min || 1;
		const pad = 6;
		const w = width - pad * 2;
		const h = height - pad * 2;
		const n = values.length;
		const stepX = n > 1 ? w / (n - 1) : 0;
		let d = '';
		for (let i = 0; i < n; i++) {
			const x = pad + i * stepX;
			const y = pad + h - ((values[i] - min) / span) * h;
			d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
		}
		return { d, min, max };
	}, [values, width, height]);

	if (values.length === 0) return null;

	return (
		<div className="rounded-md border border-border bg-card p-2">
			<div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
				<span className="font-medium text-foreground">{label}</span>
				<span>
					{path.min.toFixed(2)}–{path.max.toFixed(2)}
					{unit ? ` ${unit}` : ''} · {values.length} samples
				</span>
			</div>
			<svg
				width="100%"
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="block"
				style={{ height }}
			>
				<rect x={0} y={0} width={width} height={height} fill="transparent" />
				<path d={path.d} fill="none" stroke="#4fc3f7" strokeWidth={1.5} />
			</svg>
		</div>
	);
}

// ---- graceful empty / fallback states --------------------------------------

function Empty({ title, detail }: { title: string; detail?: string }) {
	return (
		<div className="flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-2 rounded-md border border-border bg-card p-6 text-center text-muted-foreground">
			<p className="text-sm font-medium text-foreground">{title}</p>
			{detail && <p className="max-w-md text-xs">{detail}</p>}
		</div>
	);
}

// ---- model → renderable extraction ------------------------------------------

type Renderable = {
	strokes: Vec3[][];
	points: Vec3[];
	bounds: Bounds | null;
	/** Optional scalar series shown beneath the 3D scene. */
	series?: { label: string; unit?: string; values: number[] } | null;
	/** Human note shown if there is nothing to draw in 3D. */
	emptyNote?: string;
};

function buildTrack(m: TrackModel): Renderable {
	const strokes = strokesFromSegments(m.records);
	const all: Vec3[] = strokes.flat();
	const bounds = computeBounds(all);
	const centered = bounds ? strokes.map((s) => recenter(s, bounds.center)) : strokes;
	// Speed proxy: per-segment length (world units). For a constant-rate sampled
	// telemetry path this is proportional to instantaneous speed.
	const seglen: number[] = m.records.map((r) =>
		Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1], r.end[2] - r.start[2]),
	);
	return {
		strokes: centered,
		points: [],
		bounds,
		series:
			seglen.length > 0
				? { label: 'Segment length (speed proxy) over sample', unit: 'u', values: seglen }
				: null,
		emptyNote: bounds ? undefined : 'Track has no segments to plot.',
	};
}

function buildLinkOrigins(m: LinkOriginsModel): Renderable {
	// linkorigins carries arc-length scalars, not XY positions. Lay the nodes out
	// along the X axis at their arc-length so the route ordering is visible in 3D,
	// and show the arc-length profile as the scalar series.
	const pts: Vec3[] = m.origins.map((d) => [d, 0, 0]);
	const bounds = computeBounds(pts);
	const centered = bounds ? recenter(pts, bounds.center) : pts;
	const strokes: Vec3[][] = centered.length >= 2 ? [centered] : [];
	return {
		strokes,
		points: centered,
		bounds,
		series:
			m.origins.length > 0
				? { label: 'Link arc-length origin (metres) by link index', unit: 'm', values: m.origins }
				: null,
		emptyNote: bounds ? undefined : 'No link origins to plot.',
	};
}

/** Best-effort: scan a verbatim body for plausible float32 XYZ triples (BE).
 *  Used only for the PARTIAL .checkpoints body — purely diagnostic. */
function scanFloatTriples(body: Uint8Array): Vec3[] {
	const out: Vec3[] = [];
	if (body.byteLength < 12) return out;
	const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
	const plausible = (v: number) => Number.isFinite(v) && Math.abs(v) > 1e-2 && Math.abs(v) < 1e6;
	for (let off = 0; off + 12 <= body.byteLength; off += 4) {
		const x = dv.getFloat32(off, false);
		const y = dv.getFloat32(off + 4, false);
		const z = dv.getFloat32(off + 8, false);
		if (plausible(x) && plausible(y) && plausible(z)) out.push([x, y, z]);
	}
	return out;
}

function buildCheckpoints(m: CheckpointsModel): Renderable {
	const triples = m.body ? scanFloatTriples(m.body) : [];
	const bounds = computeBounds(triples);
	const centered = bounds ? recenter(triples, bounds.center) : triples;
	return {
		strokes: [],
		points: centered,
		bounds,
		series: null,
		emptyNote:
			'.checkpoints is PARTIAL (verbatim tagged-serializer body). ' +
			(triples.length
				? `${triples.length} plausible float triples shown as points (best-effort, unverified).`
				: 'No plottable coordinates recovered from the body.'),
	};
}

// ---- main component ---------------------------------------------------------

export function WorldViewer({ model, handler, raw }: WorldViewerProps) {
	const key = (handler?.key ?? '').toLowerCase();
	const category = (handler?.category ?? '').toLowerCase();
	const handled = category === 'world' || category === 'telemetry';

	const built: Renderable | { error: string } = useMemo(() => {
		if (model == null) {
			return { error: 'No parsed model. The resource failed to parse or is empty.' };
		}
		try {
			if (key === 'track' || isTrack(model)) {
				if (isTrack(model)) return buildTrack(model);
			}
			if (key === 'linkorigins' || isLinkOrigins(model)) {
				if (isLinkOrigins(model)) return buildLinkOrigins(model);
			}
			if (key === 'checkpoints' || isCheckpoints(model)) {
				if (isCheckpoints(model)) return buildCheckpoints(model);
			}
			if (key === 'sideways' || isSideways(model)) {
				const sw = model as SidewaysModel;
				return {
					strokes: [],
					points: [],
					bounds: null,
					series: null,
					emptyNote:
						`.sideways carries lateral link adjacency (${sw.linkCount} links, ` +
						`${sw.links.filter((l) => l.count > 0).length} with neighbours) — ` +
						'link indices only, no world-space positions to plot.',
				};
			}
			return {
				error:
					`This World/Telemetry resource (${handler?.key ?? 'unknown'}) has no ` +
					'world-space geometry the viewer knows how to draw.',
			};
		} catch (err) {
			return { error: `Failed to build scene: ${String((err as Error)?.message ?? err)}` };
		}
	}, [model, key, handler?.key]);

	// Resource isn't ours: still render a polite notice rather than nothing.
	if (!handled && model == null) {
		return (
			<Empty
				title="World viewer"
				detail={
					`Handler category "${handler?.category ?? 'unknown'}" is not World/Telemetry. ` +
					`Raw size: ${raw?.byteLength ?? 0} bytes.`
				}
			/>
		);
	}

	if ('error' in built) {
		return <Empty title="Nothing to render in 3D" detail={built.error} />;
	}

	const { strokes, points, bounds, series, emptyNote } = built;
	const has3D = !!bounds && (strokes.length > 0 || points.length > 0);

	return (
		<div className="flex h-full w-full flex-col gap-2">
			<div className="relative min-h-[280px] flex-1 overflow-hidden rounded-md border border-border bg-[#0b0f14]">
				{has3D && bounds ? (
					<Canvas
						camera={{
							position: [bounds.radius * 1.6, bounds.radius * 1.4, bounds.radius * 1.6],
							near: bounds.radius * 0.01,
							far: bounds.radius * 100 + 1000,
							fov: 50,
						}}
						onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
					>
						<Scene strokes={strokes} points={points} bounds={bounds} />
					</Canvas>
				) : (
					<div className="absolute inset-0">
						<Empty
							title="No 3D geometry"
							detail={emptyNote ?? 'This resource has no world-space coordinates.'}
						/>
					</div>
				)}
				{has3D && (
					<div className="pointer-events-none absolute left-2 top-2 rounded bg-black/40 px-2 py-1 text-[10px] text-white/80">
						{handler?.name ?? handler?.key ?? 'World'} · {strokes.length} stroke
						{strokes.length === 1 ? '' : 's'}
						{points.length ? ` · ${points.length} pts` : ''} · drag to orbit
					</div>
				)}
			</div>

			{series && series.values.length > 0 && (
				<ScalarPlot label={series.label} unit={series.unit} values={series.values} />
			)}
		</div>
	);
}

export default WorldViewer;
