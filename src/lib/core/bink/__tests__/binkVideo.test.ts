import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { BinkVideo } from '../binkVideo';
import { hasSample, readSample } from '@/test/dataRoot';

// FE_Options is a small (256x256), audio-free BIKi — fast to decode in a test.
const CLIP = 'Movies/FE_Options.bik';
const CLIP_720 = 'Movies/SS_Ident.bik';

function ffmpegAvailable(): boolean {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

describe('BinkVideo decoder', () => {
	it.skipIf(!hasSample(CLIP))('decodes real frames to sane RGBA', () => {
		const dec = new BinkVideo(readSample(CLIP));
		expect(dec.fourCC).toBe('BIKi');
		expect(dec.width).toBeGreaterThan(0);
		expect(dec.height).toBeGreaterThan(0);

		for (let f = 0; f < 4 && f < dec.frameCount; f++) dec.decodeFrame(f);

		expect(dec.rgba.length).toBe(dec.width * dec.height * 4);
		// A real movie frame is not a single flat colour.
		const first = dec.rgba[0];
		let varied = false;
		for (let i = 0; i < dec.rgba.length; i += 4) {
			if (dec.rgba[i] !== first) {
				varied = true;
				break;
			}
		}
		expect(varied).toBe(true);
		// Alpha is always opaque.
		expect(dec.rgba[3]).toBe(255);
	});

	it.skipIf(!hasSample(CLIP))('re-decodes from the start on a backward seek', () => {
		const dec = new BinkVideo(readSample(CLIP));
		for (let f = 0; f < 5 && f < dec.frameCount; f++) dec.decodeFrame(f);
		const snapshot = dec.rgba.slice();
		// Jump forward then back to frame 4 — must reproduce the same pixels.
		dec.decodeFrame(Math.min(8, dec.frameCount - 1));
		dec.decodeFrame(4);
		expect(Array.from(dec.rgba)).toEqual(Array.from(snapshot));
	});

	// Byte-exact regression against the FFmpeg reference Bink decoder. Guarded so
	// it only runs where both the devkit samples and ffmpeg are present.
	const canRef = hasSample(CLIP) && ffmpegAvailable();
	it.skipIf(!canRef)('matches ffmpeg YUV byte-for-byte (256x256)', () => {
		assertMatchesFfmpeg(CLIP, 6);
	});

	const canRef720 = hasSample(CLIP_720) && ffmpegAvailable();
	it.skipIf(!canRef720)('matches ffmpeg YUV byte-for-byte (1280x720)', () => {
		assertMatchesFfmpeg(CLIP_720, 4);
	});
});

function assertMatchesFfmpeg(clipRel: string, frames: number): void {
	const raw = readSample(clipRel);
	const dec = new BinkVideo(raw);
	const W = dec.width;
	const H = dec.height;
	const cw = W >> 1;
	const ch = H >> 1;
	const N = Math.min(frames, dec.frameCount);

	// Reference YUV420p frames from ffmpeg (read the file from the devkit path).
	const abs = sampleAbsPath(clipRel);
	const ref = execFileSync(
		'ffmpeg',
		['-v', 'error', '-i', abs, '-frames:v', String(N), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
		{ maxBuffer: 1 << 30 },
	);
	const frameBytes = W * H + 2 * cw * ch;

	for (let f = 0; f < N; f++) {
		dec.decodeFrame(f);
		const p = dec.planes();
		const base = f * frameBytes;
		comparePlane(p.y, W, ref, base, W, H, `frame ${f} Y`);
		comparePlane(p.u, cw, ref, base + W * H, cw, ch, `frame ${f} U`);
		comparePlane(p.v, cw, ref, base + W * H + cw * ch, cw, ch, `frame ${f} V`);
	}
}

function comparePlane(
	mine: Uint8Array,
	pitch: number,
	ref: Buffer | Uint8Array,
	refOff: number,
	pw: number,
	ph: number,
	label: string,
): void {
	for (let r = 0; r < ph; r++) {
		for (let c = 0; c < pw; c++) {
			if (mine[r * pitch + c] !== ref[refOff + r * pw + c]) {
				throw new Error(`${label} mismatch at (${c},${r})`);
			}
		}
	}
}

// Resolve a sample's absolute path the same way readSample does, for ffmpeg.
function sampleAbsPath(rel: string): string {
	// readSample joins DATA_ROOT + rel; re-derive via the env / default.
	const root =
		process.env.SS_DATA_ROOT ??
		'D:\\Program Files (x86)\\rpcs3\\dev_hdd0\\game\\NPXX00575\\USRDIR\\Deferred';
	return root + '\\' + rel.replace(/\//g, '\\');
}
