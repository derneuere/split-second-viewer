// .model / .model.stream registry handler — Crayon2 renderable geometry.
//
// Category: mesh. Read-only MVP (caps.write=false): faithfully decodes the
// .model.stream high-LOD geometry (half-float positions + tri-strips) and a
// base .model's header, bounds, and (where safely detectable) tri-strips.
// See src/lib/core/model.ts for the byte-layout notes & wiki references.

import {
	parseModel,
	triangleCount,
	MODEL_MAGIC,
	type ParsedModel,
} from '../../model';
import type { ResourceHandler } from '../handler';

// Magic 02 00 00 08 stored big-endian.
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
		'strips, and a base .model header/bounds/strips. Partial: per-section ' +
		'vertex format and the node-tree section table are not yet resolved.',
	category: 'Graphics', // viewport family: mesh
	caps: { read: true, write: false },
	extensions: ['.model', '.model.stream'],
	magic: MODEL_MAGIC_BYTES,
	wikiUrl: 'format-model.html',

	parseRaw: (raw) => parseModel(raw),
	describe: (m) => {
		const tris = triangleCount(m);
		const verts = m.meshes.reduce((s, mesh) => s + mesh.vertexCount, 0);
		if (m.kind === 'stream') {
			return `model.stream: ${verts} verts, ${tris} tris, ${fmtBounds(m)}`;
		}
		const idx = m.meshes.reduce((s, mesh) => s + mesh.indices.length, 0);
		return (
			`model: ${m.nodeCount ?? '?'} nodes, magic 0x${(m.magic ?? MODEL_MAGIC).toString(16)}, ` +
			`${tris} tris (${idx} indices), ${fmtBounds(m)}`
		);
	},

	fixtures: [
		{
			file: 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.model.stream',
			expect: { parseOk: true },
		},
		{
			file: 'Environments/Levels/airport_test_03/ReflectionMap/Lights/PointLight.model',
			expect: { parseOk: true },
		},
	],
};
