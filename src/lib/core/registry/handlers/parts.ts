// .parts registry handler — vehicle part hierarchy (PARTIAL).
// Thin wrapper around parseParts. Read-only: only the 8-byte header is solidly
// decoded; the per-node record framing is not yet pinned, so there is no
// writer (caps.write = false).

import { parseParts, type ParsedParts } from '../../parts';
import type { ResourceHandler } from '../handler';

export const partsHandler: ResourceHandler<ParsedParts> = {
	key: 'parts',
	name: 'Vehicle Part Hierarchy',
	description:
		'Vehicle body-panel / wheel part hierarchy (damage/deform). BE typed array: u32 count + u32 elementSize header (decoded), then index/flag + float32 transform nodes (PARTIAL).',
	category: 'Data',
	caps: { read: true, write: false },
	extensions: ['.parts'],
	wikiUrl: 'https://split-second.wiki/system-tracks.html',

	parseRaw: (raw) => parseParts(raw),
	describe: (m) =>
		`count ${m.count}, elementSize ${m.elementSize} (0x${m.elementSize.toString(16)}), ` +
		`${m.wordCount} payload words${m.wordAligned ? '' : ' [not word-aligned]'}`,

	fixtures: [
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.parts',
			expect: { parseOk: true },
		},
	],
};
