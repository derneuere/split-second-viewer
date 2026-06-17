import { describe, expect, it } from 'vitest';
import { modelHandler } from '../model';
import {
	parseModel,
	parseModelStream,
	parseModelBase,
	expandStrips,
	triangleCount,
	MODEL_MAGIC,
} from '../../../model';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// ---------------------------------------------------------------------------
// Helpers to build inline fixtures.
// ---------------------------------------------------------------------------

/** Encode a finite value as IEEE-754 binary16 (sufficient for 0,±1,±0.5 etc). */
function encodeHalf(val: number): number {
	if (val === 0) return Object.is(val, -0) ? 0x8000 : 0;
	const f = new Float32Array([val]);
	const u = new Uint32Array(f.buffer)[0];
	const sign = (u >>> 16) & 0x8000;
	const exp = ((u >>> 23) & 0xff) - 127 + 15;
	const mant = u & 0x7fffff;
	if (exp <= 0) return sign; // flush tiny to signed zero (fine for test values)
	if (exp >= 31) return sign | 0x7c00;
	return sign | (exp << 10) | (mant >> 13);
}

/** Build a minimal .model.stream: 12-byte header + 4 half4 verts + one strip. */
function buildInlineStream(): Uint8Array {
	const verts: [number, number, number][] = [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
		[1, 1, 0],
	];
	const idx = [0, 1, 2, 3, 0xffff];
	const total = 12 + verts.length * 16 + idx.length * 2;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, 0, false); // dword0
	dv.setUint32(4, total - 12, false); // dword1 = size-12
	dv.setUint32(8, 0, false); // dword2
	let p = 12;
	for (const v of verts) {
		dv.setUint16(p, encodeHalf(v[0]), false);
		dv.setUint16(p + 2, encodeHalf(v[1]), false);
		dv.setUint16(p + 4, encodeHalf(v[2]), false);
		dv.setUint16(p + 6, encodeHalf(1), false); // w = 1.0
		p += 16; // remaining 8 bytes (normal/etc) stay zero
	}
	for (const i of idx) {
		dv.setUint16(p, i, false);
		p += 2;
	}
	return buf;
}

/**
 * Build a minimal base .model: magic + node header + an AABB float pair + a
 * dense trailing 16-bit triangle-strip index block (>=3 restarts so the
 * tail-cluster detector accepts it).
 */
function buildInlineBaseModel(): Uint8Array {
	// Layout: [0..0x0c) header, [0x10..0x30) AABB rows, padding, then indices.
	const header = 0x10;
	const aabbAt = 0x10;
	const idxAt = 0x40;
	// Three short strips, each terminated by 0xFFFF (=> >=3 restarts).
	const idx = [0, 1, 2, 3, 0xffff, 1, 2, 3, 4, 0xffff, 2, 3, 4, 5, 0xffff];
	const total = idxAt + idx.length * 2;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, MODEL_MAGIC, false); // 02 00 00 08
	dv.setUint32(4, 1, false); // node_count
	dv.setUint32(8, header, false); // tree_offset
	// AABB min row (x,y,z,w=1) then max row (w=1)
	const min = [-2, -3, -4];
	const max = [5, 6, 7];
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + i * 4, min[i], false);
	dv.setFloat32(aabbAt + 12, 1, false);
	for (let i = 0; i < 3; i++) dv.setFloat32(aabbAt + 16 + i * 4, max[i], false);
	dv.setFloat32(aabbAt + 28, 1, false);
	let p = idxAt;
	for (const i of idx) {
		dv.setUint16(p, i, false);
		p += 2;
	}
	return buf;
}

const INLINE_STREAM = buildInlineStream();
const INLINE_BASE = buildInlineBaseModel();

const REAL_STREAM =
	'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.model.stream';
const REAL_BASE =
	'Environments/Levels/airport_test_03/ReflectionMap/Lights/PointLight.model';

describe('model parser — strip expansion', () => {
	it('expands a tri-strip into a triangle list with winding flip', () => {
		// strip 0,1,2,3 -> (0,1,2) then (2,1,3) [flipped] ; 0xFFFF restarts
		const u16 = (() => {
			const arr = [0, 1, 2, 3, 0xffff];
			const buf = new Uint8Array(arr.length * 2);
			const dv = new DataView(buf.buffer);
			arr.forEach((v, i) => dv.setUint16(i * 2, v, false));
			return (p: number) => dv.getUint16(p, false);
		})();
		const tris = expandStrips(u16, 0, 10, 4);
		expect(tris).toEqual([0, 1, 2, 2, 1, 3]);
	});

	it('flips winding consistently across a longer strip', () => {
		const arr = [0, 1, 2, 3, 4, 0xffff];
		const buf = new Uint8Array(arr.length * 2);
		const dv = new DataView(buf.buffer);
		arr.forEach((v, i) => dv.setUint16(i * 2, v, false));
		const u16 = (p: number) => dv.getUint16(p, false);
		// (0,1,2) even, (2,1,3) odd, (2,3,4) even
		expect(expandStrips(u16, 0, arr.length * 2, 5)).toEqual([0, 1, 2, 2, 1, 3, 2, 3, 4]);
	});

	it('drops degenerate triangles and out-of-range indices', () => {
		const arr = [0, 0, 1, 2, 0xffff, 5, 6, 7]; // first tri degenerate (0,0,1); 5/6/7 out of range
		const buf = new Uint8Array(arr.length * 2);
		const dv = new DataView(buf.buffer);
		arr.forEach((v, i) => dv.setUint16(i * 2, v, false));
		const u16 = (p: number) => dv.getUint16(p, false);
		const tris = expandStrips(u16, 0, arr.length * 2, 3);
		// (0,0,1) degenerate -> dropped; odd tri (1,0,2) ok; second strip all >= limit -> dropped
		expect(tris).toEqual([1, 0, 2]);
	});
});

describe('model.stream parser', () => {
	it('decodes the 12-byte header + half-float positions (inline)', () => {
		const m = parseModelStream(INLINE_STREAM);
		expect(m.kind).toBe('stream');
		expect(m.streamPayloadLen).toBe(INLINE_STREAM.byteLength - 12);
		expect(m.meshes).toHaveLength(1);
		expect(m.meshes[0].vertexCount).toBe(4);
		expect(m.meshes[0].positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
	});

	it('expands the strip to triangles and computes bounds (inline)', () => {
		const m = parseModelStream(INLINE_STREAM);
		expect(m.meshes[0].indices).toEqual([0, 1, 2, 2, 1, 3]);
		// strip 0,1,2,3 -> (0,1,2) then (2,1,3)
		expect(triangleCount(m)).toBe(2);
		expect(m.bounds).not.toBeNull();
		expect(m.bounds!.min).toEqual([0, 0, 0]);
		expect(m.bounds!.max).toEqual([1, 1, 0]);
	});

	it('auto-detects a stream via parseModel (dword1 == size-12)', () => {
		const m = parseModel(INLINE_STREAM);
		expect(m.kind).toBe('stream');
	});
});

describe('base .model parser', () => {
	it('decodes the header, AABB bounds, and tri-strips (inline)', () => {
		const m = parseModelBase(INLINE_BASE);
		expect(m.kind).toBe('model');
		expect(m.magic).toBe(MODEL_MAGIC);
		expect(m.nodeCount).toBe(1);
		expect(m.bounds).not.toBeNull();
		expect(m.bounds!.min).toEqual([-2, -3, -4]);
		expect(m.bounds!.max).toEqual([5, 6, 7]);
		// indices decoded; positions empty for base .model (vertex layout unresolved)
		expect(m.meshes[0].indices.length).toBeGreaterThanOrEqual(3);
		expect(m.meshes[0].positions).toEqual([]);
	});

	it('rejects a bad magic', () => {
		const bad = new Uint8Array(0x40);
		new DataView(bad.buffer).setUint32(0, 0xdeadbeef, false);
		expect(() => parseModelBase(bad)).toThrow(/bad magic/);
	});

	it('auto-detects a base model via parseModel (magic 02 00 00 08)', () => {
		const m = parseModel(INLINE_BASE);
		expect(m.kind).toBe('model');
	});

	it('describe() summarizes the model', () => {
		const m = parseModelBase(INLINE_BASE);
		expect(modelHandler.describe(m)).toContain('model:');
		expect(modelHandler.describe(m)).toContain('bounds');
	});
});

describe('model parser — REAL devkit samples', () => {
	it.skipIf(!hasSample(REAL_STREAM))(
		'decodes a REAL .model.stream (Musclecar_01)',
		() => {
			const raw = readSample(REAL_STREAM);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('stream');
			// dword1 == filesize-12 (confirmed across the Musclecar stream set)
			expect(m.streamPayloadLen).toBe(raw.byteLength - 12);
			const mesh = m.meshes[0];
			// real geometry: tens of thousands of verts and triangles
			expect(mesh.vertexCount).toBeGreaterThan(10000);
			expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
			expect(mesh.indices.length).toBeGreaterThan(1000);
			// every triangle index is in range
			let maxI = 0;
			for (const i of mesh.indices) if (i > maxI) maxI = i;
			expect(maxI).toBeLessThan(mesh.vertexCount);
			// bounds are finite
			expect(m.bounds).not.toBeNull();
			for (const v of [...m.bounds!.min, ...m.bounds!.max]) {
				expect(Number.isFinite(v)).toBe(true);
			}
		},
	);

	it.skipIf(!hasSample(REAL_BASE))(
		'decodes a REAL base .model header + bounds (PointLight)',
		() => {
			const raw = readSample(REAL_BASE);
			const m = modelHandler.parseRaw(raw, ssCtx());
			expect(m.kind).toBe('model');
			expect(m.magic).toBe(MODEL_MAGIC);
			expect(m.nodeCount).toBe(1);
			// PointLight AABB is the symmetric ±0.5 box from the wiki
			expect(m.bounds).not.toBeNull();
			expect(m.bounds!.min[0]).toBeCloseTo(-0.5, 3);
			expect(m.bounds!.max[0]).toBeCloseTo(0.5, 3);
		},
	);
});
