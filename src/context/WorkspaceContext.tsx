// WorkspaceContext — the editor session. Holds loaded .ark Archives AND loose
// files as ONE unified Resource tree (PORT-BRIEF §5). Read-only MVP: selection
// and per-node visibility work; editing (setResource / undo) is stubbed with a
// clear TODO seam so the write packages can land without reshaping the context.
//
// Vocabulary (CONTEXT.md / PORT-BRIEF §3): Workspace, Archive, Resource,
// LooseFile, Selection, Visibility, Undo stack.

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import {
	parseArk,
	levelFromFilename,
	readMemberRaw,
	getMemberPayload,
} from '@/lib/core/ark/ArkArchive';
import { describeMember, memberFileName } from '@/lib/core/ark/nameHash';
import { ingestLoose, type LooseFile } from '@/lib/core/loose';
import { loadLevelGeometry, type LevelGeometry } from '@/lib/core/levelGeometry';
import {
	enumerateDirectory,
	readFileBytes,
	getCachedBytes,
	clearByteCache,
	type DirEntry,
} from '@/lib/core/fs/directory';
import {
	getHandlerByCategory,
	getHandlerByExtension,
	getHandlerByMagic,
	type ResourceHandler,
} from '@/lib/core/registry';
import type {
	ArchiveId,
	ArchiveMember,
	LooseId,
	ParsedArchive,
	ResourceRef,
} from '@/lib/core/types';
import { refKey } from '@/lib/core/types';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One loaded Archive (Static+Stream pair) in the Workspace. */
export type EditableArchive = {
	id: ArchiveId; // level name
	parsed: ParsedArchive;
	/** Original bytes per segment — for byte-exact pass-through + member reads. */
	staticBytes: Uint8Array;
	streamBytes?: Uint8Array;
};

/** One loaded loose file in the Workspace. */
export type EditableLooseFile = LooseFile;

// ---------------------------------------------------------------------------
// Unified tree
// ---------------------------------------------------------------------------

export type TreeNodeKind = 'archive' | 'segment' | 'folder' | 'resource';

export type TreeNode = {
	id: string; // stable node id (path-like)
	kind: TreeNodeKind;
	label: string;
	depth: number;
	/** Present on resource leaves — the addressable Resource. */
	ref?: ResourceRef;
	/** Resolved handler for resource leaves, if any. */
	handler?: ResourceHandler;
	children?: TreeNode[];
};

// ---------------------------------------------------------------------------
// Selection / Visibility
// ---------------------------------------------------------------------------

/** What the inspector / viewport is focused on. `null` = nothing selected. */
export type WorkspaceSelection = { ref: ResourceRef } | null;

/** A node whose visibility can be toggled. Resources cascade from containers. */
export type VisibilityNode =
	| { archiveId: ArchiveId }
	| { archiveId: ArchiveId; nameHash: number }
	| { looseId: LooseId };

function visibilityKey(node: VisibilityNode): string {
	if ('looseId' in node) return `loose:${node.looseId}`;
	if ('nameHash' in node) return `member:${node.archiveId}:${node.nameHash >>> 0}`;
	return `archive:${node.archiveId}`;
}

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export type WorkspaceContextValue = {
	archives: readonly EditableArchive[];
	looseFiles: readonly EditableLooseFile[];

	/** The unified Resource tree (archives + loose). Recomputed on load/close. */
	tree: TreeNode[];

	loadArchive: (staticFile: File, streamFile?: File) => Promise<void>;
	loadLoose: (file: File) => Promise<void>;
	/**
	 * Pick & load a whole Split/Second install folder: enumerate STRUCTURE
	 * eagerly (folders + filenames) into the unified tree; file bytes are read
	 * lazily on selection via getResourceBytes.
	 */
	loadDirectory: (dirHandle: FileSystemDirectoryHandle) => Promise<void>;
	closeArchive: (id: ArchiveId) => void;
	closeLoose: (id: LooseId) => void;
	/** True once a directory tree has been loaded (drives the empty-state UI). */
	hasDirectory: boolean;

	/**
	 * Extract a Resource's usable bytes (de-framed Stream members). SYNC: returns
	 * already-in-memory bytes (loose / ark members) or the cache for a
	 * directory-backed file; returns null if a directory file hasn't been read
	 * yet — use the async getResourceBytes for that case.
	 */
	getResourceRaw: (ref: ResourceRef) => Uint8Array | null;
	/**
	 * ASYNC byte access: resolves in-memory bytes immediately, or lazily reads +
	 * caches a directory-backed file's bytes on first request. For .ark files in
	 * a directory it loads the archive (pairing the Static/Stream sibling) and
	 * returns null (the caller should re-select the materialised archive).
	 */
	getResourceBytes: (ref: ResourceRef) => Promise<Uint8Array | null>;
	/** Resolve the handler for a Resource (by extension, category, or magic). */
	getHandler: (ref: ResourceRef) => ResourceHandler | undefined;
	/**
	 * Open a directory-backed .ark file: read its Static bytes, locate the
	 * Stream sibling in the same folder by name, parse, add to `archives`, and
	 * return the new ArchiveId so the caller can select it. No-op (returns null)
	 * for non-.ark or unknown paths.
	 */
	openArkFromDir: (looseId: LooseId) => Promise<ArchiveId | null>;
	/** Whether a directory-backed loose path is an openable .ark file. */
	isArkPath: (looseId: LooseId) => boolean;
	/** Suggested download filename (real Rosetta name or "<hash8>.<ext>"). */
	getResourceFileName: (ref: ResourceRef) => string;
	/** All addressable Resource refs in an Archive (both segments). */
	membersOf: (id: ArchiveId) => ResourceRef[];
	/**
	 * Decode EVERY geometry member of a loaded Archive into one world-space scene
	 * for the MapViewer ("Render whole level"). Returns null when the archive
	 * isn't loaded. Pure synchronous decode over the in-memory segment bytes;
	 * `maxMembers` caps the decode for very large levels.
	 */
	buildLevelGeometry: (id: ArchiveId, opts?: { maxMembers?: number }) => LevelGeometry | null;

	// selection
	selection: WorkspaceSelection;
	select: (next: WorkspaceSelection) => void;

	/**
	 * Whole-level view target (orthogonal to `selection`): the ArchiveId the user
	 * asked to "Render whole level", or null. Setting it switches the viewport to
	 * the MapViewer; selecting any normal resource clears it.
	 */
	levelView: ArchiveId | null;
	setLevelView: (id: ArchiveId | null) => void;

	// visibility
	isVisible: (node: VisibilityNode) => boolean;
	setVisibility: (node: VisibilityNode, visible: boolean) => void;

	// TODO(write packages): undo/redo stack + setResource. Read-only MVP.
	canUndo: boolean;
	canRedo: boolean;
	undo: () => void;
	redo: () => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileBytes(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer());
}

/** Match a Static file with its Stream twin from a multi-file drop, if present. */
export function findStreamTwin(staticName: string, files: File[]): File | undefined {
	const stream = staticName.replace(/\.Static\.ark$/i, '.Stream.ark');
	return files.find((f) => f.name === stream);
}

function buildTree(
	archives: readonly EditableArchive[],
	looseFiles: readonly EditableLooseFile[],
	segmentBytesFor: (archiveId: ArchiveId, seg: 'static' | 'stream') => Uint8Array | undefined,
): TreeNode[] {
	const nodes: TreeNode[] = [];

	for (const arc of archives) {
		const segmentChildren: TreeNode[] = [];
		for (const seg of ['static', 'stream'] as const) {
			const segMembers = arc.parsed.members.filter((m) => m.segment === seg);
			if (segMembers.length === 0) continue;
			const segBytes = segmentBytesFor(arc.id, seg);
			const memberNodes: TreeNode[] = segMembers.map((m) => {
				const leading = segBytes ? peekLeading(segBytes, m) : undefined;
				return {
					id: `${arc.id}/${seg}/${m.nameHash >>> 0}`,
					kind: 'resource',
					label: describeMember(m.nameHash, leading, m.detectedType),
					depth: 2,
					ref: { kind: 'member', archiveId: arc.id, nameHash: m.nameHash },
					handler: handlerForMember(m, leading),
				};
			});
			segmentChildren.push({
				id: `${arc.id}/${seg}`,
				kind: 'segment',
				label: seg === 'static' ? 'Static' : 'Stream',
				depth: 1,
				children: memberNodes,
			});
		}
		nodes.push({
			id: arc.id,
			kind: 'archive',
			label: arc.id,
			depth: 0,
			children: segmentChildren,
		});
	}

	if (looseFiles.length > 0) {
		nodes.push({
			id: '__loose__',
			kind: 'folder',
			label: 'Loose files',
			depth: 0,
			children: looseFiles.map((lf) => ({
				id: `loose/${lf.looseId}`,
				kind: 'resource' as const,
				label: lf.looseId,
				depth: 1,
				ref: { kind: 'loose', looseId: lf.looseId },
				handler: lf.handler,
			})),
		});
	}

	return nodes;
}

function peekLeading(segBytes: Uint8Array, m: ArchiveMember): Uint8Array {
	const end = Math.min(m.offset + 16, segBytes.byteLength);
	return segBytes.subarray(m.offset, end);
}

/** Is this a .Static.ark / .Stream.ark / .ark path (so we treat it as an archive)? */
function isArkName(name: string): boolean {
	return /\.ark$/i.test(name);
}

/**
 * A .Stream.ark is the *twin* of a .Static.ark — it carries no TOC the user
 * opens directly, so we hide lone Stream leaves and surface only the Static (or
 * a bare .ark). Returns true for a Stream sibling that should be folded away.
 */
function isStreamTwinName(name: string): boolean {
	return /\.Stream\.ark$/i.test(name);
}

/**
 * Build the unified tree from an enumerated directory. Folders become `folder`
 * group nodes; files become `resource` leaves keyed by their path (a `loose`
 * ref). Routing is by extension via the registry. .Stream.ark twins are folded
 * away (the .Static.ark leaf opens the pair); empty folders are pruned so the
 * tree stays navigable across ~15k entries.
 *
 * `loadedArchiveIds` lets an already-materialised archive (opened from an .ark
 * leaf) be rendered with its members in place of the bare leaf — but to keep
 * this simple the materialised archive is appended at the top level by buildTree
 * and the .ark leaf simply re-selects it, so here we only mark the leaf.
 */
function buildDirTree(rootEntry: DirEntry): TreeNode[] {
	function toNode(entry: DirEntry, depth: number): TreeNode | null {
		if (entry.kind === 'dir') {
			const children: TreeNode[] = [];
			for (const child of entry.children ?? []) {
				const node = toNode(child, depth + 1);
				if (node) children.push(node);
			}
			if (children.length === 0) return null; // prune empty folders
			return {
				id: `dir:${entry.path}`,
				kind: 'folder',
				label: entry.name,
				depth,
				children,
			};
		}
		// File leaf. Fold away .Stream.ark twins — the Static leaf opens the pair.
		if (isStreamTwinName(entry.name)) return null;
		const ref: ResourceRef = { kind: 'loose', looseId: entry.path };
		return {
			id: `file:${entry.path}`,
			kind: 'resource',
			label: entry.name,
			depth,
			ref,
			handler: getHandlerByExtension(entry.name),
		};
	}

	// The root's own children become the top-level nodes (don't show the picked
	// folder itself as a wrapper — the user already knows what they picked).
	const top: TreeNode[] = [];
	for (const child of rootEntry.children ?? []) {
		const node = toNode(child, 0);
		if (node) top.push(node);
	}
	return top;
}

/**
 * Resolve the handler for an .ark member: prefer routing by the sniffed content
 * category (so framed .geo -> model/MeshViewer and unframed .gputex ->
 * streamtex/TextureViewer even though neither carries a magic), then fall back
 * to a leading-bytes magic sniff.
 */
export function handlerForMember(
	m: ArchiveMember,
	leading?: Uint8Array,
): ResourceHandler | undefined {
	if (m.detectedType) {
		const byCat = getHandlerByCategory(m.detectedType.category, m.detectedType.ext);
		if (byCat) return byCat;
	}
	return leading ? getHandlerByMagic(leading) : undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WorkspaceProvider({ children }: { children: ReactNode }) {
	const [archives, setArchives] = useState<EditableArchive[]>([]);
	const [looseFiles, setLooseFiles] = useState<EditableLooseFile[]>([]);
	const [selection, setSelection] = useState<WorkspaceSelection>(null);
	const [levelView, setLevelViewState] = useState<ArchiveId | null>(null);
	// Visibility map: key -> explicit boolean. Absent = visible (default true).
	const [visibility, setVisibilityMap] = useState<Record<string, boolean>>({});
	// Directory-backed structure (File System Access API). The enumerated tree is
	// STRUCTURE only — bytes load lazily on selection. `dirIndex` maps a file's
	// path -> its DirEntry (with handle) for O(1) lazy reads + sibling lookup.
	const [dirTree, setDirTree] = useState<DirEntry | null>(null);
	const dirIndexRef = useRef<Map<string, DirEntry>>(new Map());

	const findArchive = useCallback(
		(id: ArchiveId) => archives.find((a) => a.id === id),
		[archives],
	);

	const segmentBytesFor = useCallback(
		(archiveId: ArchiveId, seg: 'static' | 'stream') => {
			const arc = archives.find((a) => a.id === archiveId);
			if (!arc) return undefined;
			return seg === 'static' ? arc.staticBytes : arc.streamBytes;
		},
		[archives],
	);

	const loadArchive = useCallback(async (staticFile: File, streamFile?: File) => {
		const staticBytes = await fileBytes(staticFile);
		const streamBytes = streamFile ? await fileBytes(streamFile) : undefined;
		const level = levelFromFilename(staticFile.name);
		const parsed = parseArk(staticBytes, streamBytes, level);
		setArchives((prev) => {
			const next = prev.filter((a) => a.id !== level);
			return [...next, { id: level, parsed, staticBytes, streamBytes }];
		});
	}, []);

	const loadLoose = useCallback(async (file: File) => {
		const bytes = await fileBytes(file);
		const loose = ingestLoose(file.name, bytes);
		setLooseFiles((prev) => {
			const next = prev.filter((lf) => lf.looseId !== loose.looseId);
			return [...next, loose];
		});
	}, []);

	const loadDirectory = useCallback(async (dirHandle: FileSystemDirectoryHandle) => {
		const root = await enumerateDirectory(dirHandle);
		// Index every FILE entry by path for O(1) lazy reads + sibling lookup.
		const index = new Map<string, DirEntry>();
		const walk = (entry: DirEntry) => {
			if (entry.kind === 'file') index.set(entry.path, entry);
			for (const child of entry.children ?? []) walk(child);
		};
		walk(root);
		dirIndexRef.current = index;
		clearByteCache();
		// A fresh directory replaces any prior directory + ad-hoc loads + selection.
		setArchives([]);
		setLooseFiles([]);
		setSelection(null);
		setLevelViewState(null);
		setDirTree(root);
	}, []);

	/** Look up a directory file entry by its path (= looseId), or undefined. */
	const dirEntryFor = useCallback((looseId: LooseId): DirEntry | undefined => {
		return dirIndexRef.current.get(looseId);
	}, []);

	const isArkPath = useCallback(
		(looseId: LooseId): boolean => isArkName(looseId) && !!dirEntryFor(looseId),
		[dirEntryFor],
	);

	/**
	 * Open a directory-backed .ark by path: read the chosen file's bytes, locate
	 * its Static/Stream sibling in the SAME folder by name, parse the pair, and
	 * add the archive. Returns the new ArchiveId. The level id is suffixed with
	 * the folder path so two levels named the same in different folders don't
	 * collide.
	 */
	const openArkFromDir = useCallback(
		async (looseId: LooseId): Promise<ArchiveId | null> => {
			const entry = dirEntryFor(looseId);
			if (!entry?.handle || !isArkName(entry.name)) return null;

			const slash = looseId.lastIndexOf('/');
			const folder = slash >= 0 ? looseId.slice(0, slash) : '';
			const base = entry.name;

			// Derive the Static + Stream member names from whichever twin was picked.
			let staticName: string;
			let streamName: string | undefined;
			if (/\.Static\.ark$/i.test(base)) {
				staticName = base;
				streamName = base.replace(/\.Static\.ark$/i, '.Stream.ark');
			} else if (/\.Stream\.ark$/i.test(base)) {
				streamName = base;
				staticName = base.replace(/\.Stream\.ark$/i, '.Static.ark');
			} else {
				staticName = base; // a bare ".ark" — open it alone
			}

			const pathIn = (name: string) => (folder ? `${folder}/${name}` : name);
			const staticEntry = dirEntryFor(pathIn(staticName)) ?? entry;
			const streamEntry = streamName ? dirEntryFor(pathIn(streamName)) : undefined;
			if (!staticEntry.handle) return null;

			const staticBytes = await readFileBytes(staticEntry.handle, staticEntry.path);
			const streamBytes = streamEntry?.handle
				? await readFileBytes(streamEntry.handle, streamEntry.path)
				: undefined;

			// Disambiguate by folder so duplicate level names across folders are distinct.
			const level = levelFromFilename(staticName);
			const id: ArchiveId = folder ? `${folder}/${level}` : level;
			const parsed = parseArk(staticBytes, streamBytes, level);
			setArchives((prev) => {
				const next = prev.filter((a) => a.id !== id);
				return [...next, { id, parsed, staticBytes, streamBytes }];
			});
			return id;
		},
		[dirEntryFor],
	);

	const closeArchive = useCallback((id: ArchiveId) => {
		setArchives((prev) => prev.filter((a) => a.id !== id));
		setSelection((sel) =>
			sel?.ref.kind === 'member' && sel.ref.archiveId === id ? null : sel,
		);
		setLevelViewState((lv) => (lv === id ? null : lv));
	}, []);

	const closeLoose = useCallback((id: LooseId) => {
		setLooseFiles((prev) => prev.filter((lf) => lf.looseId !== id));
		setSelection((sel) =>
			sel?.ref.kind === 'loose' && sel.ref.looseId === id ? null : sel,
		);
	}, []);

	const getResourceRaw = useCallback(
		(ref: ResourceRef): Uint8Array | null => {
			if (ref.kind === 'loose') {
				// In-memory loose file (drag-drop / file input) takes priority…
				const inMem = looseFiles.find((lf) => lf.looseId === ref.looseId)?.bytes;
				if (inMem) return inMem;
				// …else a directory-backed file: return cached bytes if already read.
				if (dirEntryFor(ref.looseId)) return getCachedBytes(ref.looseId) ?? null;
				return null;
			}
			const arc = findArchive(ref.archiveId);
			if (!arc) return null;
			const member = arc.parsed.members.find((m) => m.nameHash === ref.nameHash);
			if (!member) return null;
			const segBytes = member.segment === 'static' ? arc.staticBytes : arc.streamBytes;
			if (!segBytes) return null;
			const raw = readMemberRaw(segBytes, member);
			// De-frame / (rarely) decompress every member uniformly. getMemberPayload
			// is a no-op for raw Static objects and unframed textures, and strips the
			// 12-byte sub-frame from framed Stream geometry.
			return getMemberPayload(raw);
		},
		[findArchive, looseFiles, dirEntryFor],
	);

	/**
	 * Async byte access. Members + in-memory loose files resolve synchronously
	 * (wrapped in a promise); a directory-backed file is read + cached lazily on
	 * first request. .ark directory files are NOT byte-served here (open them via
	 * openArkFromDir) — we return null so the caller materialises the archive.
	 */
	const getResourceBytes = useCallback(
		async (ref: ResourceRef): Promise<Uint8Array | null> => {
			if (ref.kind === 'member') return getResourceRaw(ref);
			const inMem = looseFiles.find((lf) => lf.looseId === ref.looseId)?.bytes;
			if (inMem) return inMem;
			const entry = dirEntryFor(ref.looseId);
			if (!entry?.handle) return getResourceRaw(ref);
			if (isArkName(entry.name)) return null; // archive — caller uses openArkFromDir
			return readFileBytes(entry.handle, entry.path);
		},
		[getResourceRaw, looseFiles, dirEntryFor],
	);

	const findMember = useCallback(
		(ref: ResourceRef): ArchiveMember | undefined => {
			if (ref.kind !== 'member') return undefined;
			const arc = findArchive(ref.archiveId);
			return arc?.parsed.members.find((m) => m.nameHash === ref.nameHash);
		},
		[findArchive],
	);

	const getHandler = useCallback(
		(ref: ResourceRef): ResourceHandler | undefined => {
			if (ref.kind === 'loose') {
				return getHandlerByExtension(ref.looseId);
			}
			const member = findMember(ref);
			if (member) {
				const raw = getResourceRaw(ref);
				return handlerForMember(member, raw ?? undefined);
			}
			const raw = getResourceRaw(ref);
			return raw ? getHandlerByMagic(raw) : undefined;
		},
		[findMember, getResourceRaw],
	);

	/** Suggested download filename for a Resource (real name or "<hash8>.<ext>"). */
	const getResourceFileName = useCallback(
		(ref: ResourceRef): string => {
			if (ref.kind === 'loose') {
				// Directory-backed file: download under its real base name.
				const entry = dirEntryFor(ref.looseId);
				if (entry) return entry.name;
				return ref.looseId.replace(/[\\/]/g, '_');
			}
			const member = findMember(ref);
			return memberFileName(ref.nameHash, member?.detectedType?.ext);
		},
		[findMember, dirEntryFor],
	);

	/** Every member of an Archive as an addressable ResourceRef (for Extract all). */
	const membersOf = useCallback(
		(id: ArchiveId): ResourceRef[] => {
			const arc = findArchive(id);
			if (!arc) return [];
			return arc.parsed.members
				.filter((m) => m.storedLen > 0)
				.map((m) => ({ kind: 'member' as const, archiveId: id, nameHash: m.nameHash }));
		},
		[findArchive],
	);

	/** Decode every geometry member of an Archive into one world-space scene. */
	const buildLevelGeometry = useCallback(
		(id: ArchiveId, opts?: { maxMembers?: number }): LevelGeometry | null => {
			const arc = findArchive(id);
			if (!arc) return null;
			const segBytes = (seg: 'static' | 'stream') =>
				seg === 'static' ? arc.staticBytes : arc.streamBytes;
			return loadLevelGeometry(arc.parsed, segBytes, opts);
		},
		[findArchive],
	);

	// Selecting any normal resource leaves the whole-level view.
	const select = useCallback((next: WorkspaceSelection) => {
		setSelection(next);
		if (next) setLevelViewState(null);
	}, []);

	const setLevelView = useCallback((id: ArchiveId | null) => {
		setLevelViewState(id);
		if (id) setSelection(null); // the map takes over the viewport
	}, []);

	const isVisible = useCallback(
		(node: VisibilityNode): boolean => {
			// Cascade: a member is hidden if its archive is explicitly hidden.
			if ('nameHash' in node) {
				const arc = visibility[visibilityKey({ archiveId: node.archiveId })];
				if (arc === false) return false;
			}
			const own = visibility[visibilityKey(node)];
			return own !== false;
		},
		[visibility],
	);

	const setVisibility = useCallback((node: VisibilityNode, visible: boolean) => {
		setVisibilityMap((prev) => ({ ...prev, [visibilityKey(node)]: visible }));
	}, []);

	const tree = useMemo(() => {
		// Drag-drop / file-input mode: archives + loose at the top level.
		if (!dirTree) return buildTree(archives, looseFiles, segmentBytesFor);

		// Directory mode: the enumerated folder hierarchy is the tree. Any .ark
		// the user has opened is surfaced under an "Opened archives" group (with
		// its Static/Stream members), so the directory tree itself stays intact.
		const dirNodes = buildDirTree(dirTree);
		if (archives.length === 0) return dirNodes;

		const archiveNodes = buildTree(archives, [], segmentBytesFor);
		const bumpDepth = (n: TreeNode): TreeNode => ({
			...n,
			depth: n.depth + 1,
			children: n.children?.map(bumpDepth),
		});
		return [
			{
				id: '__opened_archives__',
				kind: 'folder' as const,
				label: 'Opened archives',
				depth: 0,
				children: archiveNodes.map(bumpDepth),
			},
			...dirNodes,
		];
	}, [dirTree, archives, looseFiles, segmentBytesFor]);

	const hasDirectory = dirTree !== null;

	// Read-only MVP: no undo stack yet (TODO: write packages).
	const noop = useCallback(() => {}, []);

	const value = useMemo<WorkspaceContextValue>(
		() => ({
			archives,
			looseFiles,
			tree,
			loadArchive,
			loadLoose,
			loadDirectory,
			closeArchive,
			closeLoose,
			hasDirectory,
			getResourceRaw,
			getResourceBytes,
			getHandler,
			openArkFromDir,
			isArkPath,
			getResourceFileName,
			membersOf,
			buildLevelGeometry,
			selection,
			select,
			levelView,
			setLevelView,
			isVisible,
			setVisibility,
			canUndo: false,
			canRedo: false,
			undo: noop,
			redo: noop,
		}),
		[
			archives,
			looseFiles,
			tree,
			loadArchive,
			loadLoose,
			loadDirectory,
			closeArchive,
			closeLoose,
			hasDirectory,
			getResourceRaw,
			getResourceBytes,
			getHandler,
			openArkFromDir,
			isArkPath,
			getResourceFileName,
			membersOf,
			buildLevelGeometry,
			selection,
			select,
			levelView,
			setLevelView,
			isVisible,
			setVisibility,
			noop,
		],
	);

	return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
	const ctx = useContext(WorkspaceContext);
	if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
	return ctx;
}

// re-export for consumers that import the ref type alongside the hook
export { refKey };
