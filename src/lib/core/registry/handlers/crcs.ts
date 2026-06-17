// .crcs registry handler — the worked example. Thin wrapper around
// parseCrcs / writeCrcs in src/lib/core/crcs.ts.
//
// Use this as the template for every new trivial binary handler (WP-2):
// one parser module + one handler file + one import/array entry in index.ts.

import { parseCrcs, writeCrcs, type ParsedCrcs } from '../../crcs';
import type { ResourceHandler } from '../handler';

const fmt = (c: number) => '0x' + (c >>> 0).toString(16).padStart(8, '0');

export const crcsHandler: ResourceHandler<ParsedCrcs> = {
	key: 'crcs',
	name: 'Texture CRC List',
	description:
		'Headerless flat big-endian uint32[] of texture-name CRC dependencies (N = filesize / 4).',
	category: 'Data',
	caps: { read: true, write: true },
	// .tex.crcs / .texture.crcs both resolve to the '.crcs' extension via the
	// loader's last-segment rule, so a single entry covers all three names.
	extensions: ['.crcs'],
	wikiUrl: 'https://split-second.wiki/format-crcs.html',

	parseRaw: (raw) => parseCrcs(raw),
	writeRaw: (model) => writeCrcs(model),
	describe: (m) =>
		`${m.crcs.length} CRC${m.crcs.length === 1 ? '' : 's'}: ` +
		`${m.crcs.slice(0, 4).map(fmt).join(', ')}${m.crcs.length > 4 ? ' …' : ''}`,

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Backdrop/Downtown_backdrop.texture.crcs',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation — exercises the writer on the read model unchanged',
			mutate: (m) => m,
			verify: (before, after) =>
				after.crcs.length === before.crcs.length
					? []
					: [`count ${after.crcs.length} != ${before.crcs.length}`],
		},
		{
			name: 'append',
			description: 'append a sentinel CRC — the tail must survive round-trip',
			mutate: (m) => ({ crcs: [...m.crcs, 0xcafebabe] }),
			verify: (_before, after) =>
				after.crcs.at(-1) === 0xcafebabe
					? []
					: [`tail ${fmt(after.crcs.at(-1) ?? 0)} != 0xCAFEBABE`],
		},
	],
};
