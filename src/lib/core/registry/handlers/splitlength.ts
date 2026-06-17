// .splitlength registry handler — TrackLogic per-section split lengths.
// Thin wrapper around parseSplitLength / writeSplitLength.

import { parseSplitLength, writeSplitLength, type ParsedSplitLength } from '../../splitlength';
import type { ResourceHandler } from '../handler';

export const splitLengthHandler: ResourceHandler<ParsedSplitLength> = {
	key: 'splitlength',
	name: 'Route Split Lengths',
	description:
		'TrackLogic per-section split-length weights: BE uint32 sectionCount + count×float32 (≈1.0). Size law 4 + count×4.',
	category: 'World',
	caps: { read: true, write: false },
	extensions: ['.splitlength'],
	wikiUrl: 'https://split-second.wiki/format-route.html',

	parseRaw: (raw) => parseSplitLength(raw),
	writeRaw: (model) => writeSplitLength(model),
	describe: (m) =>
		`${m.sectionCount} section${m.sectionCount === 1 ? '' : 's'}: ` +
		`${m.splitLengths.slice(0, 4).map((v) => v.toFixed(3)).join(', ')}` +
		`${m.splitLengths.length > 4 ? ' …' : ''}`,

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.splitlength',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation — exercises the writer on the read model unchanged',
			mutate: (m) => m,
			verify: (before, after) =>
				after.sectionCount === before.sectionCount
					? []
					: [`count ${after.sectionCount} != ${before.sectionCount}`],
		},
		{
			name: 'scale-first',
			description: 'double the first section weight — must survive round-trip',
			mutate: (m) => ({
				sectionCount: m.sectionCount,
				splitLengths: m.splitLengths.map((v, i) => (i === 0 ? v * 2 : v)),
			}),
			verify: (before, after) =>
				before.splitLengths.length === 0 ||
				Math.abs(after.splitLengths[0] - before.splitLengths[0]) < 1e-3
					? []
					: [`head ${after.splitLengths[0]} != ${before.splitLengths[0]}`],
		},
	],
};
