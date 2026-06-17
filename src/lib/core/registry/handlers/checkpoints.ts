// .checkpoints registry handler — TrackLogic lap checkpoint table (PARTIAL).
// Thin wrapper around parseCheckpoints. Read-only: the body sub-records are not
// yet field-decoded, so there is no writer (caps.write = false).

import { parseCheckpoints, type ParsedCheckpoints } from '../../checkpoints';
import type { ResourceHandler } from '../handler';

export const checkpointsHandler: ResourceHandler<ParsedCheckpoints> = {
	key: 'checkpoints',
	name: 'Route Checkpoints',
	description:
		'TrackLogic lap checkpoint table — fixed 348-byte tagged-serializer record. Header (version 3.0, beginTag CDAB0DF0, bodySize 0x150) decoded; nested body PARTIAL.',
	category: 'World',
	caps: { read: true, write: false },
	extensions: ['.checkpoints'],
	// Begin-object sentinel that follows the 4-byte version word.
	magic: new Uint8Array([0x00, 0x03, 0x00, 0x00, 0xcd, 0xab, 0x0d, 0xf0]),
	wikiUrl: 'https://split-second.wiki/format-route.html',

	parseRaw: (raw) => parseCheckpoints(raw),
	describe: (m) =>
		`v${(m.version >>> 16)}.${m.version & 0xffff}, bodySize ${m.bodySize} (0x${m.bodySize.toString(16)}), ` +
		`${m.endSentinelCount} end-sentinels${m.headerValid ? '' : ' [HEADER MISMATCH]'}`,

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.checkpoints',
			expect: { parseOk: true },
		},
	],
};
