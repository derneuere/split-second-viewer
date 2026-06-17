// .sectorInfo registry handler — per-level streaming / visibility partition.
// Wraps parseSectorInfo/writeSectorInfo. The 12-byte header, the q### chunk
// enumeration (tag + offset + length), each chunk's UTF-16LE name, and each
// chunk's world-space AABB (at the CONFIRMED in-chunk +0x4C) are decoded; the
// still-Theory chunk index lists are preserved verbatim in `model.body`.
// writeRaw re-emits header + verbatim body — byte-exact across all 10 real
// levels — so caps.write = true. The decoded AABBs feed the World viewport.

import { parseSectorInfo, writeSectorInfo, type ParsedSectorInfo } from '../../sectorInfo';
import type { ResourceHandler } from '../handler';

export const sectorInfoHandler: ResourceHandler<ParsedSectorInfo> = {
	key: 'sectorInfo',
	name: 'Sector Partition',
	description:
		'Big-endian header (constA 1.92, constB 300.0, sectorCount @0x8) followed by ' +
		'q###-tagged sector chunks (UTF-16LE names + world-space AABB @+0x4C). Header + tag count + per-chunk AABB decoded; chunk index lists preserved verbatim. Byte-exact round-trip.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.sectorinfo'],
	wikiUrl: 'https://burnout.wiki/format-sectors.html',

	parseRaw: (raw) => parseSectorInfo(raw),
	writeRaw: (model) => writeSectorInfo(model),
	describe: (m) => {
		const withBounds = m.chunks.filter((c) => c.aabb).length;
		return (
			`${m.sectorCount} sector${m.sectorCount === 1 ? '' : 's'}, ` +
			`${m.chunks.length} q-tag${m.chunks.length === 1 ? '' : 's'}` +
			`${m.countMatches ? ' (match)' : ' (COUNT MISMATCH)'}, ` +
			`${withBounds} with AABB, const=(${m.constA.toFixed(2)}, ${m.constB.toFixed(1)})`
		);
	},

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Sectors/Downtown.sectorInfo',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			file: 'Environments/Levels/nem_graveyard/Sectors/nem_graveyard.sectorInfo',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'identity: header + verbatim body re-serialize byte-for-byte',
			mutate: (m) => m,
			verify: (before, after) =>
				after.sectorCount === before.sectorCount && after.chunks.length === before.chunks.length
					? []
					: ['count mismatch'],
		},
	],
};
