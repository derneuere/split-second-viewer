// .nis registry handler — TrackLogic / AITrack route manifest.
// Thin wrapper around parseNis / writeNis in src/lib/core/nis.ts.

import { parseNis, writeNis, NIS_MAGIC, type ParsedNis } from '../../nis';
import type { ResourceHandler } from '../handler';

export const nisHandler: ResourceHandler<ParsedNis> = {
	key: 'nis',
	name: 'TrackLogic Route Manifest',
	description:
		"AITrack route table (magic 'i' 0x69): uint8 count + per-record " +
		'{uint16 segmentId, NUL-terminated zoneCode, uint8 flag}. Not a cutscene.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.nis'],
	magic: new Uint8Array([NIS_MAGIC]),
	wikiUrl: 'https://burnout.wiki/format-nis.html',

	parseRaw: (raw) => parseNis(raw),
	writeRaw: (model) => writeNis(model),
	describe: (m) => {
		const sample = m.records
			.slice(0, 3)
			.map((r) => `${r.segmentId}:"${r.zoneCode}"=${r.flag}`)
			.join(', ');
		return (
			`${m.recordCount} zone${m.recordCount === 1 ? '' : 's'}` +
			`${m.recordCount ? ': ' + sample + (m.recordCount > 3 ? ' …' : '') : ' (empty stub)'}`
		);
	},

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.nis',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation',
			mutate: (m) => m,
			verify: (before, after) =>
				after.recordCount === before.recordCount
					? []
					: [`count ${after.recordCount} != ${before.recordCount}`],
		},
		{
			name: 'flip-flags',
			description: 'invert every per-zone flag — must survive round-trip',
			mutate: (m) => ({
				...m,
				records: m.records.map((r) => ({ ...r, flag: r.flag ? 0 : 1 })),
			}),
			// verify(afterMutate, afterReparse): the reparsed model must match the
			// mutated one flag-for-flag.
			verify: (afterMutate, afterReparse) => {
				for (let i = 0; i < afterMutate.records.length; i++) {
					if (afterReparse.records[i]?.flag !== afterMutate.records[i].flag) {
						return [`flag ${i} not preserved through round-trip`];
					}
				}
				return [];
			},
		},
	],
};
