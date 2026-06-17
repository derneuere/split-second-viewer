// .shaderinst registry handler — Crayon2 per-mesh shader-instance bindings
// (SDRI/INSS). Read-only MVP (caps.write=false): header + per-node inst_crc /
// node_name / combo_crc confirmed; override values are wiki-Partial.
//
// Shares "SDRI" magic with .mcl, so it is routed by extension only (no magic
// sniff registered to avoid clashing with .mcl on a bare SDRI member).

import { parseShaderInst, type ParsedShaderInst } from '../../shaderinst';
import type { ResourceHandler } from '../handler';

export const shaderInstHandler: ResourceHandler<ParsedShaderInst> = {
	key: 'shaderinst',
	name: 'Shader Instance (SDRI/INSS)',
	description:
		'Crayon2 per-mesh shader-instance bindings: SDRI/INSS header + N instance records binding a node ' +
		'to a material-combo CRC with instance-specific constant overrides (paint colour, emissive, decals).',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.shaderinst'],
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseShaderInst(raw),
	describe: (m) => {
		const first = m.nodes[0];
		const head = first ? `, e.g. ${first.comboCrc}` : '';
		return (
			`SDRI v${m.version}: ${m.nodeCount} instance node${m.nodeCount === 1 ? '' : 's'}${head}` +
			`${m.hasEndTag ? '' : ' (no INSE!)'}`
		);
	},

	fixtures: [
		{
			file: 'Environments/Levels/airport_test_03/Backdrop/airport_test_03_backdrop.shaderinst',
			expect: { parseOk: true },
		},
	],
};
