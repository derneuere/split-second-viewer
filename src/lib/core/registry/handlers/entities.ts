// .entities registry handler — Catnip entity-instance table.
// Thin wrapper around parseEntities / writeEntities in src/lib/core/entities.ts.

import {
	parseEntities,
	writeEntities,
	ENTITIES_MAGIC_BYTES,
	type ParsedEntities,
} from '../../entities';
import type { ResourceHandler } from '../handler';

export const entitiesHandler: ResourceHandler<ParsedEntities> = {
	key: 'entities',
	name: 'Catnip Entities',
	description:
		"Big-endian 'ENTS' v3 table: 32-byte header + count×97-byte records " +
		'(name[33] + position + scale + 3×3 rotation + spawn index). Size law: 32 + count×97.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.entities'],
	magic: ENTITIES_MAGIC_BYTES,
	wikiUrl: 'https://burnout.wiki/format-entities.html',

	parseRaw: (raw) => parseEntities(raw),
	writeRaw: (model) => writeEntities(model),
	describe: (m) => {
		const r0 = m.records[0];
		const head = r0
			? ` first="${r0.name}" pos=(${r0.position.map((v) => v.toFixed(2)).join(', ')})`
			: '';
		return (
			`v${m.version}, ${m.count} entit${m.count === 1 ? 'y' : 'ies'}` +
			`${m.sizeLawOk ? '' : ' (size-law MISMATCH)'}${head}`
		);
	},

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Subtracks/A/Downtown.entities',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation',
			mutate: (m) => m,
			verify: (before, after) =>
				after.count === before.count ? [] : [`count mismatch`],
		},
		{
			name: 'move-player1',
			description: 'translate the first start position — must survive round-trip',
			mutate: (m) => ({
				...m,
				records: m.records.map((r, i) =>
					i === 0
						? { ...r, position: [r.position[0] + 100, r.position[1], r.position[2]] as [number, number, number] }
						: r,
				),
			}),
			verify: (afterMutate, afterReparse) => {
				const a = afterReparse.records[0]?.position[0];
				const b = afterMutate.records[0]?.position[0];
				return a === b ? [] : [`pos.x ${a} != ${b}`];
			},
		},
	],
};
