// Pure viewport-family mapping — no React, no heavy 3D deps, so the dispatch
// rule the Workspace relies on is unit-testable headlessly under Node/vitest.
//
// The handler model only carries the ResourceCategory enum (Graphics / Data /
// World / Physics / ...). The bespoke viewers are keyed by a smaller "viewport
// family" vocabulary, so the mapping from (category, key) -> family lives here
// and is shared by ViewportRouter (the React dispatcher) and its test.

import type { ResourceHandler } from '@/lib/core/registry';

/** The bespoke viewport families the router dispatches to. */
export type ViewportFamily = 'texture' | 'mesh' | 'world' | 'config' | 'binary';

/** Keys whose decoded model is rendered by TextureViewer. */
export const TEXTURE_KEYS = new Set(['textures', 'streamtex']);
/**
 * Keys whose decoded model is rendered by MeshViewer.
 *
 * `havok` is here so collision geometry visualizes: vehicle .mainColl/.phys
 * convex hulls render as solid meshes, and level .hkColl renders its AABB box
 * (its triangle buffers are SERIALIZE_IGNORED, absent from the file). The
 * MeshViewer is tolerant of an empty meshes[] (it shows a graceful message), so
 * the rare geometry-less packfile still renders without throwing.
 */
export const MESH_KEYS = new Set(['model', 'skel', 'deform', 'mcl', 'havok']);
/** Shader sets — surfaced in the Config inspector's generic table. */
export const SHADER_KEYS = new Set(['shaders', 'shaderinst', 'fxc']);

/**
 * Resolve a handler to its viewport family. Keys are matched first (most
 * precise); the ResourceCategory enum is the fallback. Unknown / unhandled
 * categories land on the Hex fallback ('binary').
 */
export function viewportFor(
	handler: Pick<ResourceHandler, 'key' | 'category'> | null | undefined,
): ViewportFamily {
	if (!handler) return 'binary';
	const key = handler.key;

	if (TEXTURE_KEYS.has(key)) return 'texture';
	if (MESH_KEYS.has(key)) return 'mesh';
	if (SHADER_KEYS.has(key)) return 'config'; // shader sets -> Config inspector

	switch (handler.category) {
		case 'World':
			return 'world';
		case 'Physics':
			return 'config'; // havok packfiles -> Config inspector (generic table)
		case 'Graphics':
			// Graphics that isn't a texture/mesh/shader (none today) -> Hex.
			return 'binary';
		case 'Data':
		case 'Script':
		case 'Camera':
		case 'Audio':
			return 'config';
		default:
			return 'binary';
	}
}
