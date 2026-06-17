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
	caps: { read: true, write: false },
	extensions: ['.params'],
	wikiUrl: 'format-misc.html',

	parseRaw: (raw) => parseParams(raw),
	// Text-grammar writer exists but is not byte-exact (CRLF/whitespace
	// normalisation); kept read-only for the MVP. Re-enable caps.write once a
	// fully faithful serializer is validated.
	describe: (m) => {
		const sections = m.groups.reduce((n, g) => n + g.sections.length, 0);
		const entries = countParamEntries(m);
		const first = m.groups[0]?.directory ?? '(none)';
		return `${m.groups.length} group(s), ${sections} section(s), ${entries} entr${
			entries === 1 ? 'y' : 'ies'
		}; dir=${first}`;
	},

	fixtures: [
		{ file: 'AreaOfEffects/GlobalParams.params', expect: { parseOk: true } },
		{ file: 'AreaOfEffects/EffectParams.params', expect: { parseOk: true } },
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

// Re-export for the round-trip stress runner if it later flips caps.write on.
export { writeParams };
