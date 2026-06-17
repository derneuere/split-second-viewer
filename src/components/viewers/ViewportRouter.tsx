// ViewportRouter — the central viewport dispatcher.
//
// Given a selected resource (its resolved handler + raw bytes), it:
//   1. parses the bytes with handler.parseRaw (guarded — a throw never escapes),
//   2. picks the matching bespoke viewer by the handler's viewport family,
//   3. renders that viewer with the shared { model, raw, handler } props,
//   4. falls back to the generic HexView whenever there is no handler, the
//      parse failed, or the family has no bespoke viewer.
//
// The bespoke viewers (Texture / Mesh / World / Config) are themselves tolerant
// of a null / partial / wrong-shape model, so a successful-but-empty parse still
// renders gracefully rather than throwing.
//
// Viewport families (derived from handler.category + handler.key — the handler
// model only carries the ResourceCategory enum, so the mapping lives here):
//   video     -> BikViewer       (bik — pure-TS Bink decoder + player)
//   texture   -> TextureViewer   (textures, streamtex)
//   mesh      -> MeshViewer      (model, skel, deform, mcl)
//   world     -> WorldViewer     (category World: track, entities, links, ...)
//   config    -> ConfigViewer    (params/xml/names/... + physics + shaders)
//   binary    -> HexView         (anything else, or parse failure)

import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';

import { HexView } from '@/components/hexviewer/HexView';
import { TextureViewer } from '@/components/viewers/TextureViewer';
import { BikViewer } from '@/components/viewers/BikViewer';
import { MeshViewer } from '@/components/viewers/MeshViewer';
import { WorldViewer } from '@/components/viewers/WorldViewer';
import { ConfigViewer } from '@/components/viewers/ConfigViewer';
import { MapViewer } from '@/components/viewers/MapViewer';
import { ssCtx, type ResourceHandler } from '@/lib/core/registry';
import { viewportFor } from '@/components/viewers/viewportFamily';
import type { LevelGeometry } from '@/lib/core/levelGeometry';

export { viewportFor, type ViewportFamily } from '@/components/viewers/viewportFamily';

/** Outcome of a guarded parse: either a model or the error message. */
type ParseState =
	| { ok: true; model: unknown }
	| { ok: false; error: string };

function safeParse(handler: ResourceHandler | undefined, raw: Uint8Array | null): ParseState | null {
	if (!handler || !raw) return null;
	if (!handler.caps?.read) return { ok: false, error: 'handler has no reader' };
	try {
		return { ok: true, model: handler.parseRaw(raw, ssCtx()) };
	} catch (err) {
		return { ok: false, error: String((err as Error)?.message ?? err) };
	}
}

export type ViewportRouterProps = {
	/** The resolved handler for the selection, if any. */
	handler?: ResourceHandler;
	/** Original (already-inflated) bytes for the selection. */
	raw: Uint8Array | null;
	/** Title shown above the Hex fallback. */
	title?: string;
	/**
	 * Whole-level override. When set, the router renders the MapViewer for the
	 * prepared level geometry instead of dispatching on the handler — this is the
	 * "Render whole level" action's render path. Takes precedence over `handler`.
	 */
	levelGeometry?: LevelGeometry | null;
};

/**
 * A thin banner shown above a bespoke viewer when the handler is read-only or
 * partial, so the user knows write-back / full decode isn't available yet.
 */
function StatusBanner({ text }: { text: string }) {
	return (
		<div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
			<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
			<span className="truncate">{text}</span>
		</div>
	);
}

export function ViewportRouter({ handler, raw, title, levelGeometry }: ViewportRouterProps) {
	const parsed = useMemo(() => safeParse(handler, raw), [handler, raw]);

	// Whole-level override: render the merged map scene regardless of any single
	// selected member's handler.
	if (levelGeometry) {
		return <MapViewer model={levelGeometry} raw={raw} handler={handler} />;
	}

	// No handler, or parse failed -> always the Hex fallback (never throws).
	if (!handler || !parsed || !parsed.ok) {
		const note =
			handler && parsed && parsed.ok === false
				? `${handler.name}: parse failed — ${parsed.error}`
				: undefined;
		return (
			<div className="flex h-full flex-col">
				{note && <StatusBanner text={note} />}
				<div className="min-h-0 flex-1">
					<HexView data={raw} title={title} />
				</div>
			</div>
		);
	}

	const family = viewportFor(handler);
	const model = parsed.model;

	switch (family) {
		case 'video':
			return <BikViewer model={model as never} raw={raw} handler={handler} />;
		case 'texture':
			return <TextureViewer model={model as never} raw={raw} handler={handler} />;
		case 'mesh':
			return <MeshViewer model={model} raw={raw} handler={handler} />;
		case 'world':
			return <WorldViewer model={model} raw={raw} handler={handler} />;
		case 'config':
			return <ConfigViewer model={model} raw={raw} handler={handler} />;
		case 'binary':
		default:
			return <HexView data={raw} title={title} />;
	}
}

export default ViewportRouter;
