// .parts registry handler — vehicle part hierarchy.
// Header (count + elementSize) decoded; 12-float affine transform blocks
// (offset vectors) surfaced as a read-only overlay for the viewer. The payload
// is preserved verbatim, so writeRaw round-trips byte-for-byte across every real
// sample (all .parts files are word-aligned), so caps.write = true. The exact
// per-node record framing is still unresolved (documented in the parser).

import { parseParts, writeParts, type ParsedParts } from '../../parts';
import type { ResourceHandler } from '../handler';

export const partsHandler: ResourceHandler<ParsedParts> = {
	key: 'parts',
	name: 'Vehicle Part Hierarchy',
	description:
		'Vehicle body-panel / wheel part hierarchy (damage/deform). BE table: u32 count + u32 elementSize header, then index/flag fields, 0xFFFFFFFF terminators and 12-float affine transform blocks (offset vectors decoded). Byte-exact round-trip.',
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.parts'],
	wikiUrl: 'https://split-second.wiki/system-tracks.html',

	parseRaw: (raw) => parseParts(raw),
	writeRaw: (model) => writeParts(model),
	describe: (m) =>
		`count ${m.count}, elementSize ${m.elementSize} (0x${m.elementSize.toString(16)}), ` +
		`${m.wordCount} words, ${m.transforms.length} transform${m.transforms.length === 1 ? '' : 's'}, ` +
		`${m.terminatorCount} terminator${m.terminatorCount === 1 ? '' : 's'}` +
		`${m.wordAligned ? '' : ' [not word-aligned]'}`,

	fixtures: [
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.parts',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			file: 'Vehicles/Bodies/Supercar_01/Supercar_01.parts',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'identity: header + payload words re-serialize byte-for-byte',
			mutate: (m) => m,
			verify: (before, after) =>
				after.wordCount === before.wordCount && after.transforms.length === before.transforms.length
					? []
					: ['word/transform count mismatch'],
		},
	],
};
