// .model / .model.stream registry handler — Crayon2 renderable geometry.
//
// Category: mesh. Read-only (caps.write=false). Decodes:
//   * .model.stream — high-LOD half-float vertex stream + tri-strips (the
//     MUST-RENDER car path), and
//   * base .model   — the Crayon2 node tree's explicit vertex-buffer and
//     index/draw-call section tables, yielding per-buffer submeshes
//     (positions + unstripped triangle indices, plus float-format UVs). Covers
//     cars, wheels, level backdrops, environment props and simple lights.
//   * skinned .model (magic 02 01 00 08) — the animated Powerplay variant. Its
//     0x48-byte vertex-buffer records pair a stride-12 float32-P3 position stream
//     with a stride-8 aux stream; this handler decodes per-section position
//     buffers (point meshes). The triangle topology lives in the compressed
//     Havok skinning section and isn't recovered yet, so these are flagged
//     partial (no indices).
// See src/lib/core/model.ts for the byte-layout notes & wiki references.

import {
	parseModel,
	triangleCount,
	vertexCount as modelVertexCount,
	MODEL_MAGIC,
	type ParsedModel,
} from '../../model';
import type { ResourceHandler } from '../handler';

// Magic 02 00 00 08 stored big-endian (the standard variant; the skinned
// variant 02 01 00 08 shares the first and last byte — both sniff via parseRaw).
const MODEL_MAGIC_BYTES = new Uint8Array([0x02, 0x00, 0x00, 0x08]);

function fmtBounds(m: ParsedModel): string {
	if (!m.bounds) return 'no bounds';
	const r = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));
	const { min, max } = m.bounds;
	return `bounds [${r(min[0])},${r(min[1])},${r(min[2])}]…[${r(max[0])},${r(max[1])},${r(max[2])}]`;
}

export const modelHandler: ResourceHandler<ParsedModel> = {
	key: 'model',
	name: 'Model (Crayon2 mesh)',
	description:
		'Crayon2 renderable geometry. Decodes the .model.stream high-LOD vertex ' +
		'stream (4 big-endian half-floats/16-byte stride) + 16-bit triangle ' +
		'strips, AND a base .model via its node-tree vertex-buffer / draw-call ' +
		'section tables -> per-buffer submeshes (positions + unstripped indices, ' +
		'+UVs for float buffers). Skinned (02 01 00 08) variants decode per-section ' +
		'float32 position buffers (point meshes, no recoverable topology, flagged ' +
		'partial); a few prop layouts remain header-only.',
	category: 'Graphics', // viewport family: mesh
	caps: { read: true, write: false },
	extensions: ['.model', '.model.stream'],
	magic: MODEL_MAGIC_BYTES,
	wikiUrl: 'format-model.html',

	parseRaw: (raw) => parseModel(raw),
	describe: (m) => {
		const tris = triangleCount(m);
		const verts = modelVertexCount(m);
		if (m.kind === 'stream') {
			return `model.stream: ${verts} verts, ${tris} tris, ${fmtBounds(m)}`;
		}
		const suffix = m.partial ? ' (partial)' : '';
		return (
			`model: ${m.nodeCount ?? '?'} nodes, magic 0x${(m.magic ?? MODEL_MAGIC).toString(16)}, ` +
			`${m.meshes.length} mesh(es), ${verts} verts, ${tris} tris, ${fmtBounds(m)}${suffix}`
		);
	},

	fixtures: [
		{
			file: 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.model.stream',
			expect: { parseOk: true },
		},
		{
			// Base .model with full vertex/index section tables (car body, no stream).
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.model',
			expect: { parseOk: true },
		},
		{
			// Simple float-format base .model (5x5 quad grid, P3+UV).
			file: 'Environments/Levels/airport_test_03/ReflectionMap/Lights/PointLight.model',
			expect: { parseOk: true },
		},
		{
			// Skinned/animated variant (magic 02 01 00 08): per-section float32
			// position buffers, partial (no topology).
			file: 'Powerplays/Animations/airport_test_03/AA/AA_Bell206B.model',
			expect: { parseOk: true },
		},
	],
};
