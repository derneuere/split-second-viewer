// The resizable 3-pane Workspace layout: tree | viewport | inspector.
// Pure layout shell — the panes are passed in as props so the page wires the
// concrete tree/viewport/inspector.

import type { ReactNode } from 'react';
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from '@/components/ui/resizable';

export type WorkspaceLayoutProps = {
	tree: ReactNode;
	viewport: ReactNode;
	inspector: ReactNode;
};

export function WorkspaceLayout({ tree, viewport, inspector }: WorkspaceLayoutProps) {
	return (
		<ResizablePanelGroup direction="horizontal" className="flex-1">
			<ResizablePanel defaultSize={22} minSize={14} className="bg-card/30">
				<div className="flex h-full flex-col">
					<div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-accent">
						Resources
					</div>
					<div className="flex-1 overflow-hidden">{tree}</div>
				</div>
			</ResizablePanel>
			<ResizableHandle withHandle />
			<ResizablePanel defaultSize={54} minSize={30}>
				<div className="h-full overflow-hidden">{viewport}</div>
			</ResizablePanel>
			<ResizableHandle withHandle />
			<ResizablePanel defaultSize={24} minSize={16} className="bg-card/30">
				{inspector}
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

export default WorkspaceLayout;
