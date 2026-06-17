import { describe, expect, it } from 'vitest';
import { mclHandler } from '../mcl';
import { parseMcl } from '../../../mcl';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a minimal SDRI/INSS material clip with one instance.
//   SDRI, headerSize=8, INSS, instanceCount=1, setId=0x10c02f34
//   instance: name "unnamed" (len 8), hash "0x622715a2" (len 0x0b),
//             one param name "coloralpha_3_fadeout" (len 0x15), then INSE.
function lenStr(s: string): Uint8Array {
	const body = new TextEncoder().encode(s);
	const out = new Uint8Array(4 + body.length + 1);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, body.length + 1, false); // length INCLUDES the NUL
	out.set(body, 4);
	return out;
}
function buildInlineMcl(): Uint8Array {
	const parts: Uint8Array[] = [];
	const hdr = new Uint8Array(0x14);
	const dv = new DataView(hdr.buffer);
	hdr.set([0x53, 0x44, 0x52, 0x49], 0); // SDRI
	dv.setUint32(0x04, 0x08, false); // headerSize
	hdr.set([0x49, 0x4e, 0x53, 0x53], 0x08); // INSS
	dv.setUint32(0x0c, 1, false); // instanceCount
	dv.setUint32(0x10, 0x10c02f34, false); // setId
	parts.push(hdr);
	parts.push(lenStr('unnamed'));
	parts.push(lenStr('0x622715a2'));
	// a couple of value/flag words then a param name (exact layout is Partial; the
	// parser scans for the name, so any filler works)
	parts.push(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
	parts.push(lenStr('coloralpha_3_fadeout'));
	parts.push(new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0x4c])); // type/slot value bytes
	parts.push(new Uint8Array([0x49, 0x4e, 0x53, 0x45])); // INSE

	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

const INLINE = buildInlineMcl();
const REAL = 'Powerplays/Animations/airport_test_03/AA/AA_HelicopterShockwave.mcl';

describe('mcl parser', () => {
	it('decodes the SDRI/INSS framing and one instance (inline fixture)', () => {
		const m = parseMcl(INLINE);
		expect(m.headerSize).toBe(8);
		expect(m.instanceCount).toBe(1);
		expect(m.setId).toBe(0x10c02f34);
		expect(m.hasEndTag).toBe(true);
		expect(m.instances).toHaveLength(1);
		expect(m.instances[0].name).toBe('unnamed');
		expect(m.instances[0].materialHash).toBe('0x622715a2');
		expect(m.instances[0].params.map((p) => p.name)).toContain('coloralpha_3_fadeout');
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[0] = 0xff;
		expect(() => parseMcl(bad)).toThrow(/bad magic/);
	});

	it('describe() summarizes instance count + hash', () => {
		const s = mclHandler.describe(parseMcl(INLINE));
		expect(s).toContain('1 instance');
		expect(s).toContain('0x622715a2');
	});

	it.skipIf(!hasSample(REAL))(
		'parses a REAL AA_HelicopterShockwave.mcl from the devkit',
		() => {
			const raw = readSample(REAL);
			const m = mclHandler.parseRaw(raw, ssCtx());
			expect(m.headerSize).toBe(8);
			expect(m.instanceCount).toBe(1);
			expect(m.setId).toBe(0x10c02f34);
			expect(m.hasEndTag).toBe(true);
			expect(m.fullyParsed).toBe(true);
			expect(m.instances[0].name).toBe('unnamed');
			expect(m.instances[0].materialHash).toBe('0x622715a2');
			// confirmed parameter names from hex inspection
			const names = m.instances[0].params.map((p) => p.name);
			expect(names).toContain('coloralpha_3_fadeout');
			expect(names).toContain('uvscroll_4_scroll');
			expect(names).toContain('alphablend_6_texture');
		},
	);
});
