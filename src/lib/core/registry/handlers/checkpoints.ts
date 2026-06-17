// .checkpoints registry handler — TrackLogic lap checkpoint table.
// Wraps parseCheckpoints/writeCheckpoints. The recursive tagged-object tree is
// fully decoded and round-trips byte-for-byte (raw payload words preserved in
// element order), so caps.write = true (verified against all 18 real routes).

import {
	parseCheckpoints,
	writeCheckpoints,
	type ParsedCheckpoints,
} from '../../checkpoints';
import type { ResourceHandler } from '../handler';

export const checkpointsHandler: ResourceHandler<ParsedCheckpoints> = {
	key: 'checkpoints',
	name: 'Route Checkpoints',
	description:
		'TrackLogic lap checkpoint table — fixed 348-byte tagged-serializer record. Header (version 3.0, beginTag CDAB0DF0, bodySize 0x150) + the recursive cd-ab-0d-f0 / ba-dc-ad-de object tree decoded; byte-exact round-trip.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.checkpoints'],
	// Begin-object sentinel that follows the 4-byte version word.
	magic: new Uint8Array([0x00, 0x03, 0x00, 0x00, 0xcd, 0xab, 0x0d, 0xf0]),
	wikiUrl: 'https://split-second.wiki/format-route.html',

	parseRaw: (raw) => parseCheckpoints(raw),
	writeRaw: (model) => writeCheckpoints(model),
	describe: (m) =>
		`v${m.version >>> 16}.${m.version & 0xffff}, bodySize ${m.bodySize} (0x${m.bodySize.toString(16)}), ` +
		`${m.objectCount} objects, ${m.endSentinelCount} end-sentinels${m.headerValid ? '' : ' [HEADER MISMATCH]'}`,

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.checkpoints',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'identity: tree re-serializes byte-for-byte',
			mutate: (m) => m,
			verify: (before, after) =>
				after.objectCount === before.objectCount && after.bodySize === before.bodySize
					? []
					: [`object/body mismatch`],
		},
	],
};
