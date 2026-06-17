// Virtualized unified Resource tree: archives (Static/Stream segments + members)
// and loose files. Flattens the TreeNode hierarchy honoring per-node collapse,
// renders only the visible window via @tanstack/react-virtual.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
	ChevronDown,
	ChevronRight,
	DownloadCloud,
	Eye,
	EyeOff,
	FileBox,
	Folder,
	Layers,
	Map as MapIcon,
	Package,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
	useWorkspace,
	type TreeNode,
	type VisibilityNode,
} from '@/context/WorkspaceContext';
import type { ResourceRef } from '@/lib/core/types';
import { refKey } from '@/lib/core/types';
import { extractAll } from '@/lib/download';

type FlatRow = { node: TreeNode; expandable: boolean; expanded: boolean };

function flatten(
	nodes: TreeNode[],
	collapsed: Set<string>,
	out: FlatRow[] = [],
): FlatRow[] {
	for (const node of nodes) {
		const expandable = !!node.children && node.children.length > 0;
		const expanded = expandable && !collapsed.has(node.id);
		out.push({ node, expandable, expanded });
		if (expandable && expanded) flatten(node.children!, collapsed, out);
	}
	return out;
}

function iconFor(node: TreeNode) {
	switch (node.kind) {
		case 'archive':
			return Package;
		case 'segment':
			return Layers;
		case 'folder':
			return Folder;
		default:
			return FileBox;
	}
}

function visibilityNodeFor(ref: ResourceRef): VisibilityNode {
	return ref.kind === 'member'
		? { archiveId: ref.archiveId, nameHash: ref.nameHash }
		: { looseId: ref.looseId };
}

export function ResourceTree() {
	const {
		tree,
		selection,
		select,
		isVisible,
		setVisibility,
		membersOf,
		getResourceRaw,
		getResourceFileName,
		levelView,
		setLevelView,
	} = useWorkspace();
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [extracting, setExtracting] = useState<string | null>(null);
	const parentRef = useRef<HTMLDivElement>(null);

	// A large directory tree (~15k nodes) would dump thousands of rows if fully
	// expanded. Default every container to COLLAPSED so the user drills down (and
	// so flatten() only walks the shallow visible set). We only auto-collapse
	// containers we haven't SEEN before, so newly-opened archives collapse
	// without re-collapsing folders the user already expanded.
	const seenContainers = useRef<Set<string>>(new Set());
	useEffect(() => {
		const newlySeen: string[] = [];
		const walk = (nodes: TreeNode[]) => {
			for (const n of nodes) {
				if (n.children && n.children.length > 0) {
					if (!seenContainers.current.has(n.id)) {
						seenContainers.current.add(n.id);
						newlySeen.push(n.id);
					}
					walk(n.children);
				}
			}
		};
		walk(tree);
		if (newlySeen.length > 0) {
			setCollapsed((prev) => {
				const next = new Set(prev);
				for (const id of newlySeen) next.add(id);
				return next;
			});
		}
	}, [tree]);

	const extractArchive = async (archiveId: string) => {
		if (extracting) return;
		setExtracting(archiveId);
		try {
			const items = membersOf(archiveId).map((ref) => ({
				bytes: getResourceRaw(ref),
				filename: getResourceFileName(ref),
			}));
			await extractAll(items);
		} finally {
			setExtracting(null);
		}
	};

	const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 26,
		overscan: 16,
	});

	const toggle = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const selectedKey = selection ? refKey(selection.ref) : null;

	if (rows.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
				No archives or loose files loaded yet.
			</div>
		);
	}

	return (
		<div ref={parentRef} className="h-full overflow-auto">
			<div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
				{virtualizer.getVirtualItems().map((vitem) => {
					const { node, expandable, expanded } = rows[vitem.index];
					const Icon = iconFor(node);
					const isResource = node.kind === 'resource' && !!node.ref;
					const selected = isResource && refKey(node.ref!) === selectedKey;
					const visible = isResource ? isVisible(visibilityNodeFor(node.ref!)) : true;

					return (
						<div
							key={vitem.key}
							className={cn(
								'absolute left-0 flex w-full items-center gap-1 px-2 text-sm',
								'cursor-pointer select-none hover:bg-accent/10',
								selected && 'bg-primary/20 text-primary',
							)}
							style={{
								top: vitem.start,
								height: vitem.size,
								paddingLeft: 8 + node.depth * 14,
							}}
							onClick={() => {
								if (isResource) select({ ref: node.ref! });
								else if (expandable) toggle(node.id);
							}}
						>
							<span
								className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
								onClick={(e) => {
									if (expandable) {
										e.stopPropagation();
										toggle(node.id);
									}
								}}
							>
								{expandable ? (
									expanded ? (
										<ChevronDown className="h-3.5 w-3.5" />
									) : (
										<ChevronRight className="h-3.5 w-3.5" />
									)
								) : null}
							</span>
							<Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							<span className="truncate">{node.label}</span>
							{node.kind === 'archive' && (
								<span className="ml-auto flex shrink-0 items-center gap-1.5">
									<button
										type="button"
										className={cn(
											'text-muted-foreground hover:text-accent',
											levelView === node.id && 'text-accent',
										)}
										title="Render whole level — decode & place every geometry member in one 3D scene"
										onClick={(e) => {
											e.stopPropagation();
											setLevelView(levelView === node.id ? null : node.id);
										}}
									>
										<MapIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										className="text-muted-foreground hover:text-accent disabled:opacity-50"
										title="Extract all members to disk"
										disabled={extracting !== null}
										onClick={(e) => {
											e.stopPropagation();
											void extractArchive(node.id);
										}}
									>
										<DownloadCloud
											className={cn(
												'h-3.5 w-3.5',
												extracting === node.id && 'animate-pulse text-accent',
											)}
										/>
									</button>
								</span>
							)}
							{isResource && (
								<button
									type="button"
									className="ml-auto shrink-0 text-muted-foreground hover:text-accent"
									title={visible ? 'Hide' : 'Show'}
									onClick={(e) => {
										e.stopPropagation();
										setVisibility(visibilityNodeFor(node.ref!), !visible);
									}}
								>
									{visible ? (
										<Eye className="h-3.5 w-3.5" />
									) : (
										<EyeOff className="h-3.5 w-3.5 opacity-50" />
									)}
								</button>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default ResourceTree;
