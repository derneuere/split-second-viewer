// Low-level binary reader. Split/Second is PS3 big-endian, so `littleEndian`
// DEFAULTS TO FALSE here — the opposite of the Burnout reference (PC LE). Pass
// `true` explicitly for the two LE-on-PS3 container exceptions (.gfx, .bik).
//
// This module is pure (no React, no registry) so it is importable from Node by
// the CLI and the vitest suite.

export class BinReader {
	private view: DataView;
	private offset = 0;
	private little: boolean;

	constructor(buf: ArrayBufferLike, littleEndian = false) {
		this.view = new DataView(buf as ArrayBuffer);
		this.little = littleEndian;
	}

	/** Total byte length of the underlying buffer. */
	get length(): number { return this.view.byteLength; }
	/** Bytes remaining from the current cursor to EOF. */
	get remaining(): number { return this.view.byteLength - this.offset; }

	/** Current read cursor. */
	get position(): number { return this.offset; }
	set position(pos: number) { this.offset = pos >>> 0; }

	/** Read cursor (alias used by the brief — `tell()`). */
	tell(): number { return this.offset; }
	/** Move the cursor to an absolute offset. */
	seek(pos: number): this { this.offset = pos >>> 0; return this; }
	/** Advance the cursor by `n` bytes. */
	skip(n: number): this { this.offset += n; return this; }

	readU8(): number { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
	readI8(): number { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
	readU16(): number { const v = this.view.getUint16(this.offset, this.little); this.offset += 2; return v; }
	readI16(): number { const v = this.view.getInt16(this.offset, this.little); this.offset += 2; return v; }
	readU32(): number { const v = this.view.getUint32(this.offset, this.little); this.offset += 4; return v >>> 0; }
	/** Read a u32 at the cursor WITHOUT advancing it (look-ahead for tagged framing). */
	peekU32(): number { return this.view.getUint32(this.offset, this.little) >>> 0; }
	readI32(): number { const v = this.view.getInt32(this.offset, this.little); this.offset += 4; return v | 0; }
	readF32(): number { const v = this.view.getFloat32(this.offset, this.little); this.offset += 4; return v; }
	readF64(): number { const v = this.view.getFloat64(this.offset, this.little); this.offset += 8; return v; }

	readU64(): bigint {
		const low = BigInt(this.view.getUint32(this.offset + (this.little ? 0 : 4), this.little));
		const high = BigInt(this.view.getUint32(this.offset + (this.little ? 4 : 0), this.little));
		this.offset += 8;
		return (high << 32n) | (low & 0xFFFFFFFFn);
	}

	/** Read `n` raw bytes as a copy. */
	readBytes(n: number): Uint8Array {
		const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n).slice();
		this.offset += n;
		return out;
	}

	/** Read a fixed-length string (latin1 / ascii), trimming at the first NUL. */
	readFixedString(length: number): string {
		const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
		this.offset += length;
		const nul = bytes.indexOf(0);
		const end = nul >= 0 ? nul : length;
		return new TextDecoder("latin1").decode(bytes.subarray(0, end));
	}

	/** Read a NUL-terminated C string from the current cursor. */
	readCString(): string {
		const start = this.offset;
		while (this.offset < this.view.byteLength && this.view.getUint8(this.offset) !== 0) this.offset++;
		const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + start, this.offset - start);
		const str = new TextDecoder("latin1").decode(bytes);
		if (this.offset < this.view.byteLength) this.offset++; // consume the NUL
		return str;
	}
}
