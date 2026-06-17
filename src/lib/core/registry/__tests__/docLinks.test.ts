import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registry } from '../index';
import { docUrlForHandler, docUrlForName, docsRouteFor, WIKI_INDEX } from '../docLinks';

// Pins the DOCS WIRING the Inspector + /docs viewer rely on: every registered
// handler deep-links to a wiki page, every target page actually exists under
// public/wiki (so no broken "Format docs" link ships), and the name/route
// helpers resolve as the UI expects. Pure data — runs headlessly under Node.

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ -> registry -> core -> lib -> src -> project root
const PUBLIC_WIKI = join(here, '..', '..', '..', '..', '..', 'public', 'wiki');

function pageOf(url: string): string {
	return url.replace(/^\/wiki\//, '');
}

describe('docLinks', () => {
	it('maps every registered handler to a /wiki page', () => {
		for (const h of registry) {
			const url = docUrlForHandler(h);
			expect(url, `handler '${h.key}' has no wiki page`).toBeDefined();
			expect(url!.startsWith('/wiki/')).toBe(true);
		}
	});

	it('points every handler at a wiki page that exists on disk', () => {
		for (const h of registry) {
			const url = docUrlForHandler(h)!;
			const file = join(PUBLIC_WIKI, pageOf(url));
			expect(existsSync(file), `missing wiki page for '${h.key}': ${url}`).toBe(true);
		}
	});

	it('the wiki index page is bundled', () => {
		expect(existsSync(join(PUBLIC_WIKI, 'index.html'))).toBe(true);
		expect(WIKI_INDEX).toBe('/wiki/index.html');
	});

	it('resolves loose names/extensions to a wiki page', () => {
		expect(docUrlForName('Downtown_backdrop.texture.crcs')).toBe('/wiki/format-crcs.html');
		expect(docUrlForName('car.model.stream')).toBe('/wiki/format-model.html');
		expect(docUrlForName('car.model')).toBe('/wiki/format-model.html');
		expect(docUrlForName('.params')).toBe('/wiki/data-params.html');
		expect(docUrlForName('unknownext')).toBeUndefined();
		expect(docUrlForName(undefined)).toBeUndefined();
	});

	it('builds a /docs deep-link route from a wiki url', () => {
		expect(docsRouteFor('/wiki/format-model.html')).toBe('/docs?page=format-model.html');
		expect(docsRouteFor(undefined)).toBe('/docs');
	});

	it('falls back to category, then undefined, for an unknown handler', () => {
		expect(docUrlForHandler({ key: 'nope', category: 'Physics' })).toBe('/wiki/format-havok.html');
		expect(docUrlForHandler({ key: 'nope', category: 'Nonsense' })).toBeUndefined();
		expect(docUrlForHandler(undefined)).toBeUndefined();
	});
});
