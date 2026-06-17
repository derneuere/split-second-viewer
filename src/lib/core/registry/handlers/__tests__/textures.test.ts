import { describe, expect, it } from 'vitest';
import { texturesHandler, decodeLargestTexture, decodeAllInline } from '../textures';
import {
	parseTextures,
	mipChainSize,
	mipByteSize,
	decodeBcnSurface,
	decodeArgb8888Surface,
	decodeSurface,
	deswizzleMorton,
	mortonIndex,
	canBeSwizzled,
	looksLinear,
	isTextures,
	findC2nm,
	parseC2nm,
	type TextureDescriptor,
} from '../../../textures';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

/** Mean of one RGBA channel across the buffer. */
function channelMean(rgba: Uint8ClampedArray, ch: 0 | 1 | 2 | 3): number {
	let s = 0;
	const n = rgba.length / 4;
	for (let i = 0; i < rgba.length; i += 4) s += rgba[i + ch];
	return s / n;
}

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

	it('mipByteSize / mipChainSize treat DXT3 like DXT5 (16 B/block)', () => {
		expect(mipByteSize('DXT3', 256, 256)).toBe((256 / 4) * (256 / 4) * 16);
		expect(mipByteSize('DXT3', 4, 4)).toBe(16);
		// A 256x256 mip-9 DXT3 chain equals the DXT5 chain (same block size).
		expect(mipChainSize('DXT3', 256, 256, 9)).toBe(mipChainSize('DXT5', 256, 256, 9));
	});
});

// ---------------------------------------------------------------------------
// BC2/DXT3 decoder (new). One 4x4 block: solid green colour with a per-texel
// 4-bit alpha ramp (0,1,2,...,15 -> *17 -> 0,17,34,...,255).
// ---------------------------------------------------------------------------
describe('DXT3 / BC2 decoder', () => {
	function buildBc2Block(): Uint8Array {
		const b: number[] = [];
		// 8 alpha bytes: texel i gets nibble = i (low nibble first within a byte).
		// byte k packs texels (2k, 2k+1) as (lo=2k, hi=2k+1).
		for (let k = 0; k < 8; k++) {
			const lo = 2 * k; // 0..14
			const hi = 2 * k + 1; // 1..15
			b.push((hi << 4) | lo);
		}
		// Colour block: c0 = pure green 565 (0x07E0), c1 = 0, indices all 0 -> c0.
		// 0x07E0 LE = E0 07.
		b.push(0xe0, 0x07); // c0
		b.push(0x00, 0x00); // c1
		b.push(0x00, 0x00, 0x00, 0x00); // indices all 0
		return new Uint8Array(b);
	}

	it('decodes explicit 4-bit alpha + BC1 colour', () => {
		const block = buildBc2Block();
		const out = decodeBcnSurface(block, 0, 4, 4, 'DXT3');
		expect(out.length).toBe(4 * 4 * 4);
		// Every texel is green (565 0x07E0 -> R0 G255 B0).
		for (let i = 0; i < 16; i++) {
			expect(out[i * 4]).toBe(0); // R
			expect(out[i * 4 + 1]).toBe(255); // G
			expect(out[i * 4 + 2]).toBe(0); // B
		}
		// Alpha ramps 0,17,34,...,255 in row-major texel order.
		for (let t = 0; t < 16; t++) {
			expect(out[t * 4 + 3]).toBe(t * 17);
		}
	});
});

// ---------------------------------------------------------------------------
// A8R8G8B8 byte order: GCM stores a little-endian ARGB dword -> bytes B,G,R,A.
// ---------------------------------------------------------------------------
describe('A8R8G8B8 byte order (little-endian ARGB = B,G,R,A in memory)', () => {
	it('maps memory bytes B,G,R,A to RGBA', () => {
		// One texel: memory = 0x11(B) 0x22(G) 0x33(R) 0x44(A).
		const data = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
		const out = decodeArgb8888Surface(data, 0, 1, 1);
		expect(Array.from(out)).toEqual([0x33, 0x22, 0x11, 0x44]); // R,G,B,A
	});
});

// ---------------------------------------------------------------------------
// Morton de-swizzle + the linear-vs-swizzled heuristic.
// ---------------------------------------------------------------------------
describe('RSX Morton de-swizzle', () => {
	it('mortonIndex interleaves coordinate bits (Z-order)', () => {
		expect(mortonIndex(0, 0)).toBe(0);
		expect(mortonIndex(1, 0)).toBe(1);
		expect(mortonIndex(0, 1)).toBe(2);
		expect(mortonIndex(1, 1)).toBe(3);
		expect(mortonIndex(2, 0)).toBe(4);
		expect(mortonIndex(3, 3)).toBe(15);
	});

	it('canBeSwizzled only accepts power-of-two square surfaces', () => {
		expect(canBeSwizzled(256, 256)).toBe(true);
		expect(canBeSwizzled(512, 512)).toBe(true);
		expect(canBeSwizzled(1024, 32)).toBe(false); // not square
		expect(canBeSwizzled(100, 100)).toBe(false); // not pow2
	});

	it('deswizzleMorton restores a linearly-built source from Morton order', () => {
		// Build a 4x4 ARGB surface in Morton order whose linear value is x+y*4.
		const w = 4,
			h = 4,
			bpu = 4;
		const swz = new Uint8Array(w * h * bpu);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const m = mortonIndex(x, y);
				swz[m * bpu] = y * w + x; // marker in first byte
			}
		}
		const lin = deswizzleMorton(swz, 0, w, h, bpu);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				expect(lin[(y * w + x) * bpu]).toBe(y * w + x);
			}
		}
	});

	it('looksLinear returns true for a smooth linear surface, false for a swizzled one', () => {
		// A smooth 2-D diagonal gradient (value = (x+y)*4) — coherent in BOTH axes,
		// like real texture content. A linear read is smooth; a Morton read scatters
		// it. 32x32 ARGB.
		const w = 32,
			h = 32,
			bpu = 4;
		const value = (x: number, y: number) => ((x + y) * 4) & 0xff;

		const linear = new Uint8Array(w * h * bpu);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) linear[(y * w + x) * bpu] = value(x, y);
		expect(looksLinear(linear, 0, w, h, bpu)).toBe(true);

		// Same image written in Morton order: a straight (linear) read is scrambled,
		// so the heuristic should prefer the de-swizzled reading.
		const swizzled = new Uint8Array(w * h * bpu);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) swizzled[mortonIndex(x, y) * bpu] = value(x, y);
		expect(looksLinear(swizzled, 0, w, h, bpu)).toBe(false);
	});

	it('decodeSurface auto-deswizzles an A8R8G8B8 surface stored in Morton order', () => {
		const w = 16,
			h = 16;
		// Build a smooth BGRA gradient in linear space, then write it Morton-swizzled.
		const swz = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const m = mortonIndex(x, y);
				swz[m * 4 + 0] = x * 8; // B
				swz[m * 4 + 1] = y * 8; // G
				swz[m * 4 + 2] = 0; // R
				swz[m * 4 + 3] = 255; // A
			}
		}
		const d: TextureDescriptor = {
			descOff: 0,
			crc: 0,
			marker: 0xffff,
			gcmFormat: 0xa5,
			format: 'A8R8G8B8',
			mipCount: 1,
			dimension: 0x200,
			gcmRemap: 0xaa1b,
			width: w,
			height: h,
			depth: 1,
			sizeUnits: 0,
			payloadSize: 0,
		};
		const { rgba, swizzled } = decodeSurface(swz, 0, d);
		expect(swizzled).toBe(true);
		expect(rgba).not.toBeNull();
		// After de-swizzle, top-left should be (R=0,G=0,B=0) and (1,0) B=8.
		expect(rgba![0]).toBe(0); // R at (0,0)
		expect(rgba![2]).toBe(0); // B at (0,0)
		expect(rgba![(0 * w + 1) * 4 + 2]).toBe(8); // B at (1,0)
	});
});

// ---------------------------------------------------------------------------
// Real-file fixtures from the devkit (skip when absent).
// ---------------------------------------------------------------------------
const BODY_PAINT = 'Vehicles/Bodies/Musclecar_01/Musclecar_01_bodyPaint.textures';
const DAMAGE_MAP = 'Vehicles/Bodies/Musclecar_01/Musclecar_01_damageMap.textures';
const LOW = 'Vehicles/Bodies/Musclecar_01/Musclecar_01_damageMap.low.textures';
const STUB = 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.textures';
const SKYDOME =
	'Environments/Levels/airport_test_03/ReflectionMap/Skydomes/Skydome_Midday.textures';
const SKYDOME_SQ = 'Environments/Levels/Downtown/Skydome/Skydome_Midday.textures';
const COLORCUBES = 'UI/Frontend/ColorCubes/ColorCubes.textures';
const POINTLIGHT =
	'Environments/Levels/airport_test_03/ReflectionMap/Lights/PointLight.textures';

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

	it.skipIf(!hasSample(BODY_PAINT))(
		'decodes the vehicle bodyPaint DXT1 to a non-garbage image',
		() => {
			const raw = readSample(BODY_PAINT);
			const m = texturesHandler.parseRaw(raw, ssCtx());
			expect(m.textureCount).toBe(1);
			const d = m.descriptors[0];
			expect(d.format).toBe('DXT1');
			expect(d.width).toBe(1024);
			expect(d.height).toBe(2048);
			expect(d.name).toBe('Musclecar_01');

			const dec = decodeLargestTexture(raw, m);
			expect(dec).not.toBeNull();
			expect(dec!.rgba!.length).toBe(1024 * 2048 * 4);
			expect(dec!.swizzled).toBe(false); // proven linear on the devkit
			// Average colour matches the Python/PIL reference (dark blue-ish livery,
			// avg ≈ R11 G20 B34). Allow a small tolerance for rounding differences.
			expect(channelMean(dec!.rgba!, 0)).toBeGreaterThan(5);
			expect(channelMean(dec!.rgba!, 0)).toBeLessThan(40);
			expect(channelMean(dec!.rgba!, 2)).toBeGreaterThan(
				channelMean(dec!.rgba!, 0),
			); // blue > red (blue livery)
			// Not a flat/garbage buffer: there is real variation across the surface.
			let nonZero = 0;
			for (let i = 0; i < dec!.rgba!.length; i += 4 * 997) {
				if (dec!.rgba![i] > 0 || dec!.rgba![i + 1] > 0 || dec!.rgba![i + 2] > 0)
					nonZero++;
			}
			expect(nonZero).toBeGreaterThan(10);
		},
	);

	it.skipIf(!hasSample(SKYDOME))('parses + decodes a single A8R8G8B8 skydome', () => {
		const raw = readSample(SKYDOME);
		const m = texturesHandler.parseRaw(raw, ssCtx());
		const d = m.descriptors[0];
		expect(d.format).toBe('A8R8G8B8');
		expect(d.gcmFormat).toBe(0xa5);
		expect(d.gcmRemap).toBe(0xaa1b);
		expect(d.width).toBe(256);
		expect(d.height).toBe(64);
		const dec = decodeLargestTexture(raw, m);
		expect(dec).not.toBeNull();
		expect(dec!.format).toBe('A8R8G8B8');
		expect(dec!.rgba).not.toBeNull();
		expect(dec!.rgba!.length).toBe(d.width * d.height * 4);
		// 256x64 is not square -> read linearly, never swizzled.
		expect(dec!.swizzled).toBe(false);
		// Sky texture: opaque-ish, mid grey-blue. Reference avg ≈ (70,81,86,156).
		expect(channelMean(dec!.rgba!, 3)).toBeGreaterThan(80); // mostly opaque
		const r = channelMean(dec!.rgba!, 0);
		const g = channelMean(dec!.rgba!, 1);
		const b = channelMean(dec!.rgba!, 2);
		expect(b).toBeGreaterThanOrEqual(g - 5); // blue >= green (sky)
		expect(g).toBeGreaterThanOrEqual(r - 5); // green >= red
	});

	it.skipIf(!hasSample(SKYDOME_SQ))(
		'decodes a 512x512 square A8R8G8B8 skydome with the linear heuristic (not swizzled)',
		() => {
			const raw = readSample(SKYDOME_SQ);
			const m = texturesHandler.parseRaw(raw, ssCtx());
			const d = m.descriptors[0];
			expect(d.format).toBe('A8R8G8B8');
			expect(d.width).toBe(512);
			expect(d.height).toBe(512);
			// Square pow2 -> swizzle-eligible, but the heuristic must keep it linear.
			expect(canBeSwizzled(d.width, d.height)).toBe(true);
			const dec = decodeLargestTexture(raw, m);
			expect(dec).not.toBeNull();
			expect(dec!.swizzled).toBe(false);
			expect(dec!.rgba!.length).toBe(512 * 512 * 4);
			// Reference avg ≈ (87,113,121): bright, mid-tone sky, not all-zero.
			expect(channelMean(dec!.rgba!, 0)).toBeGreaterThan(40);
			expect(channelMean(dec!.rgba!, 1)).toBeGreaterThan(40);
			expect(channelMean(dec!.rgba!, 2)).toBeGreaterThan(40);
		},
	);

	it.skipIf(!hasSample(COLORCUBES))(
		'decodes a multi-texture inline ColorCubes file (3x A8R8G8B8 1024x32)',
		() => {
			const raw = readSample(COLORCUBES);
			const m = texturesHandler.parseRaw(raw, ssCtx());
			expect(m.textureCount).toBe(3);
			expect(m.descriptors.every((d) => d.format === 'A8R8G8B8')).toBe(true);
			expect(m.descriptors.every((d) => d.width === 1024 && d.height === 32)).toBe(true);

			// decodeAllInline must return all THREE textures, each fully sized.
			const all = decodeAllInline(raw, m);
			expect(all.length).toBe(3);
			for (const t of all) {
				expect(t.rgba).not.toBeNull();
				expect(t.rgba!.length).toBe(1024 * 32 * 4);
				expect(t.swizzled).toBe(false);
			}
			// First texture starts at 0xD8 (verified against the raw file).
			expect(all[0].pixelStart).toBe(0xd8);
			// Each subsequent texture is one full mip chain (131072 B) later.
			expect(all[1].pixelStart).toBe(0xd8 + 1024 * 32 * 4);
			expect(all[2].pixelStart).toBe(0xd8 + 2 * 1024 * 32 * 4);
			// Names resolved from C2NM.
			const names = all.map((t) => t.name);
			expect(names).toContain('default');
			// A color-cube LUT is a smooth gradient: row 0 ramps in one channel.
			// First few texels are near-black, ramping up — not a flat buffer.
			const first = all[0].rgba!;
			const earlyMax = Math.max(first[0], first[1], first[2]);
			const laterMax = Math.max(first[60], first[61], first[62]); // texel 15
			expect(laterMax).toBeGreaterThan(earlyMax);
		},
	);

	it.skipIf(!hasSample(POINTLIGHT))(
		'decodes a single-texture DXT5 (BC3) point-light mask',
		() => {
			const raw = readSample(POINTLIGHT);
			const m = texturesHandler.parseRaw(raw, ssCtx());
			const d = m.descriptors[0];
			expect(d.format).toBe('DXT5');
			expect(d.gcmFormat).toBe(0x88);
			const dec = decodeLargestTexture(raw, m);
			expect(dec).not.toBeNull();
			expect(dec!.format).toBe('DXT5');
			expect(dec!.rgba).not.toBeNull();
			expect(dec!.rgba!.length).toBe(d.width * d.height * 4);
			// Glow mask: RGB ~white, alpha varies across the surface (the actual mask).
			const aMin = (() => {
				let mn = 255;
				for (let i = 3; i < dec!.rgba!.length; i += 4 * 311)
					mn = Math.min(mn, dec!.rgba![i]);
				return mn;
			})();
			expect(aMin).toBeLessThan(255); // there is genuine alpha variation
			expect(channelMean(dec!.rgba!, 0)).toBeGreaterThan(200); // bright RGB
		},
	);
});
