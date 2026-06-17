// FFT / RDFT / DCT — the float DSP the Bink audio decoder needs, ported from the
// FFmpeg-derived xoreos code (src/common/fft.cpp, rdft.cpp, dct.cpp; GPL/LGPL
// upstream — Bellard/Merritt/Converse/Ross/Sessak). Bink audio is float-based,
// so this mirrors FFmpeg's split-radix FFT and the RDFT/DCT built on top.
//
// Buffers and twiddle tables are Float32Array to track FFmpeg's `float`
// (FFTSample) storage as closely as a portable port can; scalar temporaries are
// JS doubles. The cosine/sine tables are GENERATED at runtime with the exact
// FFmpeg layout (verified against xoreos' hardcoded tables) rather than shipping
// the 777 KB blob.

const M_SQRT1_2 = Math.SQRT1_2; // 1/sqrt(2)
const SQRTHALF = Math.fround(M_SQRT1_2);

// --- Twiddle tables ---------------------------------------------------------
const cosTabs: Float32Array[] = [];
const sinTabs: Float32Array[] = [];

/** ff_cos_tabs[bits]: size 2^(bits-1), tab[i] = cos(2*pi*i/2^bits) with the
 *  m/2 mirror. */
function getCosineTable(bits: number): Float32Array {
	let t = cosTabs[bits];
	if (t) return t;
	const m = 1 << bits;
	const size = m >> 1;
	t = new Float32Array(size);
	const freq = (2 * Math.PI) / m;
	for (let i = 0; i <= m / 4; i++) t[i] = Math.cos(i * freq);
	for (let i = 1; i < m / 4; i++) t[m / 2 - i] = t[i];
	cosTabs[bits] = t;
	return t;
}

/** ff_sin_tabs[bits]: size 2^(bits-1); first quarter sin(2*pi*i/2^bits) rising,
 *  second quarter the negated mirror (tab[m/4+k] = -tab[k]). */
function getSineTable(bits: number): Float32Array {
	let t = sinTabs[bits];
	if (t) return t;
	const m = 1 << bits;
	const size = m >> 1;
	const q = m >> 2;
	t = new Float32Array(size);
	const freq = (2 * Math.PI) / m;
	for (let i = 0; i < q; i++) t[i] = Math.sin(i * freq);
	for (let k = 0; k < q; k++) t[q + k] = -t[k];
	sinTabs[bits] = t;
	return t;
}

// --- FFT --------------------------------------------------------------------

function splitRadixPermutation(i: number, n: number, inverse: boolean): number {
	if (n <= 2) return i & 1;
	const m = n >> 1;
	if (!(i & m)) return splitRadixPermutation(i, m, inverse) * 2;
	const m2 = m >> 1;
	if (inverse === !(i & m2)) return splitRadixPermutation(i, m2, inverse) * 4 + 1;
	return splitRadixPermutation(i, m2, inverse) * 4 - 1;
}

/** Complex FFT over an interleaved [re0,im0,re1,im1,…] Float32Array. Input must
 *  be permute()d first; no 1/sqrt(n) normalisation (matches FFmpeg's FFTContext). */
export class FFT {
	readonly bits: number;
	private readonly revTab: Uint16Array;
	private readonly tmp: Float32Array;

	constructor(bits: number, inverse: boolean) {
		this.bits = bits;
		const n = 1 << bits;
		this.revTab = new Uint16Array(n);
		this.tmp = new Float32Array(2 * n);
		for (let i = 0; i < n; i++) {
			this.revTab[-splitRadixPermutation(i, n, inverse) & (n - 1)] = i;
		}
	}

	permute(z: Float32Array): void {
		const n = 1 << this.bits;
		const tmp = this.tmp;
		const rev = this.revTab;
		for (let j = 0; j < n; j++) {
			const k = rev[j];
			tmp[2 * k] = z[2 * j];
			tmp[2 * k + 1] = z[2 * j + 1];
		}
		z.set(tmp);
	}

	calc(z: Float32Array): void {
		fftRec(z, 0, this.bits);
	}
}

// One radix-4 butterfly cluster (FFmpeg BUTTERFLIES / TRANSFORM macros). a0..a3
// are complex indices into z; wre/wim are the twiddle factors.
function transform(
	z: Float32Array,
	a0: number,
	a1: number,
	a2: number,
	a3: number,
	wre: number,
	wim: number,
): void {
	const a2re = z[a2 * 2];
	const a2im = z[a2 * 2 + 1];
	const a3re = z[a3 * 2];
	const a3im = z[a3 * 2 + 1];
	const t1 = a2re * wre + a2im * wim;
	const t2 = a2im * wre - a2re * wim;
	const t5 = a3re * wre - a3im * wim;
	const t6 = a3im * wre + a3re * wim;
	butterflies(z, a0, a1, a2, a3, t1, t2, t5, t6);
}

function transformZero(z: Float32Array, a0: number, a1: number, a2: number, a3: number): void {
	butterflies(z, a0, a1, a2, a3, z[a2 * 2], z[a2 * 2 + 1], z[a3 * 2], z[a3 * 2 + 1]);
}

function butterflies(
	z: Float32Array,
	a0: number,
	a1: number,
	a2: number,
	a3: number,
	t1: number,
	t2: number,
	t5In: number,
	t6In: number,
): void {
	const a0re = z[a0 * 2];
	const a0im = z[a0 * 2 + 1];
	const a1re = z[a1 * 2];
	const a1im = z[a1 * 2 + 1];
	// BF(t3,t5, t5,t1)
	const t3 = t5In - t1;
	const t5 = t5In + t1;
	// BF(a2.re,a0.re, a0.re,t5)
	z[a2 * 2] = a0re - t5;
	z[a0 * 2] = a0re + t5;
	// BF(a3.im,a1.im, a1.im,t3)
	z[a3 * 2 + 1] = a1im - t3;
	z[a1 * 2 + 1] = a1im + t3;
	// BF(t4,t6, t2,t6)
	const t4 = t2 - t6In;
	const t6 = t2 + t6In;
	// BF(a3.re,a1.re, a1.re,t4)
	z[a3 * 2] = a1re - t4;
	z[a1 * 2] = a1re + t4;
	// BF(a2.im,a0.im, a0.im,t6)
	z[a2 * 2 + 1] = a0im - t6;
	z[a0 * 2 + 1] = a0im + t6;
}

function fft4(z: Float32Array, o: number): void {
	const r = (i: number) => (o + i) * 2;
	const im = (i: number) => (o + i) * 2 + 1;
	// BF(t3,t1, z0.re, z1.re)
	const t3 = z[r(0)] - z[r(1)];
	const t1 = z[r(0)] + z[r(1)];
	// BF(t8,t6, z3.re, z2.re)
	const t8 = z[r(3)] - z[r(2)];
	const t6 = z[r(3)] + z[r(2)];
	// BF(z2.re, z0.re, t1, t6)
	z[r(2)] = t1 - t6;
	z[r(0)] = t1 + t6;
	// BF(t4,t2, z0.im, z1.im)
	const t4 = z[im(0)] - z[im(1)];
	const t2 = z[im(0)] + z[im(1)];
	// BF(t7,t5, z2.im, z3.im)
	const t7 = z[im(2)] - z[im(3)];
	const t5 = z[im(2)] + z[im(3)];
	// BF(z3.im, z1.im, t4, t8)
	z[im(3)] = t4 - t8;
	z[im(1)] = t4 + t8;
	// BF(z3.re, z1.re, t3, t7)
	z[r(3)] = t3 - t7;
	z[r(1)] = t3 + t7;
	// BF(z2.im, z0.im, t2, t5)
	z[im(2)] = t2 - t5;
	z[im(0)] = t2 + t5;
}

function fft8(z: Float32Array, o: number): void {
	const r = (i: number) => (o + i) * 2;
	const im = (i: number) => (o + i) * 2 + 1;
	fft4(z, o);
	// BF(t1, z5.re, z4.re, -z5.re)
	let t1 = z[r(4)] - -z[r(5)];
	z[r(5)] = z[r(4)] + -z[r(5)];
	// BF(t2, z5.im, z4.im, -z5.im)
	let t2 = z[im(4)] - -z[im(5)];
	z[im(5)] = z[im(4)] + -z[im(5)];
	// BF(t3, z7.re, z6.re, -z7.re)
	const t3 = z[r(6)] - -z[r(7)];
	z[r(7)] = z[r(6)] + -z[r(7)];
	// BF(t4, z7.im, z6.im, -z7.im)
	const t4 = z[im(6)] - -z[im(7)];
	z[im(7)] = z[im(6)] + -z[im(7)];
	// BF(t8, t1, t3, t1)
	const t8 = t3 - t1;
	t1 = t3 + t1;
	// BF(t7, t2, t2, t4)
	const t7 = t2 - t4;
	t2 = t2 + t4;
	// BF(z4.re, z0.re, z0.re, t1)
	z[r(4)] = z[r(0)] - t1;
	z[r(0)] = z[r(0)] + t1;
	// BF(z4.im, z0.im, z0.im, t2)
	z[im(4)] = z[im(0)] - t2;
	z[im(0)] = z[im(0)] + t2;
	// BF(z6.re, z2.re, z2.re, t7)
	z[r(6)] = z[r(2)] - t7;
	z[r(2)] = z[r(2)] + t7;
	// BF(z6.im, z2.im, z2.im, t8)
	z[im(6)] = z[im(2)] - t8;
	z[im(2)] = z[im(2)] + t8;
	// TRANSFORM(z1,z3,z5,z7, sqrthalf, sqrthalf)
	transform(z, o + 1, o + 3, o + 5, o + 7, SQRTHALF, SQRTHALF);
}

function fft16(z: Float32Array, o: number): void {
	fft8(z, o);
	fft4(z, o + 8);
	fft4(z, o + 12);
	const cosTable = getCosineTable(4);
	transformZero(z, o + 0, o + 4, o + 8, o + 12);
	transform(z, o + 2, o + 6, o + 10, o + 14, SQRTHALF, SQRTHALF);
	transform(z, o + 1, o + 5, o + 9, o + 13, cosTable[1], cosTable[3]);
	transform(z, o + 3, o + 7, o + 11, o + 15, cosTable[3], cosTable[1]);
}

// PASS macro: walks the cosine table forward (wre) and backward (wim).
function pass(z: Float32Array, zb: number, w: Float32Array, n: number): void {
	const o1 = 2 * n;
	const o2 = 4 * n;
	const o3 = 6 * n;
	let zi = zb;
	let wre = 0;
	let wim = o1;
	transformZero(z, zi, zi + o1, zi + o2, zi + o3);
	transform(z, zi + 1, zi + o1 + 1, zi + o2 + 1, zi + o3 + 1, w[wre + 1], w[wim - 1]);
	let k = n - 1;
	while (k > 0) {
		zi += 2;
		wre += 2;
		wim -= 2;
		transform(z, zi, zi + o1, zi + o2, zi + o3, w[wre], w[wim]);
		transform(z, zi + 1, zi + o1 + 1, zi + o2 + 1, zi + o3 + 1, w[wre + 1], w[wim - 1]);
		k--;
	}
}

function fftRec(z: Float32Array, zb: number, bits: number): void {
	if (bits === 2) return fft4(z, zb);
	if (bits === 3) return fft8(z, zb);
	if (bits === 4) return fft16(z, zb);
	const n = 1 << bits;
	const n4 = n >> 2;
	fftRec(z, zb, bits - 1);
	fftRec(z, zb + n4 * 2, bits - 2);
	fftRec(z, zb + n4 * 3, bits - 2);
	// pass and pass_big are numerically identical (inputs cached up front), so one
	// implementation serves every size.
	pass(z, zb, getCosineTable(bits), n4 / 2);
}

// --- RDFT -------------------------------------------------------------------

export const RDFTType = {
	DFT_R2C: 0,
	IDFT_C2R: 1,
	IDFT_R2C: 2,
	DFT_C2R: 3,
} as const;

export class RDFT {
	private readonly bits: number;
	private readonly inverse: boolean;
	private readonly signConvention: number;
	private readonly fft: FFT;
	private readonly tSin: Float32Array;
	private readonly tSinOff: number;
	private readonly tCos: Float32Array;

	constructor(bits: number, trans: number) {
		this.bits = bits;
		this.inverse = trans === RDFTType.IDFT_C2R || trans === RDFTType.DFT_C2R;
		this.signConvention = trans === RDFTType.IDFT_R2C || trans === RDFTType.DFT_C2R ? 1 : -1;
		this.fft = new FFT(bits - 1, trans === RDFTType.IDFT_C2R || trans === RDFTType.IDFT_R2C);
		const n = 1 << bits;
		this.tSin = getSineTable(bits);
		this.tSinOff =
			(trans === RDFTType.DFT_R2C || trans === RDFTType.DFT_C2R ? 1 : 0) * (n >> 2);
		this.tCos = getCosineTable(bits);
	}

	calc(data: Float32Array): void {
		const n = 1 << this.bits;
		const k1 = 0.5;
		const k2 = 0.5 - (this.inverse ? 1.0 : 0.0);
		const tCos = this.tCos;
		const tSin = this.tSin;
		const so = this.tSinOff;

		if (!this.inverse) {
			this.fft.permute(data);
			this.fft.calc(data);
		}

		let evRe = data[0];
		data[0] = evRe + data[1];
		data[1] = evRe - data[1];

		let i = 1;
		for (; i < n >> 2; i++) {
			const i1 = 2 * i;
			const i2 = n - i1;
			evRe = k1 * (data[i1] + data[i2]);
			const odIm = -k2 * (data[i1] - data[i2]);
			const evIm = k1 * (data[i1 + 1] - data[i2 + 1]);
			const odRe = k2 * (data[i1 + 1] + data[i2 + 1]);
			const c = tCos[i];
			const s = tSin[so + i];
			data[i1] = evRe + odRe * c - odIm * s;
			data[i1 + 1] = evIm + odIm * c + odRe * s;
			data[i2] = evRe - odRe * c + odIm * s;
			data[i2 + 1] = -evIm + odIm * c + odRe * s;
		}

		data[2 * i + 1] = this.signConvention * data[2 * i + 1];

		if (this.inverse) {
			data[0] *= k1;
			data[1] *= k1;
			this.fft.permute(data);
			this.fft.calc(data);
		}
	}
}

// --- DCT --------------------------------------------------------------------

export const DCTType = {
	DCT_II: 0,
	DCT_III: 1,
	DCT_I: 2,
	DST_I: 3,
} as const;

export class DCT {
	private readonly bits: number;
	private readonly trans: number;
	private readonly tCos: Float32Array;
	private readonly csc2: Float32Array;
	private readonly rdft: RDFT;

	constructor(bits: number, trans: number) {
		this.bits = bits;
		this.trans = trans;
		const n = 1 << bits;
		this.tCos = getCosineTable(bits + 2);
		this.csc2 = new Float32Array(n / 2);
		this.rdft = new RDFT(bits, trans === DCTType.DCT_III ? RDFTType.IDFT_C2R : RDFTType.DFT_R2C);
		for (let i = 0; i < n / 2; i++) {
			this.csc2[i] = 0.5 / Math.sin((Math.PI / (2 * n)) * (2 * i + 1));
		}
	}

	calc(data: Float32Array): void {
		// Only DCT_III is exercised by Bink audio; the others are kept for parity
		// with the reference but unused.
		if (this.trans === DCTType.DCT_III) this.calcDCTIII(data);
		else throw new Error('DCT: only DCT_III is implemented');
	}

	private calcDCTIII(data: Float32Array): void {
		const n = 1 << this.bits;
		const tCos = this.tCos;
		// SIN(n,x) = tCos[n - x]; COS(n,x) = tCos[x]
		const next = data[n - 1];
		const invN = 1.0 / n;

		for (let i = n - 2; i >= 2; i -= 2) {
			const val1 = data[i];
			const val2 = data[i - 1] - data[i + 1];
			const c = tCos[i]; // COS(n,i)
			const s = tCos[n - i]; // SIN(n,i)
			data[i] = c * val1 + s * val2;
			data[i + 1] = s * val1 - c * val2;
		}

		data[1] = 2 * next;

		this.rdft.calc(data);

		for (let i = 0; i < n / 2; i++) {
			const tmp1 = data[i] * invN;
			const tmp2 = data[n - i - 1] * invN;
			const csc = this.csc2[i] * (tmp1 - tmp2);
			const s = tmp1 + tmp2;
			data[i] = s + csc;
			data[n - i - 1] = s - csc;
		}
	}
}
