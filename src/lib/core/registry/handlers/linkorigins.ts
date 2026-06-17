// .linkorigins registry handler — TrackLogic per-link arc-length origins.
// Thin wrapper around parseLinkOrigins / writeLinkOrigins.

import { parseLinkOrigins, writeLinkOrigins, type ParsedLinkOrigins } from '../../linkorigins';
import type { ResourceHandler } from '../handler';

export const linkOriginsHandler: ResourceHandler<ParsedLinkOrigins> = {
	key: 'linkorigins',
	name: 'Route Link Origins',
	description:
		'TrackLogic per-link arc-length origins: BE uint32 linkCount + count×float32 (metres along the spline). Size law 4 + count×4.',
	category: 'World',
	caps: { read: true, write: false },
	extensions: ['.linkorigins'],
	wikiUrl: 'https://split-second.wiki/format-route.html',

	parseRaw: (raw) => parseLinkOrigins(raw),
	writeRaw: (model) => writeLinkOrigins(model),
	describe: (m) =>
		`${m.linkCount} link${m.linkCount === 1 ? '' : 's'}: ` +
		`${m.origins.slice(0, 4).map((v) => v.toFixed(2)).join(', ')}` +
		`${m.origins.length > 4 ? ' …' : ''}`,

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.linkorigins',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation — exercises the writer on the read model unchanged',
			mutate: (m) => m,
			verify: (before, after) =>
				after.linkCount === before.linkCount
					? []
					: [`count ${after.linkCount} != ${before.linkCount}`],
		},
		{
			name: 'shift-first',
			description: 'offset the first origin — must survive round-trip',
			mutate: (m) => ({
				linkCount: m.linkCount,
				origins: m.origins.map((v, i) => (i === 0 ? v + 100 : v)),
			}),
			// `before` is the already-mutated model; after reparse the head must match it.
			verify: (before, after) =>
				before.origins.length === 0 ||
				Math.abs(after.origins[0] - before.origins[0]) < 1e-2
					? []
					: [`head ${after.origins[0]} != ${before.origins[0]}`],
		},
	],
};
