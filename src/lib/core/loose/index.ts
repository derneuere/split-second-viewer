// Loose-file ingestion. Most Split/Second data ships as individual files on the
// devkit (.model, .textures, .track, .params, .crcs, ...). A loose file becomes
// a first-class Resource alongside .ark members (PORT-BRIEF §3 / §5).
//
// Pure module: routes by extension via the registry, no React.

import { getHandlerByExtension, type ResourceHandler } from '../registry';

/** A loose file ingested into the Workspace. */
export type LooseFile = {
	/** Identity — the file's name / path. */
	looseId: string;
	/** Original bytes (full file). */
	bytes: Uint8Array;
	/** Lower-case extension including the dot, e.g. '.crcs'. */
	extension: string;
	/** The handler that claims this extension, if any. */
	handler?: ResourceHandler;
};

/** Lower-case extension (with dot) of a filename, or '' if none. */
export function extensionOf(name: string): string {
	const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
	const dot = base.lastIndexOf('.');
	return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/** Wrap raw bytes + a filename as a LooseFile, routing to a handler by extension. */
export function ingestLoose(looseId: string, bytes: Uint8Array): LooseFile {
	const extension = extensionOf(looseId);
	return {
		looseId,
		bytes,
		extension,
		handler: getHandlerByExtension(looseId),
	};
}
