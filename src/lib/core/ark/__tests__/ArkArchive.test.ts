import { describe, expect, it } from 'vitest';
import {
	ARK_ENTRY_SIZE,
	ARK_HEADER_SIZE,
	levelFromFilename,
	parseArk,
	parseArkFile,
	parseArkHeader,
	readMemberRaw,
} from '../ArkArchive';
import { BinWriter } from '../../binary/BinWriter';
import { hasSample, readSample } from '@/test/dataRoot';

// Build a synthetic, in-memory .ark so the TOC seam is exercised without the
// devkit. Layout mirrors the real format: 16-byte BE header, count*16 BE TOC
// entries sorted by nameHash, then packed member blobs at the recorded offsets.
function buildArk(
	entries: { nameHash: number; size: number; data: Uint8Array }[],
): Uint8Array {
	const sorted = [...entries].sort((a, b) => (a.nameHash >>> 0) - (b.nameHash >>> 0));
	const count = sorted.length;
	const dataStart = ARK_HEADER_SIZE + count * ARK_ENTRY_SIZE;

	// Assign offsets sequentially in TOC order from dataStart.
	let cursor = dataStart;
	const offsets = sorted.map((e) => {
		const off = cursor;
		cursor += e.data.byteLength;
		return off;
	});
	const total = cursor;

	const w = new BinWriter(total, false /* big-endian */);
	// header
	w.writeU32(0); // version
	w.writeU32(dataStart);
	w.writeU32(count);
	w.writeU32(ARK_ENTRY_SIZE);
	// TOC
	sorted.forEach((e, i) => {
		w.writeU32(e.size);
		w.writeU32(e.nameHash);
		w.writeU32(0); // reserved
		w.writeU32(offsets[i]);
	});
	// data region
	sorted.forEach((e) => w.writeBytes(e.data));

	const out = w.bytes.slice();
	expect(out.byteLength).toBe(total);
	return out;
}

describe('ArkArchive TOC parsing', () => {
	const entries = [
		{ nameHash: 0x0000000a, size: 4, data: new Uint8Array([1, 2, 3, 4]) },
		{ nameHash: 0x00000002, size: 8, data: new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12]) },
		{ nameHash: 0x000000ff, size: 2, data: new Uint8Array([13, 14]) },
	];
	const bytes = buildArk(entries);

	it('parses the 16-byte big-endian header', () => {
		const h = parseArkHeader(bytes);
		expect(h.version).toBe(0);
		expect(h.count).toBe(3);
		expect(h.entrySize).toBe(ARK_ENTRY_SIZE);
	});

	it('enforces dataStart == 0x10 + count * 0x10', () => {
		const h = parseArkHeader(bytes);
		expect(h.dataStart).toBe(ARK_HEADER_SIZE + h.count * ARK_ENTRY_SIZE);
	});

	it('reads every TOC entry and tags the segment', () => {
		const { members } = parseArkFile(bytes, 'static');
		expect(members).toHaveLength(3);
		for (const m of members) expect(m.segment).toBe('static');
		// index reflects on-disk TOC order
		expect(members.map((m) => m.index)).toEqual([0, 1, 2]);
	});

	it('derives storedLen as the gap to the next offset (trailing runs to EOF)', () => {
		const { members } = parseArkFile(bytes, 'static');
		const byHash = new Map(members.map((m) => [m.nameHash >>> 0, m]));
		// TOC order is sorted by nameHash: 0x02 (8 bytes), 0x0a (4), 0xff (2).
		expect(byHash.get(0x02)!.storedLen).toBe(8);
		expect(byHash.get(0x0a)!.storedLen).toBe(4);
		expect(byHash.get(0xff)!.storedLen).toBe(2); // trailing member to EOF
	});

	it('reads a member back byte-exact via readMemberRaw', () => {
		const { members } = parseArkFile(bytes, 'static');
		const m = members.find((x) => (x.nameHash >>> 0) === 0x0a)!;
		expect(Array.from(readMemberRaw(bytes, m))).toEqual([1, 2, 3, 4]);
	});

	it('parseArk merges a pair and sorts members ascending by nameHash', () => {
		const archive = parseArk(bytes, undefined, 'Test');
		expect(archive.level).toBe('Test');
		expect(archive.streamHeader).toBeUndefined();
		const hashes = archive.members.map((m) => m.nameHash >>> 0);
		expect(hashes).toEqual([...hashes].sort((a, b) => a - b));
	});

	it('throws on a truncated header', () => {
		expect(() => parseArkHeader(new Uint8Array(4))).toThrow(/too small/);
	});
});

describe('levelFromFilename', () => {
	it('strips the .Static.ark / .Stream.ark suffix', () => {
		expect(levelFromFilename('Downtown.Static.ark')).toBe('Downtown');
		expect(levelFromFilename('Downtown.Stream.ark')).toBe('Downtown');
	});
	it('handles a bare .ark and a path prefix', () => {
		expect(levelFromFilename('docks.ark')).toBe('docks');
		expect(levelFromFilename('C:/a/b/Downtown.Static.ark')).toBe('Downtown');
	});
});

// Real-devkit guard: confirm the parser holds on an actual 768-member .ark.
const REAL_STATIC =
	'Environments/Levels/Downtown/Sectors/Downtown.Static.ark';

describe.skipIf(!hasSample(REAL_STATIC))('ArkArchive against a real devkit .ark', () => {
	it('parses Downtown.Static.ark with a sane header and member set', () => {
		const raw = readSample(REAL_STATIC);
		const { header, members } = parseArkFile(raw, 'static');
		expect(header.version).toBe(0);
		expect(header.entrySize).toBe(ARK_ENTRY_SIZE);
		expect(header.count).toBeGreaterThan(0);
		// the load-bearing invariant on real data
		expect(header.dataStart).toBe(ARK_HEADER_SIZE + header.count * ARK_ENTRY_SIZE);
		expect(members).toHaveLength(header.count);
		// members come back sorted ascending by nameHash (on-disk TOC order)
		const hashes = members.map((m) => m.nameHash >>> 0);
		expect(hashes).toEqual([...hashes].sort((a, b) => a - b));
		// every offset lands at or past the data region and inside the file
		for (const m of members) {
			if (m.size > 0) {
				expect(m.offset).toBeGreaterThanOrEqual(header.dataStart);
				expect(m.offset + m.storedLen).toBeLessThanOrEqual(raw.byteLength);
			}
		}
	});
});
