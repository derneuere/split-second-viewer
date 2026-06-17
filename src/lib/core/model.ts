// .model / .model.stream parser — Crayon2 renderable geometry (PS3 big-endian).
//
// Pure module: imports ONLY the binary helpers, NEVER the registry (acyclic
// rule, see registry/handler.ts). Importable from Node by the CLI and vitest.
//
// Status: PARTIAL. Faithful to wiki/format-model.html, which documents the
// node-tree type tags (0x04/05/06/0E/0F) and the explicit vertex/index section
// table as UNRESOLVED. We therefore decode:
//   * base .model  -> header (magic/node_count/tree_offset) + AABB bounds +
//                     (where safely detectable) the trailing 16-bit triangle
//                     strips. Per-section vertex positions in a base .model are
//                     NOT decoded: the per-section vertex format/stride lives in
//                     the still-unmapped node tree (see the wiki "Open
//                     questions").
//   * .model.stream-> the 12-byte stream header (dword1 == filesize-12), the
//                     interleaved vertex stream as 4 big-endian half-floats per
//                     16-byte stride (position x,y,z,w==1.0 — the hkxVertexP4…
//                     16-bit position layout), and the trailing tri-strips.
//                     This is the high-LOD renderable geometry path and decodes
//                     positions + indices cleanly.
//
// The returned model is the shape the brief asks for:
//   { meshes: [{ positions:number[] (flat x,y,z…), indices:number[] }], bounds }
// positions is a plain number[] (Float32Array-as-array) so it stays
// JSON-serializable for the CLI/dump path.

import { BinReader } from './binary/BinReader';

/** A decoded submesh: flat position list (x,y,z triplets) + triangle indices. */
export type ModelMesh = {
	/** Flat float positions: [x0,y0,z0, x1,y1,z1, …]. Empty when not decoded. */
	positions: number[];
	/** Triangle-list indices (strips already expanded). */
	indices: number[];
	/** Vertex count (positions.length / 3, or maxIndex+1 when positions absent). */
	vertexCount: number;
};

export type ModelBounds = {
	min: [number, number, number];
	max: [number, number, number];
} | null;

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
	/** Decoded submeshes (one entry for the single buffer we recover). */
	meshes: ModelMesh[];
	/** Axis-aligned bounds, from the float metadata (base) or decoded verts (stream). */
	bounds: ModelBounds;
};

export const MODEL_MAGIC = 0x02000008;

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
function reader(raw: Uint8Array): { r: BinReader; n: number; u16(p: number): number } {
	const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	const r = new BinReader(ab, false /* big-endian */);
	const dv = new DataView(ab);
	return { r, n: raw.byteLength, u16: (p: number) => dv.getUint16(p, false) };
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
		// This keeps a consistent facing across the strip (standard GL/RSX rule).
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
		// advance the sliding window
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
 * Locate the index buffer in a BASE .model by finding the trailing cluster of
 * 0xFFFF restarts (gaps <= GAP bytes) and walking back over the opening strip.
 * Returns -1 when no safe index region is found (e.g. tiny meshes whose only
 * 0xFFFF bytes are a stray 0xFFFFFFFF marker in the float header). Callers MUST
 * sanity-check the decoded maxIndex (< 0xFFFE) before trusting the result.
 */
function findBaseIndexStart(u16: (p: number) => number, n: number): number {
	const ffs: number[] = [];
	for (let p = 0; p + 1 < n; p += 2) if (u16(p) === 0xffff) ffs.push(p);
	if (ffs.length < 3) return -1; // a real index buffer has many restarts
	const GAP = 8192;
	// trailing cluster
	let first = ffs[ffs.length - 1];
	let restartsInCluster = 1;
	for (let i = ffs.length - 1; i > 0; i--) {
		if (ffs[i] - ffs[i - 1] <= GAP) {
			first = ffs[i - 1];
			restartsInCluster++;
		} else break;
	}
	if (restartsInCluster < 3) return -1;
	// cap = max index across the cluster region
	let cap = 0;
	for (let p = first; p + 1 < n; p += 2) {
		const v = u16(p);
		if (v !== 0xffff && v > cap) cap = v;
	}
	if (cap === 0 || cap >= 0xfffe) return -1; // grabbed a stray 0xFFFF region
	// walk back over the opening strip while values stay valid indices
	let s = first;
	for (let p = first - 2; p >= 0; p -= 2) {
		const v = u16(p);
		if (v === 0xffff || v <= cap) s = p;
		else break;
	}
	return s;
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
		const a0 = r.readF32(), a1 = r.readF32(), a2 = r.readF32(), a3 = r.readF32();
		const b0 = r.readF32(), b1 = r.readF32(), b2 = r.readF32(), b3 = r.readF32();
		if (
			Math.abs(a3 - 1) < 1e-4 &&
			Math.abs(b3 - 1) < 1e-4 &&
			Number.isFinite(a0) && Number.isFinite(a1) && Number.isFinite(a2) &&
			Number.isFinite(b0) && Number.isFinite(b1) && Number.isFinite(b2) &&
			a0 <= b0 && a1 <= b1 && a2 <= b2 &&
			(b0 - a0) + (b1 - a1) + (b2 - a2) > 1e-5
		) {
			return { min: [a0, a1, a2], max: [b0, b1, b2] };
		}
	}
	return null;
}

/** Compute bounds over a flat positions array. */
function boundsOfPositions(pos: number[]): ModelBounds {
	if (pos.length < 3) return null;
	let mnx = Infinity, mny = Infinity, mnz = Infinity;
	let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
	for (let i = 0; i + 2 < pos.length; i += 3) {
		const x = pos[i], y = pos[i + 1], z = pos[i + 2];
		if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
		if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
	}
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
	// dword1 should be filesize-12; tolerate mismatch but record what we read.
	if (dword0 !== 0 || dword2 !== 0) {
		// Not the expected envelope — still attempt to parse from 0x0C.
	}
	const payloadStart = 12;
	const idxStart = findStreamIndexStart(u16, n, payloadStart);
	const vbytes = idxStart - payloadStart;
	const vertexCount = Math.floor(vbytes / 16);
	const positions: number[] = new Array(vertexCount * 3);
	for (let v = 0; v < vertexCount; v++) {
		const base = payloadStart + v * 16;
		// first 3 of the 4 leading half-floats are the position (4th is w==1.0)
		positions[v * 3] = decodeHalf(u16(base));
		positions[v * 3 + 1] = decodeHalf(u16(base + 2));
		positions[v * 3 + 2] = decodeHalf(u16(base + 4));
	}
	const indices = expandStrips(u16, idxStart, n, vertexCount);
	return {
		kind: 'stream',
		streamPayloadLen,
		meshes: [{ positions, indices, vertexCount }],
		bounds: boundsOfPositions(positions),
	};
}

/** Parse a base .model: header + bounds + (safely-detectable) triangle strips. */
export function parseModelBase(raw: Uint8Array): ParsedModel {
	const rr = reader(raw);
	const { r, n, u16 } = rr;
	if (n < 12) throw new Error(`model: too small (${n} bytes)`);
	r.seek(0);
	const magic = r.readU32();
	if (magic !== MODEL_MAGIC) {
		throw new Error(`model: bad magic 0x${magic.toString(16)} (expected 0x02000008)`);
	}
	const nodeCount = r.readU32();
	const treeOffset = r.readU32();
	const bounds = scanBounds(rr);

	const meshes: ModelMesh[] = [];
	const idxStart = findBaseIndexStart(u16, n);
	if (idxStart >= 0) {
		// determine maxIndex first to sanity-check & to bound triangles
		let maxIdx = 0;
		for (let p = idxStart; p + 1 < n; p += 2) {
			const v = u16(p);
			if (v !== 0xffff && v > maxIdx) maxIdx = v;
		}
		if (maxIdx > 0 && maxIdx < 0xfffe) {
			const vertexCount = maxIdx + 1;
			const indices = expandStrips(u16, idxStart, n, vertexCount);
			if (indices.length >= 3) {
				// positions for a base .model are not recoverable without the
				// (unresolved) node-tree section table; leave empty.
				meshes.push({ positions: [], indices, vertexCount });
			}
		}
	}

	return { kind: 'model', magic, nodeCount, treeOffset, meshes, bounds };
}

/**
 * Top-level parse: auto-detect base .model (magic 02 00 00 08) vs a
 * .model.stream (leading dword0==0, dword1==filesize-12).
 */
export function parseModel(raw: Uint8Array): ParsedModel {
	if (raw.byteLength >= 4) {
		const view = new DataView(
			raw.buffer,
			raw.byteOffset,
			Math.min(12, raw.byteLength),
		);
		const m = view.getUint32(0, false);
		if (m === MODEL_MAGIC) return parseModelBase(raw);
		// stream heuristic: dword0==0 and dword1 == filesize-12
		if (raw.byteLength >= 12) {
			const d0 = view.getUint32(0, false);
			const d1 = view.getUint32(4, false);
			if (d0 === 0 && d1 === raw.byteLength - 12) return parseModelStream(raw);
		}
	}
	// Fall back to base parse (will throw a clear error if magic is wrong).
	return parseModelBase(raw);
}

/** Total triangle count across all submeshes. */
export function triangleCount(m: ParsedModel): number {
	let t = 0;
	for (const mesh of m.meshes) t += mesh.indices.length / 3;
	return t;
}
