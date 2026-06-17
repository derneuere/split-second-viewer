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
//   The per-draw-call -> vertex-buffer BINDING is now read EXACTLY from the
//   node-tree binding table that sits just before the draw-call table: one
//   16-byte record per draw {0:u32, ptrA:u32, ptrB:u32, 6:u32}, where ptrB takes
//   exactly `bufferCount` distinct values spaced 0x24 apart (the per-buffer node
//   stride); sorting them ascending maps each draw to its true buffer. This
//   replaced the old "smallest fitting buffer" heuristic, which mis-routed draws
//   and rendered some cars/props (Musclecar_02 et al.) with scrambled geometry.
//   The heuristic is kept only as a fallback when the binding table is ambiguous.
//
//   LEVEL-SOBJ ROBUSTNESS: some level .ark members use a QUANTIZED-position
//   variant (int16 dequantized against a per-buffer node-tree box not yet read)
//   whose half/float decode yields ±tens-of-thousands garbage. Such buffers are
//   detected (extent overshoots the header AABB / |component| >= 1e4) and BLANKED
//   (emitted as no-geometry) rather than rendered wrong — "prefer no-geometry
//   over wrong geometry". Likewise a level Stream .geo (float32-P3 at a variable
//   interleaved stride) is distinguished from the half4 car stream by the w≈1.0
//   test and withheld until its stride is recovered, instead of spiking to ±65504.
//
//   * SKINNED .model (magic 0x02010008) — the animated/skinned Powerplay
//     variant (1636 files, mostly under Powerplays/Animations). Its container
//     differs from the standard variant in three ways that this parser now
//     handles via a DEDICATED path (parseModelSkinned):
//       - The vertex-buffer table is a run of 0x48-byte records, each holding
//         TWO 0x24 sub-records that share a vertex count: a stride-12 POSITION
//         stream (3 big-endian float32 x,y,z — NOT half-floats; half-decoding it
//         yields the tens-of-thousands garbage the brief warned about) and a
//         stride-8 aux stream (UV float2 / packed normal). Confirmed on
//         AA_Bell206B.model: records at 0x560 (vc=16) and 0x5a8 (vc=688), 0x48
//         apart.
//       - The records' embedded offset fields are NOT reliable file pointers, so
//         each position buffer is LOCATED by scanning forward (16-then-4-aligned)
//         from the table end for the first contiguous float32-P3 block of the
//         right vertex count whose AABB is finite & bounded, advancing the cursor
//         past each block so buffers are taken in node order. Validated 100% on a
//         spread of samples (cars, ferries, cranes; strides 12 and 16).
//       - There is NO 16-bit tri-strip index buffer and NO 32-byte draw-call
//         table, and — CONFIRMED by exhaustive byte-budget analysis — no index
//         buffer of ANY encoding is present in the file. Each section has a node
//         descriptor {…, 0x00020000, 0x81xx0000, 0x42ff2000, (vc<<16|ic),
//         0xffffffff} that DECLARES a triangle-index count `ic` (AA_Bell206B: 24
//         + 2274 = 766 tris), but the byte budget is fully consumed by the
//         position stream (stride-12 f32 P3) + the paired aux stream (stride-8
//         UV/normal) + a small packed Havok skinning block — there is no room for
//         the ~ic*2 index bytes anywhere (verified across every multi-section
//         sample: idxBytesNeeded >> gapAfterVertexData). The topology is therefore
//         genuinely STRIPPED from the .model (reconstructed at runtime / a RAM
//         dump would be needed), not merely undecoded. The skinned path emits
//         POSITIONS ONLY (point meshes, indices empty), flags `partial`, and
//         reports the descriptor-declared expected triangle total in `note`. The
//         decoded combined AABB is cross-checked against the header float AABB for
//         sanity (extents match; axes are permuted by the engine's convention).
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

/** True only for the SKINNED/animated variant (02 01 00 08). */
export function isSkinnedMagic(m: number): boolean {
	return m === MODEL_MAGIC_SKINNED;
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

/**
 * True when a decoded position buffer is clearly GARBAGE rather than real
 * geometry: the half-float-spike fingerprint of the level-sobj quantized variant.
 * We reject a buffer only on strong evidence so cars/props (whose decoded extent
 * may differ from the header AABB by an axis permutation, but stays bounded) are
 * never wrongly blanked:
 *   - any |component| >= 1e4  (half-float spikes peak near ±65504; real meshes are
 *     metres-to-hundreds-of-metres), OR
 *   - a non-finite component, OR
 *   - when a header AABB exists, a decoded extent that overshoots the header
 *     extent by >8x on the dominant axis (the dequant-against-wrong-box symptom).
 */
function positionsImplausible(pos: number[], headerBounds: ModelBounds): boolean {
	const b = boundsOfPositions(pos);
	if (!b) return true; // all non-finite → unusable
	let maxAbs = 0;
	let anyNonFinite = false;
	for (let i = 0; i < pos.length; i++) {
		const v = pos[i];
		if (!Number.isFinite(v)) {
			anyNonFinite = true;
			break;
		}
		const a = Math.abs(v);
		if (a > maxAbs) maxAbs = a;
	}
	if (anyNonFinite) return true;
	if (maxAbs >= 1e4) return true;
	if (headerBounds) {
		const decExt = Math.max(
			b.max[0] - b.min[0],
			b.max[1] - b.min[1],
			b.max[2] - b.min[2],
		);
		const hdrExt = Math.max(
			headerBounds.max[0] - headerBounds.min[0],
			headerBounds.max[1] - headerBounds.min[1],
			headerBounds.max[2] - headerBounds.min[2],
			1e-3,
		);
		if (decExt > hdrExt * 8) return true;
	}
	return false;
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

	// Discriminate the two stream layouts that both carry the 12-byte frame:
	//   * the high-LOD CAR stream (Musclecar_*.model.stream): a 16-byte stride of
	//     4 big-endian half-floats per vertex, the 4th (w) == 1.0 (hkxVertexP4…).
	//   * the level Stream .geo (airport_test_03): float32 P3 at a LARGER, varying
	//     stride interleaved with attributes — decoding THAT as 16-byte half4 yields
	//     the ±65504 half-float spikes the level loader flags as "suspect".
	// The w≈1.0 fraction is a clean separator (cars: ~100%; level .geo: ~0-15%), so
	// we only emit the half4 decode when it is genuinely a P4-half stream. For the
	// level .geo we emit no positions (no-geometry beats wrong geometry) and flag
	// partial; its float32 layout, which needs per-stream stride recovery, is not
	// decoded here yet.
	let wHits = 0;
	const wSamples = Math.min(vertexCount, 64);
	for (let v = 0; v < wSamples; v++) {
		const w = decodeHalf(u16(payloadStart + v * 16 + 6));
		if (Math.abs(w - 1.0) < 1e-2) wHits++;
	}
	const isHalf4 = wSamples > 0 && wHits >= wSamples * 0.85;

	if (!isHalf4) {
		return {
			kind: 'stream',
			streamPayloadLen,
			meshes: [{ positions: [], indices: [], vertexCount: 0 }],
			bounds: null,
			partial: true,
			note:
				`Stream .geo: not a P4-half (16-byte half4) vertex stream — only ` +
				`${wHits}/${wSamples} vertices have w≈1.0. This is the level Stream .geo ` +
				`float32-P3 layout (variable stride + interleaved attributes); decoding it ` +
				`as half4 would produce ±65504 spikes, so positions are withheld until the ` +
				`float32 stride is recovered.`,
		};
	}

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
 * decode looks valid.
 *
 * HALF buffers: the w≈1.0 fingerprint is decisive, so the first candidate whose
 * stride carries a 4-half group with w≈1.0 is accepted (slide absorbs padding).
 *
 * FLOAT buffers: the bulk data begins EXACTLY at the VB-table end (verified on
 * the barrel/prop samples — no alignment slip). The position float3 sits at a
 * fixed byte OFFSET WITHIN the stride (byte 4 on every float sample checked:
 * PointLight stride-20, NemTruckBarrels stride-52 — a leading weight/UV float
 * precedes the position). That per-vertex offset — not the data start — is what
 * `detectVertexFormat` resolves against the header AABB. The old code instead
 * slid the *data start* in 4-byte steps with posOffset fixed at 0 and greedily
 * took the first start whose first-128-vertex AABB merely *fit inside* the
 * header box. That broke the High LOD: its first 128 verts cover only a small
 * sub-box, so a wrong start (decoding a normal column as the position) also
 * "fit inside" and won — yielding sheared geometry. We now anchor the float
 * data start at the table end and let the in-stride offset search (over the full
 * vertex span, matching the header EXTENT) recover the true position column.
 */
function probeVertexDataStart(
	recs: { size: number; stride: number; vcount: number }[],
	tableEnd: number,
	n: number,
	headerBounds: ModelBounds,
): { vertexDataStart: number } | null {
	const rec0 = recs[0];
	// HALF: keep the data-start slide (the half stream may sit a few bytes past
	// the table; the w≈1.0 group pins the true start unambiguously).
	for (let cand = tableEnd; cand <= tableEnd + 0x80 && cand + rec0.stride * 4 <= n; cand += 4) {
		const fmt = detectHalfFormat(cand, rec0, n);
		if (fmt) return { vertexDataStart: cand };
	}
	// FLOAT: the bulk data begins at the table end; the in-stride position offset
	// is resolved by detectVertexFormat. Accept iff a float position column is
	// found there.
	if (detectFloatFormat(tableEnd, rec0, n, headerBounds)) {
		return { vertexDataStart: tableEnd };
	}
	// Fallback: scan a small window for any float start (no header, denormal pad).
	for (let cand = tableEnd; cand <= tableEnd + 0x80 && cand + rec0.stride * 4 <= n; cand += 4) {
		if (detectFloatFormat(cand, rec0, n, headerBounds)) return { vertexDataStart: cand };
	}
	return null;
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

/** A decoded float3 AABB plus the denormal/usable-sample counts used to score it. */
type FloatAABB = {
	min: [number, number, number];
	max: [number, number, number];
	/** Count of sampled vertices whose magnitude read as a tiny denormal (slip). */
	denorm: number;
	/** Number of vertices actually sampled. */
	sampled: number;
};

/**
 * Decode the float32 P3 AABB at a given in-stride position offset over a LARGE,
 * evenly-spread sample of the buffer (not just the leading vertices — those can
 * cover only a small sub-region of a big mesh, which was the High-LOD trap).
 * Returns null when a component is non-finite or wildly out of range.
 */
function floatAABBAt(
	view: DataView,
	bufStart: number,
	posOffset: number,
	rec: { stride: number; vcount: number },
	n: number,
): FloatAABB | null {
	// Sample up to ~4096 vertices spread across the whole buffer via a stride step.
	const want = Math.min(rec.vcount, 4096);
	const step = Math.max(1, Math.floor(rec.vcount / want));
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity,
		mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	let denorm = 0;
	let sampled = 0;
	for (let i = 0; i < rec.vcount; i += step) {
		const b = bufStart + i * rec.stride + posOffset;
		if (b + 12 > n) break;
		sampled++;
		const x = view.getFloat32(b, false);
		const y = view.getFloat32(b + 4, false);
		const z = view.getFloat32(b + 8, false);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
		if (Math.abs(x) > 1e5 || Math.abs(y) > 1e5 || Math.abs(z) > 1e5) return null;
		// Tiny denormals (a misaligned u32 table value reads as ~1e-40) flag a slip.
		const mag = Math.abs(x) + Math.abs(y) + Math.abs(z);
		if (mag > 0 && mag < 1e-6) denorm++;
		if (x < mnx) mnx = x;
		if (y < mny) mny = y;
		if (z < mnz) mnz = z;
		if (x > mxx) mxx = x;
		if (y > mxy) mxy = y;
		if (z > mxz) mxz = z;
	}
	if (sampled === 0) return null;
	return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz], denorm, sampled };
}

/**
 * Score how well a decoded float AABB matches the header AABB. The engine
 * permutes axes by its coordinate convention, so we compare SORTED extents (the
 * three side lengths) — this is what distinguishes the true position column from
 * a normal/tangent column (extent ~2.0 on every axis) or a UV/weight column
 * (extent ~1.0). Lower is better; null when there is no header to compare to.
 */
function extentMatchError(b: FloatAABB, headerBounds: ModelBounds): number | null {
	if (!headerBounds) return null;
	const he = [
		headerBounds.max[0] - headerBounds.min[0],
		headerBounds.max[1] - headerBounds.min[1],
		headerBounds.max[2] - headerBounds.min[2],
	].sort((p, q) => p - q);
	const de = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].sort(
		(p, q) => p - q,
	);
	return Math.abs(he[0] - de[0]) + Math.abs(he[1] - de[1]) + Math.abs(he[2] - de[2]);
}

/**
 * Detect the HALF (4×f16 P4, w≈1.0) layout at a buffer start: scan the stride
 * for a 4-half group whose 4th component reads ≈1.0 across the sample. Returns
 * the position offset within the stride, or null.
 */
function detectHalfFormat(
	bufStart: number,
	rec: { stride: number; vcount: number },
	n: number,
): { format: 'half'; posOffset: number } | null {
	const view = PROBE_VIEW!;
	const sample = Math.min(rec.vcount, 64);
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
	return null;
}

/**
 * The float32 vertex layout puts a leading weight/UV float BEFORE the position
 * float3, so the position sits at byte 4 of the stride (data starting at the VB
 * table end). This is a constant format property across every float .model
 * sample checked — PointLight (stride-20), NemTruckBarrels Low/Mid/High
 * (stride-52), Helicopter_Bell206B (stride 24/32/36/44), airport props — i.e.
 * the cooked hkxVertexP4… layout where the P4 position's leading lane is the
 * skin-weight/UV slot. Used as the strong default when a per-buffer extent
 * cannot be matched against the (whole-model) header AABB.
 */
const FLOAT_POS_OFFSET = 4;

/** A float column is a usable position column if finite, non-denormal, non-flat. */
function isUsablePositionColumn(b: FloatAABB | null): boolean {
	if (!b) return false;
	if (b.denorm > b.sampled * 0.2) return false;
	const ext = b.max[0] - b.min[0] + (b.max[1] - b.min[1]) + (b.max[2] - b.min[2]);
	return ext > 1e-4; // a constant column (e.g. w==1) is not a position
}

/**
 * Detect the FLOAT (float32 P3 + UV) layout and, crucially, the byte OFFSET of
 * the position float3 WITHIN the stride.
 *
 * Why this is not "offset 0": a leading weight/UV float precedes the position on
 * every float sample (PointLight, NemTruckBarrels, the helicopter) — the true
 * position is at byte 4 (see FLOAT_POS_OFFSET). The High LOD bug came from the
 * old probe instead sliding the *data start* with the offset pinned at 0 and
 * greedily accepting the first start whose first-128-vertex AABB merely *fit
 * inside* the header box; High's leading verts cover a small sub-box, so a wrong
 * column also fit and won, shearing the mesh.
 *
 * Resolution order:
 *   1. If a single in-stride float3 column's decoded extent (over the FULL
 *      vertex span) MATCHES the header AABB extent (sorted, allowing axis
 *      permutation) within a tight tolerance, use it. This nails single-buffer
 *      models (barrels, PointLight, bench) regardless of the byte offset.
 *   2. Otherwise (multi-buffer models, where a buffer's local extent legitimately
 *      differs from the whole-model AABB), use the canonical FLOAT_POS_OFFSET (4)
 *      if that column is usable.
 *   3. Final fallbacks: byte 0, then the first usable column.
 */
function detectFloatFormat(
	bufStart: number,
	rec: { stride: number; vcount: number },
	n: number,
	headerBounds: ModelBounds,
): { format: 'float'; posOffset: number } | null {
	const view = PROBE_VIEW!;
	let best: { posOffset: number; err: number } | null = null;
	let firstUsable = -1;
	let zeroUsable = false;
	let canonUsable = false;
	for (let po = 0; po + 12 <= rec.stride; po += 4) {
		const b = floatAABBAt(view, bufStart, po, rec, n);
		if (!isUsablePositionColumn(b)) continue;
		if (firstUsable < 0) firstUsable = po;
		if (po === 0) zeroUsable = true;
		if (po === FLOAT_POS_OFFSET) canonUsable = true;
		const err = extentMatchError(b!, headerBounds);
		if (err !== null && (best === null || err < best.err)) best = { posOffset: po, err };
	}
	// 1. Clean header-extent match (single-buffer models).
	if (best && headerBounds) {
		const he = Math.max(
			headerBounds.max[0] - headerBounds.min[0],
			headerBounds.max[1] - headerBounds.min[1],
			headerBounds.max[2] - headerBounds.min[2],
		);
		if (best.err <= Math.max(0.25, he * 0.1)) {
			return { format: 'float', posOffset: best.posOffset };
		}
	}
	// 2. Canonical format offset (multi-buffer: per-buffer extent != model AABB).
	if (canonUsable) return { format: 'float', posOffset: FLOAT_POS_OFFSET };
	// 3. Fallbacks.
	if (zeroUsable) return { format: 'float', posOffset: 0 };
	if (firstUsable >= 0) return { format: 'float', posOffset: firstUsable };
	return null;
}

/**
 * Detect a buffer's vertex format and the in-stride position offset. Tries the
 * HALF (4×f16 P4) layout first — its w≈1.0 fingerprint is decisive — then the
 * FLOAT (float32 P3) layout, whose position column is resolved against the
 * header AABB extent (see detectFloatFormat for why offset 0 is wrong on the
 * float samples).
 */
function detectVertexFormat(
	bufStart: number,
	rec: { stride: number; vcount: number },
	n: number,
	headerBounds: ModelBounds = null,
): { format: 'half' | 'float'; posOffset: number } | null {
	return (
		detectHalfFormat(bufStart, rec, n) ?? detectFloatFormat(bufStart, rec, n, headerBounds)
	);
}

/**
 * Find the INDEX-BUFFER / draw-call table: the first 32-byte-strided run of
 * records {relOffset:u32, 0,0,0, idxCount:u32, idxCount*2:u32, 0,0}. Returns the
 * draw calls plus the file offset where the table starts (used to locate the
 * draw->buffer binding table that immediately precedes it).
 */
function readDrawCallTable(
	u32: (p: number) => number,
	n: number,
): { draws: DrawCall[]; tableStart: number } {
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
		if (recs.length >= 1) return { draws: recs, tableStart: start };
	}
	return { draws: [], tableStart: -1 };
}

/**
 * Read the draw->vertex-buffer BINDING table that sits in the node tree just
 * before the draw-call table. Each draw call has one 16-byte record
 * {0:u32, ptrA:u32, ptrB:u32, 6:u32}; the `ptrB` field points at the draw's
 * vertex-buffer node and takes exactly `bufferCount` distinct values spaced 0x24
 * bytes apart (the node-tree per-buffer record stride). Sorting those distinct
 * ptrB values ascending and indexing 0..bufferCount-1 yields the TRUE per-draw
 * buffer index.
 *
 * This is the fix for the "renders weirdly" class of bugs (e.g. Musclecar_02):
 * the old "smallest fitting buffer" heuristic mis-routed draw calls whose index
 * range happened to fit a smaller buffer than the one they actually belong to,
 * scrambling which positions each triangle referenced. The binding is exact.
 *
 * Returns `null` (caller falls back to the heuristic) unless the table is
 * unambiguous: exactly `drawCount` records AND exactly `bufferCount` distinct
 * 0x24-spaced ptrB values. This keeps the multi-/shared-buffer variants (where
 * the distinct count != bufferCount) on the safe heuristic path.
 */
function readDrawBufferBinding(
	u32: (p: number) => number,
	n: number,
	drawTableStart: number,
	drawCount: number,
	bufferCount: number,
): number[] | null {
	if (drawTableStart < 0x1c || drawCount <= 0 || bufferCount <= 0) return null;
	// Walk backwards over the {0, ptrA, ptrB, 6} records ending right before the
	// draw table.
	const ptrBs: number[] = [];
	let p = drawTableStart - 16;
	while (p >= 0x0c && u32(p) === 0 && u32(p + 12) === 6) {
		ptrBs.push(u32(p + 8));
		p -= 16;
	}
	ptrBs.reverse();
	if (ptrBs.length !== drawCount) return null;
	const distinct = Array.from(new Set(ptrBs)).sort((a, b) => a - b);
	if (distinct.length !== bufferCount) return null;
	for (let i = 1; i < distinct.length; i++) {
		if (distinct[i] - distinct[i - 1] !== 0x24) return null;
	}
	const ptrToBuf = new Map<number, number>();
	distinct.forEach((v, i) => ptrToBuf.set(v, i));
	return ptrBs.map((v) => ptrToBuf.get(v)!);
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
		// float32 P3 + UV: the position float3 sits at `posOffset` within the stride
		// (byte 4 on every float sample checked — a leading weight/UV float precedes
		// it). The UV float2 follows the position triple when the stride has room.
		uv = new Array(buf.vcount * 2);
		const uvOffset = posOffset + 12;
		for (let i = 0; i < buf.vcount; i++) {
			const vbase = buf.fileOffset + i * buf.stride;
			const b = vbase + posOffset;
			if (b + 12 > n) {
				positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 0;
				uv[i * 2] = uv[i * 2 + 1] = 0;
				continue;
			}
			positions[i * 3] = f32(b);
			positions[i * 3 + 1] = f32(b + 4);
			positions[i * 3 + 2] = f32(b + 8);
			if (uvOffset + 8 <= buf.stride && vbase + uvOffset + 8 <= n) {
				uv[i * 2] = f32(vbase + uvOffset);
				uv[i * 2 + 1] = f32(vbase + uvOffset + 4);
			} else {
				uv[i * 2] = uv[i * 2 + 1] = 0;
			}
		}
	}
	return { positions, uv };
}

// ---------------------------------------------------------------------------
// Skinned .model (magic 0x02010008) section decode
// ---------------------------------------------------------------------------

/** Plausible position-stream strides seen in the skinned variant. */
const SKINNED_POS_STRIDES = new Set([12, 16, 20, 24, 28, 32]);

/** One per-section descriptor from the skinned node tree (vertex + index counts). */
type SkinnedDescriptor = { vcount: number; icount: number; dataOffset: number };

/**
 * Read the skinned variant's per-section MESH DESCRIPTORS from the node tree.
 * Each section is described by a fixed frame:
 *   base+0x00: o0:u32  o1:u32  dataOffset:u32  size:u32
 *   base+0x10: 0x00020000
 *   base+0x14: 0x81xx0000           (section sig; xx varies per section)
 *   base+0x18: 0x42ff2000           (constant)
 *   base+0x1c: packed = (vcount<<16) | icount
 *   base+0x20: 0xffffffff           (terminator)
 * The `icount` is the section's TRIANGLE-INDEX count (verified against the VB
 * table's vcount, which equals the descriptor vcount). Recovering it lets us
 * report the EXPECTED triangle count even though the index data itself is not
 * present anywhere in the .model file (see parseModelSkinned).
 */
function readSkinnedDescriptors(
	u32: (p: number) => number,
	n: number,
): SkinnedDescriptor[] {
	const out: SkinnedDescriptor[] = [];
	for (let p = 0x10; p + 0x14 < n; p += 4) {
		if (
			u32(p) === 0x00020000 &&
			// Mask the per-section byte (xx in 0x81xx0000); >>>0 keeps it unsigned
			// (a bare `&` yields a *signed* int32, breaking the 0x81000000 compare).
			((u32(p + 4) & 0xff00ffff) >>> 0) === 0x81000000 &&
			u32(p + 8) === 0x42ff2000 &&
			u32(p + 0x10) === 0xffffffff
		) {
			const packed = u32(p + 0xc);
			const vcount = (packed >>> 16) & 0xffff;
			const icount = packed & 0xffff;
			const base = p - 0x10;
			out.push({ vcount, icount, dataOffset: base >= 0 ? u32(base + 8) : 0 });
		}
	}
	return out;
}

/** One skinned vertex buffer: a position sub-stream + a paired aux sub-stream. */
type SkinnedBuffer = {
	/** File offset of the 0x48 record (diagnostic). */
	recordOffset: number;
	/** Position sub-buffer: stride-12 (etc) float32 P3. */
	posSize: number;
	posStride: number;
	vcount: number;
	/** Aux sub-buffer (UV float2 / packed normal), stride-8 etc. */
	auxSize: number;
	auxStride: number;
	/** Located absolute file offset of the position data (null when not found). */
	posOffset: number | null;
};

/**
 * Read the skinned VB table: a run of 0x48-byte records, each TWO 0x24
 * sub-records {size:u32, stride:u32, vcount:u32, …} that share a vertex count
 * (sub-record A = position stream, sub-record B = aux/UV stream). The record's
 * embedded offset fields are not reliable file pointers, so offsets are resolved
 * separately by `locateSkinnedPositions`. Returns the records plus the offset
 * just past the table.
 */
function readSkinnedBufferTable(
	u32: (p: number) => number,
	n: number,
): { buffers: SkinnedBuffer[]; tableEnd: number } | null {
	const sub = (p: number): { size: number; stride: number; vcount: number } | null => {
		if (p + 12 > n) return null;
		const size = u32(p);
		const stride = u32(p + 4);
		const vcount = u32(p + 8);
		if (stride < 4 || stride > 128) return null;
		if (vcount <= 0 || vcount > 8_000_000) return null;
		const exact = stride * vcount;
		if (size < exact || size - exact >= 64 || size <= 0 || size >= n) return null;
		return { size, stride, vcount };
	};

	// A skinned record = two valid 0x24 sub-records that agree on the vertex
	// count, where the FIRST is a recognised position stride. Find the run start.
	let start = -1;
	for (let p = 0x0c; p + 0x48 <= n; p += 4) {
		const a = sub(p);
		const b = sub(p + 0x24);
		if (a && b && a.vcount === b.vcount && SKINNED_POS_STRIDES.has(a.stride)) {
			start = p;
			break;
		}
	}
	if (start < 0) return null;

	const buffers: SkinnedBuffer[] = [];
	let p = start;
	while (true) {
		const a = sub(p);
		if (!a) break;
		const b = sub(p + 0x24);
		if (!b || a.vcount !== b.vcount) break;
		buffers.push({
			recordOffset: p,
			posSize: a.size,
			posStride: a.stride,
			vcount: a.vcount,
			auxSize: b.size,
			auxStride: b.stride,
			posOffset: null,
		});
		p += 0x48;
	}
	if (buffers.length === 0) return null;
	return { buffers, tableEnd: p };
}

/**
 * Decide whether a candidate float32-P3 block of `vcount` vertices at `off`
 * (stride `stride`) looks like a real position buffer: every component finite
 * and bounded, with a non-degenerate extent. Returns the summed extent (a small
 * positive number) or null.
 */
function scoreSkinnedPosBlock(
	f32: (p: number) => number,
	n: number,
	off: number,
	vcount: number,
	stride: number,
): number | null {
	let mnx = Infinity,
		mny = Infinity,
		mnz = Infinity,
		mxx = -Infinity,
		mxy = -Infinity,
		mxz = -Infinity;
	for (let v = 0; v < vcount; v++) {
		const p = off + v * stride;
		if (p + 12 > n) return null;
		const x = f32(p),
			y = f32(p + 4),
			z = f32(p + 8);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
		if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) return null;
		if (x < mnx) mnx = x;
		if (y < mny) mny = y;
		if (z < mnz) mnz = z;
		if (x > mxx) mxx = x;
		if (y > mxy) mxy = y;
		if (z > mxz) mxz = z;
	}
	const ext = mxx - mnx + (mxy - mny) + (mxz - mnz);
	return ext > 1e-3 ? ext : null;
}

/**
 * Locate each skinned position buffer in file order. The records do not carry
 * usable data pointers, so for each record (in order) we scan forward from the
 * search cursor — 16-byte-aligned first (the common case), then 4-byte-aligned —
 * for the first contiguous float32-P3 block of the record's vertex count that
 * passes `scoreSkinnedPosBlock`, then advance the cursor past it. Mutates each
 * buffer's `posOffset`.
 */
function locateSkinnedPositions(
	f32: (p: number) => number,
	n: number,
	buffers: SkinnedBuffer[],
	tableEnd: number,
): void {
	let search = (tableEnd + 15) & ~15;
	for (const buf of buffers) {
		let found: number | null = null;
		for (const align of [16, 4]) {
			let off = (search + align - 1) & ~(align - 1);
			while (off + buf.vcount * buf.posStride <= n) {
				if (scoreSkinnedPosBlock(f32, n, off, buf.vcount, buf.posStride) !== null) {
					found = off;
					break;
				}
				off += align;
			}
			if (found !== null) break;
		}
		buf.posOffset = found;
		if (found !== null) search = found + buf.vcount * buf.posStride;
	}
}

/**
 * Parse a SKINNED .model (magic 0x02010008). Emits one position-only point mesh
 * per recovered vertex buffer; the triangle topology lives in the compressed
 * Havok skinning section that isn't decoded yet, so indices are empty and the
 * model is flagged `partial`. The decoded combined AABB is sanity-checked
 * against the header float AABB.
 */
export function parseModelSkinned(raw: Uint8Array): ParsedModel {
	const rr = reader(raw);
	const { r, n, f32 } = rr;
	if (n < 12) throw new Error(`model: too small (${n} bytes)`);
	r.seek(0);
	const magic = r.readU32();
	const nodeCount = r.readU32();
	const treeOffset = r.readU32();
	const headerBounds = scanBounds(rr);

	const meshes: ModelMesh[] = [];
	let note: string | undefined;
	let located = 0;
	let totalRecords = 0;

	// Per-section descriptors carry the section vertex AND triangle-index counts.
	// We can't recover the index DATA (it is absent from the file — see the long
	// note below), but the expected triangle count is a useful sanity figure and
	// proves the topology was stripped rather than merely undecoded.
	const descriptors = readSkinnedDescriptors(rr.u32, n);
	const expectedTris = descriptors.reduce((s, d) => s + Math.floor(d.icount / 3), 0);

	try {
		const table = readSkinnedBufferTable(rr.u32, n);
		if (table && table.buffers.length > 0) {
			totalRecords = table.buffers.length;
			locateSkinnedPositions(f32, n, table.buffers, table.tableEnd);
			for (const buf of table.buffers) {
				if (buf.posOffset === null) continue;
				located++;
				const positions: number[] = new Array(buf.vcount * 3);
				for (let v = 0; v < buf.vcount; v++) {
					const b = buf.posOffset + v * buf.posStride;
					positions[v * 3] = f32(b);
					positions[v * 3 + 1] = f32(b + 4);
					positions[v * 3 + 2] = f32(b + 8);
				}
				meshes.push({
					positions,
					indices: [], // topology not recoverable (see header note)
					vertexCount: buf.vcount,
					stride: buf.posStride,
					format: 'float',
				});
			}
			const totalVerts = meshes.reduce((s, m) => s + m.vertexCount, 0);
			const triNote =
				descriptors.length > 0
					? ` Per-section descriptors declare ${descriptors.length} mesh section(s) ` +
						`totalling ${expectedTris} triangle(s), but the index buffer is absent ` +
						`from the file (the position+aux streams and a small packed skinning ` +
						`section consume the entire byte budget — verified: no room for ` +
						`${expectedTris * 3}+ u16 indices).`
					: '';
			note =
				`Skinned .model (0x${magic.toString(16)}): decoded ${located}/${totalRecords} ` +
				`position buffer(s) (${totalVerts} verts, float32 P3). Triangle topology ` +
				`is not recoverable from the skinned container (no 16-bit strips / draw ` +
				`table — it lives in the compressed Havok skinning section), so meshes are ` +
				`emitted as positions only.` +
				triNote;
		} else {
			note =
				`Skinned .model (0x${magic.toString(16)}): no 0x48 vertex-buffer table found ` +
				`(likely a tiny stub or an unmapped sub-variant); header metadata only.`;
		}
	} catch (err) {
		note = `Skinned .model: section decode failed (${String((err as Error)?.message ?? err)}).`;
	}

	// Prefer decoded-vertex bounds when available; else the header AABB.
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
		bounds: decodedBounds ?? headerBounds,
		partial: true, // always partial: no triangle indices in this variant
		note,
	};
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
	// The skinned/animated variant (02 01 00 08) has a different vertex/index
	// container; route it to the dedicated path even when entered here directly.
	if (isSkinnedMagic(magic)) return parseModelSkinned(raw);
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
		const { draws, tableStart: drawTableStart } = readDrawCallTable(u32, n);

		if (vbTable && vbTable.buffers.length > 0) {
			const { buffers } = vbTable;
			const vertexRegionEnd =
				buffers[buffers.length - 1].fileOffset + buffers[buffers.length - 1].size;

			// Detect each buffer's format/posOffset. The header AABB is passed so the
			// FLOAT path can resolve the in-stride position column by extent-match
			// (the leading float before the position column is a weight/UV, not the
			// position — see detectFloatFormat).
			const fmts = buffers.map((b) =>
				detectVertexFormat(b.fileOffset, { stride: b.stride, vcount: b.vcount }, n, bounds),
			);

			// Decode positions per buffer.
			const decoded = buffers.map((b, i) => {
				const fmt = fmts[i] ?? { format: 'half' as const, posOffset: 0 };
				const d = decodeBufferPositions(rr, b, fmt.format, fmt.posOffset);
				return { buf: b, fmt, ...d };
			});

			// GUARD: reject any buffer whose decoded positions are clearly garbage —
			// the half-float-spike fingerprint of the level-sobj QUANTIZED-position
			// variant (int16 positions dequantized against a per-buffer node-tree box
			// we don't yet read). Such buffers decode to ±tens-of-thousands extents,
			// far beyond the model's header AABB. We blank them (positions [] →
			// no-geometry) and flag partial rather than emit wrong geometry; the
			// undetected format would otherwise place vertices at ±65504 spikes.
			let blanked = 0;
			for (const d of decoded) {
				if (!d.positions.length) continue;
				if (positionsImplausible(d.positions, bounds)) {
					d.positions = [];
					d.uv = undefined;
					blanked++;
					partial = true;
				}
			}

			// The EXACT draw->buffer binding from the node-tree binding table (one
			// record per draw call). When present this overrides the legacy
			// "smallest fitting buffer" heuristic, which mis-routed draws and made
			// some cars/props (e.g. Musclecar_02) render with scrambled geometry.
			const binding = readDrawBufferBinding(
				u32,
				n,
				drawTableStart,
				draws.length,
				buffers.length,
			);

			// Distribute draw calls to buffers and expand strips.
			const corr = findIndexCorrection(u16, n, draws, vertexRegionEnd);
			const perBufferIndices: number[][] = buffers.map(() => []);
			let misbound = 0;

			if (corr !== null && draws.length > 0) {
				for (let di = 0; di < draws.length; di++) {
					const dc = draws[di];
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
					// Pick the target buffer: prefer the exact binding; fall back to the
					// smallest-fitting-buffer heuristic when no binding is available.
					let target = -1;
					if (binding) {
						const bound = binding[di];
						// Trust the binding only if it can actually hold this draw's
						// indices; otherwise fall through to the heuristic (defensive —
						// the binding was verified exact across the sample set).
						if (buffers[bound].vcount > maxIdx) target = bound;
						else misbound++;
					}
					if (target < 0) {
						for (let bi = 0; bi < buffers.length; bi++) {
							if (buffers[bi].vcount > maxIdx) {
								if (target < 0 || buffers[bi].vcount < buffers[target].vcount) target = bi;
							}
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

			// Emit one submesh per buffer that has geometry. A blanked buffer (garbage
			// positions, see GUARD above) emits as an empty submesh — no positions and
			// no indices — so it contributes no wrong geometry to the scene.
			for (let bi = 0; bi < buffers.length; bi++) {
				const d = decoded[bi];
				const blank = d.positions.length === 0;
				const indices = blank ? [] : perBufferIndices[bi];
				meshes.push({
					positions: d.positions,
					indices,
					vertexCount: blank ? 0 : buffers[bi].vcount,
					uv: d.uv,
					stride: buffers[bi].stride,
					format: blank ? undefined : d.fmt?.format,
				});
			}

			const decodedDraws = draws.length;
			const usedDraws = corr !== null ? draws.length : 0;
			if (partial || usedDraws < decodedDraws) {
				const bindNote = binding
					? `Draw->buffer binding is EXACT (node-tree binding table).`
					: `Per-buffer binding is heuristic.`;
				const blankNote = blanked
					? ` ${blanked} buffer(s) blanked (quantized-position variant not yet decoded — kept as no-geometry to avoid garbage).`
					: '';
				note =
					`Base .model: decoded ${buffers.length} vertex buffer(s) ` +
					`(${buffers.reduce((s, b) => s + b.vcount, 0)} verts) and ` +
					`${usedDraws}/${decodedDraws} draw call(s). ${bindNote}` +
					(misbound ? ` (${misbound} binding entr(y/ies) fell back to heuristic.)` : '') +
					blankNote;
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
 * Top-level parse: auto-detect the standard base .model (magic 02 00 00 08), the
 * SKINNED variant (02 01 00 08), or a .model.stream (leading dword0==0,
 * dword1==filesize-12).
 */
export function parseModel(raw: Uint8Array): ParsedModel {
	if (raw.byteLength >= 4) {
		const view = new DataView(raw.buffer, raw.byteOffset, Math.min(12, raw.byteLength));
		const m = view.getUint32(0, false);
		if (isSkinnedMagic(m)) return parseModelSkinned(raw);
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
