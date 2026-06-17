// LSB-first, 32-bit-little-endian-word bit reader — a faithful TypeScript port
// of xoreos' Common::BitStream32LELSB (itself the layout FFmpeg's Bink decoder
// uses via get_bits with the bytestream pre-swapped to 32-bit LE words).
//
// Semantics that the Bink decoder depends on and this reader reproduces exactly:
//   * data is consumed one 32-bit little-endian word at a time;
//   * within a word, bits are handed out least-significant-bit first;
//   * getBits(n) returns a value whose bit i is the i-th bit read (LSB-first);
//   * pos()/size() are reported in BITS, word-aligned, so the decoder's
//     "advance to the next 32-bit boundary" (pos & 0x1F) skips land identically.
//
// Ported from xoreos (GPLv3), which is based on FFmpeg's LGPL Bink reader.

export class BinkBitReader {
	private readonly data: Uint8Array;
	private readonly len: number; // byte length of the (sub)stream
	private streamPos = 0; // bytes consumed so far (start of the NEXT word to read)
	private value = 0; // current 32-bit word; consumed bits are shifted out of the LSB end
	private inValue = 0; // number of bits already consumed from `value` (0..31)

	constructor(data: Uint8Array, start = 0, end = data.length) {
		this.data = data.subarray(start, end);
		this.len = this.data.length;
	}

	/** Read the next 32-bit little-endian word; missing tail bytes read as 0. */
	private readWord(): number {
		const p = this.streamPos;
		const d = this.data;
		const n = this.len;
		const b0 = p < n ? d[p] : 0;
		const b1 = p + 1 < n ? d[p + 1] : 0;
		const b2 = p + 2 < n ? d[p + 2] : 0;
		const b3 = p + 3 < n ? d[p + 3] : 0;
		this.streamPos = p + 4;
		return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
	}

	/** Read a single bit. */
	getBit(): number {
		if (this.inValue === 0) this.value = this.readWord();
		const b = this.value & 1;
		this.value >>>= 1;
		this.inValue = (this.inValue + 1) & 31;
		return b;
	}

	/** Read an n-bit value (0 <= n <= 32), LSB-first. */
	getBits(n: number): number {
		if (n === 0) return 0;
		let result = 0;
		let got = 0;
		while (got < n) {
			if (this.inValue === 0) this.value = this.readWord();
			const avail = 32 - this.inValue;
			let take = n - got;
			if (take > avail) take = avail;
			// Extract the low `take` bits currently at the front of `value`.
			const part = take === 32 ? this.value : (this.value & ((1 << take) - 1)) >>> 0;
			// Place them at bit offset `got` of the result. Use multiply (not <<) so
			// the shift can reach bit 31 without overflowing the 32-bit << operator.
			result += part * Math.pow(2, got);
			if (take === 32) {
				this.value = 0;
				this.inValue = 0;
			} else {
				this.value >>>= take;
				this.inValue = (this.inValue + take) & 31;
			}
			got += take;
		}
		return result >>> 0;
	}

	/** Append the next stream bit as bit `n` of `x` and return the new value (LSB layout). */
	addBit(x: number, n: number): number {
		const b = this.getBit();
		return ((x & ~(1 << n)) | (b << n)) >>> 0;
	}

	/** Skip `n` bits. */
	skip(n: number): void {
		while (n > 0) {
			const t = n > 24 ? 24 : n;
			this.getBits(t);
			n -= t;
		}
	}

	/** Current position, in bits (word-aligned accounting, matching xoreos). */
	pos(): number {
		if (this.streamPos === 0) return 0;
		const p = this.inValue === 0 ? this.streamPos : (this.streamPos - 1) & ~3;
		return p * 8 + this.inValue;
	}

	/** Total size, in bits (rounded down to a whole number of 32-bit words). */
	size(): number {
		return (this.len & ~3) * 8;
	}
}
