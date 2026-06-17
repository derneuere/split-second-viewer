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
// self-contained (every offset indexes its own file).
//
// MEMBER STORAGE (verified — _tools/ark_extract_full.py / ark_inflate.py):
// .ark members are stored RAW. There is NO zlib/deflate step in the .ark
// pipeline (the EBOOT's zlib is only used by Scaleform GFx / libpng for UI
// assets). On airport_test_03's 866 members: 0 were zlib/deflate, 121 carried a
// 12-byte Stream sub-frame to strip, 743 were stored raw. getMemberPayload()
// therefore: tries pako.inflate ONLY when a real zlib header (0x78 0x01/9C/DA)
// is present; else strips the 12-byte Stream sub-frame (00000000|innerSize|
// 00000000) if present; else returns the bytes verbatim.
//
// Pure module: imports only BinReader, pako, and shared types — no React.

import * as pako from 'pako';
import { BinReader } from '../binary/BinReader';
import type {
	ArchiveMember,
	ArkHeader,
	ArkSegment,
	MemberCategory,
	MemberType,
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
	//
	// CRITICAL: only offsets of NON-placeholder members (size > 0) bound a real
	// member. A size-0 placeholder can share/sit at an offset INSIDE a live
	// member's byte span; counting it as a boundary would truncate that member.
	// Mirrors `boundaries = set(offset for m if toc_size_raw)` in ark_inflate.py.
	const boundaries = Array.from(new Set(raw.filter((e) => e.size > 0).map((e) => e.offset)));
	boundaries.push(fsize);
	boundaries.sort((a, b) => a - b);
	const storedLenOf = (off: number): number => {
		for (const b of boundaries) if (b > off) return b - off;
		return Math.max(0, fsize - off);
	};

	const members: ArchiveMember[] = raw.map((e) => {
		const storedLen = e.size > 0 ? storedLenOf(e.offset) : 0;
		const member: ArchiveMember = {
			nameHash: e.nameHash,
			size: e.size,
			offset: e.offset,
			storedLen,
			segment,
			index: e.index,
		};
		// We have the segment bytes in hand — annotate framing + sniffed type so
		// the tree, CLI and viewport routing all share one detection pass.
		if (storedLen > 0) {
			const memberRaw = bytes.subarray(member.offset, Math.min(member.offset + storedLen, fsize));
			member.framed = isFramed(memberRaw);
			const payload = getMemberPayload(memberRaw);
			member.detectedType = detectMemberType(memberRaw, payload, member.framed, segment, storedLen);
		}
		return member;
	});

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

// ---------------------------------------------------------------------------
// Member payload routine (raw / frame-strip / zlib) + type detection
// ---------------------------------------------------------------------------

function u32be(b: Uint8Array, off: number): number {
	return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/**
 * A framed Stream sub-resource: `00000000 | innerSize | 00000000 | …payload…`,
 * where innerSize <= len-12 (the tail may carry alignment padding). Mirrors
 * is_framed() in _tools/ark_extract_full.py.
 */
export function isFramed(blob: Uint8Array): boolean {
	if (blob.byteLength < 12) return false;
	const w0 = u32be(blob, 0);
	const inner = u32be(blob, 4);
	const w2 = u32be(blob, 8);
	return w0 === 0 && w2 === 0 && inner > 0 && inner <= blob.byteLength - 12;
}

/** A real zlib header: 0x78 followed by 0x01 / 0x9C / 0xDA. */
function hasZlibHeader(b: Uint8Array, off: number): boolean {
	return (
		off + 2 <= b.byteLength &&
		b[off] === 0x78 &&
		(b[off + 1] === 0x01 || b[off + 1] === 0x9c || b[off + 1] === 0xda)
	);
}

/**
 * Return one member's usable payload from its raw on-disk bytes.
 *
 * Order (verified by the RE workflow — see module header & ark_inflate.py):
 *   1. pako.inflate ONLY if a genuine zlib header (0x78 0x01/9C/DA) is present
 *      at the member start or a small frame offset (real inflate ~never fires
 *      for .ark members, but kept so the routine stays correct if one ever is);
 *   2. else strip the 12-byte Stream sub-frame if present, returning exactly the
 *      inner payload (innerSize bytes);
 *   3. else return the bytes verbatim (Static serialized objects + unframed raw
 *      GPU textures).
 *
 * Never throws — a failed inflate falls through to frame-strip / raw so callers
 * can always render the result (Hex fallback at worst).
 */
export function getMemberPayload(raw: Uint8Array): Uint8Array {
	// 1) genuine zlib stream at the member start or a small header offset.
	for (const off of [0, 4, 8, 12, 16]) {
		if (off + 2 > raw.byteLength) break;
		if (hasZlibHeader(raw, off)) {
			try {
				const out = pako.inflate(off === 0 ? raw : raw.subarray(off));
				if (out && out.byteLength > 64) return out;
			} catch {
				// not actually a valid zlib stream here — fall through.
			}
		}
	}
	// 2) frame-strip (the real .ark Stream transform).
	if (isFramed(raw)) {
		const inner = u32be(raw, 4);
		const end = Math.min(12 + inner, raw.byteLength);
		return raw.slice(12, end);
	}
	// 3) raw store.
	return raw;
}

/**
 * Back-compat alias. Despite the name there is no compression in the .ark
 * pipeline; this is the raw / frame-strip / (rare) zlib payload routine.
 * Prefer getMemberPayload() in new code.
 */
export function inflateMember(raw: Uint8Array): Uint8Array {
	return getMemberPayload(raw);
}

// Magic table -> (ext, category, label). Mirrors MAGICS in ark_extract_full.py.
// `sig` is matched against the post-strip payload first, then the raw blob.
const MEMBER_MAGICS: { sig: number[]; ext: string; category: MemberCategory; label: string }[] = [
	{ sig: [0x02, 0x00, 0x00, 0x08], ext: 'sobj', category: 'model', label: 'serialized-object (02 00 00 08)' },
	{ sig: [0x57, 0xe0, 0xe0, 0x57], ext: 'hkx', category: 'havok', label: 'Havok (57 E0 E0 57)' },
	{ sig: [0xe0, 0xe0, 0x57, 0x57], ext: 'hkx', category: 'havok', label: 'Havok (LE variant)' },
	{ sig: [0x46, 0x53, 0x42, 0x34], ext: 'fsb', category: 'fsb', label: 'FMOD FSB4' },
	{ sig: [0x46, 0x53, 0x42, 0x35], ext: 'fsb', category: 'fsb', label: 'FMOD FSB5' },
	{ sig: [0x47, 0x46, 0x58], ext: 'gfx', category: 'gfx', label: 'Scaleform GFX' },
	{ sig: [0x43, 0x46, 0x58], ext: 'cfx', category: 'gfx', label: 'Scaleform CFX (compressed)' },
	{ sig: [0x44, 0x44, 0x53, 0x20], ext: 'dds', category: 'texture', label: 'DDS texture' },
	{ sig: [0x89, 0x50, 0x4e, 0x47], ext: 'png', category: 'texture', label: 'PNG' },
	{ sig: [0x42, 0x49, 0x4b, 0x69], ext: 'bik', category: 'other', label: 'Bink video' },
	{ sig: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], ext: 'xml', category: 'xml', label: 'XML' },
];

// Mip-chain-typical texture payload sizes seen in Stream members.
const TEX_SIZES = new Set([
	0x10200, 0x2ab00, 0x5580, 0xab00, 0x15580, 0x55580, 0x55600, 0x155580, 0xaab00, 0x2aab00,
]);

function matchMagic(b: Uint8Array): { ext: string; category: MemberCategory; label: string } | null {
	for (const m of MEMBER_MAGICS) {
		if (b.byteLength < m.sig.length) continue;
		let ok = true;
		for (let i = 0; i < m.sig.length; i++) {
			if (b[i] !== m.sig[i]) { ok = false; break; }
		}
		if (ok) return { ext: m.ext, category: m.category, label: m.label };
	}
	return null;
}

/**
 * Detect a member's content type from its raw blob + de-framed payload + segment.
 * Mirrors classify() in _tools/ark_extract_full.py:
 *   - magic on the payload (post-strip) first, then on the raw blob;
 *   - else framed Stream members -> '.geo' (geometry/vertex stream);
 *   - else a texture-header (0001xxxx) or mip-sized blob -> '.gputex';
 *   - else any unframed non-serialized Stream blob -> '.gputex' (GPU texture);
 *   - else '.bin' (unknown).
 *
 * `storedLen` lets the mip-size heuristic fire even when only leading bytes are
 * available (pass the member's storedLen, or payload.byteLength if unknown).
 */
export function detectMemberType(
	blob: Uint8Array,
	payload: Uint8Array,
	framed: boolean,
	segment: ArkSegment,
	storedLen: number,
): MemberType {
	const m = matchMagic(payload) ?? matchMagic(blob);
	if (m) return m;
	if (framed) {
		return { ext: 'geo', category: 'model', label: 'stream-framed geometry/vertex stream' };
	}
	const isTexHeader = blob.byteLength >= 2 && blob[0] === 0x00 && blob[1] === 0x01;
	if (isTexHeader || TEX_SIZES.has(storedLen)) {
		return { ext: 'gputex', category: 'texture', label: 'PS3 GPU texture (header 0001xxxx / mip-sized)' };
	}
	if (segment === 'stream') {
		return { ext: 'gputex', category: 'texture', label: 'PS3 GPU texture (swizzled/DXT, unframed)' };
	}
	const head = Array.from(blob.subarray(0, 4)).map((x) => x.toString(16).padStart(2, '0')).join('');
	return { ext: 'bin', category: 'other', label: 'unknown:' + head };
}

/**
 * Slice + de-frame + type-detect one member from its segment bytes in a single
 * pass. Returns the usable payload alongside its sniffed type and framing flag.
 * This is the headless equivalent of what the Workspace does on selection.
 */
export function extractMember(
	segmentBytes: Uint8Array,
	member: ArchiveMember,
): { payload: Uint8Array; framed: boolean; type: MemberType } {
	const raw = readMemberRaw(segmentBytes, member);
	const framed = isFramed(raw);
	const payload = getMemberPayload(raw);
	const type = detectMemberType(raw, payload, framed, member.segment, member.storedLen);
	return { payload, framed, type };
}
