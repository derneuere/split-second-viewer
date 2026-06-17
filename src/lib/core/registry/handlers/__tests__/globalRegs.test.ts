import { describe, expect, it } from 'vitest';
import { globalRegsHandler } from '../globalRegs';
import { parseGlobalRegs } from '../../../globalRegs';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a hand-built FREG/GLBB table of two records, exercising the
// nameLen + NUL-padding + 0xFFFFFFFF sentinel + type layout the parser relies on.
function u32be(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function rec(name: string, type: number): number[] {
	const bytes = Array.from(new TextEncoder().encode(name));
	const nameLen = bytes.length + 1; // includes NUL
	// region: name + NULs padded to a 4-byte boundary (>= one NUL).
	const region = [...bytes, 0];
	while (region.length % 4 !== 0) region.push(0);
	return [...u32be(nameLen), ...region, ...u32be(0xffffffff), ...u32be(type)];
}

const INLINE = new Uint8Array([
	0x46, 0x52, 0x45, 0x47, // 'FREG'
	...u32be(1), // version
	0x47, 0x4c, 0x42, 0x42, // 'GLBB'
	...u32be(2), // recordCount
	...u32be(0x5dc), // storageHint
	...rec('light_ambient', 1),
	...rec('Trans', 4),
]);

const REAL = 'default.global_regs';

describe('global_regs parser', () => {
	it('parses the FREG/GLBB header and the register table (inline)', () => {
		const m = parseGlobalRegs(INLINE);
		expect(m.version).toBe(1);
		expect(m.recordCount).toBe(2);
		expect(m.storageHint).toBe(0x5dc);
		expect(m.regs).toHaveLength(2);
		expect(m.regs[0]).toEqual({ name: 'light_ambient', type: 1 });
		expect(m.regs[1]).toEqual({ name: 'Trans', type: 4 });
		expect(m.tableConsistent).toBe(true);
		expect(m.payloadLength).toBe(0); // inline has no trailing payload
	});

	it('rejects a bad magic', () => {
		const bad = INLINE.slice();
		bad[0] = 0x00;
		expect(() => parseGlobalRegs(bad)).toThrow(/FREG/);
	});

	it('describe() lists the first registers', () => {
		const text = globalRegsHandler.describe(parseGlobalRegs(INLINE));
		expect(text).toContain('FREG v1');
		expect(text).toContain('light_ambient');
	});

	it.skipIf(!hasSample(REAL))('parses the REAL default.global_regs (512 regs)', () => {
		const raw = readSample(REAL);
		const m = globalRegsHandler.parseRaw(raw, ssCtx());
		expect(m.version).toBe(1);
		expect(m.recordCount).toBe(512);
		expect(m.regs).toHaveLength(512);
		expect(m.tableConsistent).toBe(true);
		// First three registers are the light constants.
		expect(m.regs[0].name).toBe('light_ambient');
		expect(m.regs[1].name).toBe('light_diffuse');
		expect(m.regs[2].name).toBe('light_specular');
		expect(m.regs[3].name).toBe('Trans');
		// Trailing register-value payload exists and is exposed.
		expect(m.payloadLength).toBeGreaterThan(0);
		expect(m.payloadOffset).toBeLessThan(raw.byteLength);
	});
});
