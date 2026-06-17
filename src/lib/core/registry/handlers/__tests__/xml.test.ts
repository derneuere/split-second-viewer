import { describe, expect, it } from 'vitest';
import { xmlHandler, powerplaysHandler, triggersHandler } from '../xml';
import { parseXmlResource, countTag } from '../../../xmlResource';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixtures mirror real shapes: the empty 32-byte triggers stub and a
// small Root-with-children document covering attributes, self-closing tags, and
// entity decoding.
const EMPTY_TRIGGERS = '<Root FileVersion="1.0000000"/>\n';
const DOC =
	'<Root FileVersion="1.0000000">\n' +
	'   <Trigger nameCRC="0x1849EA75" triggerType="Standard" enabled="true">\n' +
	'      <posAndScale X="456.17694" Y="0.0" Z="-627.85522" W="35.608612"/>\n' +
	'      <Powerplay id="1224682956.3"><Timeline id="1224682956.4"/></Powerplay>\n' +
	'   </Trigger>\n' +
	'   <Trigger nameCRC="0x2" triggerType="FireBestChild" enabled="false"/>\n' +
	'</Root>\n';

const REAL_XML = 'Audio/Locales/airport/airport_Audio_Reverb.xml';
const REAL_PP = 'Environments/Levels/docks/Subtracks/A/docks.powerplays';
const REAL_TRIG = 'Environments/Levels/docks/Subtracks/A/docks.triggers';

describe('xml resource parser', () => {
	it('parses the empty self-closing root (32-byte stub)', () => {
		const m = parseXmlResource(EMPTY_TRIGGERS);
		expect(m.root?.tag).toBe('Root');
		expect(m.root?.attrs.FileVersion).toBe('1.0000000');
		expect(m.root?.children).toHaveLength(0);
		expect(m.elementCount).toBe(1);
	});

	it('parses attributes, nesting, and self-closing children', () => {
		const m = parseXmlResource(DOC);
		expect(m.root?.tag).toBe('Root');
		expect(countTag(m.root, 'Trigger')).toBe(2);
		const t0 = m.root!.children[0];
		expect(t0.tag).toBe('Trigger');
		expect(t0.attrs.triggerType).toBe('Standard');
		expect(t0.attrs.enabled).toBe('true');
		// nested posAndScale + Powerplay > Timeline
		const pos = t0.children.find((c) => c.tag === 'posAndScale')!;
		expect(pos.attrs.W).toBe('35.608612');
		const pp = t0.children.find((c) => c.tag === 'Powerplay')!;
		expect(pp.children[0].tag).toBe('Timeline');
		expect(pp.children[0].attrs.id).toBe('1224682956.4');
	});

	it('writer reproduces the source byte-for-byte (round-trip)', () => {
		const m = parseXmlResource(DOC);
		const out = xmlHandler.writeRaw!(m, ssCtx());
		expect(new TextDecoder().decode(out)).toBe(DOC);
	});

	it('describe() reports root + element + domain tally', () => {
		expect(powerplaysHandler.describe(parseXmlResource(DOC))).toContain('<Root>');
		expect(triggersHandler.describe(parseXmlResource(DOC))).toContain('2 <Trigger>');
	});

	it.skipIf(!hasSample(REAL_XML))('parses + round-trips a REAL .xml', () => {
		const raw = readSample(REAL_XML);
		const m = xmlHandler.parseRaw(raw, ssCtx());
		expect(m.root?.tag).toBe('Root');
		const out = xmlHandler.writeRaw!(m, ssCtx());
		expect(Array.from(out)).toEqual(Array.from(raw));
	});

	it.skipIf(!hasSample(REAL_PP))('parses a REAL .powerplays with multiple <Powerplay>', () => {
		const raw = readSample(REAL_PP);
		const m = powerplaysHandler.parseRaw(raw, ssCtx());
		expect(m.root?.tag).toBe('Root');
		expect(countTag(m.root, 'Powerplay')).toBeGreaterThan(1);
		const out = powerplaysHandler.writeRaw!(m, ssCtx());
		expect(Array.from(out)).toEqual(Array.from(raw));
	});

	it.skipIf(!hasSample(REAL_TRIG))('parses a REAL .triggers with <Trigger> volumes', () => {
		const raw = readSample(REAL_TRIG);
		const m = triggersHandler.parseRaw(raw, ssCtx());
		expect(m.root?.tag).toBe('Root');
		expect(countTag(m.root, 'Trigger')).toBeGreaterThanOrEqual(1);
		// posAndScale is present on Standard triggers
		const out = triggersHandler.writeRaw!(m, ssCtx());
		expect(Array.from(out)).toEqual(Array.from(raw));
	});
});
