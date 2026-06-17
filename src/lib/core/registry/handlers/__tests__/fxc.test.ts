import { describe, expect, it } from 'vitest';
import { fxcHandler } from '../fxc';
import { parseFxc } from '../../../fxc';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a minimal \0FXC container.
//   \0FXC, version=1, combo_count=1, name_len=0x0b "0x6af4d492"
//   then a tiny symbol-table head with "TransViewProj", some opaque microcode
//   bytes, terminated by "END".
function lenStr(s: string): Uint8Array {
	const body = new TextEncoder().encode(s);
	const out = new Uint8Array(4 + body.length + 1);
	new DataView(out.buffer).setUint32(0, body.length + 1, false);
	out.set(body, 4);
	return out;
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
function buildInlineFxc(): Uint8Array {
	return concat(
		new Uint8Array([0x00, 0x46, 0x58, 0x43]), // \0FXC
		u32(1), // version
		u32(1), // combo_count
		u32(0x0b), // name_len
		new TextEncoder().encode('0x6af4d492\0'),
		// combo body head: a couple metadata words + a symbol name
		u32(2),
		lenStr('TransViewProj'),
		// opaque RSX microcode filler
		new Uint8Array([0x04, 0x18, 0x00, 0x00, 0x0c, 0xb8, 0x00, 0x00]),
		new TextEncoder().encode('END'),
	);
}

const INLINE = buildInlineFxc();
const REAL = 'Environments/Levels/airport_test_03/Backdrop/airport_test_03_backdrop.fxc';

describe('fxc parser', () => {
	it('decodes the \\0FXC header + END framing (inline fixture)', () => {
		const m = parseFxc(INLINE);
		expect(m.version).toBe(1);
		expect(m.comboCount).toBe(1);
		expect(m.setName).toBe('0x6af4d492');
		expect(m.hasEndTag).toBe(true);
		expect(m.microcode.length).toBeGreaterThan(0);
		expect(m.symbols).toContain('TransViewProj');
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[1] = 0xff; // corrupt the 'F' of \0FXC
		expect(() => parseFxc(bad)).toThrow(/bad magic/);
	});

	it('describe() summarizes combos + set name', () => {
		const s = fxcHandler.describe(parseFxc(INLINE));
		expect(s).toContain('1 combos');
		expect(s).toContain('0x6af4d492');
	});

	it.skipIf(!hasSample(REAL))(
		'parses a REAL .fxc from the devkit and matches its .shaders join key',
		() => {
			const raw = readSample(REAL);
			const m = fxcHandler.parseRaw(raw, ssCtx());
			expect(m.version).toBe(1);
			// CONFIRMED: combo_count equals the paired .shaders combo_count (9)
			expect(m.comboCount).toBe(9);
			// CONFIRMED: set_name is byte-identical to the paired .shaders set_name
			expect(m.setName).toBe('0x6af4d492');
			expect(m.hasEndTag).toBe(true);
			expect(m.microcode.length).toBeGreaterThan(1000);
		},
	);
});
