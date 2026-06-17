// .track registry handler — TrackTivity telemetry driving path.
// Thin wrapper around parseTrack / writeTrack in src/lib/core/track.ts.

import {
	parseTrack,
	writeTrack,
	trackStrokes,
	type ParsedTrack,
} from '../../track';
import type { ResourceHandler } from '../handler';

export const trackHandler: ResourceHandler<ParsedTrack> = {
	key: 'track',
	name: 'TrackTivity Telemetry',
	description:
		'Recorded driving path: big-endian uint32 count + count×24-byte segment records ' +
		'(two XYZ points each). Size law: 4 + count×24. Plots as polyline strokes.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.track'],
	wikiUrl: 'https://burnout.wiki/format-track.html',

	parseRaw: (raw) => parseTrack(raw),
	writeRaw: (model) => writeTrack(model),
	describe: (m) => {
		const strokes = trackStrokes(m);
		const r0 = m.records[0];
		const head = r0
			? ` first start=(${r0.start.map((v) => v.toFixed(2)).join(', ')})`
			: '';
		return (
			`${m.recordCount} segment${m.recordCount === 1 ? '' : 's'}, ` +
			`${strokes.length} stroke${strokes.length === 1 ? '' : 's'}` +
			`${m.sizeLawOk ? '' : ' (size-law MISMATCH)'}${head}`
		);
	},

	fixtures: [
		{
			file: 'TracktivityData_P_PS3-_2010_1_2_19_55_29.track',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation — exercises the writer on the read model unchanged',
			mutate: (m) => m,
			verify: (before, after) =>
				after.recordCount === before.recordCount
					? []
					: [`count ${after.recordCount} != ${before.recordCount}`],
		},
		{
			name: 'append',
			description: 'append one sentinel segment — count and tail must survive round-trip',
			mutate: (m) => ({
				...m,
				recordCount: m.recordCount + 1,
				sizeLawOk: true,
				records: [
					...m.records,
					{ start: [1, 2, 3] as [number, number, number], end: [4, 5, 6] as [number, number, number] },
				],
			}),
			verify: (_before, after) => {
				const tail = after.records.at(-1);
				return tail && tail.start[0] === 1 && tail.end[2] === 6
					? []
					: [`tail segment not preserved`];
			},
		},
	],
};
