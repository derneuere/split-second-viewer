// Validate the pure-TS Bink video decoder against ffmpeg's reference decode.
//
//   fnm exec --using=22 -- npx --no-install tsx scripts/bink-validate.ts <clip.bik> [numFrames]
//
// Decodes the first N frames with src/lib/core/bink and compares the YUV planes
// byte-for-byte with `ffmpeg -f rawvideo -pix_fmt yuv420p`. Both implement the
// same integer decode, so a correct port matches EXACTLY (0 mismatches).

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BinkVideo } from '../src/lib/core/bink/binkVideo';

const clip = process.argv[2];
const numFrames = parseInt(process.argv[3] ?? '3', 10);
if (!clip) {
	console.error('usage: bink-validate.ts <clip.bik> [numFrames]');
	process.exit(2);
}

const buf = fs.readFileSync(clip);
const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const dec = new BinkVideo(raw);
const W = dec.width;
const H = dec.height;
const cw = W >> 1;
const ch = H >> 1;
const N = Math.min(numFrames, dec.frameCount);
console.log(
	`clip ${clip}\n  ${dec.fourCC} ${W}x${H}  ${dec.frameCount} frames  ${dec.fpsNum}/${dec.fpsDen} fps  comparing ${N}`,
);

// Reference: ffmpeg raw yuv420p for the first N frames (binary on stdout).
const ref = execFileSync(
	'ffmpeg',
	['-v', 'error', '-i', clip, '-frames:v', String(N), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
	{ maxBuffer: 1 << 30 },
);
const frameBytes = W * H + 2 * cw * ch;

function diffPlane(name: string, mine: Uint8Array, minePitch: number, ref8: Uint8Array, refOff: number, pw: number, phh: number) {
	let mism = 0;
	let maxd = 0;
	let firstAt = -1;
	for (let r = 0; r < phh; r++) {
		for (let c = 0; c < pw; c++) {
			const a = mine[r * minePitch + c];
			const b = ref8[refOff + r * pw + c];
			if (a !== b) {
				mism++;
				const d = Math.abs(a - b);
				if (d > maxd) maxd = d;
				if (firstAt < 0) firstAt = r * pw + c;
			}
		}
	}
	return { name, total: pw * phh, mism, maxd, firstAt };
}

let allOk = true;
for (let f = 0; f < N; f++) {
	dec.decodeFrame(f);
	const p = dec.planes();
	const base = f * frameBytes;
	const ry = base;
	const ru = base + W * H;
	const rv = base + W * H + cw * ch;

	const dy = diffPlane('Y', p.y, W, ref, ry, W, H);
	const du = diffPlane('U', p.u, cw, ref, ru, cw, ch);
	const dv = diffPlane('V', p.v, cw, ref, rv, cw, ch);

	const ok = dy.mism === 0 && du.mism === 0 && dv.mism === 0;
	allOk &&= ok;
	const fmt = (d: ReturnType<typeof diffPlane>) =>
		d.mism === 0 ? `${d.name} ok` : `${d.name} ${d.mism}/${d.total} mism (max ${d.maxd}, first@${d.firstAt})`;
	console.log(`  frame ${f}: ${ok ? 'MATCH' : 'DIFF '}  ${fmt(dy)}  ${fmt(du)}  ${fmt(dv)}`);
}

console.log(allOk ? '\nALL FRAMES MATCH ffmpeg ✓' : '\nMISMATCH ✗');
process.exit(allOk ? 0 : 1);
