import { describe, expect, it } from 'vitest';
import { paramsHandler, writeParams } from '../params';
import { parseParams, countParamEntries } from '../../../params';
import { ssCtx } from '../../handler';
import { DATA_ROOT, hasDataRoot, hasSample, readSample } from '@/test/dataRoot';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Inline fixture mirrors the real grammar: a directory header, a section, and
// entries covering the quoted-key + range, unquoted-key + range, bool, and
// quoted-string value forms. CRLF, as on the devkit.
const INLINE =
	[
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
		expect(m.lineEndings).toBe('crlf');
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
		expect(floatRange.rawValue).toBe('0.75 (0.0, 1.0)');

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

	it('round-trips the inline document byte-for-byte', () => {
		const m = parseParams(INLINE);
		const out = new TextDecoder().decode(writeParams(m));
		expect(out).toBe(INLINE);
	});

	it('handles a key containing "==" without mis-splitting key/value', () => {
		const src = "X:\n\t'Look Ahead Multiplier when Skill == 0' = 1.0 (1.0, 5.0);\n";
		const m = parseParams(src);
		const e = m.groups[0].sections[0].entries[0];
		expect(e.key).toBe('Look Ahead Multiplier when Skill == 0');
		expect(e.keyQuoted).toBe(true);
		expect(e.kind).toBe('number');
		expect(e.value).toBe(1.0);
		expect(e.range).toEqual({ min: 1.0, max: 5.0 });
		// And it round-trips verbatim.
		expect(new TextDecoder().decode(writeParams(m))).toBe(src);
	});

	it('preserves mixed line endings and a missing trailing newline', () => {
		// LF body with a single CRLF blank line and NO final terminator — the
		// shape of the one MIXED devkit file (PostProcess.params).
		const src = '!directory: /X\n\nX:\n\t' + "'a' = 1.0;" + '\r\n\t' + "'b' = 2.0;";
		const m = parseParams(src);
		expect(m.lineEndings).toBe('mixed');
		expect(new TextDecoder().decode(writeParams(m))).toBe(src);
	});

	it('splices an edited value in place, leaving all other bytes intact', () => {
		const m = parseParams(INLINE);
		const e = m.groups[0].sections[0].entries[0]; // 'a; Min Car Distance Factor'
		e.rawValue = '0.99 (0.0, 1.0)';
		e.dirty = true;
		const out = new TextDecoder().decode(writeParams(m));
		expect(out).toContain("'a; Min Car Distance Factor' = 0.99 (0.0, 1.0);");
		// Untouched lines unchanged: same length delta as the value edit only.
		expect(out).toContain('\tSubjectID = 0;');
		expect(out.endsWith('\r\n')).toBe(true);
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
		// Byte-exact round-trip of the escaped-quote line.
		expect(new TextDecoder().decode(writeParams(m))).toBe(weird);
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

// Hard byte-exact guarantee: parse→write must equal the original bytes for a
// broad spread of real files (CRLF, LF, mixed endings, no-trailing-newline,
// blank-line runs, escaped quotes, `==`-in-key). Discovers files at runtime so
// the corpus is wide, not a hand-picked few.
describe.skipIf(!hasDataRoot)('params round-trips real samples byte-for-byte', () => {
	function listParams(dir: string): string[] {
		const out: string[] = [];
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) out.push(...listParams(p));
			else if (e.name.toLowerCase().endsWith('.params')) out.push(p);
		}
		return out;
	}

	it('round-trips a wide spread of real .params unchanged', () => {
		const all = listParams(DATA_ROOT);
		expect(all.length).toBeGreaterThan(100);
		// Test a deterministic, evenly-spaced sample for speed (every ~10th file)
		// plus the four pinned tricky files.
		const pinned = [
			'AreaOfEffects/GlobalParams.params',
			'AreaOfEffects/EffectParams.params',
			'Cameras/CommonCameras/Cameras.params',
			'Environments/Levels/airport_test_03/Params/PostProcess.params',
		].map((r) => path.join(DATA_ROOT, r));
		const sampled = all.filter((_, i) => i % 10 === 0);
		const corpus = Array.from(new Set([...pinned, ...sampled]));

		let tested = 0;
		const failures: string[] = [];
		for (const f of corpus) {
			const buf = fs.readFileSync(f);
			const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			const out = writeParams(parseParams(raw));
			tested++;
			if (out.byteLength !== raw.byteLength || !out.every((b, i) => b === raw[i])) {
				failures.push(path.relative(DATA_ROOT, f));
			}
		}
		expect({ tested, failures }).toEqual({ tested, failures: [] });
		expect(tested).toBeGreaterThan(50);
	});
});
