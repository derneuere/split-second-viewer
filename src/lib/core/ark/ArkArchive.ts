// .ark container parser for Split/Second (PS3, big-endian).
//
// Ported from _tools/ark_extract.py. The format:
//
//   Header (16 bytes, big-endian):
//     0x0  u32 version    (0 in all samples)
//     0x4  u32 dataStart  (== 0x10 + count * 0x10; data region begins here)
//     0x8  u32 count      (number of TOC entries)
//     0xC  u32 entrySize  (always 0x10)
//
//   TOC entry (16 bytes, big-endian), sorted ascending by nameHash:
//     0x0  u32 size       (member size; decompressed / in-memory hint)
//     0x4  u32 nameHash   (32-bit name/content hash; stable across levels)
//     0x8  u32 reserved   (0 in all samples)
//     0xC  u32 offset     (absolute byte offset of member data in THIS file)
//
//   Data region: packed member blobs addressed by absolute offset. A member's
//   on-disk stored length is derived from the next distinct offset (by offset
//   order), clamped to EOF; the trailing member runs to EOF.
//
// One logical Archive = the Static + Stream PAIR for a level. Both files are
// self-contained (every offset indexes its own file). Static members are
// uncompressed serialized objects; Stream members are deflate-packed — see
// inflateMember() (a stub until the inner-frame boundary is pinned, WP-1/WP-2).
//
// Pure module: imports only BinReader, pako, and shared types — no React.

import * as pako from 'pako';
import { BinReader } from '../binary/BinReader';
import type {
	ArchiveMember,
	ArkHeader,
	ArkSegment,
	ParsedArchive,
} from '../types';

export const ARK_ENTRY_SIZE = 0x10;
export const ARK_HEADER_SIZE = 0x10;

/** Parse the 16-byte .ark header (big-endian). */
export function parseArkHeader(bytes: Uint8Array): ArkHeader {
	if (bytes.byteLength < ARK_HEADER_SIZE) {
		throw new Error(`ark: file too small for header (${bytes.byteLength} bytes)`);
	}
	const r = new BinReader(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + ARK_HEADER_SIZE),
		false,
	);
	return {
		version: r.readU32(),
		dataStart: r.readU32(),
		count: r.readU32(),
		entrySize: r.readU32(),
	};
}

/**
 * Parse one .ark file (Static OR Stream) into its header + member list, with
 * `storedLen` derived from offset ordering. `segment` tags every member.
 */
export function parseArkFile(bytes: Uint8Array, segment: ArkSegment): {
	header: ArkHeader;
	members: ArchiveMember[];
} {
	const header = parseArkHeader(bytes);
	const fsize = bytes.byteLength;

	const r = new BinReader(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		false,
	);
	r.seek(ARK_HEADER_SIZE);

	type RawEntry = { size: number; nameHash: number; reserved: number; offset: number; index: number };
	const raw: RawEntry[] = [];
	for (let i = 0; i < header.count; i++) {
		const size = r.readU32();
		const nameHash = r.readU32();
		const reserved = r.readU32();
		const offset = r.readU32();
		raw.push({ size, nameHash, reserved, offset, index: i });
	}

	// Derive on-disk stored length: distance to the next distinct offset,
	// clamped to EOF for the trailing member. Size-0 entries get storedLen 0.
	const boundaries = Array.from(new Set(raw.map((e) => e.offset)));
	boundaries.push(fsize);
	boundaries.sort((a, b) => a - b);
	const storedLenOf = (off: number): number => {
		for (const b of boundaries) if (b > off) return b - off;
		return Math.max(0, fsize - off);
	};

	const members: ArchiveMember[] = raw.map((e) => ({
		nameHash: e.nameHash,
		size: e.size,
		offset: e.offset,
		storedLen: e.size > 0 ? storedLenOf(e.offset) : 0,
		segment,
		index: e.index,
	}));

	return { header, members };
}

/** Strip a level name from an .ark filename ('Downtown.Static.ark' -> 'Downtown'). */
export function levelFromFilename(name: string): string {
	const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
	return base.replace(/\.(Static|Stream)\.ark$/i, '').replace(/\.ark$/i, '');
}

/**
 * Parse a Static/Stream .ark pair into one ParsedArchive. The Stream file is
 * optional (some flows open only the Static). Members are merged and sorted by
 * nameHash (the on-disk TOC order).
 */
export function parseArk(
	staticBytes: Uint8Array,
	streamBytes: Uint8Array | undefined,
	level: string,
): ParsedArchive {
	const staticParsed = parseArkFile(staticBytes, 'static');
	const streamParsed = streamBytes ? parseArkFile(streamBytes, 'stream') : undefined;

	const members = [...staticParsed.members, ...(streamParsed?.members ?? [])];
	members.sort((a, b) => (a.nameHash >>> 0) - (b.nameHash >>> 0));

	return {
		level,
		staticHeader: staticParsed.header,
		streamHeader: streamParsed?.header,
		members,
	};
}

/**
 * Slice one member's raw bytes out of its segment file by offset + storedLen.
 * Returns a copy (safe to keep past the caller's buffer lifetime).
 */
export function readMemberRaw(segmentBytes: Uint8Array, member: ArchiveMember): Uint8Array {
	const end = Math.min(member.offset + member.storedLen, segmentBytes.byteLength);
	return segmentBytes.slice(member.offset, end);
}

/**
 * Inflate a Stream member's bytes.
 *
 * STUB: the exact deflate boundary inside the Stream sub-frame
 * (`00000000 | innerSize | ...`) is not yet pinned (PORT-BRIEF §7 WP-2). pako
 * is wired and the framing-aware path is sketched: when the real boundary is
 * known, set `deflateOffset` from the inner frame instead of probing.
 *
 * For now this attempts a raw/zlib inflate and falls back to returning the
 * bytes verbatim (Static members and not-yet-compressed Stream members both
 * read fine that way). Never throws — callers can always render the result in
 * the Hex fallback.
 */
export function inflateMember(raw: Uint8Array): Uint8Array {
	// TODO(WP-2): parse the inner `00000000|innerSize|...` frame to locate the
	// deflate stream start precisely. Until then, probe a couple of candidate
	// offsets and fall back to the raw bytes.
	const candidates = [0];
	for (const off of candidates) {
		const slice = off === 0 ? raw : raw.subarray(off);
		try {
			const out = pako.inflate(slice);
			if (out && out.byteLength > 0) return out;
		} catch {
			// not a zlib stream at this offset — try the next candidate
		}
		try {
			const out = pako.inflateRaw(slice);
			if (out && out.byteLength > 0) return out;
		} catch {
			// not a raw-deflate stream at this offset either
		}
	}
	return raw;
}
