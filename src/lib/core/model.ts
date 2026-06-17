// .model / .model.stream parser — Crayon2 renderable geometry (PS3 big-endian).
//
// Pure module: imports ONLY the binary helpers, NEVER the registry (acyclic
// rule, see registry/handler.ts). Importable from Node by the CLI and vitest.
//
// Status: stream = CONFIRMED; base .model = DECODED (best-effort).
//
// The decode now covers BOTH paths the brief asks for:
//   * .model.stream -> the 12-byte stream header (dword1 == filesize-12), the
//                      interleaved vertex stream as 4 big-endian half-floats per
//                      16-byte stride (position x,y,z,w==1.0 — hkxVertexP4…) and
//                      the trailing 0xFFFF tri-strips. The high-LOD car path.
//   * base .model   -> the Crayon2 node tree carries TWO explicit section
//                      tables that this parser now reads:
//                        - the INDEX-BUFFER / draw-call table: repeating
//                          {relOffset:u32, 0,0,0, idxCount:u32, idxCount*2:u32,
//                           0,0} records (32 bytes). One per draw call.
//                        - the VERTEX-BUFFER table: repeating
//                          {bufSize:u32, stride:u32, vCount:u32, …} records
//                          (0x24 bytes) where bufSize ≈ stride*vCount (rounded
//                          up to a 16-byte multiple). One per vertex buffer.
//                      The bulk vertex data follows the VB table; the index data
//                      follows the vertex data. Vertex positions are stored as
//                      4 big-endian half-floats (P4, w==1.0) for cooked car/level
//                      meshes, or as full float32 (P3 + UV) for simple props
//                      (e.g. PointLight). The parser auto-detects which.
//
//   The exact node-tree TYPE TAGS (0x04/05/06/0E/0F) and the per-draw-call →
//   vertex-buffer binding are still only partially mapped, so a draw call is
//   routed to the smallest vertex buffer whose vCount contains all of its
//   indices. This yields renderable per-buffer submeshes; see "Open questions".
//
// The returned model is the shape the brief asks for:
//   { meshes: [{ positions, indices, normals?, uv? }], bounds, skeleton? }
// positions/indices are plain number[] so they stay JSON-serializable for the
// CLI/dump path.

import { BinReader } from './binary/BinReader';

/** A decoded submesh: flat position list (x,y,z triplets) + triangle indices. */
export type ModelMesh = {
	/** Flat float positions: [x0,y0,z0, x1,y1,z1, …]. Empty when not decoded. */
	positions: number[];
	/** Triangle-list indices (strips already expanded). */
	indices: number[];
	/** Vertex count (positions.length / 3, or maxIndex+1 when positions absent). */
	vertexCount: number;
	/** Flat per-vertex normals (x,y,z…) when decodable; otherwise omitted. */
	normals?: number[];
	/** Flat per-vertex UVs (u,v…) when decodable; otherwise omitted. */
	uv?: number[];
	/** Per-vertex byte stride of the source buffer (diagnostic). */
	stride?: number;
	/** Vertex storage format: 'half' (4×f16 P4) or 'float' (f32 P3+UV). */
	format?: 'half' | 'float';
};

export type ModelBounds = {
	min: [number, number, number];
	max: [number, number, number];
} | null;

/** A skeleton bone exposed for line-segment drawing (origin = matrix translation). */
export type ModelBone = {
	index: number;
	parent: number;
	name: string;
	/** World-space (or local) bone origin [x,y,z]. */
	pos: [number, number, number];
};

export type ParsedModel = {
	/** 'model' for a base .model (magic 02 00 00 08), 'stream' for a .model.stream. */
	kind: 'model' | 'stream';
	/** Base .model header magic (0x02000008). undefined for a stream. */
	magic?: number;
	/** Top-level node/section count (base .model only). */
	nodeCount?: number;
	/** Offset just past the node-descriptor block (base .model only). */
	treeOffset?: number;
	/** Stream payload length from the 12-byte header (== filesize-12). stream only. */
	streamPayloadLen?: number;
	/** Decoded submeshes (one per recovered vertex buffer). */
	meshes: ModelMesh[];
	/** Axis-aligned bounds, from the float metadata (base) or decoded verts. */
	bounds: ModelBounds;
	/** Optional skeleton bones (parented .skel rig), drawn as line segments. */
	skeleton?: ModelBone[];
	/** True when the geometry decode is partial (some sections may be missing). */
	partial?: boolean;
	/** Human-readable note about decode coverage. */
	note?: string;
};

export const MODEL_MAGIC = 0x02000008;
/** Skinned/animated Crayon2 variant (high byte 02, flag 01). Same container shape. */
export const MODEL_MAGIC_SKINNED = 0x02010008;

/** True for any recognised base-.model version/flags word (02 xx 00 08). */
export function isModelMagic(m: number): boolean {
	return (m & 0xff0000ff) === 0x02000008;
}

/** Decode one IEEE-754 binary16 (half) value. */
function decodeHalf(u: number): number {
	const sign = u & 0x8000 ? -1 : 1;
	const exp = (u >> 10) & 0x1f;
	const mant = u & 0x3ff;
	if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024);
	if (exp === 31) return mant ? NaN : sign * Infinity;
	return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
}

/** Wrap raw bytes (which may be a view into a larger buffer) in a fresh BE reader. */
function reader(raw: Uint8Array): {
	r: BinReader;
	n: number;
	u16(p: number): number;
	u32(p: number): number;
	f32(p: number): number;
} {
	const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	const r = new BinReader(ab, false /* big-endian */);
	const dv = new DataView(ab);
	return {
		r,
		n: raw.byteLength,
		u16: (p: number) => dv.getUint16(p, false),
		u32: (p: number) => dv.getUint32(p, false) >>> 0,
		f32: (p: number) => dv.getFloat32(p, false),
	};
}

/**
 * Expand a 16-bit triangle-strip index buffer (with 0xFFFF primitive-restart)
 * into a flat triangle list. Skips degenerate triangles (repeated index) and
 * any index >= vertexLimit when a limit is known. Handles strip winding flip.
 */
export function expandStrips(
	u16: (p: number) => number,
	start: number,
	endExclusive: number,
	vertexLimit = Infinity,
): number[] {
	const out: number[] = [];
	let a = -1;
	let b = -1;
	let winding = 0; // 0/1 flips each step within a strip
	for (let p = start; p + 1 < endExclusive; p += 2) {
		const v = u16(p);
		if (v === 0xffff) {
			a = b = -1;
			winding = 0;
			continue;
		}
		if (a < 0) {
			a = v;
			continue;
		}
		if (b < 0) {
			b = v;
			winding = 0;
			continue;
		}
		const c = v;
		// emit triangle with strip winding: even -> (a,b,c); odd -> (b,a,c).
		const t = winding === 0 ? [a, b, c] : [b, a, c];
		if (
			t[0] !== t[1] &&
			t[1] !== t[2] &&
			t[0] !== t[2] &&
			t[0] < vertexLimit &&
			t[1] < vertexLimit &&
			t[2] < vertexLimit
		) {
			out.push(t[0], t[1], t[2]);
		}
		a = b;
		b = c;
		winding ^= 1;
	}
	return out;
}

/** Expand a strip held in a plain number[] of u16 values. */
function expandStripArray(idx: number[], vertexLimit: number): number[] {
	const out: number[] = [];
	let a = -1;
	let b = -1;
	let winding = 0;
	for (const v of idx) {
		if (v === 0xffff) {
			a = b = -1;
			winding = 0;
			continue;
		}
		if (a < 0) {
			a = v;
			continue;
		}
		if (b < 0) {
			b = v;
			winding = 0;
			continue;
		}
		const c = v;
		const t = winding === 0 ? [a, b, c] : [b, a, c];
		if (
			t[0] !== t[1] &&
			t[1] !== t[2] &&
			t[0] !== t[2] &&
			t[0] < vertexLimit &&
			t[1] < vertexLimit &&
			t[2] < vertexLimit
		) {
			out.push(t[0], t[1], t[2]);
		}
		a = b;
		b = c;
		winding ^= 1;
	}
	return out;
}

/**
 * Locate the index-buffer start in a .model.stream payload. The vertex region
 * (half-float positions/normals) never contains a 0xFFFF half-word, so the
 * first 0xFFFF marks the index region; round it DOWN to a 16-byte-aligned
 * vertex boundary. Verified exact across the Musclecar stream set.
 */
function findStreamIndexStart(u16: (p: number) => number, n: number, payloadStart: number): number {
	for (let p = payloadStart; p + 1 < n; p += 2) {
		if (u16(p) === 0xffff) {
			const rel = p - payloadStart;
			return payloadStart + Math.floor(rel / 16) * 16;
		}
	}
	return n; // no indices found — all vertices
}

/**
 * Scan the float-metadata header region for the axis-aligned bounding box: two
 * consecutive float4 rows (min, max) whose w == 1.0 and whose components are
 * ordered min <= max. Matches the wiki's ±corner pairs. Returns null if absent.
 */
function scanBounds(rr: { r: BinReader; n: number }): ModelBounds {
	const { r, n } = rr;
	const limit = Math.min(n - 32, 8192);
	for (let p = 12; p < limit; p += 4) {
		r.seek(p);
		const a0 = r.readF32(),
			a1 = r.readF32(),
			a2 = r.readF32(),
			a3 = r.readF32();
		const b0 = r.readF32(),
			b1 = r.readF32(),
			b2 = r.readF32(),
			b3 = r.readF32();
		if (
			Math.abs(a3 - 1) < 1e-4 &&
			Math.abs(b3 - 1) < 1e-4 &&
			Number.isFinite(a0) &&
			Number.isFinite(a1) &&
			Number.isFinite(a2) &&
			Number.isFinite(b0) &&
			Number.isFinite(b1) &&
			Number.isFinite(b2) &&
			a0 <= b0 &&
			a1 <= b1 &&
			a2 <= b2 &&
			b0 - a0 + (b1 - a1) + (b2 - a2) > 1e-5
		) {
			return { min: [a0, a1, a2], max: [b0, b1, b2] };
		}
	}
	return null;
}

/** Compute bounds over a flat positions array, ignoring non-finite values. */
function boundsOfPositions(pos: number[]): ModelBounds {
	if (pos.length < 3) return null;
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity;
	let mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	let any = false;
	for (let i = 0; i + 2 < pos.length; i += 3) {
		const x = pos[i],
			y = pos[i + 1],
			z = pos[i + 2];
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
		any = true;
		if (x < mnx) mnx = x;
		if (y < mny) mny = y;
		if (z < mnz) mnz = z;
		if (x > mxx) mxx = x;
		if (y > mxy) mxy = y;
		if (z > mxz) mxz = z;
	}
	if (!any) return null;
	return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
}

/** Parse a .model.stream high-LOD payload: 12-byte header + interleaved verts + strips. */
export function parseModelStream(raw: Uint8Array): ParsedModel {
	const rr = reader(raw);
	const { r, n, u16 } = rr;
	if (n < 12) throw new Error(`model.stream: too small (${n} bytes)`);
	r.seek(0);
	const dword0 = r.readU32();
	const streamPayloadLen = r.readU32();
	const dword2 = r.readU32();
	void dword0;
	void dword2;
	const payloadStart = 12;
	const idxStart = findStreamIndexStart(u16, n, payloadStart);
	const vbytes = idxStart - payloadStart;
	const vertexCount = Math.floor(vbytes / 16);
	const positions: number[] = new Array(vertexCount * 3);
	for (let v = 0; v < vertexCount; v++) {
		const base = payloadStart + v * 16;
		positions[v * 3] = decodeHalf(u16(base));
		positions[v * 3 + 1] = decodeHalf(u16(base + 2));
		positions[v * 3 + 2] = decodeHalf(u16(base + 4));
	}
	const indices = expandStrips(u16, idxStart, n, vertexCount);
	return {
		kind: 'stream',
		streamPayloadLen,
		meshes: [{ positions, indices, vertexCount, stride: 16, format: 'half' }],
		bounds: boundsOfPositions(positions),
	};
}

// ---------------------------------------------------------------------------
// Base .model section-table decode
// ---------------------------------------------------------------------------

/** One vertex buffer from the VB table. */
type VertexBuffer = { fileOffset: number; size: number; stride: number; vcount: number };
/** One draw call from the IB table. */
type DrawCall = { relOffset: number; idxCount: number };

const STRIDE_MIN = 12;
const STRIDE_MAX = 64;

/**
 * Find the VERTEX-BUFFER table: the first 0x24-strided run of records
 * {size:u32, stride:u32, vcount:u32, …} where size ≈ stride*vcount (rounded up
 * to a 16-byte multiple) and stride is a plausible vertex stride. Returns the
 * parsed buffers (with their absolute file offsets) plus the offset just past
 * the table (= the start of the bulk vertex region).
 */
function readVertexBufferTable(
	u32: (p: number) => number,
	n: number,
	headerBounds: ModelBounds,
): { buffers: VertexBuffer[]; vertexDataStart: number } | null {
	const validRec = (p: number): { size: number; stride: number; vcount: number } | null => {
		if (p + 12 > n) return null;
		const size = u32(p);
		const stride = u32(p + 4);
		const vcount = u32(p + 8);
		if (stride < STRIDE_MIN || stride > STRIDE_MAX) return null;
		if (vcount <= 0 || vcount > 4_000_000) return null;
		const exact = stride * vcount;
		// size is the buffer length, padded up to a 16-byte multiple.
		if (size < exact || size - exact >= 64 || size <= 0 || size >= n) return null;
		return { size, stride, vcount };
	};

	for (let start = 0x0c; start + 12 <= n; start += 4) {
		const first = validRec(start);
		if (!first) continue;
		// Walk consecutive 0x24-strided records.
		const recs: { size: number; stride: number; vcount: number }[] = [];
		let p = start;
		while (true) {
			const rec = validRec(p);
			if (!rec) break;
			recs.push(rec);
			p += 0x24;
		}
		if (recs.length === 0) continue;
		const tableEnd = p; // first non-record offset
		// Locate the bulk vertex data start: the first offset >= tableEnd where
		// buffer 0 decodes with w≈1.0 (half) or finite positions matching the
		// header AABB (float). Search a small window to absorb alignment padding.
		const probe = probeVertexDataStart(recs, tableEnd, n, headerBounds);
		if (!probe) continue;
		const buffers: VertexBuffer[] = [];
		let acc = probe.vertexDataStart;
		for (const rec of recs) {
			buffers.push({ fileOffset: acc, size: rec.size, stride: rec.stride, vcount: rec.vcount });
			acc += rec.size;
		}
		return { buffers, vertexDataStart: probe.vertexDataStart };
	}
	return null;
}

/**
 * Heuristically find where the bulk vertex region begins (right after the VB
 * table, modulo alignment padding). Returns the candidate offset whose buffer-0
 * decode looks valid. For the float path we additionally require the decoded
 * buffer-0 AABB to fall inside the header AABB — this disambiguates the 4-byte
 * alignment slip where a u32 table value decodes as a finite denormal float.
 */
function probeVertexDataStart(
	recs: { size: number; stride: number; vcount: number }[],
	tableEnd: number,
	n: number,
	headerBounds: ModelBounds,
): { vertexDataStart: number } | null {
	const rec0 = recs[0];
	let best: { off: number; score: number } | null = null;
	for (let cand = tableEnd; cand <= tableEnd + 0x80 && cand + rec0.stride * 4 <= n; cand += 4) {
		const fmt = detectVertexFormat(cand, rec0, n);
		if (!fmt) continue;
		if (fmt.format === 'half') {
			// w≈1.0 is already a strong signal — accept the first match.
			return { vertexDataStart: cand };
		}
		// float: score by how well the decoded AABB sits inside the header AABB.
		const score = scoreFloatCandidate(cand, rec0, n, headerBounds);
		if (score !== null && (best === null || score < best.score)) best = { off: cand, score };
	}
	return best ? { vertexDataStart: best.off } : null;
}

/**
 * Score a float-format candidate start: decode buffer-0 positions and measure
 * how far the resulting AABB extends beyond the header AABB (lower = better).
 * Returns null when positions are implausible (denormal soup / out of range).
 */
function scoreFloatCandidate(
	cand: number,
	rec: { stride: number; vcount: number },
	n: number,
	headerBounds: ModelBounds,
): number | null {
	const view = PROBE_VIEW!;
	const sample = Math.min(rec.vcount, 128);
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity,
		mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	let denorm = 0;
	for (let i = 0; i < sample; i++) {
		const b = cand + i * rec.stride;
		if (b + 12 > n) return null;
		const x = view.getFloat32(b, false);
		const y = view.getFloat32(b + 4, false);
		const z = view.getFloat32(b + 8, false);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
		// Reject tiny denormals (a misaligned u32 table value reads as ~1e-40).
		const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
		if (mag > 0 && mag < 1e-6) denorm++;
		if (Math.abs(x) > 1e5 || Math.abs(y) > 1e5 || Math.abs(z) > 1e5) return null;
		mnx = Math.min(mnx, x);
		mny = Math.min(mny, y);
		mnz = Math.min(mnz, z);
		mxx = Math.max(mxx, x);
		mxy = Math.max(mxy, y);
		mxz = Math.max(mxz, z);
	}
	if (denorm > sample * 0.2) return null;
	if (!headerBounds) return mxx - mnx + (mxy - mny) + (mxz - mnz); // no AABB to compare
	const over = (a: number, lo: number, hi: number) =>
		Math.max(0, lo - a) + Math.max(0, a - hi);
	const pad = 1e-2;
	const excess =
		over(mnx, headerBounds.min[0] - pad, headerBounds.max[0] + pad) +
		over(mxx, headerBounds.min[0] - pad, headerBounds.max[0] + pad) +
		over(mny, headerBounds.min[1] - pad, headerBounds.max[1] + pad) +
		over(mxy, headerBounds.min[1] - pad, headerBounds.max[1] + pad) +
		over(mnz, headerBounds.min[2] - pad, headerBounds.max[2] + pad) +
		over(mxz, headerBounds.min[2] - pad, headerBounds.max[2] + pad);
	return excess;
}

/**
 * Read a big-endian half at an absolute offset (cheap inline, used by the
 * format probe before a typed reader is available at that offset).
 */
function halfAt(view: DataView, p: number): number {
	return decodeHalf(view.getUint16(p, false));
}

// A DataView shared by the probe functions, set per-parse.
let PROBE_VIEW: DataView | null = null;

/**
 * Detect a buffer's vertex format by sampling its first vertices:
 *   - 'half': 4 big-endian half-floats per vertex, 4th (w) ≈ 1.0 (hkxVertexP4…).
 *   - 'float': full float32 P3 + UV; positions finite and within a sane range.
 * Returns the format and the byte offset of the position triple within a vertex.
 */
function detectVertexFormat(
	bufStart: number,
	rec: { stride: number; vcount: number },
	n: number,
): { format: 'half' | 'float'; posOffset: number } | null {
	const view = PROBE_VIEW!;
	const sample = Math.min(rec.vcount, 64);
	// HALF: scan stride for a 4-half group whose 4th half ≈ 1.0 across samples.
	for (let po = 0; po + 8 <= rec.stride; po += 2) {
		let wOk = 0;
		let posOk = 0;
		for (let i = 0; i < sample; i++) {
			const b = bufStart + i * rec.stride + po;
			if (b + 8 > n) break;
			const w = halfAt(view, b + 6);
			if (Math.abs(w - 1.0) < 1e-2) wOk++;
			const x = halfAt(view, b);
			const y = halfAt(view, b + 2);
			const z = halfAt(view, b + 4);
			if (
				Number.isFinite(x) &&
				Number.isFinite(y) &&
				Number.isFinite(z) &&
				Math.abs(x) < 1e4 &&
				Math.abs(y) < 1e4 &&
				Math.abs(z) < 1e4
			)
				posOk++;
		}
		if (wOk >= sample * 0.85 && posOk >= sample * 0.85) {
			return { format: 'half', posOffset: po };
		}
	}
	// FLOAT: full float32. Position is the first float3 of the stride; require all
	// finite & in a sane range across samples.
	{
		let posOk = 0;
		for (let i = 0; i < sample; i++) {
			const b = bufStart + i * rec.stride;
			if (b + 12 > n) break;
			const x = view.getFloat32(b, false);
			const y = view.getFloat32(b + 4, false);
			const z = view.getFloat32(b + 8, false);
			if (
				Number.isFinite(x) &&
				Number.isFinite(y) &&
				Number.isFinite(z) &&
				Math.abs(x) < 1e5 &&
				Math.abs(y) < 1e5 &&
				Math.abs(z) < 1e5
			)
				posOk++;
		}
		if (posOk >= sample * 0.95) return { format: 'float', posOffset: 0 };
	}
	return null;
}

/**
 * Find the INDEX-BUFFER / draw-call table: the first 32-byte-strided run of
 * records {relOffset:u32, 0,0,0, idxCount:u32, idxCount*2:u32, 0,0}.
 */
function readDrawCallTable(u32: (p: number) => number, n: number): DrawCall[] {
	const validRec = (p: number): DrawCall | null => {
		if (p + 32 > n) return null;
		const off = u32(p);
		if (u32(p + 4) !== 0 || u32(p + 8) !== 0 || u32(p + 12) !== 0) return null;
		const cnt = u32(p + 16);
		const blen = u32(p + 20);
		if (u32(p + 24) !== 0) return null;
		if (cnt <= 0 || cnt * 2 !== blen) return null;
		if (off <= 0 || off >= n) return null;
		return { relOffset: off, idxCount: cnt };
	};
	for (let start = 0x0c; start + 32 <= n; start += 4) {
		if (!validRec(start)) continue;
		const recs: DrawCall[] = [];
		let p = start;
		while (true) {
			const rec = validRec(p);
			if (!rec) break;
			recs.push(rec);
			p += 32;
		}
		if (recs.length >= 1) return recs;
	}
	return [];
}

/**
 * Locate the absolute file offset of the index region (the first 0xFFFF-restart
 * triangle-strip block at/after `vertexRegionEnd`). The draw-call table stores
 * RELATIVE offsets; the correction = indexRegionStart - firstDrawCall.relOffset.
 * We find indexRegionStart by aligning vertexRegionEnd up and scanning for the
 * first strip-like run that, when corrected, makes the draw-call table tile to
 * EOF.
 */
function findIndexCorrection(
	u16: (p: number) => number,
	n: number,
	draws: DrawCall[],
	vertexRegionEnd: number,
): number | null {
	if (draws.length === 0) return null;
	// The last draw call must end at/just before EOF. Solve for the correction
	// from that constraint, then verify the FIRST draw call lands on a valid strip.
	const last = draws[draws.length - 1];
	const lastEnd = last.relOffset + last.idxCount * 2; // relative end of region
	// correction so that lastEnd maps to ~EOF (allowing <=16 bytes of padding).
	for (let pad = 0; pad <= 16; pad += 2) {
		const corr = n - pad - lastEnd;
		if (corr <= 0) continue;
		const first = draws[0].relOffset + corr;
		if (first < vertexRegionEnd - 64 || first + 8 > n) continue;
		// Validate: the first few u16 of draw 0 look like a strip (small ascending
		// indices and/or a restart soon).
		if (looksLikeStrip(u16, first, Math.min(draws[0].idxCount, 32), n)) return corr;
	}
	// Fallback: align the vertex-region end up to 16 and treat that as the index
	// region start; correction = that - firstRelOffset.
	const aligned = (vertexRegionEnd + 15) & ~15;
	const corr = aligned - draws[0].relOffset;
	if (corr > 0 && looksLikeStrip(u16, draws[0].relOffset + corr, 32, n)) return corr;
	return null;
}

/** A run looks like a strip if its non-restart values stay small (< 65000). */
function looksLikeStrip(
	u16: (p: number) => number,
	start: number,
	count: number,
	n: number,
): boolean {
	let seen = 0;
	let big = 0;
	for (let i = 0; i < count; i++) {
		const p = start + i * 2;
		if (p + 1 >= n) break;
		const v = u16(p);
		if (v === 0xffff) continue;
		if (v > 65000) big++;
		seen++;
	}
	return seen > 0 && big === 0;
}

/**
 * Decode positions (and best-effort UVs) for one vertex buffer.
 * `posOffset` is the byte offset of the position triple within the stride.
 */
function decodeBufferPositions(
	rr: { u16: (p: number) => number; f32: (p: number) => number; n: number },
	buf: VertexBuffer,
	format: 'half' | 'float',
	posOffset: number,
): { positions: number[]; uv?: number[] } {
	const { u16, f32, n } = rr;
	const positions: number[] = new Array(buf.vcount * 3);
	let uv: number[] | undefined;
	if (format === 'half') {
		for (let i = 0; i < buf.vcount; i++) {
			const b = buf.fileOffset + i * buf.stride + posOffset;
			if (b + 6 > n) {
				positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 0;
				continue;
			}
			positions[i * 3] = decodeHalf(u16(b));
			positions[i * 3 + 1] = decodeHalf(u16(b + 2));
			positions[i * 3 + 2] = decodeHalf(u16(b + 4));
		}
	} else {
		// float32 P3 + UV: position is the first float3; UV the float2 at byte 12.
		uv = new Array(buf.vcount * 2);
		for (let i = 0; i < buf.vcount; i++) {
			const b = buf.fileOffset + i * buf.stride;
			if (b + 12 > n) {
				positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 0;
				continue;
			}
			positions[i * 3] = f32(b);
			positions[i * 3 + 1] = f32(b + 4);
			positions[i * 3 + 2] = f32(b + 8);
			if (buf.stride >= 20 && b + 20 <= n) {
				uv[i * 2] = f32(b + 12);
				uv[i * 2 + 1] = f32(b + 16);
			} else {
				uv[i * 2] = uv[i * 2 + 1] = 0;
			}
		}
	}
	return { positions, uv };
}

/**
 * Parse a base .model: header + bounds + (where present) the explicit vertex /
 * index section tables -> per-buffer submeshes with positions & indices.
 * Falls back to the header-only metadata when the tables can't be located
 * (e.g. a tiny stub .model whose geometry lives in a .model.stream twin).
 */
export function parseModelBase(raw: Uint8Array): ParsedModel {
	const rr = reader(raw);
	const { r, n, u16, u32, f32 } = rr;
	if (n < 12) throw new Error(`model: too small (${n} bytes)`);
	r.seek(0);
	const magic = r.readU32();
	if (!isModelMagic(magic)) {
		throw new Error(`model: bad magic 0x${magic.toString(16)} (expected 0x02xx0008)`);
	}
	const nodeCount = r.readU32();
	const treeOffset = r.readU32();
	const bounds = scanBounds(rr);

	// Make the shared DataView available to the format probe.
	const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	PROBE_VIEW = new DataView(ab);

	const meshes: ModelMesh[] = [];
	let partial = false;
	let note: string | undefined;

	try {
		const vbTable = readVertexBufferTable(u32, n, bounds);
		const draws = readDrawCallTable(u32, n);

		if (vbTable && vbTable.buffers.length > 0) {
			const { buffers } = vbTable;
			const vertexRegionEnd =
				buffers[buffers.length - 1].fileOffset + buffers[buffers.length - 1].size;

			// Detect each buffer's format/posOffset.
			const fmts = buffers.map((b) =>
				detectVertexFormat(b.fileOffset, { stride: b.stride, vcount: b.vcount }, n),
			);

			// Decode positions per buffer.
			const decoded = buffers.map((b, i) => {
				const fmt = fmts[i] ?? { format: 'half' as const, posOffset: 0 };
				const d = decodeBufferPositions(rr, b, fmt.format, fmt.posOffset);
				return { buf: b, fmt, ...d };
			});

			// Distribute draw calls to buffers and expand strips.
			const corr = findIndexCorrection(u16, n, draws, vertexRegionEnd);
			const perBufferIndices: number[][] = buffers.map(() => []);

			if (corr !== null && draws.length > 0) {
				for (const dc of draws) {
					const start = dc.relOffset + corr;
					if (start < 0 || start + dc.idxCount * 2 > n) {
						partial = true;
						continue;
					}
					// Read the raw strip indices.
					const strip: number[] = new Array(dc.idxCount);
					let maxIdx = 0;
					for (let i = 0; i < dc.idxCount; i++) {
						const v = u16(start + i * 2);
						strip[i] = v;
						if (v !== 0xffff && v > maxIdx) maxIdx = v;
					}
					// Route to the smallest buffer whose vcount contains maxIdx.
					let target = -1;
					for (let bi = 0; bi < buffers.length; bi++) {
						if (buffers[bi].vcount > maxIdx) {
							if (target < 0 || buffers[bi].vcount < buffers[target].vcount) target = bi;
						}
					}
					if (target < 0) {
						partial = true;
						continue;
					}
					const tris = expandStripArray(strip, buffers[target].vcount);
					if (tris.length >= 3) {
						const dst = perBufferIndices[target];
						for (const t of tris) dst.push(t);
					}
				}
			} else {
				partial = true;
			}

			// Emit one submesh per buffer that has geometry.
			for (let bi = 0; bi < buffers.length; bi++) {
				const d = decoded[bi];
				const indices = perBufferIndices[bi];
				meshes.push({
					positions: d.positions,
					indices,
					vertexCount: buffers[bi].vcount,
					uv: d.uv,
					stride: buffers[bi].stride,
					format: d.fmt?.format,
				});
			}

			const decodedDraws = draws.length;
			const usedDraws = corr !== null ? draws.length : 0;
			if (partial || usedDraws < decodedDraws) {
				note =
					`Base .model: decoded ${buffers.length} vertex buffer(s) ` +
					`(${buffers.reduce((s, b) => s + b.vcount, 0)} verts) and ` +
					`${usedDraws}/${decodedDraws} draw call(s). Per-buffer binding is heuristic.`;
			}
		} else {
			// No VB table — likely a stub .model (geometry in .model.stream) or an
			// unmapped variant. Fall back to header-only metadata.
			partial = true;
			note =
				'Base .model: no vertex/index section table found (likely a stub whose ' +
				'geometry lives in a .model.stream twin).';
		}
	} catch (err) {
		partial = true;
		note = `Base .model: section-table decode failed (${String((err as Error)?.message ?? err)}).`;
	} finally {
		PROBE_VIEW = null;
	}

	// Prefer decoded-vertex bounds when we have positions; else header AABB.
	// Merge per-mesh bounds without spreading huge arrays (avoids stack overflow
	// on large backdrops with hundreds of thousands of vertices).
	const decodedBounds = ((): ModelBounds => {
		let mnx = Infinity,
			mny = Infinity,
			mnz = Infinity,
			mxx = -Infinity,
			mxy = -Infinity,
			mxz = -Infinity;
		let any = false;
		for (const m of meshes) {
			if (!m.positions.length) continue;
			const b = boundsOfPositions(m.positions);
			if (!b) continue;
			any = true;
			mnx = Math.min(mnx, b.min[0]);
			mny = Math.min(mny, b.min[1]);
			mnz = Math.min(mnz, b.min[2]);
			mxx = Math.max(mxx, b.max[0]);
			mxy = Math.max(mxy, b.max[1]);
			mxz = Math.max(mxz, b.max[2]);
		}
		return any ? { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] } : null;
	})();

	return {
		kind: 'model',
		magic,
		nodeCount,
		treeOffset,
		meshes,
		bounds: decodedBounds ?? bounds,
		partial,
		note,
	};
}

/**
 * Top-level parse: auto-detect base .model (magic 02 00 00 08) vs a
 * .model.stream (leading dword0==0, dword1==filesize-12).
 */
export function parseModel(raw: Uint8Array): ParsedModel {
	if (raw.byteLength >= 4) {
		const view = new DataView(raw.buffer, raw.byteOffset, Math.min(12, raw.byteLength));
		const m = view.getUint32(0, false);
		if (isModelMagic(m)) return parseModelBase(raw);
		if (raw.byteLength >= 12) {
			const d0 = view.getUint32(0, false);
			const d1 = view.getUint32(4, false);
			if (d0 === 0 && d1 === raw.byteLength - 12) return parseModelStream(raw);
		}
	}
	return parseModelBase(raw);
}

/** Total triangle count across all submeshes. */
export function triangleCount(m: ParsedModel): number {
	let t = 0;
	for (const mesh of m.meshes) t += mesh.indices.length / 3;
	return t;
}

/** Total vertex count across all submeshes. */
export function vertexCount(m: ParsedModel): number {
	let v = 0;
	for (const mesh of m.meshes) v += mesh.vertexCount;
	return v;
}
