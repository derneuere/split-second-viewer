// Validate the pure-TS Bink AUDIO decoder against ffmpeg's PCM.
//   fnm exec --using=22 -- node --import tsx scripts/bink-audio-validate.ts <clip.bik>
//
// Decodes the first audio track to interleaved s16 and compares with
// `ffmpeg -map 0:a:0 -f s16le` (native rate/channels, no resample). Audio is
// float-FFT based, so we report exact-match %, max |diff|, and RMS rather than
// assuming bit-equality.

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BinkAudio } from '../src/lib/core/bink/binkAudio';

const clip = process.argv[2];
if (!clip) {
	console.error('usage: bink-audio-validate.ts <clip.bik>');
	process.exit(2);
}

const buf = fs.readFileSync(clip);
const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const ba = new BinkAudio(raw, 0);
if (!ba.hasAudio) {
	console.log('clip has no audio tracks');
	process.exit(0);
}
const t0 = performance.now();
const { pcm, sampleRate, channels } = ba.decodeAll();
const decodeMs = performance.now() - t0;

function stats(a: Int16Array) {
	let min = 32767,
		max = -32768,
		sum2 = 0;
	for (let i = 0; i < a.length; i++) {
		const v = a[i];
		if (v < min) min = v;
		if (v > max) max = v;
		sum2 += v * v;
	}
	return { min, max, rms: Math.sqrt(sum2 / Math.max(1, a.length)) };
}

const mine = stats(pcm);
console.log(`clip ${clip}`);
console.log(
	`  mine: ${sampleRate} Hz, ${channels} ch, ${pcm.length} samples (${(pcm.length / channels / sampleRate).toFixed(2)}s), ` +
		`rms ${mine.rms.toFixed(1)} min ${mine.min} max ${mine.max}, decoded in ${decodeMs.toFixed(0)}ms`,
);

const ref = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-map', '0:a:0', '-f', 's16le', 'pipe:1'], {
	maxBuffer: 1 << 30,
});
const refI16 = new Int16Array(ref.buffer, ref.byteOffset, ref.length >> 1);
const refStats = stats(refI16);
console.log(`  ffmpeg: ${refI16.length} samples, rms ${refStats.rms.toFixed(1)} min ${refStats.min} max ${refStats.max}`);

// Compare over the overlapping region, searching a small sample offset to absorb
// any decoder priming/alignment difference.
function compare(offMine: number, offRef: number) {
	const n = Math.min(pcm.length - offMine, refI16.length - offRef);
	if (n <= 0) return { n: 0, exact: 0, maxDiff: Infinity, rms: Infinity };
	let exact = 0,
		maxDiff = 0,
		sum2 = 0;
	for (let i = 0; i < n; i++) {
		const d = pcm[offMine + i] - refI16[offRef + i];
		if (d === 0) exact++;
		const ad = Math.abs(d);
		if (ad > maxDiff) maxDiff = ad;
		sum2 += d * d;
	}
	return { n, exact, maxDiff, rms: Math.sqrt(sum2 / n) };
}

let best = compare(0, 0);
let bestOff = 0;
for (let off = -8 * channels; off <= 8 * channels; off++) {
	const r = off >= 0 ? compare(off, 0) : compare(0, -off);
	if (r.rms < best.rms) {
		best = r;
		bestOff = off;
	}
}

console.log(
	`  diff @offset ${bestOff}: ${((best.exact / best.n) * 100).toFixed(3)}% exact, ` +
		`maxDiff ${best.maxDiff}, rms ${best.rms.toFixed(3)} over ${best.n} samples`,
);
