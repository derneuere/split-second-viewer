import { describe, expect, it } from 'vitest';
import { shadersHandler } from '../shaders';
import { parseShaders } from '../../../shaders';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a minimal SHDR set with one combo.
//   SHDR, version=6, combo_count=1, name_len=0x0b "0x6af4d492"
//   then one record: HDRB + a symbol name "WorldCameraPos" + HDRE
//   + SDRS u32(0) SDRE + SDRS u32(0) SDRE + len-prefixed combo_crc "0x618d6dad".
function lenStr(s: string): Uint8Array {
	const body = new TextEncoder().encode(s);
	const out = new Uint8Array(4 + body.length + 1);
	new DataView(out.buffer).setUint32(0, body.length + 1, false);
	out.set(body, 4);
	return out;
}
function tag(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}
function u32(n: number): Uint8Array {
	const o = new Uint8Array(4);
	new DataView(o.buffer).setUint32(0, n >>> 0, false);
	return o;
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
function buildInlineShaders(): Uint8Array {
	const header = concat(
		tag('SHDR'),
		u32(6), // version
		u32(1), // combo_count
		u32(0x0b), // name_len
		new TextEncoder().encode('0x6af4d492\0'),
		new Uint8Array([0, 0]), // pad to align HDRB (matches real samples)
	);
	const record = concat(
		tag('HDRB'),
		u32(0), u32(0), // reserved
		u32(2), u32(2), // count_a / combiner_count region (Partial)
		lenStr('WorldCameraPos'),
		tag('HDRE'),
		tag('SDRS'), u32(0), tag('SDRE'),
		tag('SDRS'), u32(0), tag('SDRE'),
		lenStr('0x618d6dad'),
	);
	return concat(header, record);
}

const INLINE = buildInlineShaders();
const REAL = 'Environments/Levels/airport_test_03/Backdrop/airport_test_03_backdrop.shaders';

describe('shaders parser', () => {
	it('decodes the SHDR header and one combo record (inline fixture)', () => {
		const m = parseShaders(INLINE);
		expect(m.version).toBe(6);
		expect(m.comboCount).toBe(1);
		expect(m.setName).toBe('0x6af4d492');
		expect(m.combos).toHaveLength(1);
		expect(m.combos[0].comboCrc).toBe('0x618d6dad');
		expect(m.combos[0].symbols).toContain('WorldCameraPos');
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[0] = 0xff;
		expect(() => parseShaders(bad)).toThrow(/bad magic/);
	});

	it('describe() summarizes combos + set name', () => {
		const s = shadersHandler.describe(parseShaders(INLINE));
		expect(s).toContain('1 combos');
		expect(s).toContain('0x6af4d492');
	});

	it.skipIf(!hasSample(REAL))(
		'parses a REAL .shaders from the devkit',
		() => {
			const raw = readSample(REAL);
			const m = shadersHandler.parseRaw(raw, ssCtx());
			expect(m.version).toBe(6);
			// CONFIRMED: combo_count == number of HDRB markers
			expect(m.comboCount).toBe(9);
			expect(m.setName).toBe('0x6af4d492');
			expect(m.combos).toHaveLength(9);
			// The first record's CRC is byte-confirmed from the hex dump.
			expect(m.combos[0].comboCrc).toBe('0xbd432ca5');
			// Every record EXCEPT the last carries a trailing combo CRC; the final
			// record is terminated by "END" with no CRC string (confirmed in hex).
			const withCrc = m.combos.filter((c) => /^0x[0-9a-f]+$/.test(c.comboCrc));
			expect(withCrc.length).toBe(8);
		},
	);
});
