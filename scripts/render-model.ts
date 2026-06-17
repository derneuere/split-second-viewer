/**
 * render-model — headless software renderer for .model files.
 *
 * Parses a .model (via the same model.ts the app uses), resolves its diffuse
 * texture(s) (via material.ts), and rasterises the textured mesh to a PNG from
 * several camera angles (a contact sheet). No GPU / browser — a tiny perspective
 * rasteriser with a z-buffer and perspective-correct UVs, matching MeshViewer's
 * sampler (RepeatWrapping + flipY). Lets us VERIFY texture/UV mapping (e.g. the
 * chevron band on the barrels, livery on the heli body) without the live preview.
 *
 * Usage:
 *   npx tsx scripts/render-model.ts <model-path> [--mode texture|uv|checker]
 *                                   [--out file.png] [--size 512] [--list]
 *   <model-path> is relative to SS_DATA_ROOT (or absolute). Multiple allowed.
 *
 * Examples:
 *   npx tsx scripts/render-model.ts Generic/Models/NemTruckBarrels_High/NemTruckBarrels_High.model
 *   npx tsx scripts/render-model.ts <heli>.model --mode checker
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { parseModel, type ModelMesh } from '../src/lib/core/model';
import { buildMaterials, materialForSubmesh } from '../src/lib/core/material';
import { DATA_ROOT } from '../src/test/dataRoot';

// --------------------------------------------------------------------------
// args
// --------------------------------------------------------------------------
const argv = process.argv.slice(2);
let mode: 'texture' | 'uv' | 'checker' = 'texture';
let outArg: string | null = null;
let size = 512;
let uvCols: [number, number] | null = null; // debug: force raw in-stride UV byte offsets
const models: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--mode') mode = argv[++i] as typeof mode;
	else if (a === '--out') outArg = argv[++i];
	else if (a === '--size') size = parseInt(argv[++i], 10);
	else if (a === '--uvcols') {
		const [u, v] = argv[++i].split(',').map((x) => parseInt(x, 10));
		uvCols = [u, v];
	} else models.push(a);
}
if (models.length === 0) {
	console.error('usage: tsx scripts/render-model.ts <model-path> [--mode texture|uv|checker] [--out f.png] [--size N]');
	process.exit(1);
}

function resolveModel(rel: string): string {
	if (fs.existsSync(rel)) return rel;
	const j = path.join(DATA_ROOT, rel);
	if (fs.existsSync(j)) return j;
	throw new Error(`model not found: ${rel} (also tried ${j})`);
}
function readBytes(p: string): Uint8Array {
	const b = fs.readFileSync(p);
	return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
function readOpt(p: string): Uint8Array | null {
	return fs.existsSync(p) ? readBytes(p) : null;
}

// --------------------------------------------------------------------------
// VB-table re-parse (debug --uvcols only): recover each buffer's file offset.
// Mirrors model.ts readVertexBufferTable's record signature.
// --------------------------------------------------------------------------
function rawBuffers(raw: Uint8Array): { fileOffset: number; stride: number; vcount: number }[] {
	const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	const n = raw.byteLength;
	const u32 = (p: number) => dv.getUint32(p, false) >>> 0;
	const valid = (p: number) => {
		if (p + 12 > n) return null;
		const size = u32(p), stride = u32(p + 4), vcount = u32(p + 8);
		if (stride < 12 || stride > 64 || vcount <= 0 || vcount > 4_000_000) return null;
		const exact = stride * vcount;
		if (size < exact || size - exact >= 64 || size <= 0 || size >= n) return null;
		return { size, stride, vcount };
	};
	for (let start = 0x0c; start + 12 <= n; start += 4) {
		if (!valid(start)) continue;
		const recs: { size: number; stride: number; vcount: number }[] = [];
		let p = start;
		for (let r = valid(p); r; r = valid(p)) {
			recs.push(r);
			p += 0x24;
		}
		if (!recs.length) continue;
		let acc = p; // table end = first byte of bulk vertex data
		return recs.map((r) => {
			const o = acc;
			acc += r.size;
			return { fileOffset: o, stride: r.stride, vcount: r.vcount };
		});
	}
	return [];
}

// --------------------------------------------------------------------------
// tiny vec3 + matrix helpers
// --------------------------------------------------------------------------
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};

// --------------------------------------------------------------------------
// texture sampling (matches makeDiffuseTexture: RepeatWrapping + flipY=true)
// --------------------------------------------------------------------------
type Tex = { rgba: Uint8ClampedArray; w: number; h: number };
function sampleTex(t: Tex, u: number, v: number): [number, number, number] {
	const uu = u - Math.floor(u);
	const vv = v - Math.floor(v);
	// flipY=true → texture v=1 reads the top (row 0) of the top-down rgba array.
	const col = Math.min(t.w - 1, Math.max(0, Math.round(uu * (t.w - 1))));
	const row = Math.min(t.h - 1, Math.max(0, Math.round((1 - vv) * (t.h - 1))));
	const i = (row * t.w + col) * 4;
	return [t.rgba[i], t.rgba[i + 1], t.rgba[i + 2]];
}
function checker(u: number, v: number): [number, number, number] {
	const s = 8;
	const a = (Math.floor(u * s) + Math.floor(v * s)) & 1;
	return a ? [225, 225, 225] : [40, 40, 40];
}
function uvColor(u: number, v: number): [number, number, number] {
	const uu = u - Math.floor(u);
	const vv = v - Math.floor(v);
	return [Math.round(uu * 255), Math.round(vv * 255), 60];
}

// --------------------------------------------------------------------------
// rasterise one view of a list of submeshes into an RGB framebuffer
// --------------------------------------------------------------------------
type Submesh = { mesh: ModelMesh; tex: Tex | null };

function renderView(subs: Submesh[], eye: V3, center: V3, up: V3, W: number, H: number): Uint8Array {
	const fb = new Uint8Array(W * H * 3);
	// background
	for (let i = 0; i < W * H; i++) {
		fb[i * 3] = 14;
		fb[i * 3 + 1] = 18;
		fb[i * 3 + 2] = 28;
	}
	const zb = new Float32Array(W * H).fill(Infinity);

	// camera basis
	const f = norm(sub(center, eye)); // forward
	const s = norm(cross(f, up)); // right
	const u2 = cross(s, f); // true up
	const fov = (42 * Math.PI) / 180;
	const focal = 1 / Math.tan(fov / 2);
	const aspect = W / H;
	const near = 0.01;
	const lightDir = norm([0.4, 0.8, 0.5]);

	// project a world point → screen + clip-w (null if behind near plane)
	function project(p: V3): { x: number; y: number; z: number; w: number } | null {
		const r = sub(p, eye);
		const vx = dot(r, s);
		const vy = dot(r, u2);
		const vz = dot(r, f); // distance along forward (>0 in front)
		if (vz <= near) return null;
		const cx = (focal / aspect) * vx;
		const cy = focal * vy;
		const ndcx = cx / vz;
		const ndcy = cy / vz;
		return {
			x: (ndcx * 0.5 + 0.5) * W,
			y: (0.5 - ndcy * 0.5) * H,
			z: vz,
			w: vz,
		};
	}

	for (const { mesh, tex } of subs) {
		const pos = mesh.positions;
		const uv = mesh.uv;
		const idx = mesh.indices;
		if (idx.length < 3) continue;
		for (let t = 0; t + 2 < idx.length; t += 3) {
			const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
			const wa: V3 = [pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]];
			const wb: V3 = [pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]];
			const wc: V3 = [pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]];
			const pa = project(wa), pb = project(wb), pc = project(wc);
			if (!pa || !pb || !pc) continue;
			// face normal (world) for simple lambert
			const fn = norm(cross(sub(wb, wa), sub(wc, wa)));
			const lambert = Math.abs(dot(fn, lightDir)); // two-sided
			const shade = 0.35 + 0.65 * lambert;
			// UVs (0,0 if absent)
			const uvs = (i: number): [number, number] => (uv ? [uv[i * 2], uv[i * 2 + 1]] : [0, 0]);
			const [ua, va] = uvs(ia), [ub, vb] = uvs(ib), [uc, vc] = uvs(ic);
			// screen bbox
			const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
			const maxX = Math.min(W - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
			const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
			const maxY = Math.min(H - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
			const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
			if (Math.abs(area) < 1e-7) continue;
			const ia_w = 1 / pa.w, ib_w = 1 / pb.w, ic_w = 1 / pc.w;
			for (let py = minY; py <= maxY; py++) {
				for (let px = minX; px <= maxX; px++) {
					const fx = px + 0.5, fy = py + 0.5;
					const w0 = ((pb.x - fx) * (pc.y - fy) - (pc.x - fx) * (pb.y - fy)) / area;
					const w1 = ((pc.x - fx) * (pa.y - fy) - (pa.x - fx) * (pc.y - fy)) / area;
					const w2 = 1 - w0 - w1;
					if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
					const depth = w0 * pa.z + w1 * pb.z + w2 * pc.z;
					const di = py * W + px;
					if (depth >= zb[di]) continue;
					zb[di] = depth;
					// perspective-correct uv
					const invW = w0 * ia_w + w1 * ib_w + w2 * ic_w;
					const ww = 1 / invW;
					const u = (w0 * ua * ia_w + w1 * ub * ib_w + w2 * uc * ic_w) * ww;
					const v = (w0 * va * ia_w + w1 * vb * ib_w + w2 * vc * ic_w) * ww;
					let col: [number, number, number];
					if (mode === 'uv') col = uvColor(u, v);
					else if (mode === 'checker') col = checker(u, v);
					else if (tex) col = sampleTex(tex, u, v);
					else col = [120, 120, 125];
					const o = di * 3;
					fb[o] = Math.min(255, col[0] * shade);
					fb[o + 1] = Math.min(255, col[1] * shade);
					fb[o + 2] = Math.min(255, col[2] * shade);
				}
			}
		}
	}
	return fb;
}

// --------------------------------------------------------------------------
// minimal PNG encoder (RGB, color type 2)
// --------------------------------------------------------------------------
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
	const len = data.length;
	const out = new Uint8Array(12 + len);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, len, false);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	const crc = crc32(out.subarray(4, 8 + len));
	dv.setUint32(8 + len, crc, false);
	return out;
}
function writePNG(file: string, rgb: Uint8Array, W: number, H: number): void {
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, W, false);
	dv.setUint32(4, H, false);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type RGB
	// raw scanlines with filter byte 0
	const raw = new Uint8Array(H * (W * 3 + 1));
	for (let y = 0; y < H; y++) {
		raw[y * (W * 3 + 1)] = 0;
		raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
	}
	const idat = zlib.deflateSync(raw);
	const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	fs.writeFileSync(file, out);
}

// --------------------------------------------------------------------------
// build a contact sheet of N views
// --------------------------------------------------------------------------
function blit(dst: Uint8Array, DW: number, src: Uint8Array, SW: number, SH: number, ox: number, oy: number) {
	for (let y = 0; y < SH; y++) {
		for (let x = 0; x < SW; x++) {
			const s = (y * SW + x) * 3;
			const d = ((oy + y) * DW + (ox + x)) * 3;
			dst[d] = src[s];
			dst[d + 1] = src[s + 1];
			dst[d + 2] = src[s + 2];
		}
	}
}

function processModel(rel: string) {
	const modelPath = resolveModel(rel);
	const base = modelPath.replace(/\.model$/i, '');
	const raw = readBytes(modelPath);
	const model = parseModel(raw);

	// resolve materials from same-dir siblings
	const built = buildMaterials({
		textures: readOpt(`${base}.textures`),
		shaderinst: readOpt(`${base}.shaderinst`),
		shaders: readOpt(`${base}.shaders`),
		submeshCount: model.meshes.length,
	});

	// Debug: override per-vertex UV by reading raw in-stride byte offsets, so we can
	// test candidate texcoord columns visually without touching the decoder.
	if (uvCols) {
		const bufs = rawBuffers(raw);
		console.log(`  [uvcols ${uvCols[0]},${uvCols[1]}] buffers:`, bufs.map((b) => `vc=${b.vcount}@${b.fileOffset.toString(16)}/s${b.stride}`).join(' '));
		for (const mesh of model.meshes) {
			const b = bufs.find((x) => x.vcount === mesh.vertexCount);
			if (!b) {
				console.log(`  [uvcols] no buffer match for mesh vc=${mesh.vertexCount}`);
				continue;
			}
			const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
			const uv = new Array(mesh.vertexCount * 2);
			let umn = Infinity, umx = -Infinity, vmn = Infinity, vmx = -Infinity;
			for (let v = 0; v < mesh.vertexCount; v++) {
				const base = b.fileOffset + v * b.stride;
				const uu = dv.getFloat32(base + uvCols[0], false);
				const vv = dv.getFloat32(base + uvCols[1], false);
				uv[v * 2] = uu;
				uv[v * 2 + 1] = vv;
				if (uu < umn) umn = uu; if (uu > umx) umx = uu;
				if (vv < vmn) vmn = vv; if (vv > vmx) vmx = vv;
			}
			mesh.uv = uv;
			console.log(`  [uvcols] mesh vc=${mesh.vertexCount}: U=[${umn.toFixed(2)},${umx.toFixed(2)}] V=[${vmn.toFixed(2)},${vmx.toFixed(2)}]`);
		}
	}

	const subs: Submesh[] = model.meshes.map((mesh, i) => {
		const mat = materialForSubmesh(built, i);
		const dt = mat?.diffuseTexture;
		const tex: Tex | null = dt && dt.rgba ? { rgba: dt.rgba, w: dt.width, h: dt.height } : null;
		return { mesh, tex };
	});

	// scene bounds
	const mn: V3 = [Infinity, Infinity, Infinity], mx: V3 = [-Infinity, -Infinity, -Infinity];
	for (const { mesh } of subs) {
		for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
			for (let k = 0; k < 3; k++) {
				const c = mesh.positions[i + k];
				if (c < mn[k]) mn[k] = c;
				if (c > mx[k]) mx[k] = c;
			}
		}
	}
	const center: V3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
	const radius = Math.max(0.5, 0.5 * Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
	const dist = radius * 2.6;

	const tris = subs.reduce((a, b) => a + b.mesh.indices.length / 3, 0);
	const withTex = subs.filter((s) => s.tex).length;
	console.log(`${path.basename(modelPath)}: ${subs.length} submesh(es), ${tris} tris, ${withTex} textured — mode=${mode}`);

	// six views: azimuth × elevation
	const views: { az: number; el: number }[] = [
		{ az: 20, el: 18 },
		{ az: 70, el: 18 },
		{ az: 110, el: 18 },
		{ az: 200, el: 18 },
		{ az: 20, el: 70 },
		{ az: 20, el: -25 },
	];
	const S = size;
	const cols = 3, rows = 2;
	const sheet = new Uint8Array(cols * S * rows * S * 3);
	views.forEach((vw, vi) => {
		const ar = (vw.az * Math.PI) / 180;
		const er = (vw.el * Math.PI) / 180;
		const eye: V3 = [
			center[0] + dist * Math.cos(er) * Math.cos(ar),
			center[1] + dist * Math.sin(er),
			center[2] + dist * Math.cos(er) * Math.sin(ar),
		];
		const up: V3 = Math.abs(vw.el) > 80 ? [0, 0, 1] : [0, 1, 0];
		const fb = renderView(subs, eye, center, up, S, S);
		const cx = (vi % cols) * S, cy = Math.floor(vi / cols) * S;
		blit(sheet, cols * S, fb, S, S, cx, cy);
	});

	const out = outArg ?? `${path.basename(base)}.${mode}.png`;
	writePNG(out, sheet, cols * S, rows * S);
	console.log(`  → ${out}  (${cols * S}×${rows * S})`);
}

for (const m of models) {
	try {
		processModel(m);
	} catch (e) {
		console.error(`! ${m}: ${(e as Error).message}`);
	}
}
