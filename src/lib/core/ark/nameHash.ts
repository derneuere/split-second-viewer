// Name-hash resolution for .ark members.
//
// The Split/Second nameHash function is NOT yet cracked. Until it is, members
// are addressed by their BE u32 hash and a guessed type from magic-sniffing
// the leading bytes (see ../registry getHandlerByMagic). This module ships a
// stub lookup table + a magic-sniff fallback so the UI can label members.
//
// When the hash is reversed, populate KNOWN_NAMES (hash -> filename) — every
// consumer already routes through resolveName().

import { getHandlerByMagic } from '../registry';

/** Hand-maintained nameHash -> filename table. Empty until the hash is cracked. */
export const KNOWN_NAMES: Record<number, string> = {
	// 0x000ecb73: 'Track.model',
};

/** Resolve a member's nameHash to a filename, or undefined if unknown. */
export function resolveName(nameHash: number): string | undefined {
	return KNOWN_NAMES[nameHash >>> 0];
}

/**
 * Best-effort label for a member: the resolved filename if known, otherwise a
 * magic-sniffed type tag (e.g. `0x01C17470 [serialized-object]`) or just the
 * hex hash. Used by the resource tree and the CLI listing.
 */
export function describeMember(nameHash: number, leadingBytes?: Uint8Array): string {
	const hex = '0x' + (nameHash >>> 0).toString(16).toUpperCase().padStart(8, '0');
	const name = resolveName(nameHash);
	if (name) return name;
	if (leadingBytes) {
		const handler = getHandlerByMagic(leadingBytes);
		if (handler) return `${hex} [${handler.key}]`;
		const tag = sniffMagicTag(leadingBytes);
		if (tag) return `${hex} [${tag}]`;
	}
	return hex;
}

// Magic table mirrors _tools/ark_extract.py — coarse content tags for members
// without a dedicated handler yet.
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
