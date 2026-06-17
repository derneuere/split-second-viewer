// The Workspace editor — the app's single primary page.
//
// Empty state: a START DIALOG asks the user to pick their Split/Second install
// folder once (File System Access API). Drag-drop + a multi-file input remain a
// secondary fallback (and the only path on non-Chromium browsers).
//
// Loaded state: the unified tree shows the full folder hierarchy. Selecting any
// file reads its bytes ON DEMAND (await getResourceBytes), then routes through
// the handler -> ViewportRouter (Hex fallback). A loading state shows while the
// bytes read. Selecting an .ark leaf opens the archive (pairing its Static/
// Stream sibling) and re-selects to the materialised archive node.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
	AlertTriangle,
	FolderOpen,
	Loader2,
	Package,
	UploadCloud,
} from 'lucide-react';
import { ResourceTree } from '@/components/ResourceTree';
import { Inspector } from '@/components/Inspector';
import { ViewportRouter } from '@/components/viewers/ViewportRouter';
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import {
	useWorkspace,
	findStreamTwin,
	type WorkspaceSelection,
} from '@/context/WorkspaceContext';
import type { ResourceRef } from '@/lib/core/types';
import { refKey } from '@/lib/core/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
	openDirectory,
	isDirectoryPickerSupported,
} from '@/lib/core/fs/directory';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Viewport — reads selected bytes ON DEMAND, with a loading state.
// ---------------------------------------------------------------------------

function Viewport() {
	const { selection, getResourceBytes, getHandler, select, openArkFromDir, isArkPath } =
		useWorkspace();
	const [raw, setRaw] = useState<Uint8Array | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Track the in-flight selection so a fast re-select doesn't show stale bytes.
	const reqKey = useRef<string | null>(null);

	useEffect(() => {
		if (!selection) {
			setRaw(null);
			setError(null);
			reqKey.current = null;
			return;
		}
		const ref = selection.ref;
		const key = refKey(ref);
		reqKey.current = key;

		// An .ark directory leaf: open the archive (pairing its sibling) and
		// re-select to the materialised archive node instead of decoding bytes.
		if (ref.kind === 'loose' && isArkPath(ref.looseId)) {
			setLoading(true);
			setError(null);
			setRaw(null);
			void openArkFromDir(ref.looseId)
				.then((archiveId) => {
					if (reqKey.current !== key) return;
					if (archiveId) {
						// Select the archive container so its members are browsable.
						// (Selecting the archive node itself shows nothing; the user
						// expands it in the tree. We clear selection to the archive's
						// presence — the tree now shows its members under "Opened
						// archives".)
						toast.success(`Opened archive ${archiveId.split('/').pop()}`);
						select(null);
					} else {
						setError('Could not open this archive.');
					}
				})
				.catch((e) => {
					if (reqKey.current === key) setError(String(e?.message ?? e));
				})
				.finally(() => {
					if (reqKey.current === key) setLoading(false);
				});
			return;
		}

		setLoading(true);
		setError(null);
		void getResourceBytes(ref)
			.then((bytes) => {
				if (reqKey.current !== key) return; // superseded
				setRaw(bytes);
			})
			.catch((e) => {
				if (reqKey.current === key) setError(String(e?.message ?? e));
			})
			.finally(() => {
				if (reqKey.current === key) setLoading(false);
			});
	}, [selection, getResourceBytes, openArkFromDir, isArkPath, select]);

	const handler = selection && raw ? getHandler(selection.ref) : undefined;

	if (!selection) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				Select a resource from the tree.
			</div>
		);
	}

	if (loading) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
				<Loader2 className="h-6 w-6 animate-spin text-accent" />
				<span className="text-sm">Reading bytes…</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-destructive">
				<AlertTriangle className="h-6 w-6" />
				<span className="text-sm">{error}</span>
			</div>
		);
	}

	const title = titleFor(selection);
	// The router parses via the handler and dispatches to the bespoke viewport,
	// always falling back to Hex on no-handler / parse failure.
	return <ViewportRouter handler={handler} raw={raw} title={title} />;
}

function titleFor(selection: WorkspaceSelection): string | undefined {
	if (!selection) return undefined;
	const ref: ResourceRef = selection.ref;
	if (ref.kind === 'member') {
		return `${ref.archiveId} · 0x${(ref.nameHash >>> 0)
			.toString(16)
			.toUpperCase()
			.padStart(8, '0')}`;
	}
	return ref.looseId;
}

// ---------------------------------------------------------------------------
// Start dialog (empty state) — pick a folder; drag-drop + file input fallback.
// ---------------------------------------------------------------------------

function StartScreen() {
	const { loadDirectory, loadArchive, loadLoose } = useWorkspace();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const supported = isDirectoryPickerSupported();

	const pickFolder = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		try {
			const dir = await openDirectory();
			await loadDirectory(dir);
			toast.success(`Loaded folder “${dir.name}”`);
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			// User cancelling the picker is not an error.
			if (!/abort/i.test(msg)) toast.error(`Could not open folder: ${msg}`);
		} finally {
			setBusy(false);
		}
	}, [busy, loadDirectory]);

	// Fallback: ingest a multi-file drop / input (pairs Static/Stream .ark).
	const ingestFiles = useCallback(
		async (files: File[]) => {
			if (files.length === 0) return;
			setBusy(true);
			try {
				const statics = files.filter((f) => /\.Static\.ark$/i.test(f.name));
				const handledStreams = new Set<string>();
				for (const stat of statics) {
					const twin = findStreamTwin(stat.name, files);
					if (twin) handledStreams.add(twin.name);
					await loadArchive(stat, twin);
				}
				for (const f of files) {
					if (/\.Static\.ark$/i.test(f.name)) continue;
					if (handledStreams.has(f.name)) continue;
					await loadLoose(f);
				}
				toast.success(`Loaded ${files.length} file${files.length === 1 ? '' : 's'}`);
			} finally {
				setBusy(false);
			}
		},
		[loadArchive, loadLoose],
	);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragging(false);
			void ingestFiles(Array.from(e.dataTransfer.files));
		},
		[ingestFiles],
	);

	return (
		<div className="mx-auto flex max-w-2xl flex-1 flex-col items-center justify-center gap-6 p-8">
			<div className="text-center">
				<h1 className="text-2xl font-bold text-primary">
					Select your Split/Second installation folder
				</h1>
				<p className="mt-2 text-muted-foreground">
					Point Steward at your game data directory — e.g.{' '}
					<code className="text-accent">…\USRDIR\Deferred</code> (or the game root).
					Steward reads the folder structure once, then lets you browse and decode
					every file. Files are read on demand; nothing is uploaded.
				</p>
			</div>

			{supported ? (
				<Button size="lg" onClick={pickFolder} disabled={busy}>
					{busy ? (
						<Loader2 className="mr-1 h-5 w-5 animate-spin" />
					) : (
						<FolderOpen className="mr-1 h-5 w-5" />
					)}
					Select folder
				</Button>
			) : (
				<Card className="w-full border-amber-500/40 bg-amber-500/5">
					<CardContent className="flex items-start gap-3 p-4 text-sm">
						<AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
						<div>
							<p className="font-medium">Folder picker unavailable</p>
							<p className="text-muted-foreground">
								Your browser doesn&apos;t support the File System Access API
								(it&apos;s a Chromium feature — Chrome / Edge). Use the drag-and-drop
								fallback below instead.
							</p>
						</div>
					</CardContent>
				</Card>
			)}

			<Card
				className={cn(
					'w-full border-dashed transition-colors',
					dragging && 'border-primary bg-primary/5',
				)}
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
			>
				<CardContent className="flex flex-col items-center gap-3 p-8 text-center">
					<UploadCloud className="h-8 w-8 text-accent" />
					<div>
						<p className="font-medium">Or drag &amp; drop files here</p>
						<p className="text-sm text-muted-foreground">
							Drop a level&apos;s <code>.Static.ark</code> with its{' '}
							<code>.Stream.ark</code> to open the pair, or any loose file.
						</p>
					</div>
					<input
						ref={inputRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => void ingestFiles(Array.from(e.target.files ?? []))}
					/>
					<Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
						<Package className="mr-1 h-4 w-4" /> Open files
					</Button>
				</CardContent>
			</Card>

			<p className="text-xs text-muted-foreground">
				Read-only MVP · PS3 big-endian · See the bundled{' '}
				<Link to="/docs" className="text-accent underline">
					RE wiki
				</Link>{' '}
				for format details.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------

export function WorkspaceEditor() {
	const { archives, looseFiles, hasDirectory } = useWorkspace();
	const empty = !hasDirectory && archives.length === 0 && looseFiles.length === 0;

	if (empty) return <StartScreen />;

	return (
		<WorkspaceLayout
			tree={<ResourceTree />}
			viewport={<Viewport />}
			inspector={<Inspector />}
		/>
	);
}

export default WorkspaceEditor;
