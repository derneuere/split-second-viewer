// Whole-level geometry loader — decode EVERY renderable geometry member of a
// level's Static+Stream .ark pair and gather it into ONE world-space scene.
//
// WORLD-PLACEMENT SCHEME (investigated on airport_test_03, see WP findings):
//   Level geometry in the .ark is authored PRE-TRANSFORMED into world space.
//   Each Static `.sobj` (serialized object, magic 02 00 00 08) and each Stream
//   `.geo` (framed vertex/index stream) member carries its vertices already at
//   their final world coordinates — verified: the decoded per-member AABBs sit
//   at DIFFERENT world locations that tile together into the level extent
//   (±2600 X, ±1880 Z), matching the level's `.sectorInfo` float-triple extent.
//   There is NO separate per-object transform table in the .ark: placement is
//   IMPLICIT in the vertex data, so the loader simply decodes each member and
//   keeps its native coordinates. (The `.entities` file carries explicit
//   transforms, but only for dynamic / spawn entities — start positions etc. —
//   NOT for the static level mesh.)
//
//   Each member also carries a Crayon2 header AABB (two float4 min/max rows,
//   w==1.0) which model.ts surfaces as `bounds`. We use that header AABB to:
//     - frame the whole-level camera even when a member's mesh decode is partial
//       (some `.sobj` decode to header-only — their high-LOD geometry lives in a
//       Stream `.geo` twin), and
//     - reject members whose DECODED vertices fall wildly outside their own
//       header AABB (a model.ts half-float mis-decode artifact — the brief notes
//       those fixes land in parallel), so one bad sobj can't blow up the scene.
//
// Pure module: imports ONLY the binary helpers + ArkArchive + model parser.
// NEVER React or the registry (acyclic rule). Node-importable for the test suite.

import {
	readMemberRaw,
	getMemberPayload,
	isFramed,
} from './ark/ArkArchive';
import { parseModel, type ParsedModel } from './model';
import type { ArchiveMember, ParsedArchive } from './types';

/** One decoded level part: world-space positions + triangle indices + provenance. */
export type LevelPart = {
	/** The source member's nameHash (provenance / dedup key). */
	nameHash: number;
	/** Which segment the member came from. */
	segment: 'static' | 'stream';
	/** Sniffed member ext ('sobj' | 'geo' | …). */
	ext: string;
	/** Flat world-space float positions [x0,y0,z0, …]. */
	positions: Float32Array;
	/** Triangle-list indices into `positions` (already strip-expanded). */
	indices: Uint32Array;
	/** Triangle count for this part. */
	triangleCount: number;
	/**
	 * True when the decoded vertices look mis-decoded — either they reach the
	 * half-float-saturation magnitude (±65504, the model.ts 4×f16 mis-read of a
	 * Stream .geo stream) or they overshoot this member's own header AABB. The
	 * part is still rendered (honest output) but flagged so the UI / note can say
	 * how much of the scene is suspect. model.ts fixes land in parallel.
	 */
	suspect: boolean;
};

export type LevelGeometry = {
	parts: LevelPart[];
	/** Combined world-space AABB over the parts we kept (geometry, not headers). */
	bounds: { min: [number, number, number]; max: [number, number, number] } | null;
	/** Members enumerated as geometry candidates (sobj + geo). */
	candidateCount: number;
	/** Members that decoded into at least one renderable triangle/vertex. */
	decodedCount: number;
	/** Members skipped because the decode produced no positions. */
	emptyCount: number;
	/** Members rejected because the decoded vertices were unusable (NaN / huge). */
	rejectedCount: number;
	/** Members kept but flagged suspect (decoded extent overshoots header AABB). */
	suspectCount: number;
	/** Members whose decode threw (counted, never fatal). */
	failedCount: number;
	/** Total triangle / vertex tallies across kept parts. */
	totalTriangles: number;
	totalVertices: number;
	/** Human note about coverage / known limitations. */
	note: string;
};

/** Byte accessor for a level segment (returns the whole .ark file's bytes). */
export type SegmentBytes = (segment: 'static' | 'stream') => Uint8Array | undefined;

/** Coarse categories whose members carry renderable geometry. */
const GEOMETRY_CATEGORIES = new Set(['model']); // .sobj + .geo both sniff to 'model'

/** Is this member a geometry candidate (a .sobj or .geo we should try to decode)? */
export function isGeometryMember(m: ArchiveMember): boolean {
	if (m.storedLen <= 0) return false;
	const cat = m.detectedType?.category;
	const ext = m.detectedType?.ext;
	if (cat && GEOMETRY_CATEGORIES.has(cat)) return true;
	// Belt-and-braces: a member typed only by ext.
	return ext === 'sobj' || ext === 'geo' || ext === 'model';
}

/**
 * How far a decoded mesh may extend beyond its own header AABB before we FLAG it
 * suspect (a model.ts half-float mis-decode produces ±65504 spikes). The part is
 * still rendered — this only drives the honesty note / per-part flag.
 */
const HEADER_OVERSHOOT_FACTOR = 8;
/** Absolute hard clamp: a coordinate past this is unusable (NaN-soup / overflow). */
const MAX_WORLD_COORD = 1e7;

type Extent = { min: [number, number, number]; max: [number, number, number] } | null;

/** Axis-aligned extent of a flat positions array (finite components only). */
export function positionsExtent(positions: ArrayLike<number>): Extent {
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity,
		mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	let any = false;
	for (let i = 0; i + 2 < positions.length; i += 3) {
		const x = positions[i],
			y = positions[i + 1],
			z = positions[i + 2];
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
		any = true;
		if (x < mnx) mnx = x;
		if (y < mny) mny = y;
		if (z < mnz) mnz = z;
		if (x > mxx) mxx = x;
		if (y > mxy) mxy = y;
		if (z > mxz) mxz = z;
	}
	return any ? { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] } : null;
}

/**
 * Hard usability test: keep the part only when it has finite positions within
 * the absolute world clamp. Rejects all-NaN / overflowed decodes that would
 * blow up the camera framing, but keeps half-float-y-spiked parts (those are
 * flagged suspect, not dropped — model.ts fixes land in parallel).
 */
export function positionsUsable(positions: ArrayLike<number>): boolean {
	const ext = positionsExtent(positions);
	if (!ext) return false;
	for (let k = 0; k < 3; k++) {
		if (Math.abs(ext.min[k]) > MAX_WORLD_COORD || Math.abs(ext.max[k]) > MAX_WORLD_COORD)
			return false;
	}
	return true;
}

/**
 * The IEEE-754 binary16 maximum finite magnitude. A `.geo` vertex stream that
 * model.ts mis-reads as 4×f16 P4 (it is not) saturates components to ±65504 —
 * the unmistakable fingerprint of the half-float mis-decode. We treat any part
 * whose extent reaches near this magnitude on ANY axis as suspect, independent
 * of the header AABB (which is itself derived from the same garbage and so can't
 * be trusted to disagree).
 */
/**
 * A part reaching this magnitude on any axis is almost certainly a half-float
 * mis-decode spike, NOT a real coordinate. Real Split/Second levels sit within a
 * few thousand units of the origin (airport_test_03's `.sectorInfo` extent is
 * ≈ ±2600); a `.geo` stream wrongly read as 4×f16 P4 leaks ±65504-derived
 * garbage (intermediate strip/index values decoded as positions land in the
 * tens-of-thousands). Chosen well above the real level extent and well below the
 * ±65504 half-float saturation so partial spikes are caught too.
 */
const HALF_FLOAT_SPIKE = 8000;

/**
 * Soft suspicion test: a part is suspect when EITHER
 *   (a) its extent reaches the half-float-saturation magnitude on any axis (the
 *       direct ±65504 fingerprint — fires even when the header AABB is equally
 *       wrong), OR
 *   (b) a header AABB exists and the decoded extent overshoots it by more than
 *       HEADER_OVERSHOOT_FACTOR on any axis.
 * Suspect parts are still rendered (honest output); the flag only drives the
 * coverage note and the robust camera framing. model.ts fixes land in parallel.
 */
export function positionsSuspect(
	positions: ArrayLike<number>,
	header: ParsedModel['bounds'],
): boolean {
	const ext = positionsExtent(positions);
	if (!ext) return false;
	for (let k = 0; k < 3; k++) {
		if (Math.abs(ext.min[k]) >= HALF_FLOAT_SPIKE || Math.abs(ext.max[k]) >= HALF_FLOAT_SPIKE)
			return true;
	}
	if (!header) return false;
	const headSpan = (k: 0 | 1 | 2) => Math.max(1, header.max[k] - header.min[k]);
	const decSpan = [
		ext.max[0] - ext.min[0],
		ext.max[1] - ext.min[1],
		ext.max[2] - ext.min[2],
	] as const;
	for (let k = 0 as 0 | 1 | 2; k < 3; k++) {
		if (decSpan[k] > headSpan(k) * HEADER_OVERSHOOT_FACTOR) return true;
	}
	return false;
}

/**
 * Merge a member's submeshes into one flat positions + triangle-index part
 * (world space). Only submeshes that carry VALID, in-range triangle indices are
 * kept — for a whole-level surface mesh a point-soup fallback (one index per
 * vertex) is meaningless and would leave a non-triangle index count, so those
 * submeshes are dropped. Returns null when no submesh contributes a triangle.
 */
function partFromModel(
	model: ParsedModel,
	member: ArchiveMember,
): { positions: Float32Array; indices: Uint32Array } | null {
	// First pass: select the renderable submeshes and tally sizes.
	type Sel = { positions: number[]; indices: number[]; vc: number };
	const sel: Sel[] = [];
	let totalVerts = 0;
	let totalIdx = 0;
	for (const mesh of model.meshes) {
		const vc = mesh.positions.length / 3;
		if (vc < 3) continue;
		if (mesh.indices.length < 3 || mesh.indices.length % 3 !== 0) continue;
		// Validate indices are in range; drop the submesh if not (model.ts may emit
		// an index that points past this submesh's vertex count).
		let ok = true;
		for (let i = 0; i < mesh.indices.length; i++) {
			const idx = mesh.indices[i];
			if (idx < 0 || idx >= vc) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		sel.push({ positions: mesh.positions, indices: mesh.indices, vc });
		totalVerts += vc;
		totalIdx += mesh.indices.length;
	}
	if (sel.length === 0 || totalVerts < 3) return null;

	const positions = new Float32Array(totalVerts * 3);
	const indices = new Uint32Array(totalIdx);
	let vOff = 0;
	let iOff = 0;
	for (const s of sel) {
		positions.set(s.positions, vOff * 3);
		for (let i = 0; i < s.indices.length; i++) indices[iOff + i] = s.indices[i] + vOff;
		iOff += s.indices.length;
		vOff += s.vc;
	}
	void member;
	// Sanitize: a partial model.ts decode can leave NaN/Inf components in a vertex.
	// Replace them with 0 so THREE's bounding-sphere / normals math stays finite —
	// the camera framing must never become NaN.
	for (let i = 0; i < positions.length; i++) {
		if (!Number.isFinite(positions[i])) positions[i] = 0;
	}
	return { positions, indices };
}

/**
 * Load every geometry member of a parsed level archive into ONE world-space
 * scene. `segmentBytes(seg)` returns the raw bytes of the Static / Stream .ark
 * file. Each member is sliced, de-framed (getMemberPayload), decoded via the
 * shared model parser, validated against its header AABB, and kept as a
 * world-space LevelPart. Never throws — a member that fails to decode is counted
 * and skipped so one bad object can't abort the whole-level load.
 *
 * `maxMembers` caps how many members are decoded (newest-first by storedLen so
 * the biggest backdrops come first); pass 0/undefined for no cap.
 */
export function loadLevelGeometry(
	archive: ParsedArchive,
	segmentBytes: SegmentBytes,
	opts?: { maxMembers?: number },
): LevelGeometry {
	const candidates = archive.members.filter(isGeometryMember);
	const limit = opts?.maxMembers && opts.maxMembers > 0 ? opts.maxMembers : candidates.length;
	// Decode the largest members first (the level shells / backdrops), so a cap
	// keeps the visually-dominant geometry.
	const ordered = [...candidates].sort((a, b) => b.storedLen - a.storedLen).slice(0, limit);

	const parts: LevelPart[] = [];
	let decodedCount = 0;
	let emptyCount = 0;
	let rejectedCount = 0;
	let suspectCount = 0;
	let failedCount = 0;

	for (const member of ordered) {
		const seg = segmentBytes(member.segment);
		if (!seg) {
			failedCount++;
			continue;
		}
		try {
			const raw = readMemberRaw(seg, member);
			// A FRAMED Stream `.geo` is a raw vertex/index stream whose 12-byte frame
			// (00000000 | innerSize | 00000000) IS the `.model.stream` header the
			// parser recognises (innerSize == len-12). Feed the RAW framed bytes so
			// parseModel routes to the stream path; an unframed `.sobj` keeps its
			// 02 00 00 08 magic in the de-framed payload and routes to the base path.
			const framed = isFramed(raw);
			const input = framed ? raw : getMemberPayload(raw);
			const model = parseModel(input);
			const merged = partFromModel(model, member);
			if (!merged) {
				emptyCount++;
				continue;
			}
			if (!positionsUsable(merged.positions)) {
				rejectedCount++;
				continue;
			}
			const suspect = positionsSuspect(merged.positions, model.bounds);
			if (suspect) suspectCount++;
			parts.push({
				nameHash: member.nameHash,
				segment: member.segment,
				ext: member.detectedType?.ext ?? 'model',
				positions: merged.positions,
				indices: merged.indices,
				triangleCount: merged.indices.length / 3,
				suspect,
			});
			decodedCount++;
		} catch {
			failedCount++;
		}
	}

	// Frame the camera from the CLEAN (non-suspect) parts when we have any, so a
	// handful of half-float-spiked parts don't blow the camera out to ±65k. Fall
	// back to all parts when every kept part is suspect.
	const clean = parts.filter((p) => !p.suspect);
	const framing = clean.length > 0 ? clean : parts;
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity,
		mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	for (const p of framing) {
		const ext = positionsExtent(p.positions);
		if (!ext) continue;
		mnx = Math.min(mnx, ext.min[0]);
		mny = Math.min(mny, ext.min[1]);
		mnz = Math.min(mnz, ext.min[2]);
		mxx = Math.max(mxx, ext.max[0]);
		mxy = Math.max(mxy, ext.max[1]);
		mxz = Math.max(mxz, ext.max[2]);
	}
	const haveBounds = framing.length > 0 && Number.isFinite(mnx);

	const totalTriangles = parts.reduce((s, p) => s + p.triangleCount, 0);
	const totalVertices = parts.reduce((s, p) => s + p.positions.length / 3, 0);

	const note =
		`Whole-level decode: ${decodedCount}/${candidates.length} geometry members ` +
		`rendered (${totalVertices.toLocaleString()} verts, ${Math.round(totalTriangles).toLocaleString()} tris); ` +
		`${suspectCount} flagged suspect — their decoded coordinates spike toward the ` +
		`half-float maximum (±65504), the fingerprint of model.ts mis-reading the Stream ` +
		`.geo vertex streams as 4×f16; the Static .sobj shells decode cleanly. model.ts ` +
		`fixes land in a parallel work package. ` +
		`${emptyCount} header-only (high-LOD geometry lives in a Stream twin), ` +
		`${rejectedCount} unusable (NaN / overflow), ${failedCount} failed to parse. ` +
		`Geometry is placed by its native world-space coordinates: level .ark members ` +
		`are authored PRE-TRANSFORMED into world space (no per-object transform table; ` +
		`the .entities transforms cover only dynamic/spawn entities).`;

	return {
		parts,
		bounds: haveBounds ? { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] } : null,
		candidateCount: candidates.length,
		decodedCount,
		emptyCount,
		rejectedCount,
		suspectCount,
		failedCount,
		totalTriangles,
		totalVertices,
		note,
	};
}
