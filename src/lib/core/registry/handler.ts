// Core contract every Split/Second resource type implements.
//
// Dependency rule (mirrors the reference): individual parser modules in
// src/lib/core/*.ts must NEVER import this file or anything under
// src/lib/core/registry/*. The registry imports the parsers, not the other
// way around. That keeps the graph acyclic and the parsers Node-importable
// (the CLI and vitest exercise them with zero React involvement).
//
// Delta from the Burnout reference:
//   - Split/Second is PS3-only, BIG-ENDIAN — ResourceCtx defaults to
//     littleEndian: false (see ssCtx()).
//   - Resources are addressed by `nameHash` inside an .ark, or by file
//     extension when loose — so handlers declare `extensions` and `magic`
//     for routing instead of the Burnout numeric `typeId`.

export type ResourceCategory =
	| 'Graphics'
	| 'Audio'
	| 'Data'
	| 'Script'
	| 'Camera'
	| 'Physics'
	| 'World'
	| 'Other';

/** Platform numeric ids. Split/Second ships PS3 only; kept for forward-compat. */
export const PLATFORM = { PC: 1, XBOX360: 2, PS3: 3 } as const;
export type Platform = typeof PLATFORM[keyof typeof PLATFORM];

export type ResourceCtx = {
	/** Default FALSE for Split/Second (PS3 big-endian). */
	littleEndian: boolean;
	/** PLATFORM.PS3 by default. Kept for diagnostics / future fork points. */
	platform: number;
};

/** Build the default Split/Second context: PS3, big-endian. */
export function ssCtx(overrides?: Partial<ResourceCtx>): ResourceCtx {
	return { littleEndian: false, platform: PLATFORM.PS3, ...overrides };
}

export type HandlerCaps = {
	read: boolean;
	write: boolean;
};

export type ResourceFixture = {
	/**
	 * Path to a REAL sample file, relative to the Split/Second data root
	 * (see src/test/dataRoot.ts) — e.g.
	 * 'Environments/Levels/Downtown/Backdrop/Downtown_backdrop.texture.crcs'.
	 */
	file: string;
	expect?: {
		/** Expect parseRaw to succeed without throwing. Defaults to true. */
		parseOk?: boolean;
		/** Expect writeRaw(parseRaw(raw)) to equal raw byte-for-byte. */
		byteRoundTrip?: boolean;
		/** Expect the writer to be idempotent (stable on the second pass). */
		stableWriter?: boolean;
	};
};

/**
 * A single deterministic mutation scenario exercised by `ark-cli stress`.
 * Read-only handlers can register scenarios but the CLI refuses to run them
 * (there is nothing to write).
 */
export type StressScenario<Model = unknown> = {
	/** Short slug used for --scenario filtering from the CLI. */
	name: string;
	/** One-line description printed by the stress runner. */
	description?: string;
	/** Produce a mutated copy of the model (the runner always passes a clone). */
	mutate(model: Model): Model;
	/**
	 * Optional invariant check run after parse→write→parse. Returns an array of
	 * problem strings; empty means success. If omitted the runner only checks
	 * writer idempotence.
	 */
	verify?(afterMutate: Model, afterReparse: Model): string[];
};

export interface ResourceHandler<Model = unknown> {
	/** Stable slug: CLI --type, JSON dumps, route paths. e.g. 'crcs'. */
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly category: ResourceCategory;
	readonly caps: HandlerCaps;

	/**
	 * Loose-file extensions this handler claims, e.g. ['.crcs']. The loose
	 * loader routes by extension; the registry builds a byExtension map.
	 * Lower-case, leading dot.
	 */
	readonly extensions?: string[];

	/**
	 * Magic bytes (as stored, big-endian) for sniffing .ark members whose
	 * nameHash isn't yet resolved to a filename. Matched against the member's
	 * leading bytes.
	 */
	readonly magic?: Uint8Array;

	readonly wikiUrl?: string;

	/** Decode already-extracted (and, for Stream members, already-inflated) bytes. */
	parseRaw(raw: Uint8Array, ctx: ResourceCtx): Model;

	/** Encode a model back to raw bytes. Omitted when caps.write is false. */
	writeRaw?(model: Model, ctx: ResourceCtx): Uint8Array;

	/** One-line human summary printed by `ark-cli parse`. */
	describe(model: Model): string;

	/** Pinned real-file fixtures for the auto-generated vitest suite. */
	fixtures: ResourceFixture[];

	/** Known mutation scenarios for `ark-cli stress`. */
	stressScenarios?: StressScenario<Model>[];
}
