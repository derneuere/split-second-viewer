import { describe, expect, it } from 'vitest';
import { shaderInstHandler } from '../shaderinst';
import { parseShaderInst } from '../../../shaderinst';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a minimal SDRI/INSS shader-instance file with two nodes.
//   SDRI, version=8, INSS, node_count=2
//   node0: inst_crc 0xf2a04952, name "unnamed", combo "0xbd432ca5"
//   node1: inst_crc 0x11223344, name "unnamed", combo "0xcd124d09"
//   then INSE.
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
function tag(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
function buildInlineShaderInst(): Uint8Array {
	return concat(
		tag('SDRI'),
		u32(8), // version
		tag('INSS'),
		u32(2), // node_count
		// node 0
		u32(0xf2a04952), lenStr('unnamed'), lenStr('0xbd432ca5'),
		new Uint8Array([0, 0, 0, 0]), // a little override filler
		// node 1
		u32(0x11223344), lenStr('unnamed'), lenStr('0xcd124d09'),
		new Uint8Array([0, 0, 0, 0]),
		tag('INSE'),
	);
}

const INLINE = buildInlineShaderInst();
const REAL = 'Environments/Levels/airport_test_03/Backdrop/airport_test_03_backdrop.shaderinst';

describe('shaderinst parser', () => {
	it('decodes the SDRI/INSS header and two instance nodes (inline fixture)', () => {
		const m = parseShaderInst(INLINE);
		expect(m.version).toBe(8);
		expect(m.nodeCount).toBe(2);
		expect(m.hasEndTag).toBe(true);
		expect(m.nodes).toHaveLength(2);
		expect(m.nodes[0].instCrc).toBe(0xf2a04952);
		expect(m.nodes[0].nodeName).toBe('unnamed');
		expect(m.nodes[0].comboCrc).toBe('0xbd432ca5');
		expect(m.nodes[1].comboCrc).toBe('0xcd124d09');
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[0] = 0xff;
		expect(() => parseShaderInst(bad)).toThrow(/bad magic/);
	});

	it('describe() summarizes node count + a combo', () => {
		const s = shaderInstHandler.describe(parseShaderInst(INLINE));
		expect(s).toContain('2 instance nodes');
		expect(s).toContain('0xbd432ca5');
	});

	it.skipIf(!hasSample(REAL))(
		'parses a REAL .shaderinst from the devkit',
		() => {
			const raw = readSample(REAL);
			const m = shaderInstHandler.parseRaw(raw, ssCtx());
			expect(m.version).toBe(8);
			// CONFIRMED: node_count == count of "unnamed" instance records
			expect(m.nodeCount).toBe(8);
			expect(m.hasEndTag).toBe(true);
			expect(m.fullyParsed).toBe(true);
			expect(m.nodes).toHaveLength(8);
			expect(m.nodes[0].instCrc).toBe(0xf2a04952);
			expect(m.nodes[0].comboCrc).toBe('0xbd432ca5');
			expect(m.nodes[m.nodes.length - 1].comboCrc).toBe('0xf26bc3a7');
			expect(m.nodes.every((n) => /^0x[0-9a-f]+$/.test(n.comboCrc))).toBe(true);
		},
	);
});
