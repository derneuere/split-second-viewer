// Name-hash resolution for .ark members.
//
// The Split/Second nameHash function is only PARTIALLY cracked, so member names
// CANNOT be computed from a resource id yet. The only source of REAL names is
// the Rosetta corpus (309 hash->name pairs from the UI/texture packs), embedded
// as ROSETTA_NAMES in rosettaNames.ts. A member whose BE u32 hash appears there
// gets its real name; everything else falls back to "<hash8>.<detected-ext>".
//
// SEAM: when the hash is reversed, drop the real implementation into
// computeNameHash() below and wire a reverse map (name -> hash) — every consumer
// already routes through resolveName(), so naming ALL members becomes a one-line
// change. See computeNameHash() for the proven facts.

import { getHandlerByMagic } from '../registry';
import type { MemberType } from '../types';
import { ROSETTA_NAMES, ROSETTA_COUNT } from './rosettaNames';

export { ROSETTA_NAMES, ROSETTA_COUNT };

/** Lower-case 8-hex-digit form of a BE u32 nameHash, the Rosetta map key. */
export function hashKey(nameHash: number): string {
	return (nameHash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Resolve a member's nameHash to its REAL filename, or null if unknown.
 *
 * Today this is purely a Rosetta lookup (the hash can't be computed). When a
 * computeNameHash() exists, this stays the single resolution point: build a
 * reverse map once and merge it in here.
 */
export function resolveName(nameHash: number): string | null {
	return ROSETTA_NAMES[hashKey(nameHash)] ?? null;
}

/** True if a member's nameHash has a known real name in the Rosetta corpus. */
export function hasName(nameHash: number): boolean {
	return hashKey(nameHash) in ROSETTA_NAMES;
}

/**
 * A safe download filename for a member: its real Rosetta name if known
 * (slashes flattened, an extension appended when the name lacks one), else
 * "<hash8>.<detected-ext>". `detectedExt` is the member's sniffed extension
 * without a leading dot (e.g. 'sobj', 'geo', 'gputex'); defaults to 'bin'.
 */
export function memberFileName(nameHash: number, detectedExt = 'bin'): string {
	const ext = detectedExt.replace(/^\./, '') || 'bin';
	const name = resolveName(nameHash);
	if (name) {
		const flat = name.replace(/[\\/]/g, '_');
		return /\.[a-z0-9]+$/i.test(flat) ? flat : `${flat}.${ext}`;
	}
	return `${hashKey(nameHash)}.${ext}`;
}

/**
 * Best-effort tree/CLI label for a member:
 *   - the resolved Rosetta name if known;
 *   - otherwise "<hex> . <type>" where <type> is the sniffed payload category /
 *     extension (from `detectedType`, falling back to a magic sniff of the
 *     leading bytes), or just the hex hash when nothing is known.
 */
export function describeMember(
	nameHash: number,
	leadingBytes?: Uint8Array,
	detectedType?: MemberType,
): string {
	const hex = '0x' + (nameHash >>> 0).toString(16).toUpperCase().padStart(8, '0');
	const name = resolveName(nameHash);
	if (name) return name;
	if (detectedType) {
		return `${hex} · ${detectedType.ext}`;
	}
	if (leadingBytes) {
		const handler = getHandlerByMagic(leadingBytes);
		if (handler) return `${hex} · ${handler.key}`;
		const tag = sniffMagicTag(leadingBytes);
		if (tag) return `${hex} · ${tag}`;
	}
	return hex;
}

// ---------------------------------------------------------------------------
// computeNameHash — DOCUMENTED STUB / future seam
// ---------------------------------------------------------------------------

/**
 * Compute the 32-bit nameHash of a Split/Second resource id.
 *
 * NOT YET IMPLEMENTED — returns null. A parallel RE effort is cracking the
 * closed form; when it lands, implement this and the whole archive becomes
 * fully named (resolveName can compute a name for any member whose resource id
 * we can enumerate, e.g. from the .sectorInfo sector tables).
 *
 * PROVEN FACTS about the hash (see _tools/ark_namehash.py + wiki/format-ark.html
 * "Naming"):
 *   - Input is a resource-ID STRING of the form "<archiveTag>|<relpath>"
 *     (e.g. "CityStatic|q000_rig0", "Resident|UI/Bootup/Bootup.gfx").
 *   - The hash is GF(2)-AFFINE (linear over GF(2)): 23/23 four-way XOR-zero
 *     relations hold within an archive, so H(a) ^ H(b) ^ H(c) ^ H(d) = 0 for
 *     any four ids whose bytes XOR to zero, modulo a constant affine term.
 *   - Per-character contribution is UNIVERSAL when indexed by DISTANCE-FROM-END
 *     of the string (not absolute position).
 *   - The within-byte bit recurrence is a left-shift LFSR with polynomial
 *     0xDB710641. Last-byte single-bit contributions:
 *       bit0=0xefc26b3e bit1=0x04f5d03d bit2=0x09eba07a bit3=0x13d740f4
 *   - It is NOT any standard CRC32 / FNV-1 / FNV-1a / djb2 / Murmur / lookup3
 *     (ruled out by a full 2^32 polynomial+seed search).
 *   - The inter-byte propagation is position-keyed; the 309-pair Rosetta corpus
 *     is too sparse to pin the exact closed form.
 *
 * TODO(namehash-crack): replace the body with the affine matrix once recovered:
 *     hash = (A · bits(resourceId)) ^ c   (A: 32xN GF(2) matrix, c: const)
 * then add `for (const id of knownIds) reverse[computeNameHash(id)!] = id;`
 * inside resolveName()'s module init.
 */
export function computeNameHash(_resourceId: string): number | null {
	// Affine/LFSR facts are documented above; the closed form is not yet known.
	return null;
}

// Magic table mirrors _tools/ark_extract_full.py — coarse content tags for
// members without a dedicated handler or a detectedType.
const MAGIC_TAGS: { sig: number[]; tag: string }[] = [
	{ sig: [0x02, 0x00, 0x00, 0x08], tag: 'serialized-object' },
	{ sig: [0x57, 0xe0, 0xe0, 0x57], tag: 'havok' },
	{ sig: [0xe0, 0xe0, 0x57, 0x57], tag: 'havok-le' },
	{ sig: [0x46, 0x53, 0x42, 0x34], tag: 'fsb4' }, // FSB4
	{ sig: [0x46, 0x53, 0x42, 0x35], tag: 'fsb5' }, // FSB5
	{ sig: [0x47, 0x46, 0x58], tag: 'gfx' }, // GFX
	{ sig: [0x44, 0x44, 0x53, 0x20], tag: 'dds' }, // 'DDS '
	{ sig: [0x89, 0x50, 0x4e, 0x47], tag: 'png' },
];

function sniffMagicTag(bytes: Uint8Array): string | undefined {
	for (const { sig, tag } of MAGIC_TAGS) {
		if (bytes.byteLength < sig.length) continue;
		let ok = true;
		for (let i = 0; i < sig.length; i++) {
			if (bytes[i] !== sig[i]) { ok = false; break; }
		}
		if (ok) return tag;
	}
	return undefined;
}
