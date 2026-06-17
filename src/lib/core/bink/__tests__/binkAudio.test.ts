import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { BinkAudio } from '../binkAudio';
import { hasSample, readSample, DATA_ROOT } from '@/test/dataRoot';

const CLIP = 'Movies/Intro.bik'; // BIKi 1280x720, 2 stereo DCT audio tracks @ 48000

function ffmpegAvailable(): boolean {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

describe('BinkAudio decoder', () => {
	it.skipIf(!hasSample(CLIP))('decodes real audio to non-silent stereo PCM', () => {
		const ba = new BinkAudio(readSample(CLIP), 0);
		expect(ba.hasAudio).toBe(true);
		const { pcm, sampleRate, channels } = ba.decodeAll();
		expect(sampleRate).toBe(48000);
		expect(channels).toBe(2);
		expect(pcm.length).toBeGreaterThan(48000); // > 0.5s of stereo
		let sum2 = 0;
		for (let i = 0; i < pcm.length; i++) sum2 += pcm[i] * pcm[i];
		expect(Math.sqrt(sum2 / pcm.length)).toBeGreaterThan(100); // clearly audible
	});

	// Sample-accuracy regression against FFmpeg's reference binkaudio decoder.
	// Audio is float-FFT based, so it is NOT bit-identical (FFmpeg uses a SIMD
	// float FFT), but every sample must be within 1 LSB and the vast majority
	// bit-exact.
	const canRef = hasSample(CLIP) && ffmpegAvailable();
	it.skipIf(!canRef)('matches ffmpeg PCM to within 1 LSB (>=99% bit-exact)', () => {
		const { pcm } = new BinkAudio(readSample(CLIP), 0).decodeAll();
		const abs = DATA_ROOT + '\\' + CLIP.replace(/\//g, '\\');
		const ref = execFileSync(
			'ffmpeg',
			['-v', 'error', '-i', abs, '-map', '0:a:0', '-f', 's16le', 'pipe:1'],
			{ maxBuffer: 1 << 30 },
		);
		const refI16 = new Int16Array(ref.buffer, ref.byteOffset, ref.length >> 1);
		const n = Math.min(pcm.length, refI16.length);
		expect(n).toBeGreaterThan(48000);

		let exact = 0;
		let maxDiff = 0;
		for (let i = 0; i < n; i++) {
			const d = Math.abs(pcm[i] - refI16[i]);
			if (d === 0) exact++;
			if (d > maxDiff) maxDiff = d;
		}
		expect(maxDiff).toBeLessThanOrEqual(1);
		expect(exact / n).toBeGreaterThan(0.99);
	});
});
