import { describe, expect, it } from 'vitest';
import { sectorInfoHandler } from '../sectorInfo';
import { parseSectorInfo } from '../../../sectorInfo';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture mirrors the wiki's Downtown.sectorInfo head: constA 1.92,
// constB 300.0, sectorCount = 2, "q000", a UTF-16LE source path, then a "q001"
// tag — so the q-tag scan should find exactly 2 tags and match the header count.
function buildInline(): Uint8Array {
	const bytes: number[] = [];
	const pushU32 = (v: number) => bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
	pushU32(0x3ff5c28f); // constA = 1.92
	pushU32(0x43960000); // constB = 300.0
	pushU32(2); // sectorCount = 2
	for (const c of 'q000') bytes.push(c.charCodeAt(0)); // chunkTag0
	// leading NUL word + UTF-16LE "\proj"
	bytes.push(0x00, 0x00);
	for (const c of '\\proj') bytes.push(c.charCodeAt(0), 0x00);
	bytes.push(0x00, 0x00); // NUL terminator
	for (const c of 'q001') bytes.push(c.charCodeAt(0)); // second sector tag
	bytes.push(0x00, 0x00, 0x00, 0x00); // some chunk body filler
	return new Uint8Array(bytes);
}
const INLINE_BYTES = buildInline();

const REAL_FIXTURE = 'Environments/Levels/Downtown/Sectors/Downtown.sectorInfo';

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

	it('rejects a too-small file', () => {
		expect(() => parseSectorInfo(new Uint8Array(8))).toThrow(/smaller than/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses a REAL .sectorInfo and the q-tag count matches sectorCount',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = sectorInfoHandler.parseRaw(raw, ssCtx());
			expect(m.constA).toBeCloseTo(1.92, 2);
			expect(m.constB).toBeCloseTo(300.0, 1);
			expect(m.sectorCount).toBe(128); // wiki: Downtown = 128 sectors
			expect(m.chunkTag0).toBe('q000');
			// the q### tag scan equals the header sectorCount (the Confirmed field)
			expect(m.chunks.length).toBe(m.sectorCount);
			expect(m.countMatches).toBe(true);
		},
	);
});
