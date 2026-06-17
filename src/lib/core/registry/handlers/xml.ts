// XML-family registry handlers — .xml, .powerplays, .triggers.
//
// All three are plain UTF-8 XML (the latter two only LOOK binary by extension —
// see wiki format-powerplays.html / format-triggers.html). They share one
// parser (src/lib/core/xmlResource.ts) and a text-preserving byte-exact writer,
// but register as separate handlers so the loader can route by extension and the
// UI can label them distinctly.

import {
	parseXmlResource,
	writeXmlResource,
	countTag,
	type ParsedXml,
} from '../../xmlResource';
import type { ResourceHandler } from '../handler';

/** Shared describe(): root tag + element count + a domain-specific tally. */
function describeXml(m: ParsedXml, countOf?: string): string {
	const root = m.root?.tag ?? '(empty)';
	const fileVersion = m.root?.attrs.FileVersion;
	const tally =
		countOf && m.root ? `, ${countTag(m.root, countOf)} <${countOf}>` : '';
	const ver = fileVersion ? ` FileVersion=${fileVersion}` : '';
	return `<${root}>${ver}, ${m.elementCount} element(s)${tally}`;
}

export const xmlHandler: ResourceHandler<ParsedXml> = {
	key: 'xml',
	name: 'XML Config',
	description:
		'Plain UTF-8 XML config (audio, cameras, tonic engine states, etc.). Parsed to a ' +
		'serializable element tree; the writer reproduces the source byte-for-byte.',
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.xml'],
	magic: new Uint8Array([0x3c, 0x52, 0x6f, 0x6f]), // '<Roo' (most SS XML opens <Root>)
	wikiUrl: 'format-misc.html',

	parseRaw: (raw) => parseXmlResource(raw),
	writeRaw: (model) => writeXmlResource(model),
	describe: (m) => describeXml(m),

	fixtures: [
		{
			file: 'Audio/Locales/airport/airport_Audio_Reverb.xml',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'source is preserved verbatim across parse → write',
			mutate: (m) => m,
			verify: (before, after) =>
				after.source === before.source ? [] : ['source not preserved'],
		},
	],
};

export const powerplaysHandler: ResourceHandler<ParsedXml> = {
	key: 'powerplays',
	name: 'Powerplays (XML)',
	description:
		'Per-subtrack catalogue of powerplay set-piece definitions. Plain UTF-8 XML: a flat ' +
		'list of <Powerplay> elements (placement matrix, timelines, animated-prop tree).',
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.powerplays'],
	wikiUrl: 'format-powerplays.html',

	parseRaw: (raw) => parseXmlResource(raw),
	writeRaw: (model) => writeXmlResource(model),
	describe: (m) => describeXml(m, 'Powerplay'),

	fixtures: [
		{
			file: 'Environments/Levels/docks/Subtracks/A/docks.powerplays',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'source preserved + <Powerplay> count stable',
			mutate: (m) => m,
			verify: (before, after) =>
				after.source === before.source &&
				countTag(after.root, 'Powerplay') === countTag(before.root, 'Powerplay')
					? []
					: ['powerplays changed across round-trip'],
		},
	],
};

export const triggersHandler: ResourceHandler<ParsedXml> = {
	key: 'triggers',
	name: 'Triggers (XML)',
	description:
		'Per-subtrack list of powerplay trigger volumes. Plain UTF-8 XML: <Trigger> elements ' +
		'with a posAndScale sphere and a powerplay/timeline reference. Empty form is a 32-byte stub.',
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.triggers'],
	wikiUrl: 'format-triggers.html',

	parseRaw: (raw) => parseXmlResource(raw),
	writeRaw: (model) => writeXmlResource(model),
	describe: (m) => describeXml(m, 'Trigger'),

	fixtures: [
		{
			file: 'Environments/Levels/docks/Subtracks/A/docks.triggers',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			file: 'Environments/Levels/nem_downtown/Subtracks/A/nem_downtown.triggers',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'source preserved + <Trigger> count stable',
			mutate: (m) => m,
			verify: (before, after) =>
				after.source === before.source &&
				countTag(after.root, 'Trigger') === countTag(before.root, 'Trigger')
					? []
					: ['triggers changed across round-trip'],
		},
	],
};
