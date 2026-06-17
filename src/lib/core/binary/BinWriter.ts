// Low-level binary writer. Mirrors BinReader: `littleEndian` DEFAULTS TO FALSE
// (PS3 big-endian) for Split/Second. Pure module — importable from Node.

export class BinWriter {
	private buf: Uint8Array;
	private view: DataView;
	private little: boolean;
	private _offset = 0;

	constructor(initialSize = 1024, littleEndian = false) {
		this.buf = new Uint8Array(Math.max(16, initialSize >>> 0));
		this.view = new DataView(this.buf.buffer);
		this.little = littleEndian;
	}

	/** Current write cursor. */
	get offset(): number { return this._offset; }
	/** `tell()` alias from the brief. */
	tell(): number { return this._offset; }
	/** The written bytes (a view over the internal buffer, length === offset). */
	get bytes(): Uint8Array { return this.buf.subarray(0, this._offset); }

	/** Move the cursor; grows the buffer if needed. */
	seek(pos: number): this {
		const p = pos >>> 0;
		this.ensure(p - this._offset);
		this._offset = p;
		return this;
	}

	private ensure(extra: number) {
		const need = this._offset + extra;
		if (need <= this.buf.length) return;
		let size = this.buf.length;
		while (size < need) size <<= 1;
		const next = new Uint8Array(size);
		next.set(this.buf);
		this.buf = next;
		this.view = new DataView(this.buf.buffer);
	}

	/** Patch a u32 at an already-written offset (for back-filled lengths). */
	setU32(at: number, value: number) { this.view.setUint32(at >>> 0, value >>> 0, this.little); }

	writeU8(v: number) { this.ensure(1); this.view.setUint8(this._offset, v & 0xFF); this._offset += 1; }
	writeI8(v: number) { this.ensure(1); this.view.setInt8(this._offset, v | 0); this._offset += 1; }
	writeU16(v: number) { this.ensure(2); this.view.setUint16(this._offset, v >>> 0, this.little); this._offset += 2; }
	writeI16(v: number) { this.ensure(2); this.view.setInt16(this._offset, v | 0, this.little); this._offset += 2; }
	writeU32(v: number) { this.ensure(4); this.view.setUint32(this._offset, v >>> 0, this.little); this._offset += 4; }
	writeI32(v: number) { this.ensure(4); this.view.setInt32(this._offset, v | 0, this.little); this._offset += 4; }
	writeF32(v: number) { this.ensure(4); this.view.setFloat32(this._offset, v, this.little); this._offset += 4; }
	writeF64(v: number) { this.ensure(8); this.view.setFloat64(this._offset, v, this.little); this._offset += 8; }

	writeU64(v: bigint) {
		const low = Number(v & 0xFFFFFFFFn) >>> 0;
		const high = Number((v >> 32n) & 0xFFFFFFFFn) >>> 0;
		if (this.little) { this.writeU32(low); this.writeU32(high); }
		else { this.writeU32(high); this.writeU32(low); }
	}

	writeBytes(arr: Uint8Array) { this.ensure(arr.length); this.buf.set(arr, this._offset); this._offset += arr.length; }
	writeZeroes(n: number) { this.ensure(n); this.buf.fill(0, this._offset, this._offset + n); this._offset += n; }

	writeCString(str: string) {
		const bytes = new TextEncoder().encode(str);
		this.writeBytes(bytes);
		this.writeU8(0);
	}

	writeFixedString(str: string, length: number) {
		const bytes = new Uint8Array(length);
		const encoded = new TextEncoder().encode(str);
		bytes.set(encoded.subarray(0, length));
		this.writeBytes(bytes);
	}

	/** Pad with zeroes to the next multiple of `align` bytes. */
	alignTo(align: number) {
		const mod = this._offset % align;
		if (mod !== 0) this.writeZeroes(align - mod);
	}
}
