// .dct registry handler — Split/Second localisation dictionary.
// Thin wrapper around parseDct in src/lib/core/dct.ts.
//
// Status: PARTIAL. The DICT header (version/hash/constant/entryCount) and the
// 12-byte {hash, stringOffset, reserved} record table are decoded (Confirmed),
// and the readable tail string blob is extracted. The base that stringOffset is
// measured from is unverified, so hash→string resolution is not byte-exact
// (stringsResolved=false). LITTLE-ENDIAN. Read-only.

import { parseDct, type ParsedDct } from '../../dct';
import type { ResourceHandler } from '../handler';

export const dctHandler: ResourceHandler<ParsedDct> = {
	key: 'dct',
	name: 'Localisation Dictionary',
	description:
		"Little-endian 'DICT' dictionary: header + {hash, stringOffset, reserved} record table + " +
		'packed string blob. Header and table confirmed; hash→string mapping partial.',
	category: 'Data',
	caps: { read: true, write: false },
	extensions: ['.dct'],
	magic: new Uint8Array([0x44, 0x49, 0x43, 0x54]), // 'DICT'
	wikiUrl: 'format-misc.html',

	parseRaw: (raw) => parseDct(raw),
	describe: (m) =>
		`DICT v0x${m.version.toString(16)}, ${m.entryCount} entries, ${m.strings.length} strings; ` +
		`e.g. ${m.strings.slice(0, 3).map((s) => JSON.stringify(s)).join(', ')}${
			m.strings.length > 3 ? ' …' : ''
		}`,

	fixtures: [
		{ file: 'Dictionary/ENGLISH_PS3.dct', expect: { parseOk: true } },
		{ file: 'Dictionary/GERMAN_PS3.dct', expect: { parseOk: true } },
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'entry count + string count stable across a parse cycle',
			mutate: (m) => m,
			verify: (before, after) =>
				after.entryCount === before.entryCount &&
				after.strings.length === before.strings.length
					? []
					: ['dct counts drift'],
		},
	],
};
