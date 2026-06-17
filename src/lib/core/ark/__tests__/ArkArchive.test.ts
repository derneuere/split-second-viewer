import { describe, expect, it } from 'vitest';
import {
	ARK_ENTRY_SIZE,
	ARK_HEADER_SIZE,
	detectMemberType,
	extractMember,
	getMemberPayload,
	isFramed,
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

describe('member payload routine (raw / frame-strip / zlib)', () => {
	it('returns unframed bytes verbatim (raw store)', () => {
		const blob = new Uint8Array([0x02, 0x00, 0x00, 0x08, 9, 8, 7, 6]);
		expect(isFramed(blob)).toBe(false);
		expect(Array.from(getMemberPayload(blob))).toEqual(Array.from(blob));
	});

	it('strips the 12-byte Stream sub-frame (00000000|innerSize|00000000)', () => {
		// frame: 00000000 | 00000004 | 00000000 | <4 payload bytes> | <pad>
		const w = new BinWriter(20, false);
		w.writeU32(0);
		w.writeU32(4); // innerSize
		w.writeU32(0);
		w.writeBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
		w.writeBytes(new Uint8Array([0, 0, 0, 0])); // trailing alignment pad
		const blob = w.bytes.slice();
		expect(isFramed(blob)).toBe(true);
		expect(Array.from(getMemberPayload(blob))).toEqual([0xde, 0xad, 0xbe, 0xef]);
	});

	it('detects a serialized-object (02 00 00 08) as model/.sobj', () => {
		const blob = new Uint8Array([0x02, 0x00, 0x00, 0x08, 0, 0, 0, 0]);
		const t = detectMemberType(blob, blob, false, 'static', blob.byteLength);
		expect(t.category).toBe('model');
		expect(t.ext).toBe('sobj');
	});

	it('detects a framed Stream member as model/.geo', () => {
		const w = new BinWriter(24, false);
		w.writeU32(0);
		w.writeU32(8);
		w.writeU32(0);
		w.writeBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
		const blob = w.bytes.slice();
		const payload = getMemberPayload(blob);
		const t = detectMemberType(blob, payload, true, 'stream', blob.byteLength);
		expect(t.category).toBe('model');
		expect(t.ext).toBe('geo');
	});

	it('detects an unframed Stream blob as texture/.gputex', () => {
		const blob = new Uint8Array([0xab, 0x81, 0x1b, 0x03, 0, 0, 0, 0]);
		const t = detectMemberType(blob, blob, false, 'stream', blob.byteLength);
		expect(t.category).toBe('texture');
		expect(t.ext).toBe('gputex');
	});
});

// Real-devkit guard: confirm the parser holds on an actual 768-member .ark.
const REAL_STATIC =
	'Environments/Levels/Downtown/Sectors/Downtown.Static.ark';

// The airport_test_03 level pair — the workflow's verified fixture (866 members).
const AIR_DIR = 'Environments/Levels/airport_test_03/Sectors';
const AIR_STATIC = `${AIR_DIR}/airport_test_03.Static.ark`;
const AIR_STREAM = `${AIR_DIR}/airport_test_03.Stream.ark`;

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

// Full extraction against the verified airport_test_03 pair. Ground truth from
// _tools/ark_extract_full.py: 866 TOC members (245 Static + 621 Stream), 864
// non-empty, 121 frame-strip + 743 raw, histogram model=365 / texture=499.
describe.skipIf(!hasSample(AIR_STATIC) || !hasSample(AIR_STREAM))(
	'full extraction — airport_test_03 Static+Stream pair',
	() => {
		const staticBytes = hasSample(AIR_STATIC) ? readSample(AIR_STATIC) : new Uint8Array();
		const streamBytes = hasSample(AIR_STREAM) ? readSample(AIR_STREAM) : new Uint8Array();
		const archive = parseArk(staticBytes, streamBytes, 'airport_test_03');

		it('merges 866 members across the pair (245 Static + 621 Stream)', () => {
			expect(archive.members).toHaveLength(866);
			expect(archive.members.filter((m) => m.segment === 'static')).toHaveLength(245);
			expect(archive.members.filter((m) => m.segment === 'stream')).toHaveLength(621);
		});

		it('splits framing/raw 121/743 (and detects 2 size-0 placeholders)', () => {
			const live = archive.members.filter((m) => m.storedLen > 0);
			expect(live).toHaveLength(864);
			const framed = live.filter((m) => m.framed);
			expect(framed).toHaveLength(121);
			expect(live.length - framed.length).toBe(743);
			// all 121 framed members are in the Stream segment
			expect(framed.every((m) => m.segment === 'stream')).toBe(true);
		});

		it('produces a sane type histogram (hundreds of model + hundreds of texture)', () => {
			const hist: Record<string, number> = {};
			for (const m of archive.members) {
				if (!m.detectedType) continue;
				hist[m.detectedType.category] = (hist[m.detectedType.category] ?? 0) + 1;
			}
			expect(hist.model).toBe(365); // 244 .sobj + 121 .geo
			expect(hist.texture).toBe(499); // .gputex
			expect(hist.model).toBeGreaterThan(100);
			expect(hist.texture).toBeGreaterThan(100);
		});

		it("a Static member's extracted bytes start with the 02 00 00 08 magic", () => {
			const m = archive.members.find(
				(x) => x.segment === 'static' && (x.nameHash >>> 0) === 0x000ecb73,
			)!;
			expect(m).toBeDefined();
			const { payload, framed, type } = extractMember(staticBytes, m);
			expect(framed).toBe(false);
			expect(type.ext).toBe('sobj');
			expect(Array.from(payload.subarray(0, 4))).toEqual([0x02, 0x00, 0x00, 0x08]);
		});

		it('a framed Stream member loses its 12-byte sub-frame on extract', () => {
			const m = archive.members.find((x) => x.segment === 'stream' && x.framed)!;
			expect(m).toBeDefined();
			const raw = readMemberRaw(streamBytes, m);
			const { payload, type } = extractMember(streamBytes, m);
			expect(type.ext).toBe('geo');
			// payload == on_disk - 12 (or less, when trailing alignment padding exists)
			expect(payload.byteLength).toBeLessThanOrEqual(raw.byteLength - 12);
			expect(payload.byteLength).toBeGreaterThan(0);
		});
	},
);
