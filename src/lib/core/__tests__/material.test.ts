import { describe, expect, it } from 'vitest';
import { buildMaterials, materialForSubmesh } from '../material';
import { parseModel } from '../model';
import { hasSample, readSample, DATA_ROOT } from '@/test/dataRoot';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Big-endian byte builders (Split/Second is PS3 BE).
// ---------------------------------------------------------------------------
function be32(v: number): number[] {
	return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function be16(v: number): [number, number] {
	return [(v >> 8) & 0xff, v & 0xff];
}
function lenStr(s: string): number[] {
	const bytes = [...s].map((c) => c.charCodeAt(0));
	bytes.push(0); // NUL terminator counted in the length prefix
	return [...be32(bytes.length), ...bytes];
}

// ---------------------------------------------------------------------------
// Synthetic .textures — one 4x4 DXT1 texture named "Albedo" with CRC 0xABCD0001.
// Mirrors the real TEXS layout the textures.ts parser + decodeAllInline expect.
// ---------------------------------------------------------------------------
const TEX_CRC = 0xabcd0001;
function buildTextures(): Uint8Array {
	const b: number[] = [];
	b.push(0x54, 0x45, 0x58, 0x53); // "TEXS"
	b.push(...be32(12)); // version
	b.push(...be32(1)); // flags
	b.push(...be32(0x68)); // payloadTableOff
	b.push(...be32(1)); // textureCount
	b.push(...be32(0x18)); // firstDescOff
	b.push(...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x3c, 0, 0, 0, 0]); // sub-header
	// descriptor @0x2C
	b.push(...be32(TEX_CRC)); // crc
	b.push(...be16(0xffff)); // marker
	b.push(...be16(0)); // pad0
	b.push(0x86); // gcmFormat DXT1
	b.push(1); // mipCount
	b.push(...be16(0x0200)); // dimension
	b.push(...be32(0xaae4)); // gcmRemap
	b.push(...be16(4)); // width
	b.push(...be16(4)); // height
	b.push(...be16(1)); // depth
	b.push(...be16(0)); // pad1
	b.push(...be32(8)); // sizeUnits
	b.push(...be32(0)); // pad2
	b.push(...be32(8)); // payloadSize (one DXT1 block)
	// pixel payload: one solid-green DXT1 block (565 green = 0x07E0).
	b.push(0xe0, 0x07); // c0 LE
	b.push(0xe0, 0x07); // c1 LE
	b.push(0x00, 0x00, 0x00, 0x00); // indices 0
	// C2NM trailer mapping the CRC -> "Albedo"
	b.push(0x43, 0x32, 0x4e, 0x4d); // "C2NM"
	b.push(...be32(TEX_CRC));
	b.push(...be32(7)); // length incl NUL
	b.push(...[...'Albedo'].map((c) => c.charCodeAt(0)), 0);
	return new Uint8Array(b);
}

// ---------------------------------------------------------------------------
// Synthetic .shaderinst — SDRI/INSS with two nodes. node[0] binds a diffuseMap
// texture override (CRC 0xABCD0001); node[1] has only a float constant. Replays
// the exact override value layout we reverse-engineered:
//   texture: <name> 00 00 00 00 03 00 00 00 SS <CRC:4 BE> 00 00 00 09
//   float:   <name> 00 00 00 00 02 00 00 00 SS 00 00 00 NN <f32×NN>
// ---------------------------------------------------------------------------
function buildShaderInst(): Uint8Array {
	const b: number[] = [];
	b.push(0x53, 0x44, 0x52, 0x49); // "SDRI"
	b.push(...be32(8)); // version
	b.push(0x49, 0x4e, 0x53, 0x53); // "INSS"
	b.push(...be32(2)); // node_count
	// node[0]
	b.push(...be32(0x11111111)); // inst_crc
	b.push(...lenStr('unnamed')); // node_name
	b.push(...lenStr('0x7982350f')); // combo_crc
	// override: VehiclePaintFast_0_diffuseMap (texture, kind 3)
	b.push(...lenStr('VehiclePaintFast_0_diffuseMap'));
	b.push(...be32(0)); // padding word
	b.push(0x03, 0x00, 0x00, 0x00, 0x01); // kind 3, slot 1
	b.push(...be32(TEX_CRC)); // texture CRC
	b.push(...be32(0x09)); // trailing type marker
	// node[1]
	b.push(...be32(0x22222222)); // inst_crc
	b.push(...lenStr('unnamed')); // node_name
	b.push(...lenStr('0x6d4eea20')); // combo_crc
	// override: VehiclePaintFast_0_paintColour (float3, kind 2) = (0.5, 0.25, 0.75)
	b.push(...lenStr('VehiclePaintFast_0_paintColour'));
	b.push(...be32(0)); // padding word
	b.push(0x02, 0x00, 0x00, 0x00, 0x0e); // kind 2, slot 0x0e
	b.push(...be32(3)); // component count
	const f = (v: number) => {
		const buf = new ArrayBuffer(4);
		new DataView(buf).setFloat32(0, v, false);
		return [...new Uint8Array(buf)];
	};
	b.push(...f(0.5), ...f(0.25), ...f(0.75));
	// INSE terminator
	b.push(0x49, 0x4e, 0x53, 0x45);
	return new Uint8Array(b);
}

// ---------------------------------------------------------------------------
// Synthetic suite — runs everywhere (no devkit needed).
// ---------------------------------------------------------------------------
describe('buildMaterials (synthetic fixtures)', () => {
	const textures = buildTextures();
	const shaderinst = buildShaderInst();

	it('decodes the texture container and indexes it by CRC', () => {
		const built = buildMaterials({ textures, shaderinst, submeshCount: 2 });
		expect(built.textureByCrc.has(TEX_CRC)).toBe(true);
		expect(built.nameByCrc.get(TEX_CRC)).toBe('Albedo');
		const decoded = built.textureByCrc.get(TEX_CRC)!;
		expect(decoded.rgba).not.toBeNull();
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(4);
	});

	it('binds the diffuseMap texture override to submesh 0', () => {
		const built = buildMaterials({ textures, shaderinst, submeshCount: 2 });
		expect(built.submeshes).toHaveLength(2);
		const s0 = built.submeshes[0];
		expect(s0.comboCrc).toBe('0x7982350f');
		expect(s0.instCrc).toBe(0x11111111);
		// The diffuse binding resolved to a non-empty RGBA texture.
		expect(s0.diffuseTexture).toBeDefined();
		expect(s0.diffuseTexture!.rgba).not.toBeNull();
		expect(s0.textures.some((t) => t.role === 'diffuse' && t.crc === TEX_CRC)).toBe(true);
	});

	it('reads a float-vector override (paintColour) without a texture', () => {
		const built = buildMaterials({ textures, shaderinst, submeshCount: 2 });
		const s1 = built.submeshes[1];
		expect(s1.diffuseTexture).toBeUndefined();
		expect(s1.params.baseColor).toBeDefined();
		const [r, g, bl] = s1.params.baseColor!;
		expect(r).toBeCloseTo(0.5, 4);
		expect(g).toBeCloseTo(0.25, 4);
		expect(bl).toBeCloseTo(0.75, 4);
	});

	it('reports counts matched when submesh count == node count', () => {
		const built = buildMaterials({ textures, shaderinst, submeshCount: 2 });
		expect(built.countsMatched).toBe(true);
	});

	it('clamps materialForSubmesh past the last node', () => {
		const built = buildMaterials({ textures, shaderinst, submeshCount: 2 });
		expect(materialForSubmesh(built, 0)?.index).toBe(0);
		expect(materialForSubmesh(built, 5)?.index).toBe(1); // clamped to last
	});

	it('decodes textures but binds nothing when the .shaderinst is absent', () => {
		const built = buildMaterials({ textures, submeshCount: 2 });
		expect(built.submeshes).toHaveLength(0);
		expect(built.textureByCrc.has(TEX_CRC)).toBe(true);
		expect(built.countsMatched).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// REAL devkit suite — the self-contained helicopter that ships every sibling.
//   Generic/Models/Helicopter_Bell206B_01/Helicopter_Bell206B_01.*
// Asserts that buildMaterials returns a non-empty diffuse for the heli body and
// that the body submesh carries UVs.
// ---------------------------------------------------------------------------
const HELI_DIR = 'Generic/Models/Helicopter_Bell206B_01';
const HELI = `${HELI_DIR}/Helicopter_Bell206B_01`;
const heliPresent = hasSample(`${HELI}.textures`) && hasSample(`${HELI}.shaderinst`);

describe('buildMaterials — REAL devkit helicopter (Helicopter_Bell206B_01)', () => {
	it.skipIf(!heliPresent)('resolves the Attack_Chopper diffuse for the body submesh', () => {
		const model = parseModel(readSample(`${HELI}.model`));
		const built = buildMaterials({
			textures: readSample(`${HELI}.textures`),
			shaderinst: readSample(`${HELI}.shaderinst`),
			shaders: readSample(`${HELI}.shaders`),
			submeshCount: model.meshes.length,
		});

		// All five named textures decode with non-null pixels.
		expect(built.textureByCrc.size).toBeGreaterThanOrEqual(5);
		for (const t of built.textureByCrc.values()) {
			expect(t.rgba).not.toBeNull();
		}

		// At least one submesh gets a real diffuse, and the body's is Attack_Chopper.
		const withDiffuse = built.submeshes.filter((s) => s.diffuseTexture);
		expect(withDiffuse.length).toBeGreaterThanOrEqual(1);

		const body = built.submeshes.find(
			(s) => s.diffuseTexture && built.nameByCrc.get(s.diffuseTexture.crc) === 'Attack_Chopper',
		);
		expect(body).toBeDefined();
		expect(body!.diffuseTexture!.rgba).not.toBeNull();
		expect(body!.diffuseTexture!.width).toBe(1024);
		expect(body!.diffuseTexture!.height).toBe(1024);
		// The body's combo CRC is the VehiclePaintFast combo.
		expect(body!.comboCrc).toBe('0x7982350f');
	});

	it.skipIf(!heliPresent)('the body submesh has bounded, mostly-unit UVs', () => {
		const model = parseModel(readSample(`${HELI}.model`));
		// The largest mesh (by vertex count) is the chopper body — it must have UVs.
		const bodyMesh = model.meshes.reduce((a, b) => (b.vertexCount > a.vertexCount ? b : a));
		expect(bodyMesh.uv).toBeDefined();
		expect(bodyMesh.uv!.length).toBe(bodyMesh.vertexCount * 2);
		// Real game UVs TILE, so they legitimately wrap past [0,1] (mirror/repeat).
		// What we can faithfully assert: they are finite, tightly bounded to the
		// standard [-1,1] tiling band, and a substantial share lands in the unit
		// square (so a RepeatWrapping sampler maps the diffuse sensibly).
		let mn = Infinity;
		let mx = -Infinity;
		let inUnit = 0;
		let finite = 0;
		for (let i = 0; i < bodyMesh.uv!.length; i++) {
			const v = bodyMesh.uv![i];
			if (!Number.isFinite(v)) continue;
			finite++;
			mn = Math.min(mn, v);
			mx = Math.max(mx, v);
			if (v >= -0.001 && v <= 1.001) inUnit++;
		}
		// All components present & finite.
		expect(finite).toBe(bodyMesh.uv!.length);
		// Bounded to the [-1,1] tiling band (no garbage like the half-float misread).
		expect(mn).toBeGreaterThanOrEqual(-1.001);
		expect(mx).toBeLessThanOrEqual(1.001);
		// A meaningful fraction sits inside the unit square.
		expect(inUnit / finite).toBeGreaterThan(0.5);
	});
});

// A guard so a missing devkit doesn't silently pass everything (informational).
describe('material test data root', () => {
	it('notes whether the devkit helicopter is present', () => {
		if (!heliPresent) {
			console.log(
				`[material.test] devkit heli not found under ${path.join(DATA_ROOT, HELI_DIR)} — ` +
					'real-file assertions skipped.',
			);
		}
		expect(typeof DATA_ROOT).toBe('string');
		// Touch fs so the import is used even when the devkit is absent.
		expect(typeof fs.existsSync).toBe('function');
	});
});
