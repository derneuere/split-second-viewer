// .shaders registry handler — Crayon2 shader-set register blocks (SHDR).
// Read-only MVP (caps.write=false): header + per-combo CRC names confirmed.

import { parseShaders, SHADERS_MAGIC, type ParsedShaders } from '../../shaders';
import type { ResourceHandler } from '../handler';

export const shadersHandler: ResourceHandler<ParsedShaders> = {
	key: 'shaders',
	name: 'Shader Set (SHDR)',
	description:
		'Crayon2 shader-set register blocks: SHDR header + per-combo HDRB/HDRE records carrying named ' +
		'constant/sampler binding tables and material-combo CRCs. Microcode lives in the paired .fxc.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.shaders'],
	magic: SHADERS_MAGIC, // 53 48 44 52 "SHDR"
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseShaders(raw),
	describe: (m) =>
		`SHDR v${m.version}: ${m.comboCount} combos, set "${m.setName}"` +
		(m.combos.length
			? `, e.g. ${m.combos.slice(0, 3).map((c) => c.comboCrc).filter(Boolean).join('/')}`
			: ''),

	fixtures: [
		{
			file: 'Environments/Levels/airport_test_03/Backdrop/airport_test_03_backdrop.shaders',
			expect: { parseOk: true },
		},
	],
};
