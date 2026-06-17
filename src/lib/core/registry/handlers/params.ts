// .params registry handler — Black Rock's plaintext tuning grammar.
// Thin wrapper around parseParams / writeParams in src/lib/core/params.ts.

import {
	parseParams,
	writeParams,
	countParamEntries,
	type ParsedParams,
} from '../../params';
import type { ResourceHandler } from '../handler';

export const paramsHandler: ResourceHandler<ParsedParams> = {
	key: 'params',
	name: 'Tuning Params',
	description:
		"Black Rock plaintext tuning grammar: '!directory:' header, '/section:' groups, " +
		"and 'key = value (min, max);' tuples parsed to a tree of groups/sections/entries.",
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.params'],
	wikiUrl: 'data-params.html',

	parseRaw: (raw) => parseParams(raw),
	// Byte-exact writer: a verbatim line model is the source of truth, so an
	// unmodified document round-trips byte-for-byte; an edit splices only the
	// changed value's column span. Validated against many real .params files
	// (CRLF/LF/mixed endings, no-trailing-newline, blank-line runs, escaped
	// quotes, `==`-in-key). See params.test.ts "round-trips real sample…".
	writeRaw: (model) => writeParams(model),
	describe: (m) => {
		const sections = m.groups.reduce((n, g) => n + g.sections.length, 0);
		const entries = countParamEntries(m);
		const first = m.groups[0]?.directory ?? '(none)';
		return `${m.groups.length} group(s), ${sections} section(s), ${entries} entr${
			entries === 1 ? 'y' : 'ies'
		}; dir=${first}`;
	},

	fixtures: [
		// GlobalParams: CRLF, single group. EffectParams: CRLF, multi-section.
		{ file: 'AreaOfEffects/GlobalParams.params', expect: { parseOk: true, byteRoundTrip: true } },
		{ file: 'AreaOfEffects/EffectParams.params', expect: { parseOk: true, byteRoundTrip: true } },
		// Cameras: LF endings, MANY back-to-back `!directory:` groups, no trailing
		// newline on some — the hardest line-structure cases.
		{
			file: 'Cameras/CommonCameras/Cameras.params',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		// PostProcess: MIXED endings + escaped-quote / colon-laden values.
		{
			file: 'Environments/Levels/airport_test_03/Params/PostProcess.params',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'parse → write → parse keeps the group/entry counts',
			mutate: (m) => m,
			verify: (before, after) =>
				after.groups.length === before.groups.length &&
				countParamEntries(after) === countParamEntries(before)
					? []
					: [
							`group ${after.groups.length}/${before.groups.length} ` +
								`entries ${countParamEntries(after)}/${countParamEntries(before)}`,
						],
		},
	],
};

// Re-export the byte-exact writer for the round-trip stress runner / CLI.
export { writeParams };
