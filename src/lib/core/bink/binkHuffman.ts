// Canonical-ish Huffman decoder for Bink, ported from xoreos' Common::Huffman.
//
// Codes are grouped by length. getSymbol() accumulates the incoming bits
// (LSB-first, via BinkBitReader.addBit) one at a time and, after each bit,
// checks every code of that length for an exact match — mirroring the upstream
// decoder bit-for-bit so the prebuilt code tables in binkData.ts apply verbatim.

import { BinkBitReader } from './bitReader';

type Entry = { code: number; symbol: number };

export class BinkHuffman {
	/** Codes bucketed by (length - 1). */
	private readonly buckets: Entry[][];

	constructor(lengths: number[], codes: number[], symbols?: number[]) {
		let maxLen = 0;
		for (const l of lengths) if (l > maxLen) maxLen = l;

		this.buckets = Array.from({ length: maxLen }, () => [] as Entry[]);
		for (let i = 0; i < codes.length; i++) {
			const symbol = symbols ? symbols[i] : i;
			this.buckets[lengths[i] - 1].push({ code: codes[i], symbol });
		}
	}

	/** Decode and return the next symbol from the bit stream. */
	getSymbol(bits: BinkBitReader): number {
		let code = 0;
		for (let i = 0; i < this.buckets.length; i++) {
			code = bits.addBit(code, i);
			const bucket = this.buckets[i];
			for (let j = 0; j < bucket.length; j++) {
				if (bucket[j].code === code) return bucket[j].symbol;
			}
		}
		throw new Error('Bink: unknown Huffman code');
	}
}
