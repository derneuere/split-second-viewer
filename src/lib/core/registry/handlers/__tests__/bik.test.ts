import { describe, expect, it } from 'vitest';
import { bikHandler } from '../bik';
import { parseBik } from '../../../bik';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Build a minimal BIKi header (the fixed 44-byte block + optional audio table).
function buildHeader(opts: {
	version?: string;
	width: number;
	height: number;
	numFrames: number;
	fpsNum: number;
	fpsDen: number;
	videoFlags?: number;
	audio?: { sampleRate: number; flags: number; trackId: number }[];
}): Uint8Array {
	const audio = opts.audio ?? [];
	const buf = new Uint8Array(0x2c + audio.length * 12);
	const dv = new DataView(buf.buffer);
	const sig = opts.version ?? 'i';
	buf[0] = 0x42; // B
	buf[1] = 0x49; // I
	buf[2] = 0x4b; // K
	buf[3] = sig.charCodeAt(0);
	dv.setUint32(0x04, 0, true); // file size
	dv.setUint32(0x08, opts.numFrames, true);
	dv.setUint32(0x0c, 0, true); // largest frame
	dv.setUint32(0x10, opts.numFrames, true);
	dv.setUint32(0x14, opts.width, true);
	dv.setUint32(0x18, opts.height, true);
	dv.setUint32(0x1c, opts.fpsNum, true);
	dv.setUint32(0x20, opts.fpsDen, true);
	dv.setUint32(0x24, opts.videoFlags ?? 0, true);
	dv.setUint32(0x28, audio.length, true);
	let p = 0x2c;
	for (const _ of audio) {
		dv.setUint32(p, 0x1000, true);
		p += 4;
	} // max packet
	for (const a of audio) {
		dv.setUint32(p, (a.sampleRate & 0xffff) | (a.flags << 16), true);
		p += 4;
	}
	for (const a of audio) {
		dv.setUint32(p, a.trackId, true);
		p += 4;
	}
	return buf;
}

describe('bik header parser', () => {
	it('parses a silent BIKi header (inline)', () => {
		const raw = buildHeader({ width: 1280, height: 720, numFrames: 733, fpsNum: 30, fpsDen: 1 });
		const m = parseBik(raw);
		expect(m.fourCC).toBe('BIKi');
		expect(m.version).toBe('i');
		expect(m.width).toBe(1280);
		expect(m.height).toBe(720);
		expect(m.numFrames).toBe(733);
		expect(m.fps).toBeCloseTo(30);
		expect(m.durationSeconds).toBeCloseTo(733 / 30, 3);
		expect(m.numAudioTracks).toBe(0);
		expect(m.headerSize).toBe(0x2c);
		expect(m.hasAlpha).toBe(false);
	});

	it('decodes the per-track audio descriptor (stereo DCT @ 48000)', () => {
		const raw = buildHeader({
			width: 640,
			height: 360,
			numFrames: 100,
			fpsNum: 2997,
			fpsDen: 100,
			// flags 0x7000 = 16-bit (0x4000) | stereo (0x2000) | DCT (0x1000)
			audio: [{ sampleRate: 48000, flags: 0x7000, trackId: 0 }],
		});
		const m = parseBik(raw);
		expect(m.fps).toBeCloseTo(29.97, 2);
		expect(m.numAudioTracks).toBe(1);
		const a = m.audioTracks[0];
		expect(a.sampleRate).toBe(48000);
		expect(a.channels).toBe(2);
		expect(a.bitsPerSample).toBe(16);
		expect(a.algorithm).toBe('DCT');
		expect(m.headerSize).toBe(0x2c + 12);
	});

	it('rejects a non-Bink blob', () => {
		expect(() => parseBik(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0]))).toThrow(/not a Bink/);
	});

	it('flags Bink 2 (KB2*) as unsupported but still parses dimensions', () => {
		const raw = buildHeader({ width: 100, height: 100, numFrames: 1, fpsNum: 30, fpsDen: 1 });
		raw[0] = 0x4b; // K
		raw[1] = 0x42; // B
		raw[2] = 0x32; // 2
		raw[3] = 0x61; // a
		const m = parseBik(raw);
		expect(m.isBink2).toBe(true);
		expect(m.fourCC).toBe('KB2a');
	});

	it('handler describe() summarises the clip', () => {
		const raw = buildHeader({
			width: 1280,
			height: 720,
			numFrames: 733,
			fpsNum: 30,
			fpsDen: 1,
			audio: [{ sampleRate: 48000, flags: 0x7000, trackId: 0 }],
		});
		const m = bikHandler.parseRaw(raw, ssCtx());
		const text = bikHandler.describe(m);
		expect(text).toContain('BIKi 1280x720');
		expect(text).toContain('30 fps');
		expect(text).toContain('1 audio track');
	});

	const REAL = 'Movies/Intro.bik';
	it.skipIf(!hasSample(REAL))('parses a REAL Intro.bik from the devkit', () => {
		const raw = readSample(REAL);
		const m = bikHandler.parseRaw(raw, ssCtx());
		expect(m.fourCC).toBe('BIKi');
		expect(m.width).toBe(1280);
		expect(m.height).toBe(720);
		expect(m.fps).toBeCloseTo(30);
		expect(m.numFrames).toBe(733);
		expect(m.numAudioTracks).toBe(2);
		for (const a of m.audioTracks) {
			expect(a.sampleRate).toBe(48000);
			expect(a.channels).toBe(2);
			expect(a.algorithm).toBe('DCT');
		}
	});
});
