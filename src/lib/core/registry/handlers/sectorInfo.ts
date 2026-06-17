// .sectorInfo registry handler — per-level streaming / visibility partition.
// Thin wrapper around parseSectorInfo in src/lib/core/sectorInfo.ts.
// PARTIAL + READ-ONLY: the 12-byte header and the q### sector-tag enumeration
// are decoded (the tag count matches the header sectorCount on every level),
// but the per-chunk body (AABB / index lists / name) is not yet resolved, so
// there is no writer — the Hex fallback covers the undecoded body.

import { parseSectorInfo, type ParsedSectorInfo } from '../../sectorInfo';
import type { ResourceHandler } from '../handler';

export const sectorInfoHandler: ResourceHandler<ParsedSectorInfo> = {
	key: 'sectorInfo',
	name: 'Sector Partition',
	description:
		'Big-endian header (constA 1.92, constB 300.0, sectorCount @0x8) followed by ' +
		'q###-tagged sector chunks (UTF-16LE strings). Header + tag count solved; chunk body partial.',
	category: 'World',
	caps: { read: true, write: false },
	extensions: ['.sectorinfo'],
	wikiUrl: 'https://burnout.wiki/format-sectors.html',

	parseRaw: (raw) => parseSectorInfo(raw),
	describe: (m) =>
		`${m.sectorCount} sector${m.sectorCount === 1 ? '' : 's'}, ` +
		`${m.chunks.length} q-tag${m.chunks.length === 1 ? '' : 's'}` +
		`${m.countMatches ? ' (match)' : ' (COUNT MISMATCH)'}, ` +
		`const=(${m.constA.toFixed(2)}, ${m.constB.toFixed(1)})`,

	fixtures: [
		{
			// read-only: only parseOk is asserted (no writer to round-trip)
			file: 'Environments/Levels/Downtown/Sectors/Downtown.sectorInfo',
			expect: { parseOk: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'read-only: confirm the decoded sector count is stable',
			mutate: (m) => m,
			verify: (before, after) =>
				after.sectorCount === before.sectorCount ? [] : [`count mismatch`],
		},
	],
};
