import { describe, expect, it } from 'vitest';
import { highlightTagsHandler } from '../highlighttags';
import { parseHighlightTags, writeHighlightTags } from '../../../highlighttags';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: the empty self-closing root (the 32-byte nem_storm stub) and a
// two-tag document mirroring the real Graveyard layout (identity marker + a
// rotated one), exercising relative_transform true/false and the Powerplay link.
const EMPTY = '<Root FileVersion="2.0000000"/>\n';

const DOC =
	'<Root FileVersion="2.0000000">\n' +
	'   <HighlightTag id="1263809359.-611452811" idCRC="0x492CC192" icon="0" relative_transform="true">\n' +
	'      <transformation>\n' +
	'         <Row0 X="1.0000000" Y="0.0000000" Z="0.0000000"/>\n' +
	'         <Row1 X="0.0000000" Y="1.0000000" Z="0.0000000"/>\n' +
	'         <Row2 X="0.0000000" Y="0.0000000" Z="1.0000000"/>\n' +
	'         <Row3 X="0.0000000" Y="229.37067" Z="-178.84406"/>\n' +
	'      </transformation>\n' +
	'      <Powerplay id="1239805449.2" idCRC="0x13887213"/>\n' +
	'   </HighlightTag>\n' +
	'   <HighlightTag id="1262886888.-508312769" idCRC="0xD0A88A65" icon="0" relative_transform="false">\n' +
	'      <transformation>\n' +
	'         <Row0 X="0.8370311" Y="0.0000000" Z="0.5471553"/>\n' +
	'         <Row1 X="0.0000000" Y="1.0000000" Z="0.0000000"/>\n' +
	'         <Row2 X="-0.5471553" Y="0.0000000" Z="0.8370311"/>\n' +
	'         <Row3 X="-10.038172" Y="15.508035" Z="-6.7290363"/>\n' +
	'      </transformation>\n' +
	'      <Powerplay id="1256919348.-669000736" idCRC="0x6211B6B"/>\n' +
	'   </HighlightTag>\n' +
	'</Root>\n';

const GRAVEYARD = 'Environments/Levels/Graveyard/Graveyard.highlighttags';
const DOCKS = 'Environments/Levels/docks/docks.highlighttags';
const AIRPORT = 'Environments/Levels/airport_test_03/airport_test_03.highlighttags';
const STORM = 'Environments/Levels/nem_storm/nem_storm.highlighttags';

// Every level .highlighttags file on the devkit — exercise round-trip on all 10.
const ALL_SAMPLES = [
	GRAVEYARD,
	DOCKS,
	AIRPORT,
	STORM,
	'Environments/Levels/Downtown/Downtown.highlighttags',
	'Environments/Levels/Powerplant/Powerplant.highlighttags',
	'Environments/Levels/nem_downtown/nem_downtown.highlighttags',
	'Environments/Levels/nem_graveyard/nem_graveyard.highlighttags',
	'Environments/Levels/nem_training/nem_training.highlighttags',
	'Environments/Levels/nem_warehouse/nem_warehouse.highlighttags',
];

describe('highlighttags parser', () => {
	it('parses the empty self-closing root (32-byte stub)', () => {
		const m = parseHighlightTags(EMPTY);
		expect(m.fileVersion).toBe('2.0000000');
		expect(m.count).toBe(0);
		expect(m.tags).toHaveLength(0);
		expect(m.points).toHaveLength(0);
	});

	it('decodes typed HighlightTag records (id, transform, powerplay)', () => {
		const m = parseHighlightTags(DOC);
		expect(m.count).toBe(2);
		const t0 = m.tags[0];
		expect(t0.id).toBe('1263809359.-611452811');
		expect(t0.idCRC).toBe('0x492CC192');
		expect(t0.icon).toBe(0);
		expect(t0.relativeTransform).toBe(true);
		// identity basis, Row3 translation
		expect(t0.transform.basis).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
		expect(t0.transform.translation[1]).toBeCloseTo(229.37067, 3);
		expect(t0.transform.translation[2]).toBeCloseTo(-178.84406, 3);
		expect(t0.powerplay).toEqual({ id: '1239805449.2', idCRC: '0x13887213' });
		// second tag carries the per-tag relative_transform="false" flag
		expect(m.tags[1].relativeTransform).toBe(false);
		// world points mirror the Row3 translations, one per tag
		expect(m.points).toHaveLength(2);
		expect(m.points[0]).toEqual(t0.transform.translation);
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeHighlightTags(parseHighlightTags(DOC));
		expect(new TextDecoder().decode(out)).toBe(DOC);
	});

	it('round-trips the empty stub byte-exact (inline)', () => {
		const out = writeHighlightTags(parseHighlightTags(EMPTY));
		expect(new TextDecoder().decode(out)).toBe(EMPTY);
	});

	it('rejects a non-Root document', () => {
		expect(() => parseHighlightTags('<Other/>')).toThrow(/expected <Root>/);
	});

	it('describe() reports version, marker count, and flag mix', () => {
		expect(highlightTagsHandler.describe(parseHighlightTags(EMPTY))).toContain(
			'0 markers',
		);
		const d = highlightTagsHandler.describe(parseHighlightTags(DOC));
		expect(d).toContain('2 markers');
		expect(d).toContain('1 absolute'); // one relative_transform="false"
	});

	it.skipIf(!hasSample(GRAVEYARD))(
		'parses + round-trips a REAL Graveyard.highlighttags byte-for-byte',
		() => {
			const raw = readSample(GRAVEYARD);
			const m = highlightTagsHandler.parseRaw(raw, ssCtx());
			expect(m.fileVersion).toBe('2.0000000');
			expect(m.count).toBeGreaterThan(0);
			// wiki: first Graveyard tag is the identity marker pointing at 0x13887213
			expect(m.tags[0].idCRC).toBe('0x492CC192');
			expect(m.tags[0].powerplay?.idCRC).toBe('0x13887213');
			// every tag has a full 4x3 transform + world point
			for (const t of m.tags) {
				expect(t.transform.basis).toHaveLength(9);
				expect(t.transform.translation).toHaveLength(3);
			}
			expect(m.points).toHaveLength(m.count);
			const out = highlightTagsHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	it.skipIf(!hasSample(AIRPORT))(
		'decodes the per-tag relative_transform flag from REAL airport_test_03',
		() => {
			const raw = readSample(AIRPORT);
			const m = highlightTagsHandler.parseRaw(raw, ssCtx());
			// airport is the ONLY level with relative_transform="false" tags (wiki: 32)
			const absolute = m.tags.filter((t) => !t.relativeTransform);
			expect(absolute.length).toBeGreaterThan(0);
			const out = highlightTagsHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	it.skipIf(!hasSample(STORM))(
		'parses + round-trips the REAL empty nem_storm stub',
		() => {
			const raw = readSample(STORM);
			const m = highlightTagsHandler.parseRaw(raw, ssCtx());
			expect(m.count).toBe(0);
			const out = highlightTagsHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	for (const rel of ALL_SAMPLES) {
		it.skipIf(!hasSample(rel))(
			`round-trips ${rel.split('/').pop()} byte-for-byte`,
			() => {
				const raw = readSample(rel);
				const m = highlightTagsHandler.parseRaw(raw, ssCtx());
				const out = highlightTagsHandler.writeRaw!(m, ssCtx());
				expect(out.byteLength).toBe(raw.byteLength);
				expect(Array.from(out)).toEqual(Array.from(raw));
			},
		);
	}
});
