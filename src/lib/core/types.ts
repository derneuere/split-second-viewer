// Shared domain types for Split/Second Steward — the data shapes the .ark
// parser, the loose loader, and the Workspace context all agree on.
//
// Vocabulary (CONTEXT.md, adapted in PORT-BRIEF.md §3): Workspace / Archive /
// Resource / Handler / LooseFile. An Archive is the Static+Stream .ark PAIR
// for one level; a LooseFile is one individually-opened file. Both surface as
// Resources in the unified tree.

export const PLATFORMS = { PC: 1, XBOX360: 2, PS3: 3 } as const;
export type PlatformId = typeof PLATFORMS[keyof typeof PLATFORMS];

// ---------------------------------------------------------------------------
// .ark container
// ---------------------------------------------------------------------------

/**
 * The 16-byte .ark header (big-endian). `dataStart` always equals
 * 0x10 + count * entrySize; `entrySize` is always 0x10 in observed samples.
 */
export type ArkHeader = {
	version: number;
	dataStart: number;
	count: number;
	entrySize: number;
};

/** Which file of the Static/Stream pair a member came from. */
export type ArkSegment = 'static' | 'stream';

/**
 * One member parsed from an .ark TOC (all fields big-endian). `storedLen` is
 * NOT in the file — it is derived as the gap to the next-higher offset
 * (clamped to EOF for the last member), giving the on-disk byte span.
 */
export type ArchiveMember = {
	/** BE u32 name/content hash. Stable across levels; the TOC sort key. */
	nameHash: number;
	/** Member size from the TOC — treated as the decompressed / in-memory hint. */
	size: number;
	/** Absolute byte offset into this member's own .ark file. */
	offset: number;
	/** Derived on-disk length (distance to next offset / EOF). */
	storedLen: number;
	/** Which file of the pair this member belongs to. */
	segment: ArkSegment;
	/** Position within the TOC, as read. */
	index: number;
};

/**
 * A parsed Static/Stream .ark pair for one level. `members` merges both
 * segments, sorted by nameHash.
 */
export type ParsedArchive = {
	/** Level identity, e.g. 'Downtown', 'docks'. Derived from the filename. */
	level: string;
	staticHeader: ArkHeader;
	streamHeader?: ArkHeader;
	members: ArchiveMember[];
};

// ---------------------------------------------------------------------------
// Resource references — how the Workspace addresses a single Resource
// ---------------------------------------------------------------------------

export type ArchiveId = string; // '<Level>' — the Static/Stream pair identity
export type LooseId = string;   // the loose file's path / name

/**
 * Stable address of one Resource in the Workspace. A member lives inside an
 * Archive keyed by nameHash; a loose file is keyed by its path. Both resolve
 * to bytes via extractResourceRaw(ref) and then to a model via the handler.
 */
export type ResourceRef =
	| { kind: 'member'; archiveId: ArchiveId; nameHash: number }
	| { kind: 'loose'; looseId: LooseId };

export function refKey(ref: ResourceRef): string {
	return ref.kind === 'member'
		? `member:${ref.archiveId}:${ref.nameHash >>> 0}`
		: `loose:${ref.looseId}`;
}
