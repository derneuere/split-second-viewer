// The Workspace editor: wires the unified tree + viewport + inspector. The
// viewport dispatches on the selected resource's handler; the MVP falls back to
// the generic HexView for everything (bespoke viewports arrive in WP-4/5/6).

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ResourceTree } from '@/components/ResourceTree';
import { Inspector } from '@/components/Inspector';
import { HexView } from '@/components/hexviewer/HexView';
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import { useWorkspace } from '@/context/WorkspaceContext';
import { Button } from '@/components/ui/button';

function Viewport() {
	const { selection, getResourceRaw } = useWorkspace();
	const raw = useMemo(
		() => (selection ? getResourceRaw(selection.ref) : null),
		[selection, getResourceRaw],
	);

	if (!selection) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				Select a resource from the tree.
			</div>
		);
	}

	const title =
		selection.ref.kind === 'member'
			? `${selection.ref.archiveId} · 0x${(selection.ref.nameHash >>> 0)
					.toString(16)
					.toUpperCase()
					.padStart(8, '0')}`
			: selection.ref.looseId;

	// MVP: every resource renders in the Hex fallback. WP-4/5/6 will dispatch on
	// the resolved handler.key to bespoke 2D / mesh / world viewports here.
	return <HexView data={raw} title={title} />;
}

export function WorkspaceEditor() {
	const { archives, looseFiles } = useWorkspace();
	const empty = archives.length === 0 && looseFiles.length === 0;

	if (empty) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
				<p className="text-muted-foreground">No archives or loose files loaded.</p>
				<Button asChild>
					<Link to="/">Open files</Link>
				</Button>
			</div>
		);
	}

	return (
		<WorkspaceLayout
			tree={<ResourceTree />}
			viewport={<Viewport />}
			inspector={<Inspector />}
		/>
	);
}

export default WorkspaceEditor;
