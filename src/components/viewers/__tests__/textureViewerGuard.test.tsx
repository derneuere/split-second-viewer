// Regression test for #7: clicking a .ark .gputex member crashed the texture
// viewport with "Cannot read properties of undefined (reading 'length')".
//
// A bare .gputex / .streamtex member routes through the `streamtex` handler,
// whose parseRaw returns a ParsedStreamtex `{ headerless, byteLength, payload }`
// — NOT a ParsedTextures. The old TextureViewer dereferenced
// `model.descriptors.length` unconditionally and threw.
//
// The vitest env is `node` (no DOM), so rather than render the component we
// exercise the PURE render-decision the component now makes — classifyTextureModel
// + the two guards it is built from. Every shape the dispatcher can feed the
// viewport must classify into a graceful, non-throwing branch.

import { describe, expect, it } from 'vitest';
import {
	classifyTextureModel,
	isParsedTextures,
	asStreamtexPayloadLen,
} from '../TextureViewer';
import { parseStreamtex } from '@/lib/core/streamtex';
import { parseTextures } from '@/lib/core/textures';
import type { ParsedTextures } from '@/lib/core/textures';

// Mip-chain-typical .gputex Stream-member payload sizes (mirror TEX_SIZES in
// ArkArchive.ts) — a .gputex of one of these sizes is what triggered #7.
const TEX_SIZES_FOR_TEST = [0x5580, 0x55580];

describe('TextureViewer model guards (#7 crash regression)', () => {
	it('isParsedTextures accepts a TEXS model and rejects a streamtex / partial shape', () => {
		const texs = makeTexs(2);
		expect(isParsedTextures(texs)).toBe(true);
		// The exact shape a .gputex member produces (streamtex handler):
		expect(isParsedTextures(parseStreamtex(new Uint8Array(0x55580)))).toBe(false);
		expect(isParsedTextures(null)).toBe(false);
		expect(isParsedTextures({ textureCount: 3 })).toBe(false); // no descriptors[]
		expect(isParsedTextures({ descriptors: [] })).toBe(false); // no textureCount
	});

	it('asStreamtexPayloadLen returns the byte length only for a headerless payload', () => {
		const st = parseStreamtex(new Uint8Array(0x55580));
		expect(asStreamtexPayloadLen(st)).toBe(0x55580);
		expect(asStreamtexPayloadLen(makeTexs(1))).toBeNull();
		expect(asStreamtexPayloadLen(null)).toBeNull();
		expect(asStreamtexPayloadLen({ headerless: false, byteLength: 10 })).toBeNull();
	});

	it('classifies the .gputex / streamtex model as the streamtex branch (was the crash)', () => {
		const st = parseStreamtex(new Uint8Array(0x55580));
		expect(classifyTextureModel(st)).toBe('streamtex');
	});

	it('classifies a descriptor-less / partial model as not-texs (never dereferences descriptors)', () => {
		expect(classifyTextureModel({ textureCount: 3 })).toBe('not-texs');
		expect(classifyTextureModel({ foo: 'bar' })).toBe('not-texs');
	});

	it('classifies null / undefined as no-model', () => {
		expect(classifyTextureModel(null)).toBe('no-model');
		expect(classifyTextureModel(undefined)).toBe('no-model');
	});

	it('classifies an empty vs populated TEXS model', () => {
		expect(classifyTextureModel(makeTexs(0))).toBe('empty');
		expect(classifyTextureModel(makeTexs(3))).toBe('texs');
	});

	it('never throws for ANY of the shapes the dispatcher can feed the viewport', () => {
		const shapes: unknown[] = [
			null,
			undefined,
			parseStreamtex(new Uint8Array(0)),
			parseStreamtex(new Uint8Array(TEX_SIZES_FOR_TEST[0])),
			{ textureCount: 5 },
			{ descriptors: [] },
			{},
			makeTexs(0),
			makeTexs(2),
			parseTextures(buildMinimalTexs()),
		];
		for (const s of shapes) {
			expect(() => classifyTextureModel(s)).not.toThrow();
		}
	});
});

// ---- fixtures ---------------------------------------------------------------

function makeTexs(n: number): ParsedTextures {
	return {
		magic: 'TEXS',
		version: 12,
		flags: 1,
		payloadTableOff: 0,
		textureCount: n,
		firstDescOff: 0x18,
		subHeader: new Uint8Array(20),
		descriptors: Array.from({ length: n }, (_, i) => ({
			descOff: 0x2c + i * 0x24,
			crc: 0xdeadbe00 + i,
			marker: 0xffff,
			gcmFormat: 0x88,
			format: 'DXT5' as const,
			mipCount: 1,
			dimension: 0x0200,
			gcmRemap: 0xaae4,
			width: 64,
			height: 64,
			depth: 1,
			sizeUnits: 0,
			payloadSize: 0,
		})),
		c2nmOff: -1,
		isStub: false,
		byteLength: 0x2c + n * 0x24,
	};
}

/** A 0-texture TEXS header (TEXS magic + version 12 + flags 1 + zeros) so the
 *  real parser is exercised without needing a fixture file. */
function buildMinimalTexs(): Uint8Array {
	const b = new Uint8Array(0x2c);
	b.set([0x54, 0x45, 0x58, 0x53], 0); // "TEXS"
	const dv = new DataView(b.buffer);
	dv.setUint32(0x04, 12, false); // version
	dv.setUint32(0x08, 1, false); // flags
	dv.setUint32(0x0c, 0x2c, false); // payloadTableOff
	dv.setUint32(0x10, 0, false); // textureCount = 0
	dv.setUint32(0x14, 0x18, false); // firstDescOff
	return b;
}
