// The one-stop registry. Import a handler from its file here and it is
// automatically picked up by the CLI, the registry test suite, and the UI.
//
// Adding a new resource type: create src/lib/core/registry/handlers/<key>.ts
// exporting a ResourceHandler, then add one import + one array entry below.
// No edits to types.ts, the Workspace context, or the pages are needed —
// the registry stays UI-framework-agnostic so the CLI can import it under Node.

import type { ResourceHandler } from './handler';

import { crcsHandler } from './handlers/crcs';

// --- World / Telemetry -----------------------------------------------------
import { splitLengthHandler } from './handlers/splitlength';
import { linkOriginsHandler } from './handlers/linkorigins';
import { sidewaysHandler } from './handlers/sideways';
import { checkpointsHandler } from './handlers/checkpoints';
import { trackHandler } from './handlers/track';
import { nisHandler } from './handlers/nis';
import { gbxHandler } from './handlers/gbx';
import { entitiesHandler } from './handlers/entities';
import { timelineInfoHandler } from './handlers/timelineInfo';
import { logicInfoHandler } from './handlers/logicinfo';
import { sectorInfoHandler } from './handlers/sectorInfo';

// --- Data / Config ---------------------------------------------------------
import { namesHandler } from './handlers/names';
import { fileNamesHandler } from './handlers/filenames';
import { partsHandler } from './handlers/parts';
import { dctHandler } from './handlers/dct';
import { globalRegsHandler } from './handlers/globalRegs';
import { paramsHandler } from './handlers/params';
import { xmlHandler, powerplaysHandler, triggersHandler } from './handlers/xml';

// --- Graphics: textures / mesh / shaders -----------------------------------
import { texturesHandler } from './handlers/textures';
import { streamtexHandler } from './handlers/streamtex';
import { modelHandler } from './handlers/model';
import { skelHandler } from './handlers/skel';
import { deformHandler } from './handlers/deform';
import { mclHandler } from './handlers/mcl';
import { shadersHandler } from './handlers/shaders';
import { shaderInstHandler } from './handlers/shaderinst';
import { fxcHandler } from './handlers/fxc';

// --- Physics ---------------------------------------------------------------
import { havokHandler } from './handlers/havok';

export const registry: ResourceHandler[] = [
	crcsHandler,
	// World / Telemetry
	splitLengthHandler,
	linkOriginsHandler,
	sidewaysHandler,
	checkpointsHandler,
	trackHandler,
	nisHandler,
	gbxHandler,
	entitiesHandler,
	timelineInfoHandler,
	logicInfoHandler,
	sectorInfoHandler,
	// Data / Config
	namesHandler,
	fileNamesHandler,
	partsHandler,
	dctHandler,
	globalRegsHandler,
	paramsHandler,
	xmlHandler,
	powerplaysHandler,
	triggersHandler,
	// Graphics: textures / mesh / shaders
	texturesHandler,
	streamtexHandler,
	modelHandler,
	skelHandler,
	deformHandler,
	mclHandler,
	shadersHandler,
	shaderInstHandler,
	fxcHandler,
	// Physics
	havokHandler,
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
 *
 * Tries the longest compound extension first (so 'x.model.stream' resolves to
 * the '.model.stream' handler, not '.stream'), then falls back to the final
 * dotted segment.
 */
export function getHandlerByExtension(nameOrExt: string): ResourceHandler | undefined {
	const base = nameOrExt.replace(/\\/g, '/').split('/').pop() ?? nameOrExt;
	const lower = base.toLowerCase();
	// Walk every '.'-prefixed suffix from the longest to the shortest so a
	// compound extension (e.g. '.model.stream') wins over its tail ('.stream').
	let from = 0;
	for (;;) {
		const dot = lower.indexOf('.', from);
		if (dot < 0) break;
		const candidate = lower.slice(dot);
		const hit = byExtension.get(candidate);
		if (hit) return hit;
		from = dot + 1;
	}
	// `lower` had no '.', or none of the suffixes matched: treat the whole thing
	// as a bare extension ('crcs' -> '.crcs').
	if (lower.indexOf('.') < 0) return byExtension.get('.' + lower);
	return undefined;
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
