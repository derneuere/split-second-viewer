// Inspector pane — metadata + handler describe() for the current Selection.
// Read-only MVP: shows the resolved handler, raw byte length, and (when a
// handler parses cleanly) its one-line describe() summary.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileQuestion, Download, BookOpen, FileCheck2, RefreshCw } from 'lucide-react';
import { useWorkspace } from '@/context/WorkspaceContext';
import { refKey } from '@/lib/core/types';
import { ssCtx } from '@/lib/core/registry';
import { docUrlForHandler, docUrlForName, docsRouteFor } from '@/lib/core/registry/docLinks';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { downloadBytes } from '@/lib/download';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="truncate text-right text-foreground">{value}</span>
		</div>
	);
}

export function Inspector() {
	const { selection, getResourceBytes, getHandler, getResourceFileName, isArkPath } =
		useWorkspace();

	// Bytes load ON DEMAND (directory-backed files are read lazily) — mirror the
	// Viewport so the Inspector's size / describe() reflect the same selection.
	const [raw, setRaw] = useState<Uint8Array | null>(null);
	const reqKey = useRef<string | null>(null);
	useEffect(() => {
		if (!selection) {
			setRaw(null);
			reqKey.current = null;
			return;
		}
		const ref = selection.ref;
		// .ark leaves materialise into an archive; nothing to inspect as bytes.
		if (ref.kind === 'loose' && isArkPath(ref.looseId)) {
			setRaw(null);
			reqKey.current = null;
			return;
		}
		const key = refKey(ref);
		reqKey.current = key;
		void getResourceBytes(ref).then((bytes) => {
			if (reqKey.current === key) setRaw(bytes);
		});
	}, [selection, getResourceBytes, isArkPath]);

	const handler = useMemo(
		() => (selection ? getHandler(selection.ref) : undefined),
		[selection, getHandler],
	);
	const fileName = useMemo(
		() => (selection ? getResourceFileName(selection.ref) : ''),
		[selection, getResourceFileName],
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

	// Wiki page for this resource: prefer the handler mapping, else the filename
	// extension (covers loose resources that fell through to the Hex viewer).
	const docUrl = useMemo(
		() => docUrlForHandler(handler) ?? docUrlForName(fileName),
		[handler, fileName],
	);

	// caps.write === true means writeRaw(parseRaw(bytes)) is byte-exact-proven —
	// surface it as a badge + a "re-serialize and download" action.
	const writable = !!handler?.caps?.write && typeof handler.writeRaw === 'function';
	const [reserializeError, setReserializeError] = useState<string | null>(null);

	const handleReserialize = () => {
		if (!handler?.writeRaw || !raw) return;
		setReserializeError(null);
		try {
			const model = handler.parseRaw(raw, ssCtx());
			const out = handler.writeRaw(model, ssCtx());
			downloadBytes(out, fileName);
		} catch (err) {
			setReserializeError(String((err as Error)?.message ?? err));
		}
	};

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
			<Row
				label="Handler"
				value={
					handler ? (
						<span className="inline-flex items-center gap-2">
							{`${handler.name} (${handler.key})`}
							{writable && (
								<span
									className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400"
									title="caps.write — writeRaw(parseRaw(bytes)) round-trips byte-for-byte against real files"
								>
									<FileCheck2 className="h-3 w-3" />
									writable
								</span>
							)}
						</span>
					) : (
						'none'
					)
				}
			/>
			<Row label="Filename" value={<span className="font-mono text-xs">{fileName}</span>} />

			<Button
				variant="outline"
				size="sm"
				className="mt-3 w-full"
				disabled={!raw}
				onClick={() => raw && downloadBytes(raw, fileName)}
				title="Download this resource's extracted bytes"
			>
				<Download className="h-4 w-4" />
				Download
			</Button>

			{writable && (
				<Button
					variant="outline"
					size="sm"
					className="mt-2 w-full"
					disabled={!raw}
					onClick={handleReserialize}
					title="Parse then re-serialize with the handler's writer (round-trips byte-for-byte for an unedited resource)"
				>
					<RefreshCw className="h-4 w-4" />
					Download (re-serialized)
				</Button>
			)}

			{reserializeError && (
				<p className="mt-1 text-xs text-destructive">
					Re-serialize failed: {reserializeError}
				</p>
			)}

			{docUrl && (
				<div className="mt-2 flex items-center gap-2">
					<Button asChild variant="ghost" size="sm" className="flex-1 justify-start">
						<Link to={docsRouteFor(docUrl)} title="Open this format's wiki page in the Docs pane">
							<BookOpen className="h-4 w-4" />
							Format docs
						</Link>
					</Button>
					<Button asChild variant="ghost" size="sm" title="Open the wiki page in a new tab">
						<a href={docUrl} target="_blank" rel="noreferrer">
							↗
						</a>
					</Button>
				</div>
			)}

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
