// .highlighttags registry handler — HUD highlight-marker table (XML).
// Thin wrapper around parseHighlightTags / writeHighlightTags.
//
// Plaintext XML, one per level. The decoded model surfaces typed HighlightTag
// records (id/idCRC/icon/relative_transform + 4x3 transform + linked powerplay)
// AND world-space Row3 points so the World viewport can render markers. The
// writer re-emits the verbatim source, so the round-trip is byte-exact.

import {
	parseHighlightTags,
	writeHighlightTags,
	type ParsedHighlightTags,
} from '../../highlighttags';
import type { ResourceHandler } from '../handler';

export const highlightTagsHandler: ResourceHandler<ParsedHighlightTags> = {
	key: 'highlighttags',
	name: 'HUD Highlight Tags',
	description:
		'Per-level plaintext XML list of HUD highlight markers: <HighlightTag> with a 4x3 ' +
		'transform + linked <Powerplay>. Decoded to typed records + world points; the writer ' +
		'reproduces the source byte-for-byte.',
	category: 'World',
	extensions: ['.highlighttags'],
	// '<Roo' — every shipped file opens <Root FileVersion="2.0000000">.
	magic: new Uint8Array([0x3c, 0x52, 0x6f, 0x6f]),
	caps: { read: true, write: true },
	wikiUrl: 'format-highlighttags.html',

	parseRaw: (raw) => parseHighlightTags(raw),
	writeRaw: (model) => writeHighlightTags(model),
	describe: (m) => {
		if (m.count === 0) return `v${m.fileVersion}, 0 markers (empty stub)`;
		const abs = m.tags.filter((t) => !t.relativeTransform).length;
		const flagInfo = abs === 0 ? 'all relative' : `${abs} absolute`;
		return `v${m.fileVersion}, ${m.count} marker${m.count === 1 ? '' : 's'} (${flagInfo})`;
	},

	fixtures: [
		{
			file: 'Environments/Levels/Graveyard/Graveyard.highlighttags',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			// busiest level — 20 KB, the most markers
			file: 'Environments/Levels/docks/docks.highlighttags',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			// the only level with relative_transform="false" tags
			file: 'Environments/Levels/airport_test_03/airport_test_03.highlighttags',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			// empty self-closing root (32-byte stub)
			file: 'Environments/Levels/nem_storm/nem_storm.highlighttags',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'source preserved verbatim + marker count stable',
			mutate: (m) => m,
			verify: (before, after) =>
				after.xml.source === before.xml.source && after.count === before.count
					? []
					: ['highlighttags changed across round-trip'],
		},
		{
			name: 'decode-consistency',
			description: 'every decoded tag still carries a 12-float basis + Row3 point',
			mutate: (m) => m,
			verify: (_before, after) => {
				const problems: string[] = [];
				after.tags.forEach((t, i) => {
					if (t.transform.basis.length !== 9)
						problems.push(`tag ${i} basis len ${t.transform.basis.length}`);
					if (t.transform.translation.length !== 3)
						problems.push(`tag ${i} translation len`);
				});
				if (after.points.length !== after.count)
					problems.push(`points ${after.points.length} != count ${after.count}`);
				return problems;
			},
		},
	],
};
