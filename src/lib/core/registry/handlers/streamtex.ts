// .streamtex registry handler — headerless full-resolution pixel payload for a
// sibling .textures stub (see wiki/format-streamtex.html).
//
// A .streamtex has no magic and no self-describing structure: its layout is
// dictated entirely by the companion .textures descriptor. On its own the
// handler records the payload size; decoding requires pairing with the stub via
// decodeStreamtexWithStub (called by the texture viewport). Read-only.

import { parseStreamtex, type ParsedStreamtex } from '../../streamtex';
import type { ResourceHandler } from '../handler';

const fmtBytes = (n: number) => {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

export const streamtexHandler: ResourceHandler<ParsedStreamtex> = {
	key: 'streamtex',
	name: 'Streamed Texture Payload',
	description:
		'Headerless full-resolution swizzled pixel payload for a sibling .textures ' +
		'stub. No magic or table of its own — layout (format/dims/mips/offset) comes ' +
		'from the companion .textures descriptor. Read-only; decoded by pairing with ' +
		'the stub.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.streamtex'],
	// No magic — a .streamtex starts with raw swizzled pixel data.
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseStreamtex(raw),

	describe: (m) =>
		`streamtex: ${fmtBytes(m.byteLength)} raw payload (decode needs the sibling .textures stub)`,

	fixtures: [
		{
			file: 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.streamtex',
			expect: { parseOk: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'payload length is preserved through parse',
			mutate: (m) => m,
			verify: (before, after) =>
				after.byteLength === before.byteLength
					? []
					: [`length ${after.byteLength} != ${before.byteLength}`],
		},
	],
};
