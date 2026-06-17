import { describe, expect, it } from 'vitest';
import { streamtexHandler } from '../streamtex';
import { parseStreamtex, decodeStreamtexWithStub } from '../../../streamtex';
import { parseTextures } from '../../../textures';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a .streamtex is headerless, so any bytes "parse". We assert it
// records the length and keeps the payload reference.
const INLINE = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55]);

describe('streamtex parser (inline)', () => {
	it('records the payload length and bytes', () => {
		const m = parseStreamtex(INLINE);
		expect(m.headerless).toBe(true);
		expect(m.byteLength).toBe(INLINE.length);
		expect(m.payload).toBe(INLINE);
	});

	it('describe() reports the payload size', () => {
		const m = streamtexHandler.parseRaw(INLINE, ssCtx());
		expect(streamtexHandler.describe(m)).toContain('payload');
		expect(streamtexHandler.describe(m)).toContain('8 B');
	});

	it('handler caps are read-only', () => {
		expect(streamtexHandler.caps.read).toBe(true);
		expect(streamtexHandler.caps.write).toBe(false);
		expect(streamtexHandler.extensions).toContain('.streamtex');
	});
});

// ---------------------------------------------------------------------------
// Real-file fixtures: pair the stub + its stream and decode.
// ---------------------------------------------------------------------------
const STREAM = 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.streamtex';
const STUB = 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.textures';

describe('streamtex parser (REAL devkit samples)', () => {
	it.skipIf(!hasSample(STREAM))('parses the raw streamed payload', () => {
		const raw = readSample(STREAM);
		const m = streamtexHandler.parseRaw(raw, ssCtx());
		// The wiki cites Musclecar_01.streamtex == 3,277,312 bytes.
		expect(m.byteLength).toBe(raw.byteLength);
		expect(m.byteLength).toBeGreaterThan(3_000_000);
	});

	it.skipIf(!hasSample(STREAM) || !hasSample(STUB))(
		'decodes the full-res textures using the sibling .textures stub',
		() => {
			const stub = parseTextures(readSample(STUB));
			const payload = readSample(STREAM);
			const decoded = decodeStreamtexWithStub(payload, stub);
			// The stub lists 7 unique textures (full-res half of the 14 descriptors).
			expect(decoded.length).toBe(7);
			// The largest full-res texture is Musclecar_01 at 1024x2048.
			const big = decoded.find((t) => t.width === 1024 && t.height === 2048);
			expect(big).toBeDefined();
			expect(big!.format).toBe('DXT1');
			expect(big!.rgba).not.toBeNull();
			expect(big!.rgba!.length).toBe(1024 * 2048 * 4);
			// First texture starts at offset 0 of the stream.
			expect(decoded[0].pixelStart).toBe(0);
		},
	);
});
