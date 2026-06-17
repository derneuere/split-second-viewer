// The Workspace editor: wires the unified tree + viewport + inspector.
//
// Tree selection -> getResourceRaw -> getHandler -> ViewportRouter, which parses
// via the handler and renders the matching bespoke viewer (texture / mesh /
// world / config), falling back to the generic HexView when there is no handler
// or the parse fails. The Inspector shows handler.describe(model) for the same
// selection. Loose files load via drag/drop + file input on the Home page and
// route to a handler by extension (see WorkspaceContext.ingestLoose).

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ResourceTree } from '@/components/ResourceTree';
import { Inspector } from '@/components/Inspector';
import { ViewportRouter } from '@/components/viewers/ViewportRouter';
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import { useWorkspace } from '@/context/WorkspaceContext';
import { Button } from '@/components/ui/button';

function Viewport() {
	const { selection, getResourceRaw, getHandler } = useWorkspace();

	const raw = useMemo(
		() => (selection ? getResourceRaw(selection.ref) : null),
		[selection, getResourceRaw],
	);
	const handler = useMemo(
		() => (selection ? getHandler(selection.ref) : undefined),
		[selection, getHandler],
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

	// The router parses via the handler and dispatches to the bespoke viewport,
	// always falling back to Hex on no-handler / parse failure.
	return <ViewportRouter handler={handler} raw={raw} title={title} />;
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
