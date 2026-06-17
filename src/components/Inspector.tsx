// Inspector pane — metadata + handler describe() for the current Selection.
// Read-only MVP: shows the resolved handler, raw byte length, and (when a
// handler parses cleanly) its one-line describe() summary.

import { useMemo } from 'react';
import { FileQuestion } from 'lucide-react';
import { useWorkspace } from '@/context/WorkspaceContext';
import { ssCtx } from '@/lib/core/registry';
import { Separator } from '@/components/ui/separator';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="truncate text-right text-foreground">{value}</span>
		</div>
	);
}

export function Inspector() {
	const { selection, getResourceRaw, getHandler } = useWorkspace();

	const raw = useMemo(
		() => (selection ? getResourceRaw(selection.ref) : null),
		[selection, getResourceRaw],
	);
	const handler = useMemo(
		() => (selection ? getHandler(selection.ref) : undefined),
		[selection, getHandler],
	);

	const summary = useMemo(() => {
		if (!handler || !raw) return null;
		try {
			const model = handler.parseRaw(raw, ssCtx());
			return { ok: true as const, text: handler.describe(model) };
		} catch (err) {
			return { ok: false as const, text: String((err as Error)?.message ?? err) };
		}
	}, [handler, raw]);

	if (!selection) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
				<FileQuestion className="h-8 w-8" />
				<p className="text-sm">Select a resource to inspect it.</p>
			</div>
		);
	}

	const ref = selection.ref;

	return (
		<div className="flex h-full flex-col overflow-auto p-4">
			<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-accent">
				Inspector
			</h2>
			<Separator className="mb-3" />

			{ref.kind === 'member' ? (
				<>
					<Row label="Kind" value="Archive member" />
					<Row label="Archive" value={ref.archiveId} />
					<Row
						label="nameHash"
						value={'0x' + (ref.nameHash >>> 0).toString(16).toUpperCase().padStart(8, '0')}
					/>
				</>
			) : (
				<>
					<Row label="Kind" value="Loose file" />
					<Row label="File" value={ref.looseId} />
				</>
			)}

			<Row
				label="Raw size"
				value={raw ? `${raw.byteLength.toLocaleString()} bytes` : '—'}
			/>
			<Row label="Handler" value={handler ? `${handler.name} (${handler.key})` : 'none'} />

			{handler && (
				<>
					<Separator className="my-3" />
					<h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{handler.category}
					</h3>
					<p className="mb-2 text-xs text-muted-foreground">{handler.description}</p>
					{summary && (
						<div
							className={
								summary.ok
									? 'rounded-md border border-border bg-card p-2 text-xs'
									: 'rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive'
							}
						>
							{summary.ok ? summary.text : `parse error: ${summary.text}`}
						</div>
					)}
				</>
			)}
		</div>
	);
}

export default Inspector;
