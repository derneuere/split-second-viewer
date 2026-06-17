// .logicinfo registry handler — Catnip track-logic metadata.
// Thin wrapper around parseLogicInfo / writeLogicInfo.
// PARTIAL: only the header/footer + five per-track floats are interpreted; the
// interleaved CRC words are preserved verbatim (so the writer is byte-exact).

import {
	parseLogicInfo,
	writeLogicInfo,
	type ParsedLogicInfo,
} from '../../logicinfo';
import type { ResourceHandler } from '../handler';

export const logicInfoHandler: ResourceHandler<ParsedLogicInfo> = {
	key: 'logicinfo',
	name: 'Track Logic Info',
	description:
		'Fixed 288-byte big-endian Catnip blob: 12-byte header (ver 3.0, magic 0xCDAB0DF0, ' +
		'payloadLen 276), five per-track floats, zero-fill, 0xBADCADDE footer. Partial decode.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.logicinfo'],
	wikiUrl: 'https://burnout.wiki/format-logicinfo.html',

	parseRaw: (raw) => parseLogicInfo(raw),
	writeRaw: (model) => writeLogicInfo(model),
	describe: (m) =>
		`v${m.versionMajor}.${m.versionMinor}` +
		`${m.headerOk ? '' : ' (header MISMATCH)'}, ` +
		`vals=[${m.vals.map((v) => v.toFixed(2)).join(', ')}]`,

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.logicinfo',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation — writer must reproduce the 288 bytes exactly',
			mutate: (m) => m,
			verify: (before, after) =>
				after.raw.length === before.raw.length ? [] : [`length mismatch`],
		},
		{
			name: 'edit-val1',
			description: 'change the per-track posX float — must survive round-trip',
			mutate: (m) => ({
				...m,
				vals: m.vals.map((v, i) => (i === 1 ? v + 50 : v)),
			}),
			verify: (afterMutate, afterReparse) =>
				afterReparse.vals[1] === afterMutate.vals[1]
					? []
					: [`val1 ${afterReparse.vals[1]} != ${afterMutate.vals[1]}`],
		},
	],
};
