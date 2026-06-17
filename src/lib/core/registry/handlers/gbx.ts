// .gbx registry handler — per-light-rig override / extras table.
// Thin wrapper around parseGbx / writeGbx in src/lib/core/gbx.ts.
// (Black Rock light-rig table, NOT the Nadeo/TrackMania GameBox format.)

import { parseGbx, writeGbx, type ParsedGbx } from '../../gbx';
import type { ResourceHandler } from '../handler';

export const gbxHandler: ResourceHandler<ParsedGbx> = {
	key: 'gbx',
	name: 'Light-Rig Overrides',
	description:
		'Big-endian uint32 count + per-record {typeHash, len+ASCII type, nameHash, ' +
		'len+ASCII instance, 12×float32}. Type "Ambient Light" / "Prop Draw Distance".',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.gbx'],
	wikiUrl: 'https://burnout.wiki/format-nis.html',

	parseRaw: (raw) => parseGbx(raw),
	writeRaw: (model) => writeGbx(model),
	describe: (m) => {
		if (m.recordCount === 0) return '0 overrides (empty stub)';
		const sample = m.records
			.slice(0, 2)
			.map((r) => `"${r.typeName}":${r.instanceName}`)
			.join(', ');
		return `${m.recordCount} override${m.recordCount === 1 ? '' : 's'}: ${sample}${m.recordCount > 2 ? ' …' : ''}`;
	},

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/LightRigs/sunset/sunset.gbx',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			// empty 4-byte stub — exercises the recordCount==0 path
			file: 'Environments/Levels/Downtown/LightRigs/midday/midday.gbx',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation',
			mutate: (m) => m,
			verify: (before, after) =>
				after.recordCount === before.recordCount ? [] : [`count mismatch`],
		},
		{
			name: 'scale-values',
			description: 'double every float value — must survive round-trip',
			mutate: (m) => ({
				...m,
				records: m.records.map((r) => ({ ...r, values: r.values.map((v) => v * 2) })),
			}),
			verify: (afterMutate, afterReparse) => {
				for (let i = 0; i < afterMutate.records.length; i++) {
					for (let f = 0; f < afterMutate.records[i].values.length; f++) {
						const a = afterReparse.records[i]?.values[f];
						const b = afterMutate.records[i].values[f];
						// float32 re-encode: compare with tolerance for non-finite safety
						if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
							return [`value [${i}][${f}] ${a} != ${b}`];
						}
					}
				}
				return [];
			},
		},
	],
};
