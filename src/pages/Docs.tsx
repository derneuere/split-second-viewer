// Docs page — embeds the bundled Split/Second RE wiki.
//
// The wiki is copied verbatim into public/wiki and served by Vite at /wiki/.
// We render it inside a full-pane <iframe> so its OWN sidebar, search, and
// internal navigation keep working untouched (the iframe document's base URL is
// /wiki/, so the wiki's relative links resolve correctly).
//
// Deep-linking: /docs?page=format-model.html points the iframe at that page.
// The Inspector's "Format docs" affordance and the Home Docs card both use this.

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';

const WIKI_BASE = '/wiki/';
const DEFAULT_PAGE = 'index.html';

/** Only allow same-origin wiki pages (a bare '<name>.html'); never an absolute URL. */
function safePage(raw: string | null): string {
	if (!raw) return DEFAULT_PAGE;
	// Strip any leading '/wiki/' a caller may have passed, then reject path
	// traversal / protocol-relative / absolute URLs — we only serve our own pages.
	let p = raw.trim();
	if (p.startsWith(WIKI_BASE)) p = p.slice(WIKI_BASE.length);
	if (p.startsWith('/') || p.includes('..') || p.includes('://') || p.includes('\\')) {
		return DEFAULT_PAGE;
	}
	return p.length > 0 ? p : DEFAULT_PAGE;
}

export function Docs() {
	const [params] = useSearchParams();
	const page = safePage(params.get('page'));
	const src = useMemo(() => WIKI_BASE + page, [page]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/50 px-4 py-2">
				<BookOpen className="h-4 w-4 text-accent" />
				<span className="text-sm font-medium">Reverse-Engineering Wiki</span>
				<span className="text-xs text-muted-foreground">
					Split/Second (PS3, devkit NPXX00575) — engine, formats &amp; systems
				</span>
				<Button asChild variant="outline" size="sm" className="ml-auto">
					<a href={src} target="_blank" rel="noreferrer" title="Open the wiki in a new tab">
						<ExternalLink className="h-4 w-4" />
						Open in new tab
					</a>
				</Button>
			</div>
			<iframe
				key={src}
				src={src}
				title="Split/Second RE Wiki"
				className="min-h-0 w-full flex-1 border-0 bg-white"
			/>
		</div>
	);
}

export default Docs;
