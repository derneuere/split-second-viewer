// The one-stop registry. Import a handler from its file here and it is
// automatically picked up by the CLI, the registry test suite, and the UI.
//
// Adding a new resource type: create src/lib/core/registry/handlers/<key>.ts
// exporting a ResourceHandler, then add one import + one array entry below.
// No edits to types.ts, the Workspace context, or the pages are needed —
// the registry stays UI-framework-agnostic so the CLI can import it under Node.

import type { ResourceHandler } from './handler';
import { crcsHandler } from './handlers/crcs';

export const registry: ResourceHandler[] = [
	crcsHandler,
	// WP-2+: splitlength, linkorigins, sideways, names, timelineInfo, ...
	// WP-3:  params, xml, powerplays, triggers
	// WP-4:  textures, streamtex
	// WP-5:  model
	// WP-6:  track, lip
];

const byKey = new Map<string, ResourceHandler>();
const byExtension = new Map<string, ResourceHandler>();

for (const h of registry) {
	if (byKey.has(h.key)) {
		throw new Error(`Duplicate ResourceHandler key: ${h.key}`);
	}
	byKey.set(h.key, h);
	for (const ext of h.extensions ?? []) {
		const norm = ext.toLowerCase();
		if (byExtension.has(norm)) {
			throw new Error(
				`Duplicate ResourceHandler extension ${norm}: ` +
					`${byExtension.get(norm)!.key} and ${h.key}`,
			);
		}
		byExtension.set(norm, h);
	}
}

/** Look up a handler by its stable slug (CLI --type, route paths). */
export function getHandlerByKey(key: string): ResourceHandler | undefined {
	return byKey.get(key);
}

/**
 * Look up a handler for a loose file by extension. `nameOrExt` may be a full
 * filename ('Track.crcs') or a bare extension ('.crcs' / 'crcs').
 */
export function getHandlerByExtension(nameOrExt: string): ResourceHandler | undefined {
	const dot = nameOrExt.lastIndexOf('.');
	const ext = (dot >= 0 ? nameOrExt.slice(dot) : '.' + nameOrExt).toLowerCase();
	return byExtension.get(ext);
}

/**
 * Sniff an .ark member whose nameHash isn't yet resolved to a filename: match
 * its leading bytes against every handler's declared `magic`. Returns the
 * first match, or undefined.
 */
export function getHandlerByMagic(raw: Uint8Array): ResourceHandler | undefined {
	for (const h of registry) {
		const m = h.magic;
		if (!m || raw.byteLength < m.byteLength) continue;
		let ok = true;
		for (let i = 0; i < m.byteLength; i++) {
			if (raw[i] !== m[i]) { ok = false; break; }
		}
		if (ok) return h;
	}
	return undefined;
}

export { type ResourceHandler, type ResourceCategory, type ResourceCtx, ssCtx, PLATFORM } from './handler';
