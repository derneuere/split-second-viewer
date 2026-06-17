// .fxc registry handler — Crayon2 compiled-effect container. Read-only MVP
// (caps.write=false): header + END framing decoded; RSX microcode is opaque.

import { parseFxc, FXC_MAGIC, type ParsedFxc } from '../../fxc';
import type { ResourceHandler } from '../handler';

export const fxcHandler: ResourceHandler<ParsedFxc> = {
	key: 'fxc',
	name: 'FX Compiled (.fxc)',
	description:
		'Crayon2 compiled-effect container: \\0FXC header + set-name CRC (join key with the paired .shaders) ' +
		'+ per-combo symbol tables and RSX/NV40 microcode (opaque), terminated by an "END" tag.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.fxc'],
	magic: FXC_MAGIC, // 00 46 58 43 "\0FXC"
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseFxc(raw),
	describe: (m) =>
		`\\0FXC v${m.version}: ${m.comboCount} combos, set "${m.setName}", ` +
		`microcode ${m.microcode.length} bytes${m.hasEndTag ? '' : ' (no END!)'}` +
		(m.symbols.length ? `, syms: ${m.symbols.slice(0, 3).join('/')}` : ''),

	fixtures: [
		{
			file: 'Environments/Levels/airport_test_03/Backdrop/airport_test_03_backdrop.fxc',
			expect: { parseOk: true },
		},
	],
};
