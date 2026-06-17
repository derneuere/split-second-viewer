import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sectorInfoHandler } from '../sectorInfo';
import { parseSectorInfo, writeSectorInfo } from '../../../sectorInfo';
import { ssCtx } from '../../handler';
import { DATA_ROOT, hasDataRoot, hasSample, readSample } from '@/test/dataRoot';

// Inline fixture mirrors the wiki's Downtown.sectorInfo head: constA 1.92,
// constB 300.0, sectorCount = 2, "q000", a UTF-16LE source path, then a "q001"
// tag — so the q-tag scan should find exactly 2 tags and match the header count.
function buildInline(): Uint8Array {
	const bytes: number[] = [];
	const pushU32 = (v: number) =>
		bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
	pushU32(0x3ff5c28f); // constA = 1.92
	pushU32(0x43960000); // constB = 300.0
	pushU32(2); // sectorCount = 2
	for (const c of 'q000') bytes.push(c.charCodeAt(0)); // chunkTag0 @0x0C
	bytes.push(0x00, 0x00); // leading NUL word
	for (const c of '\\proj') bytes.push(c.charCodeAt(0), 0x00); // UTF-16LE "\proj"
	bytes.push(0x00, 0x00); // NUL terminator
	for (const c of 'q001') bytes.push(c.charCodeAt(0)); // second sector tag
	bytes.push(0x00, 0x00, 0x00, 0x00); // chunk body filler
	return new Uint8Array(bytes);
}
const INLINE_BYTES = buildInline();

const REAL_FIXTURE = 'Environments/Levels/Downtown/Sectors/Downtown.sectorInfo';

/** Enumerate every real .sectorInfo under Environments/Levels/<L>/Sectors. */
function allSectorInfoFiles(): string[] {
	if (!hasDataRoot) return [];
	const levels = path.join(DATA_ROOT, 'Environments', 'Levels');
	if (!fs.existsSync(levels)) return [];
	const out: string[] = [];
	for (const lvl of fs.readdirSync(levels)) {
		const sdir = path.join(levels, lvl, 'Sectors');
		if (!fs.existsSync(sdir)) continue;
		for (const f of fs.readdirSync(sdir)) {
			if (f.toLowerCase().endsWith('.sectorinfo')) out.push(path.join(sdir, f));
		}
	}
	return out;
}

describe('sectorInfo parser', () => {
	it('decodes the header and enumerates q### chunk tags (inline)', () => {
		const m = parseSectorInfo(INLINE_BYTES);
		expect(m.constA).toBeCloseTo(1.92, 2);
		expect(m.constB).toBeCloseTo(300.0, 1);
		expect(m.sectorCount).toBe(2);
		expect(m.chunkTag0).toBe('q000');
		expect(m.chunks.map((c) => c.tag)).toEqual(['q000', 'q001']);
		expect(m.countMatches).toBe(true);
		expect(m.srcPath).toContain('proj');
	});

	it('round-trips the inline fixture byte-for-byte', () => {
		const out = writeSectorInfo(parseSectorInfo(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects a too-small file', () => {
		expect(() => parseSectorInfo(new Uint8Array(8))).toThrow(/smaller than/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses a REAL .sectorInfo: count matches, chunks carry AABBs',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = sectorInfoHandler.parseRaw(raw, ssCtx());
			expect(m.constA).toBeCloseTo(1.92, 2);
			expect(m.constB).toBeCloseTo(300.0, 1);
			expect(m.sectorCount).toBe(128); // wiki: Downtown = 128 sectors
			expect(m.chunkTag0).toBe('q000');
			expect(m.chunks.length).toBe(m.sectorCount);
			expect(m.countMatches).toBe(true);
			// regular chunks carry a decoded world-space AABB (for the World viewport).
			const withAabb = m.chunks.filter((c) => c.aabb);
			expect(withAabb.length).toBeGreaterThan(10);
			const b = withAabb[0].aabb!;
			expect(b.min[0]).toBeLessThanOrEqual(b.max[0]);
			expect(b.min[1]).toBeLessThanOrEqual(b.max[1]);
			expect(b.min[2]).toBeLessThanOrEqual(b.max[2]);
		},
	);

	it.skipIf(!hasDataRoot)(
		'sectorInfo round-trips real sample byte-for-byte',
		() => {
			const files = allSectorInfoFiles();
			expect(files.length).toBeGreaterThan(0);
			for (const f of files) {
				const buf = fs.readFileSync(f);
				const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
				const out = sectorInfoHandler.writeRaw!(sectorInfoHandler.parseRaw(raw, ssCtx()), ssCtx());
				expect(Array.from(out), `round-trip mismatch for ${f}`).toEqual(Array.from(raw));
			}
		},
	);
});
