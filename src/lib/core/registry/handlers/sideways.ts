// .sideways registry handler — TrackLogic lateral adjacency table.
// Thin wrapper around parseSideways / writeSideways.

import { parseSideways, writeSideways, type ParsedSideways } from '../../sideways';
import type { ResourceHandler } from '../handler';

export const sidewaysHandler: ResourceHandler<ParsedSideways> = {
	key: 'sideways',
	name: 'Route Sideways Links',
	description:
		'TrackLogic lateral adjacency: BE uint32 linkCount + per-link record (uint8 N then N×uint16 link indices). Decodes Track.sideways.txt.',
	category: 'World',
	caps: { read: true, write: false },
	extensions: ['.sideways'],
	wikiUrl: 'https://split-second.wiki/format-route.html',

	parseRaw: (raw) => parseSideways(raw),
	writeRaw: (model) => writeSideways(model),
	describe: (m) => {
		const withLinks = m.links.filter((l) => l.count > 0).length;
		return `${m.linkCount} links, ${withLinks} with sideways neighbours`;
	},

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.sideways',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation — exercises the writer on the read model unchanged',
			mutate: (m) => m,
			verify: (before, after) =>
				after.linkCount === before.linkCount &&
				after.links.length === before.links.length
					? []
					: [`count ${after.linkCount}/${after.links.length} != ${before.linkCount}/${before.links.length}`],
		},
		{
			name: 'append-neighbour',
			description: 'add a sideways neighbour to the first link — must survive round-trip',
			mutate: (m) => ({
				linkCount: m.linkCount,
				links: m.links.map((l, i) =>
					i === 0 ? { count: l.count + 1, linkIndices: [...l.linkIndices, 7] } : l,
				),
			}),
			verify: (before, after) =>
				before.links.length === 0 ||
				after.links[0].linkIndices.at(-1) === before.links[0].linkIndices.at(-1)
					? []
					: [`head tail ${after.links[0].linkIndices.at(-1)} != ${before.links[0].linkIndices.at(-1)}`],
		},
	],
};
