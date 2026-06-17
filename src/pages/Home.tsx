// Landing page: intro + file open / drag-drop. Loading an .ark Static file
// (with optional Stream twin selected alongside) or any loose file routes the
// user into the Workspace editor.

import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Package, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useWorkspace, findStreamTwin } from '@/context/WorkspaceContext';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

export function Home() {
	const navigate = useNavigate();
	const { loadArchive, loadLoose, archives, looseFiles } = useWorkspace();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);

	const ingest = useCallback(
		async (files: File[]) => {
			if (files.length === 0) return;
			const statics = files.filter((f) => /\.Static\.ark$/i.test(f.name));
			const handledStreams = new Set<string>();
			let loaded = 0;

			for (const stat of statics) {
				const twin = findStreamTwin(stat.name, files);
				if (twin) handledStreams.add(twin.name);
				await loadArchive(stat, twin);
				loaded++;
			}

			// Everything that isn't a paired Static/Stream .ark is a loose file.
			for (const f of files) {
				if (/\.Static\.ark$/i.test(f.name)) continue;
				if (handledStreams.has(f.name)) continue;
				if (/\.Stream\.ark$/i.test(f.name)) {
					// A lone Stream without its Static — open it as loose for hex inspection.
					await loadLoose(f);
					loaded++;
					continue;
				}
				await loadLoose(f);
				loaded++;
			}

			if (loaded > 0) {
				toast.success(`Loaded ${loaded} file${loaded === 1 ? '' : 's'}`);
				navigate('/workspace');
			}
		},
		[loadArchive, loadLoose, navigate],
	);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragging(false);
			ingest(Array.from(e.dataTransfer.files));
		},
		[ingest],
	);

	const hasContent = archives.length > 0 || looseFiles.length > 0;

	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
			<div>
				<h1 className="text-3xl font-bold text-primary">Split/Second Steward</h1>
				<p className="mt-2 text-muted-foreground">
					A browser-based, read-only editor for Split/Second (PS3, big-endian) game
					data. Open <code className="text-accent">.ark</code> archives (paired
					Static / Stream) or individual loose files, browse the unified resource
					tree, and decode + visualize members.
				</p>
			</div>

			<Card
				className={cn(
					'border-dashed transition-colors',
					dragging && 'border-primary bg-primary/5',
				)}
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
			>
				<CardContent className="flex flex-col items-center gap-4 p-10 text-center">
					<UploadCloud className="h-10 w-10 text-accent" />
					<div>
						<p className="font-medium">Drag &amp; drop files here</p>
						<p className="text-sm text-muted-foreground">
							Select a level&apos;s <code>.Static.ark</code> together with its{' '}
							<code>.Stream.ark</code> to open the pair, or drop any loose file.
						</p>
					</div>
					<input
						ref={inputRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => ingest(Array.from(e.target.files ?? []))}
					/>
					<div className="flex gap-2">
						<Button onClick={() => inputRef.current?.click()}>
							<FolderOpen className="mr-1" /> Open files
						</Button>
						{hasContent && (
							<Button variant="outline" onClick={() => navigate('/workspace')}>
								<Package className="mr-1" /> Go to Workspace
							</Button>
						)}
					</div>
				</CardContent>
			</Card>

			<div className="text-xs text-muted-foreground">
				Architecture: a registry-first, UI-agnostic core (handlers + .ark parser)
				exercised headlessly by the CLI (<code>npm run ark</code>) and vitest. See{' '}
				<code>README.md</code> and the Split/Second RE wiki for format details.
			</div>
		</div>
	);
}

export default Home;
