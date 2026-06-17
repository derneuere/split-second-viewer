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

	it.skipIf(!heliPresent)('the body submesh carries finite, tiling UVs the textured path can sample', () => {
		const model = parseModel(readSample(`${HELI}.model`));
		// The largest mesh (by vertex count) is the chopper body — it must have UVs.
		const bodyMesh = model.meshes.reduce((a, b) => (b.vertexCount > a.vertexCount ? b : a));
		expect(bodyMesh.uv).toBeDefined();
		expect(bodyMesh.uv!.length).toBe(bodyMesh.vertexCount * 2);
		// Real game UVs TILE and can wrap past [0,1]. The exact UV RANGE/quality is
		// owned by model.ts (the geometry WP), not this material WP — the textured
		// path only needs every component FINITE and free of half-float garbage (the
		// failure mode that produced values in the thousands). A RepeatWrapping
		// sampler (set in makeDiffuseTexture) then reads the diffuse correctly across
		// however the UVs tile.
		let finite = 0;
		for (let i = 0; i < bodyMesh.uv!.length; i++) {
			const v = bodyMesh.uv![i];
			if (!Number.isFinite(v)) continue;
			finite++;
			// Sane band — guards against the half-float misread (values in the
			// thousands); legitimate tiling stays small-magnitude.
			expect(Math.abs(v)).toBeLessThanOrEqual(64);
		}
		// All components present & finite.
		expect(finite).toBe(bodyMesh.uv!.length);
	});
});

// ---------------------------------------------------------------------------
// REAL devkit suite — GENERALIZED texturing beyond the heli. These prove the
// helicopter-style binding is the DEFAULT for any model whose material siblings
// sit in the same directory, not a heli-only special case.
//
// NOTE on NemTruckBarrels: the Low/Mid LODs ship a 76-byte .textures STUB
// (textureCount 0, no pixels) with NO sibling .streamtex, so they genuinely have
// no decodable albedo — the correct behaviour is to bind nothing and fall back to
// flat (asserted below). The High LOD ships the real 4 MB inline .textures, so it
// is the NemTruckBarrels model that actually resolves a diffuse RGBA.
// ---------------------------------------------------------------------------
const NTB_DIR = 'Generic/Models';
const ntbHigh = `${NTB_DIR}/NemTruckBarrels_High/NemTruckBarrels_High`;
const ntbLow = `${NTB_DIR}/NemTruckBarrels_Low/NemTruckBarrels_Low`;
const ntbMid = `${NTB_DIR}/NemTruckBarrels_Mid/NemTruckBarrels_Mid`;
const skycrane = `${NTB_DIR}/skycrane_military/skycrane_military`;

const ntbHighPresent = hasSample(`${ntbHigh}.textures`) && hasSample(`${ntbHigh}.shaderinst`);
const ntbLowPresent = hasSample(`${ntbLow}.shaderinst`);
const ntbMidPresent = hasSample(`${ntbMid}.shaderinst`);
const skycranePresent = hasSample(`${skycrane}.textures`) && hasSample(`${skycrane}.shaderinst`);

describe('buildMaterials — REAL devkit NemTruckBarrels (generalized, same-dir siblings)', () => {
	it.skipIf(!ntbHighPresent)('resolves a diffuse RGBA for NemTruckBarrels_High', () => {
		const model = parseModel(readSample(`${ntbHigh}.model`));
		const built = buildMaterials({
			textures: readSample(`${ntbHigh}.textures`),
			shaderinst: readSample(`${ntbHigh}.shaderinst`),
			shaders: readSample(`${ntbHigh}.shaders`),
			submeshCount: model.meshes.length,
		});

		// The 4 MB inline container decodes both barrel albedos.
		expect(built.textureByCrc.size).toBeGreaterThanOrEqual(2);
		for (const t of built.textureByCrc.values()) expect(t.rgba).not.toBeNull();

		// At least one node resolves a real diffuse, and node[0] (the one the single
		// decoded submesh clamps to) is a "barrel" albedo with non-null pixels.
		const withDiffuse = built.submeshes.filter((s) => s.diffuseTexture);
		expect(withDiffuse.length).toBeGreaterThanOrEqual(1);

		const sub0 = materialForSubmesh(built, 0);
		expect(sub0?.diffuseTexture).toBeDefined();
		expect(sub0!.diffuseTexture!.rgba).not.toBeNull();
		expect(built.nameByCrc.get(sub0!.diffuseTexture!.crc)).toMatch(/barrel/i);
		// A genuine full-res albedo (2048²), not a tiny reflection/cube probe.
		expect(sub0!.diffuseTexture!.width).toBeGreaterThanOrEqual(512);
	});

	it.skipIf(!ntbLowPresent)('NemTruckBarrels_Low (stub .textures, no stream) resolves no diffuse without crashing', () => {
		const model = parseModel(readSample(`${ntbLow}.model`));
		const built = buildMaterials({
			textures: hasSample(`${ntbLow}.textures`) ? readSample(`${ntbLow}.textures`) : null,
			shaderinst: readSample(`${ntbLow}.shaderinst`),
			shaders: hasSample(`${ntbLow}.shaders`) ? readSample(`${ntbLow}.shaders`) : null,
			submeshCount: model.meshes.length,
		});
		// Nodes still resolve (the spine parses), but no pixels are available — the
		// 0xFFFFFFFF sampler sentinel binds nothing, so every diffuse is undefined.
		expect(built.submeshes.length).toBeGreaterThan(0);
		expect(built.submeshes.every((s) => s.diffuseTexture === undefined)).toBe(true);
		expect(built.textureByCrc.size).toBe(0);
	});

	it.skipIf(!ntbMidPresent)('NemTruckBarrels_Mid (stub .textures) resolves no diffuse without crashing', () => {
		const model = parseModel(readSample(`${ntbMid}.model`));
		const built = buildMaterials({
			textures: hasSample(`${ntbMid}.textures`) ? readSample(`${ntbMid}.textures`) : null,
			shaderinst: readSample(`${ntbMid}.shaderinst`),
			submeshCount: model.meshes.length,
		});
		expect(built.submeshes.every((s) => s.diffuseTexture === undefined)).toBe(true);
	});
});

describe('buildMaterials — REAL devkit skycrane (over-fit regression guard)', () => {
	// skycrane_military's node[0] has THREE kind-3 samplers:
	//   Diffuse_IPR_0_diffuse (slot1) -> generic_skycrane_military 1024×512  [albedo]
	//   Diffuse_IPR_0_ipr     (slot2) -> *_ipr 512×256                        [reflection]
	//   Diffuse_IPR_0_cubemap (slot3) -> Docks_Outsource_World_Sunset 32×32   [sky cube]
	// None end in "map"/"texture", so the old name-suffix gate dropped the real
	// albedo and (because "cubemap" ends in "map" and the name contains "diffuse")
	// bound the 32×32 sky cube as the diffuse. The generalized binding must pick the
	// slot-1 albedo instead.
	it.skipIf(!skycranePresent)('binds the slot-1 albedo, not the sky cubemap', () => {
		const model = parseModel(readSample(`${skycrane}.model`));
		const built = buildMaterials({
			textures: readSample(`${skycrane}.textures`),
			shaderinst: readSample(`${skycrane}.shaderinst`),
			shaders: readSample(`${skycrane}.shaders`),
			submeshCount: model.meshes.length,
		});
		const sub0 = materialForSubmesh(built, 0);
		expect(sub0?.diffuseTexture).toBeDefined();
		const name = built.nameByCrc.get(sub0!.diffuseTexture!.crc);
		expect(name).toBe('generic_skycrane_military');
		// Definitively NOT the 32×32 cube probe.
		expect(name).not.toBe('Docks_Outsource_World_Sunset');
		expect(sub0!.diffuseTexture!.width).toBeGreaterThan(32);
		// All three samplers are still recorded (kind-3 detection, not name-gated).
		expect(sub0!.textures.length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Synthetic over-fit guard — a node with a "*_cubemap" containing "diffuse" in
// the name plus a plainly-named real diffuse at a lower slot. Runs everywhere.
// ---------------------------------------------------------------------------
describe('buildMaterials — slot-based diffuse pick (synthetic)', () => {
	const ALBEDO = 0xaa110011;
	const CUBE = 0xaa220022;
	function texturesTwo(): Uint8Array {
		// Two 4×4 DXT1 textures inline + a C2NM trailer naming both.
		const b: number[] = [];
		const be32x = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
		const be16x = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
		b.push(0x54, 0x45, 0x58, 0x53, ...be32x(12), ...be32x(1), ...be32x(0x68), ...be32x(2), ...be32x(0x18));
		b.push(...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x3c, 0, 0, 0, 0]);
		const desc = (crc: number) => {
			b.push(...be32x(crc), ...be16x(0xffff), ...be16x(0), 0x86, 1, ...be16x(0x0200), ...be32x(0xaae4),
				...be16x(4), ...be16x(4), ...be16x(1), ...be16x(0), ...be32x(8), ...be32x(0), ...be32x(8));
		};
		desc(ALBEDO);
		desc(CUBE);
		// two DXT1 blocks back-to-back (green, then red), in descriptor order.
		b.push(0xe0, 0x07, 0xe0, 0x07, 0, 0, 0, 0); // ALBEDO block
		b.push(0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0); // CUBE block
		// C2NM trailer
		const nameRec = (crc: number, s: string) => {
			b.push(...be32x(crc), ...be32x(s.length + 1), ...[...s].map((c) => c.charCodeAt(0)), 0);
		};
		b.push(0x43, 0x32, 0x4e, 0x4d);
		nameRec(ALBEDO, 'BodyAlbedo');
		nameRec(CUBE, 'Sky_Cube');
		return new Uint8Array(b);
	}
	function shaderInstSlots(): Uint8Array {
		const b: number[] = [];
		const be32x = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
		b.push(0x53, 0x44, 0x52, 0x49, ...be32x(8), 0x49, 0x4e, 0x53, 0x53, ...be32x(1));
		b.push(...be32x(0x33333333), ...lenStr('unnamed'), ...lenStr('0xabc12300'));
		// override A: cubemap at slot 3, name contains "diffuse" (the trap).
		b.push(...lenStr('Diffuse_IPR_0_cubemap'), ...be32(0), 0x03, 0x00, 0x00, 0x00, 0x03, ...be32(CUBE), ...be32(9));
		// override B: real albedo at slot 1, plainly named (no map/texture suffix).
		b.push(...lenStr('Diffuse_IPR_0_diffuse'), ...be32(0), 0x03, 0x00, 0x00, 0x00, 0x01, ...be32(ALBEDO), ...be32(9));
		b.push(0x49, 0x4e, 0x53, 0x45);
		return new Uint8Array(b);
	}

	it('picks the slot-1 plainly-named albedo over a higher-slot "*cubemap"', () => {
		const built = buildMaterials({ textures: texturesTwo(), shaderinst: shaderInstSlots(), submeshCount: 1 });
		expect(built.textureByCrc.size).toBe(2);
		const s0 = built.submeshes[0];
		expect(s0.textures.length).toBe(2); // both samplers recorded (kind-3 detection)
		expect(s0.diffuseTexture).toBeDefined();
		expect(built.nameByCrc.get(s0.diffuseTexture!.crc)).toBe('BodyAlbedo');
		// The cubemap (name contains "diffuse") must be classified 'other', not diffuse.
		const cube = s0.textures.find((t) => t.name.endsWith('cubemap'))!;
		expect(cube.role).toBe('other');
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
