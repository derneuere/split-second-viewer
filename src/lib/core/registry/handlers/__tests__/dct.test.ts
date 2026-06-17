import { describe, expect, it } from 'vitest';
import { dctHandler } from '../dct';
import { parseDct, writeDct } from '../../../dct';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a DICT header (LE) + one 12-byte record + a tiny string blob.
function u32le(n: number): number[] {
	return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
const INLINE = new Uint8Array([
	0x44, 0x49, 0x43, 0x54, // 'DICT'
	...u32le(0x2000), // version
	...u32le(0x18e9778f), // fileHash
	...u32le(19), // constant
	...u32le(1), // entryCount
	...u32le(0x12345678), // record0.hash
	...u32le(0x6af), // record0.stringOffset
	...u32le(0), // record0.reserved
	...Array.from(new TextEncoder().encode('NO AWARD')),
	0x00,
	...Array.from(new TextEncoder().encode('BACK')),
	0x00,
]);

const REAL_EN = 'Dictionary/ENGLISH_PS3.dct';

describe('dct parser', () => {
	it('parses the DICT header + record table + string blob (inline)', () => {
		const m = parseDct(INLINE);
		expect(m.version).toBe(0x2000);
		expect(m.fileHash >>> 0).toBe(0x18e9778f);
		expect(m.constant).toBe(19);
		expect(m.entryCount).toBe(1);
		expect(m.records).toHaveLength(1);
		expect(m.records[0]).toEqual({
			hash: 0x12345678,
			stringOffset: 0x6af,
			reserved: 0,
		});
		expect(m.strings).toContain('NO AWARD');
		expect(m.strings).toContain('BACK');
		expect(m.stringsResolved).toBe(false);
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[0] = 0x00;
		expect(() => parseDct(bad)).toThrow(/DICT/);
	});

	it('describe() reports entry + string counts', () => {
		const text = dctHandler.describe(parseDct(INLINE));
		expect(text).toContain('1 entry');
		expect(text).toContain('NO AWARD');
	});

	it('byte-exact passthrough writer round-trips the inline doc', () => {
		const out = writeDct(parseDct(INLINE));
		expect(Array.from(out)).toEqual(Array.from(INLINE));
	});

	it.skipIf(!hasSample(REAL_EN))('parses the REAL ENGLISH_PS3.dct (142 entries)', () => {
		const raw = readSample(REAL_EN);
		const m = dctHandler.parseRaw(raw, ssCtx());
		expect(m.version).toBe(0x2000);
		expect(m.constant).toBe(19);
		expect(m.entryCount).toBe(142);
		expect(m.records).toHaveLength(142);
		// Readable UI text is present in the tail blob (per wiki).
		expect(m.strings).toContain('MAIN MENU');
		expect(m.strings.length).toBeGreaterThan(50);
	});

	it.skipIf(!hasSample(REAL_EN))('dct round-trips a real sample byte-for-byte', () => {
		const raw = readSample(REAL_EN);
		const out = dctHandler.writeRaw!(dctHandler.parseRaw(raw, ssCtx()), ssCtx());
		expect(out.byteLength).toBe(raw.byteLength);
		expect(Array.from(out)).toEqual(Array.from(raw));
	});
});
