import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { partsHandler } from '../parts';
import { parseParts, writeParts } from '../../../parts';
import { ssCtx } from '../../handler';
import { DATA_ROOT, hasDataRoot, hasSample, readSample } from '@/test/dataRoot';

// Inline fixture mirroring the Musclecar_01.parts head: count=5, elementSize=46,
// then payload words including a 0xFFFFFFFF marker and a 12-float transform block
// (three 1.0 diagonals + offset vector) so the transform scanner has something
// to find.
function buildInline(): Uint8Array {
	const bytes: number[] = [];
	const pushU32 = (v: number) =>
		bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
	pushU32(5); // count
	pushU32(0x2e); // elementSize
	pushU32(0x00000000); // word 0
	pushU32(0xffffffff); // word 1 terminator
	// 12-float transform block: rows [1,0,0,0] [1,0,0,0] [1, ox, oy, oz]
	pushU32(0x3f800000); pushU32(0); pushU32(0); pushU32(0);
	pushU32(0x3f800000); pushU32(0); pushU32(0); pushU32(0);
	pushU32(0x3f800000); pushU32(0x3f000000); pushU32(0x3f000000); pushU32(0x3f000000); // off=(0.5,0.5,0.5)
	return new Uint8Array(bytes);
}
const INLINE_BYTES = buildInline();

const REAL_FIXTURE = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.parts';

/** Enumerate every real .parts under Vehicles/Bodies. */
function allPartsFiles(): string[] {
	if (!hasDataRoot) return [];
	const dir = path.join(DATA_ROOT, 'Vehicles', 'Bodies');
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const car of fs.readdirSync(dir)) {
		const cdir = path.join(dir, car);
		if (!fs.statSync(cdir).isDirectory()) continue;
		for (const f of fs.readdirSync(cdir)) {
			if (f.toLowerCase().endsWith('.parts')) out.push(path.join(cdir, f));
		}
	}
	return out;
}

describe('parts parser', () => {
	it('decodes the 8-byte header + payload words (inline fixture)', () => {
		const m = parseParts(INLINE_BYTES);
		expect(m.count).toBe(5);
		expect(m.elementSize).toBe(0x2e);
		expect(m.wordCount).toBe(14);
		expect(m.words[0]).toBe(0x00000000);
		expect(m.words[1]).toBe(0xffffffff);
		expect(m.terminatorCount).toBe(1);
		expect(m.wordAligned).toBe(true);
	});

	it('surfaces the 12-float transform block with its offset vector (inline)', () => {
		const m = parseParts(INLINE_BYTES);
		expect(m.transforms).toHaveLength(1);
		expect(m.transforms[0].offsetVec[0]).toBeCloseTo(0.5, 6);
		expect(m.transforms[0].offsetVec[1]).toBeCloseTo(0.5, 6);
		expect(m.transforms[0].offsetVec[2]).toBeCloseTo(0.5, 6);
		// transform begins at payload word 2 → absolute byte offset 8 + 2*4 = 16
		expect(m.transforms[0].offset).toBe(16);
	});

	it('round-trips the inline fixture byte-for-byte', () => {
		const out = writeParts(parseParts(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects a buffer too small for the header', () => {
		expect(() => parseParts(new Uint8Array([0, 0, 0]))).toThrow(/too small/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses the REAL Musclecar_01.parts header + transforms',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = partsHandler.parseRaw(raw, ssCtx());
			expect(raw.byteLength).toBe(2328);
			expect(m.count).toBe(5);
			expect(m.elementSize).toBe(0x2e);
			expect(m.wordCount).toBe((2328 - 8) / 4);
			expect(m.wordAligned).toBe(true);
			expect(m.words).toContain(0xffffffff);
			expect(m.words).toContain(0x3f800000);
			// the file carries multiple part transforms (identity-diagonal blocks).
			expect(m.transforms.length).toBeGreaterThan(0);
		},
	);

	it.skipIf(!hasDataRoot)(
		'parts round-trips real sample byte-for-byte',
		() => {
			const files = allPartsFiles();
			expect(files.length).toBeGreaterThan(0);
			for (const f of files) {
				const buf = fs.readFileSync(f);
				const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
				const out = partsHandler.writeRaw!(partsHandler.parseRaw(raw, ssCtx()), ssCtx());
				expect(Array.from(out), `round-trip mismatch for ${f}`).toEqual(Array.from(raw));
			}
		},
	);
});
