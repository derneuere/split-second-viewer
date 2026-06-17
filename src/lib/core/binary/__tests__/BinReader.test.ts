import { describe, expect, it } from 'vitest';
import { BinReader } from '../BinReader';
import { BinWriter } from '../BinWriter';

// Split/Second is PS3 big-endian, so BinReader/BinWriter DEFAULT to big-endian.
// These tests pin that contract — the single most load-bearing invariant for
// every downstream parser (a silent LE/BE flip corrupts every field).

const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer;

describe('BinReader (big-endian default)', () => {
	it('reads 00 00 00 08 as u32 == 8 (BE is the default)', () => {
		const r = new BinReader(buf(0x00, 0x00, 0x00, 0x08));
		expect(r.readU32()).toBe(8);
	});

	it('reads the SAME bytes as 0x08000000 when littleEndian=true', () => {
		const r = new BinReader(buf(0x00, 0x00, 0x00, 0x08), true);
		expect(r.readU32()).toBe(0x08000000);
	});

	it('reads u16 big-endian (00 08 == 8)', () => {
		const r = new BinReader(buf(0x00, 0x08));
		expect(r.readU16()).toBe(8);
	});

	it('reads signed i32 big-endian (FF FF FF FF == -1)', () => {
		const r = new BinReader(buf(0xff, 0xff, 0xff, 0xff));
		expect(r.readI32()).toBe(-1);
	});

	it('reads u64 big-endian as a bigint', () => {
		const r = new BinReader(buf(0, 0, 0, 0, 0, 0, 0, 8));
		expect(r.readU64()).toBe(8n);
	});

	it('keeps u32 unsigned (FF FF FF FF == 4294967295)', () => {
		const r = new BinReader(buf(0xff, 0xff, 0xff, 0xff));
		expect(r.readU32()).toBe(0xffffffff);
	});

	it('advances the cursor and reports remaining / tell()', () => {
		const r = new BinReader(buf(0, 0, 0, 1, 0, 0, 0, 2));
		expect(r.readU32()).toBe(1);
		expect(r.tell()).toBe(4);
		expect(r.remaining).toBe(4);
		expect(r.readU32()).toBe(2);
		expect(r.remaining).toBe(0);
	});

	it('seek/skip move the cursor to absolute / relative positions', () => {
		const r = new BinReader(buf(0xaa, 0xbb, 0xcc, 0xdd));
		r.seek(2);
		expect(r.readU8()).toBe(0xcc);
		r.seek(0).skip(3);
		expect(r.readU8()).toBe(0xdd);
	});

	it('readBytes returns an independent copy (not a view)', () => {
		const src = new Uint8Array([1, 2, 3, 4]);
		const r = new BinReader(src.buffer);
		const out = r.readBytes(4);
		out[0] = 0xff;
		expect(src[0]).toBe(1); // original untouched
	});

	it('readFixedString trims at the first NUL', () => {
		const r = new BinReader(buf(0x41, 0x42, 0x00, 0x43)); // 'AB\0C'
		expect(r.readFixedString(4)).toBe('AB');
	});

	it('readCString reads up to and consumes the NUL', () => {
		const r = new BinReader(buf(0x68, 0x69, 0x00, 0x7a)); // 'hi\0z'
		expect(r.readCString()).toBe('hi');
		expect(r.readU8()).toBe(0x7a); // cursor advanced past the NUL
	});
});

describe('BinWriter (big-endian default) round-trips BinReader', () => {
	it('writeU32(8) emits 00 00 00 08 and reads back as 8', () => {
		const w = new BinWriter(4);
		w.writeU32(8);
		expect(Array.from(w.bytes)).toEqual([0x00, 0x00, 0x00, 0x08]);
		expect(new BinReader(w.bytes.slice().buffer).readU32()).toBe(8);
	});

	it('writeU64 / readU64 round-trip a large bigint big-endian', () => {
		const w = new BinWriter(8);
		w.writeU64(0x0102030405060708n);
		expect(Array.from(w.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(new BinReader(w.bytes.slice().buffer).readU64()).toBe(0x0102030405060708n);
	});

	it('setU32 back-fills a previously-written length slot', () => {
		const w = new BinWriter(8);
		w.writeU32(0); // placeholder
		w.writeU32(0xdeadbeef);
		w.setU32(0, 4);
		const r = new BinReader(w.bytes.slice().buffer);
		expect(r.readU32()).toBe(4);
		expect(r.readU32()).toBe(0xdeadbeef);
	});

	it('alignTo pads with zeroes to the next boundary', () => {
		const w = new BinWriter(8);
		w.writeU8(0x01);
		w.alignTo(4);
		expect(Array.from(w.bytes)).toEqual([0x01, 0x00, 0x00, 0x00]);
	});
});
