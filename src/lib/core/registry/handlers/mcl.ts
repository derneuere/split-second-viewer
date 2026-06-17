// .mcl registry handler — Black Rock material-clip / material-combo override list
// (SDRI/INSS container). NOT a collision mesh. Read-only MVP (caps.write=false).
//
// Note: .mcl and .shaderinst both use the "SDRI" magic but are different inner
// dialects, so .mcl is routed by extension (no magic sniff registered here to
// avoid clashing with .shaderinst on a bare SDRI member).

import { parseMcl, type ParsedMcl } from '../../mcl';
import type { ResourceHandler } from '../handler';

export const mclHandler: ResourceHandler<ParsedMcl> = {
	key: 'mcl',
	name: 'Material Clip (.mcl)',
	description:
		'Custom SDRI/INSS container of animated material-parameter overrides (colour fades, UV scrolls, ' +
		'fresnel/specular tweaks, texture swaps) applied to props during powerplay sequences. Not Havok, no geometry.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.mcl'],
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseMcl(raw),
	describe: (m) => {
		const first = m.instances[0];
		const head = first
			? `, hash ${first.materialHash}, params: ${first.params.slice(0, 3).map((p) => p.name).join('/')}${first.params.length > 3 ? '…' : ''}`
			: '';
		return (
			`SDRI/INSS: ${m.instanceCount} instance${m.instanceCount === 1 ? '' : 's'}, ` +
			`setId 0x${m.setId.toString(16).padStart(8, '0')}${head}` +
			`${m.hasEndTag ? '' : ' (no INSE!)'}`
		);
	},

	fixtures: [
		{
			file: 'Powerplays/Animations/airport_test_03/AA/AA_HelicopterShockwave.mcl',
			expect: { parseOk: true },
		},
	],
};
