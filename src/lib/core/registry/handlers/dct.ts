// .dct registry handler — Split/Second localisation dictionary.
// Thin wrapper around parseDct / writeDct in src/lib/core/dct.ts.
//
// Status: PARTIAL DECODE, BYTE-EXACT WRITER. The DICT header
// (version/hash/constant/entryCount) and the 12-byte {hash, stringOffset,
// reserved} record table are decoded (Confirmed), and the readable tail string
// blob is extracted. The base that stringOffset is measured from is unverified,
// so hash→string resolution is not byte-exact (stringsResolved=false). Because
// the model keeps the verbatim source bytes, the writer is a byte-exact
// passthrough — writeRaw(parse(b)) === b. LITTLE-ENDIAN.

import { parseDct, writeDct, type ParsedDct } from '../../dct';
import type { ResourceHandler } from '../handler';

export const dctHandler: ResourceHandler<ParsedDct> = {
	key: 'dct',
	name: 'Localisation Dictionary',
	description:
		"Little-endian 'DICT' dictionary: header + {hash, stringOffset, reserved} record table + " +
		'packed string blob. Header and table confirmed; hash→string mapping partial. ' +
		'Byte-exact passthrough writer (unmodified docs round-trip identically).',
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.dct'],
	magic: new Uint8Array([0x44, 0x49, 0x43, 0x54]), // 'DICT'
	wikiUrl: 'format-misc.html',

	parseRaw: (raw) => parseDct(raw),
	writeRaw: (model) => writeDct(model),
	describe: (m) => {
		const blobBytes = Math.max(0, m.raw.byteLength - m.stringBlobOffset);
		const sample = m.strings
			.slice(0, 3)
			.map((s) => JSON.stringify(s))
			.join(', ');
		return (
			`DICT v0x${m.version.toString(16)}, fileHash 0x${(m.fileHash >>> 0)
				.toString(16)
				.padStart(8, '0')}, ${m.entryCount} entr${m.entryCount === 1 ? 'y' : 'ies'}, ` +
			`${m.strings.length} string(s) in ${blobBytes}B blob; e.g. ${sample}${
				m.strings.length > 3 ? ' …' : ''
			}`
		);
	},

	fixtures: [
		{ file: 'Dictionary/ENGLISH_PS3.dct', expect: { parseOk: true, byteRoundTrip: true } },
		{ file: 'Dictionary/GERMAN_PS3.dct', expect: { parseOk: true, byteRoundTrip: true } },
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
