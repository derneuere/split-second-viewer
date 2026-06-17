import { describe, expect, it } from 'vitest';
import { FFT } from '../dsp';

// The FFT is the foundation of the Bink audio RDFT/DCT. Pin it against a naive
// O(n^2) DFT (FFmpeg's forward convention is sign -1, no normalisation, input
// pre-permuted). Errors are float32-level since the transform buffer is Float32.

function naiveDFT(re: Float64Array, im: Float64Array, sign: number): [Float64Array, Float64Array] {
	const n = re.length;
	const or = new Float64Array(n);
	const oi = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		let sr = 0;
		let si = 0;
		for (let j = 0; j < n; j++) {
			const a = (sign * 2 * Math.PI * k * j) / n;
			const c = Math.cos(a);
			const s = Math.sin(a);
			sr += re[j] * c - im[j] * s;
			si += re[j] * s + im[j] * c;
		}
		or[k] = sr;
		oi[k] = si;
	}
	return [or, oi];
}

describe('FFT', () => {
	for (const bits of [2, 3, 4, 5, 6, 8, 10]) {
		it(`matches a naive DFT at n=${1 << bits}`, () => {
			const n = 1 << bits;
			const re = new Float64Array(n);
			const im = new Float64Array(n);
			let seed = 1234567 + bits;
			const rnd = () => {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				return (seed / 0x7fffffff) * 2 - 1;
			};
			for (let i = 0; i < n; i++) {
				re[i] = rnd();
				im[i] = rnd();
			}
			const z = new Float32Array(2 * n);
			for (let i = 0; i < n; i++) {
				z[2 * i] = re[i];
				z[2 * i + 1] = im[i];
			}
			const fft = new FFT(bits, false);
			fft.permute(z);
			fft.calc(z);
			const [or, oi] = naiveDFT(re, im, -1);
			let maxErr = 0;
			for (let k = 0; k < n; k++) {
				maxErr = Math.max(maxErr, Math.abs(z[2 * k] - or[k]), Math.abs(z[2 * k + 1] - oi[k]));
			}
			// float32 accumulation tolerance, scaled by n.
			expect(maxErr).toBeLessThan(1e-3 * n);
		});
	}
});
