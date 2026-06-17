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
	closeArchive: (id: ArchiveId) => void;
	closeLoose: (id: LooseId) => void;

	/** Extract a Resource's usable bytes (de-framed Stream members). */
	getResourceRaw: (ref: ResourceRef) => Uint8Array | null;
	/** Resolve the handler for a Resource (by extension, category, or magic). */
	getHandler: (ref: ResourceRef) => ResourceHandler | undefined;
	/** Suggested download filename (real Rosetta name or "<hash8>.<ext>"). */
	getResourceFileName: (ref: ResourceRef) => string;
	/** All addressable Resource refs in an Archive (both segments). */
	membersOf: (id: ArchiveId) => ResourceRef[];

	// selection
	selection: WorkspaceSelection;
	select: (next: WorkspaceSelection) => void;

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
	// Visibility map: key -> explicit boolean. Absent = visible (default true).
	const [visibility, setVisibilityMap] = useState<Record<string, boolean>>({});

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

	const closeArchive = useCallback((id: ArchiveId) => {
		setArchives((prev) => prev.filter((a) => a.id !== id));
		setSelection((sel) =>
			sel?.ref.kind === 'member' && sel.ref.archiveId === id ? null : sel,
		);
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
				return looseFiles.find((lf) => lf.looseId === ref.looseId)?.bytes ?? null;
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
		[findArchive, looseFiles],
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
			if (ref.kind === 'loose') return ref.looseId.replace(/[\\/]/g, '_');
			const member = findMember(ref);
			return memberFileName(ref.nameHash, member?.detectedType?.ext);
		},
		[findMember],
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

	const select = useCallback((next: WorkspaceSelection) => setSelection(next), []);

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

	const tree = useMemo(
		() => buildTree(archives, looseFiles, segmentBytesFor),
		[archives, looseFiles, segmentBytesFor],
	);

	// Read-only MVP: no undo stack yet (TODO: write packages).
	const noop = useCallback(() => {}, []);

	const value = useMemo<WorkspaceContextValue>(
		() => ({
			archives,
			looseFiles,
			tree,
			loadArchive,
			loadLoose,
			closeArchive,
			closeLoose,
			getResourceRaw,
			getHandler,
			getResourceFileName,
			membersOf,
			selection,
			select,
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
			closeArchive,
			closeLoose,
			getResourceRaw,
			getHandler,
			getResourceFileName,
			membersOf,
			selection,
			select,
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
