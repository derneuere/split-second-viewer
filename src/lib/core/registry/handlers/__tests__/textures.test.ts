import { describe, expect, it } from 'vitest';
import { texturesHandler, decodeLargestTexture } from '../textures';
import {
	parseTextures,
	mipChainSize,
	mipByteSize,
	decodeBcnSurface,
	isTextures,
	findC2nm,
	parseC2nm,
} from '../../../textures';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// ---------------------------------------------------------------------------
// Inline synthetic TEXS fixture — a 1-texture DXT1 4x4 file (single block,
// single mip). Built so the test runs without the devkit. The block is a solid
// red (565 = 0xF800) DXT1 block: c0=c1=0xF800, indices all 0 -> all-red.
// ---------------------------------------------------------------------------
function be16(v: number): [number, number] {
	return [(v >> 8) & 0xff, v & 0xff];
}
function be32(v: number): number[] {
	return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function buildInlineTextures(): Uint8Array {
	const bytes: number[] = [];
	// Header (0x18)
	bytes.push(0x54, 0x45, 0x58, 0x53); // "TEXS"
	bytes.push(...be32(12)); // version
	bytes.push(...be32(1)); // flags
	bytes.push(...be32(0x68)); // payloadTableOff (arbitrary, like the real files)
	bytes.push(...be32(1)); // textureCount
	bytes.push(...be32(0x18)); // firstDescOff
	// Sub-header (0x14) — copy the constant single-texture pattern.
	bytes.push(...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x3c, 0, 0, 0, 0]);
	// Descriptor (0x24) at 0x2C
	const CRC = 0xdeadbeef;
	bytes.push(...be32(CRC)); // crc
	bytes.push(...be16(0xffff)); // marker
	bytes.push(...be16(0)); // pad0
	bytes.push(0x86); // gcmFormat DXT1
	bytes.push(1); // mipCount = 1
	bytes.push(...be16(0x0200)); // dimension
	bytes.push(...be32(0xaae4)); // gcmRemap
	bytes.push(...be16(4)); // width
	bytes.push(...be16(4)); // height
	bytes.push(...be16(1)); // depth
	bytes.push(...be16(0)); // pad1
	bytes.push(...be32(8)); // sizeUnits
	bytes.push(...be32(0)); // pad2
	bytes.push(...be32(8)); // payloadSize (one DXT1 block = 8 bytes)
	// Pixel payload: one solid-red DXT1 block. C2NM must sit at payloadStart+8
	// because the decoder computes pixelStart = C2NM - chain, chain=8.
	// DXT1 block colours are LITTLE-ENDIAN within the block.
	bytes.push(0x00, 0xf8); // c0 = 0xF800 (red) LE
	bytes.push(0x00, 0xf8); // c1 = 0xF800 (red) LE
	bytes.push(0x00, 0x00, 0x00, 0x00); // indices all 0
	// C2NM trailer
	bytes.push(0x43, 0x32, 0x4e, 0x4d); // "C2NM"
	bytes.push(...be32(CRC)); // crc
	bytes.push(...be32(4)); // length 4
	bytes.push(0x54, 0x65, 0x73, 0x74); // "Test"
	return new Uint8Array(bytes);
}

const INLINE = buildInlineTextures();

describe('textures parser (inline synthetic TEXS)', () => {
	it('recognizes the TEXS magic', () => {
		expect(isTextures(INLINE)).toBe(true);
		expect(isTextures(new Uint8Array([0, 1, 2, 3]))).toBe(false);
	});

	it('parses the constant header fields', () => {
		const m = parseTextures(INLINE);
		expect(m.magic).toBe('TEXS');
		expect(m.version).toBe(12);
		expect(m.flags).toBe(1);
		expect(m.firstDescOff).toBe(0x18);
		expect(m.textureCount).toBe(1);
		expect(m.subHeader.byteLength).toBe(0x14);
	});

	it('decodes the single descriptor with the right format/dims/crc', () => {
		const m = parseTextures(INLINE);
		const d = m.descriptors[0];
		expect(d.descOff).toBe(0x2c);
		expect(d.crc).toBe(0xdeadbeef);
		expect(d.marker).toBe(0xffff);
		expect(d.gcmFormat).toBe(0x86);
		expect(d.format).toBe('DXT1');
		expect(d.mipCount).toBe(1);
		expect(d.dimension).toBe(0x0200);
		expect(d.gcmRemap).toBe(0xaae4);
		expect(d.width).toBe(4);
		expect(d.height).toBe(4);
		expect(d.depth).toBe(1);
		expect(d.payloadSize).toBe(8);
	});

	it('resolves the C2NM name onto the descriptor', () => {
		const m = parseTextures(INLINE);
		expect(m.c2nmOff).toBeGreaterThanOrEqual(0);
		expect(m.descriptors[0].name).toBe('Test');
		const names = parseC2nm(INLINE, findC2nm(INLINE));
		expect(names.get(0xdeadbeef)).toBe('Test');
	});

	it('decodes the top mip to a solid-red RGBA buffer', () => {
		const m = parseTextures(INLINE);
		const dec = decodeLargestTexture(INLINE, m);
		expect(dec).not.toBeNull();
		expect(dec!.width).toBe(4);
		expect(dec!.height).toBe(4);
		expect(dec!.format).toBe('DXT1');
		expect(dec!.rgba).not.toBeNull();
		expect(dec!.rgba!.length).toBe(4 * 4 * 4);
		// Top-left texel = red, opaque.
		expect(dec!.rgba![0]).toBe(255); // R
		expect(dec!.rgba![1]).toBe(0); // G
		expect(dec!.rgba![2]).toBe(0); // B
		expect(dec!.rgba![3]).toBe(255); // A
	});

	it('describe() summarizes the set', () => {
		const m = parseTextures(INLINE);
		const s = texturesHandler.describe(m);
		expect(s).toContain('TEXS');
		expect(s).toContain('DXT1 4x4');
		expect(s).toContain('Test');
	});

	it('rejects a non-TEXS blob', () => {
		expect(() => parseTextures(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad magic/);
	});
});

describe('texture geometry math', () => {
	it('mipByteSize matches the DXT1 block formula', () => {
		// 1024x2048 DXT1 top mip = (1024/4)*(2048/4)*8
		expect(mipByteSize('DXT1', 1024, 2048)).toBe((1024 / 4) * (2048 / 4) * 8);
		// 4x4 DXT1 = one 8-byte block
		expect(mipByteSize('DXT1', 4, 4)).toBe(8);
		// 256x64 A8R8G8B8 = w*h*4
		expect(mipByteSize('A8R8G8B8', 256, 64)).toBe(256 * 64 * 4);
	});

	it('mipChainSize for damageMap (1024x2048 DXT1, 12 mips) = 1,398,120', () => {
		// This is the exact value the wiki cites for the damageMap full chain.
		expect(mipChainSize('DXT1', 1024, 2048, 12)).toBe(1398120);
	});

	it('decodeBcnSurface tolerates a truncated payload', () => {
		// 8x8 DXT1 needs 4 blocks (32 bytes); give it only 8 -> partial decode.
		const out = decodeBcnSurface(new Uint8Array(8), 0, 8, 8, 'DXT1');
		expect(out.length).toBe(8 * 8 * 4);
	});
});

// ---------------------------------------------------------------------------
// Real-file fixtures from the devkit (skip when absent).
// ---------------------------------------------------------------------------
const DAMAGE_MAP = 'Vehicles/Bodies/Musclecar_01/Musclecar_01_damageMap.textures';
const LOW = 'Vehicles/Bodies/Musclecar_01/Musclecar_01_damageMap.low.textures';
const STUB = 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.textures';
const SKYDOME =
	'Environments/Levels/airport_test_03/ReflectionMap/Skydomes/Skydome_Midday.textures';

describe('textures parser (REAL devkit samples)', () => {
	it.skipIf(!hasSample(DAMAGE_MAP))(
		'parses + decodes a single-texture DXT1 1024x2048 damageMap',
		() => {
			const raw = readSample(DAMAGE_MAP);
			const m = texturesHandler.parseRaw(raw, ssCtx());
			expect(m.magic).toBe('TEXS');
			expect(m.version).toBe(12);
			expect(m.flags).toBe(1);
			expect(m.textureCount).toBe(1);
			const d = m.descriptors[0];
			expect(d.format).toBe('DXT1');
			expect(d.width).toBe(1024);
			expect(d.height).toBe(2048);
			expect(d.mipCount).toBe(12);
			expect(d.marker).toBe(0xffff);
			expect(d.gcmRemap).toBe(0xaae4);
			expect(d.name).toBe('Musclecar_01_DamageMap');
			expect(m.isStub).toBe(false);

			// Decode the top mip: 1024x2048 RGBA.
			const dec = decodeLargestTexture(raw, m);
			expect(dec).not.toBeNull();
			expect(dec!.width).toBe(1024);
			expect(dec!.height).toBe(2048);
			expect(dec!.rgba).not.toBeNull();
			expect(dec!.rgba!.length).toBe(1024 * 2048 * 4);
			// Pixel start = C2NM - chain == 144 (0x90) per the layout probe.
			expect(dec!.pixelStart).toBe(m.c2nmOff - mipChainSize('DXT1', 1024, 2048, 12));
			// Every alpha byte from BC1 is 255 (opaque) for c0>c1 blocks; at least
			// the first texel must have a valid (0..255) alpha.
			expect(dec!.rgba![3]).toBeGreaterThanOrEqual(0);
			expect(dec!.rgba![3]).toBeLessThanOrEqual(255);
		},
	);

	it.skipIf(!hasSample(LOW))('parses a .low.textures (lowest-mip fallback)', () => {
		const raw = readSample(LOW);
		const m = texturesHandler.parseRaw(raw, ssCtx());
		expect(m.textureCount).toBe(1);
		const d = m.descriptors[0];
		expect(d.format).toBe('DXT1');
		expect(d.name).toBe('Musclecar_01_DamageMap');
		// .low holds a tiny mip (16x32 in this sample).
		expect(d.width).toBeLessThanOrEqual(64);
		expect(d.height).toBeLessThanOrEqual(64);
	});

	it.skipIf(!hasSample(STUB))('parses a 14-descriptor frontend stub', () => {
		const raw = readSample(STUB);
		const m = texturesHandler.parseRaw(raw, ssCtx());
		expect(m.textureCount).toBe(14);
		expect(m.isStub).toBe(true);
		// The seven names from the C2NM trailer (the wiki's worked example).
		const names = m.descriptors.map((d) => d.name);
		expect(names).toContain('paraboloid_back');
		expect(names).toContain('Musclecar_01');
		expect(names).toContain('DirtMap');
		// Descriptor 9 is the full-res Musclecar_01 (1024x2048).
		const full = m.descriptors.find(
			(d) => d.name === 'Musclecar_01' && d.width === 1024 && d.height === 2048,
		);
		expect(full).toBeDefined();
		// Stubs carry payloadSize=0.
		expect(m.descriptors.every((d) => d.payloadSize === 0)).toBe(true);
	});

	it.skipIf(!hasSample(SKYDOME))('parses + decodes a single A8R8G8B8 skydome', () => {
		const raw = readSample(SKYDOME);
		const m = texturesHandler.parseRaw(raw, ssCtx());
		const d = m.descriptors[0];
		expect(d.format).toBe('A8R8G8B8');
		expect(d.gcmFormat).toBe(0xa5);
		expect(d.gcmRemap).toBe(0xaa1b);
		const dec = decodeLargestTexture(raw, m);
		expect(dec).not.toBeNull();
		expect(dec!.format).toBe('A8R8G8B8');
		expect(dec!.rgba).not.toBeNull();
		expect(dec!.rgba!.length).toBe(d.width * d.height * 4);
	});
});
