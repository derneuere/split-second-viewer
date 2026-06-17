// docLinks — maps each registry handler to its page in the bundled RE wiki.
//
// The wiki (the navigable HTML reverse-engineering reference built from devkit
// NPXX00575) is copied verbatim into `public/wiki/` and served by Vite at
// `/wiki/`. This module is the single source of truth for "which wiki page
// documents this resource type" so the Inspector's "Format docs ↗" link and the
// in-app /docs viewer can deep-link consistently.
//
// Why a dedicated map (and not handler.wikiUrl)? The handlers' own `wikiUrl`
// fields are inconsistent — some point at the external burnout.wiki/
// split-second.wiki, some are bare filenames — and the Integrate stage owns the
// docs wiring without editing every handler. This map resolves every handler
// KEY to a REAL local page that exists under public/wiki, with category and
// extension fallbacks for anything unmapped.
//
// Pure data + lookups: no React, no registry import cycle (it only takes a
// handler-shaped {key, category, extensions} so it stays importable by both the
// UI and headless tests).

/** Absolute path (Vite-served) of the wiki landing page. */
export const WIKI_INDEX = '/wiki/index.html';

/** Prefix every page lives under once the wiki is copied into public/. */
const WIKI_BASE = '/wiki/';

/**
 * handler.key -> wiki page filename (relative to /wiki/). Every target here is
 * a file that EXISTS under public/wiki (verified at integrate time). Keep this
 * list aligned with src/lib/core/registry/handlers/*.
 */
const KEY_TO_PAGE: Record<string, string> = {
	// World / route / telemetry
	crcs: 'format-crcs.html',
	track: 'format-track.html',
	checkpoints: 'format-route.html',
	sideways: 'format-route.html',
	splitlength: 'format-route.html',
	linkorigins: 'format-route.html',
	sectorInfo: 'format-sectors.html',
	highlighttags: 'format-highlighttags.html',
	entities: 'format-entities.html',
	nis: 'format-nis.html',
	gbx: 'format-nis.html',
	timelineInfo: 'format-timeline.html',
	logicinfo: 'format-logicinfo.html',

	// Data / config
	names: 'format-names.html',
	filenames: 'format-names.html',
	parts: 'system-tracks.html',
	dct: 'format-misc.html',
	global_regs: 'data-globalregs.html',
	params: 'data-params.html',
	xml: 'data-xml.html',
	powerplays: 'format-powerplays.html',
	triggers: 'format-triggers.html',

	// Graphics: textures / mesh / shaders
	textures: 'format-textures.html',
	streamtex: 'format-streamtex.html',
	model: 'format-model.html',
	skel: 'format-skel.html',
	deform: 'format-deform.html',
	mcl: 'format-mcl.html',
	shaders: 'format-shaders.html',
	shaderinst: 'format-shaders.html',
	fxc: 'format-fxc.html',

	// Physics
	havok: 'format-havok.html',

	// Audio / Video
	bik: 'format-bik.html',
};

/**
 * Loose-file extension -> wiki page, used when a resource has no resolved
 * handler (Hex fallback) but its extension is still documented. Lower-case,
 * leading dot.
 */
const EXT_TO_PAGE: Record<string, string> = {
	'.crcs': 'format-crcs.html',
	'.track': 'format-track.html',
	'.checkpoints': 'format-route.html',
	'.sideways': 'format-route.html',
	'.splitlength': 'format-route.html',
	'.linkorigins': 'format-route.html',
	'.sectorinfo': 'format-sectors.html',
	'.highlighttags': 'format-highlighttags.html',
	'.entities': 'format-entities.html',
	'.nis': 'format-nis.html',
	'.gbx': 'format-nis.html',
	'.params': 'data-params.html',
	'.global_regs': 'data-globalregs.html',
	'.dct': 'format-misc.html',
	'.powerplays': 'format-powerplays.html',
	'.triggers': 'format-triggers.html',
	'.textures': 'format-textures.html',
	'.streamtex': 'format-streamtex.html',
	'.model': 'format-model.html',
	'.model.stream': 'format-model.html',
	'.skel': 'format-skel.html',
	'.deform': 'format-deform.html',
	'.mcl': 'format-mcl.html',
	'.fxc': 'format-fxc.html',
	'.phys': 'format-phys.html',
	'.maincoll': 'format-hkcoll.html',
	'.hkcoll': 'format-hkcoll.html',
	'.hkpps': 'format-hkpps.html',
	'.hkrbs': 'format-hkrbs.html',
	'.bik': 'format-bik.html',
};

/** ResourceCategory -> a sensible overview page when nothing more specific hits. */
const CATEGORY_TO_PAGE: Record<string, string> = {
	Graphics: 'format-index.html',
	Physics: 'format-havok.html',
	World: 'format-route.html',
	Data: 'format-misc.html',
	Script: 'data-catnip.html',
	Camera: 'system-cameras.html',
	Audio: 'engine-audio.html',
	Other: 'format-index.html',
};

/** The minimal handler shape this module reads — keeps it registry-cycle-free. */
export type DocLinkHandler = {
	key?: string;
	category?: string;
	extensions?: readonly string[];
};

function toUrl(page: string | undefined): string | undefined {
	return page ? WIKI_BASE + page : undefined;
}

/**
 * Resolve a handler to its bundled wiki page URL (e.g. '/wiki/format-model.html').
 * Tries key, then declared extensions, then category. Returns undefined when the
 * handler is missing entirely (callers fall back to the wiki index).
 */
export function docUrlForHandler(handler: DocLinkHandler | null | undefined): string | undefined {
	if (!handler) return undefined;
	if (handler.key && KEY_TO_PAGE[handler.key]) return toUrl(KEY_TO_PAGE[handler.key]);
	for (const ext of handler.extensions ?? []) {
		const page = EXT_TO_PAGE[ext.toLowerCase()];
		if (page) return toUrl(page);
	}
	if (handler.category && CATEGORY_TO_PAGE[handler.category]) {
		return toUrl(CATEGORY_TO_PAGE[handler.category]);
	}
	return undefined;
}

/**
 * Resolve a bare filename / extension (a loose resource with no handler) to its
 * wiki page. Accepts 'Track.crcs', '.crcs', 'crcs', or 'x.model.stream'. Walks
 * every dotted suffix longest-first so '.model.stream' beats '.stream'.
 */
export function docUrlForName(nameOrExt: string | null | undefined): string | undefined {
	if (!nameOrExt) return undefined;
	const base = nameOrExt.replace(/\\/g, '/').split('/').pop() ?? nameOrExt;
	const lower = base.toLowerCase();
	let from = 0;
	for (;;) {
		const dot = lower.indexOf('.', from);
		if (dot < 0) break;
		const page = EXT_TO_PAGE[lower.slice(dot)];
		if (page) return toUrl(page);
		from = dot + 1;
	}
	if (lower.indexOf('.') < 0) {
		const page = EXT_TO_PAGE['.' + lower];
		if (page) return toUrl(page);
	}
	return undefined;
}

/**
 * Build a URL to open a specific wiki page inside the in-app /docs viewer, e.g.
 * docsRouteFor('/wiki/format-model.html') -> '/docs?page=format-model.html'.
 * The /docs page reads ?page and points its iframe at /wiki/<page>.
 */
export function docsRouteFor(wikiUrl: string | undefined): string {
	if (!wikiUrl) return '/docs';
	const page = wikiUrl.startsWith(WIKI_BASE) ? wikiUrl.slice(WIKI_BASE.length) : wikiUrl;
	return `/docs?page=${encodeURIComponent(page)}`;
}
