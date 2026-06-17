import { describe, expect, it } from 'vitest';
import { paramsHandler } from '../params';
import { parseParams, countParamEntries } from '../../../params';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture mirrors the real grammar: a directory header, a section, and
// entries covering the quoted-key + range, unquoted-key + range, bool, and
// quoted-string value forms. CRLF, as on the devkit.
const INLINE = [
	'!directory: /AreaOfEffects/GlobalParameters',
	'',
	'/AreaOfEffects/GlobalParameters:',
	"\t'a; Min Car Distance Factor' = 0.75 (0.0, 1.0);",
	'\tSubjectID = 0;',
	"\t'u; disable_danger_zone' = false;",
	"\t'b;Forced Effect Type' = 'On Opponent';",
].join('\r\n') + '\r\n';

const REAL = 'AreaOfEffects/GlobalParams.params';

describe('params parser', () => {
	it('parses the directory header, section, and typed entries (inline)', () => {
		const m = parseParams(INLINE);
		expect(m.crlf).toBe(true);
		expect(m.groups).toHaveLength(1);
		const g = m.groups[0];
		expect(g.directory).toBe('/AreaOfEffects/GlobalParameters');
		expect(g.sections).toHaveLength(1);
		const s = g.sections[0];
		expect(s.name).toBe('/AreaOfEffects/GlobalParameters');
		expect(s.entries).toHaveLength(4);

		const [floatRange, intNoRange, boolEntry, strEntry] = s.entries;

		expect(floatRange.key).toBe('a; Min Car Distance Factor');
		expect(floatRange.keyQuoted).toBe(true);
		expect(floatRange.kind).toBe('number');
		expect(floatRange.value).toBe(0.75);
		expect(floatRange.range).toEqual({ min: 0.0, max: 1.0 });

		expect(intNoRange.key).toBe('SubjectID');
		expect(intNoRange.keyQuoted).toBe(false);
		expect(intNoRange.kind).toBe('number');
		expect(intNoRange.value).toBe(0);
		expect(intNoRange.range).toBeUndefined();

		expect(boolEntry.kind).toBe('bool');
		expect(boolEntry.value).toBe(false);

		expect(strEntry.kind).toBe('string');
		expect(strEntry.value).toBe('On Opponent');
	});

	it('describe() summarizes groups/sections/entries', () => {
		const m = parseParams(INLINE);
		const text = paramsHandler.describe(m);
		expect(text).toContain('1 group(s)');
		expect(text).toContain('4 entr');
		expect(text).toContain('/AreaOfEffects/GlobalParameters');
	});

	it('tolerates an escaped-quote / colon-laden value without crashing', () => {
		const weird =
			"!directory: /X\n\nX:\n\t'@99d; Reset' = ':99d; Reset:action:\\'99d\\' ';\n";
		const m = parseParams(weird);
		expect(countParamEntries(m)).toBe(1);
		expect(m.groups[0].sections[0].entries[0].kind).toBe('string');
	});

	it.skipIf(!hasSample(REAL))('parses a REAL .params from the devkit', () => {
		const raw = readSample(REAL);
		const m = paramsHandler.parseRaw(raw, ssCtx());
		expect(m.groups.length).toBeGreaterThanOrEqual(1);
		expect(m.groups[0].directory).toBe('/AreaOfEffects/GlobalParameters');
		// First documented entry: 'a; Min Car Distance Factor' = 0.75 (0.0, 1.0).
		const first = m.groups[0].sections[0].entries[0];
		expect(first.value).toBe(0.75);
		expect(first.range).toEqual({ min: 0.0, max: 1.0 });
		expect(countParamEntries(m)).toBeGreaterThanOrEqual(5);
	});
});
