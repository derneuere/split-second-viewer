import { describe, expect, it } from 'vitest';
import { gbxHandler } from '../gbx';
import { parseGbx, writeGbx, FLOATS_PER_RECORD } from '../../../gbx';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a single "Ambient Light" record (the wiki's Downtown/sunset
// record 0) with 12 trailing big-endian float32. Layout:
//   count=1
//   typeHash=0xa3c09f74, len=13 "Ambient Light"
//   nameHash=0xd5a9bc78, len=27 "Downtown_Tunnel_ambient_box"
//   12 × float32
function buildInline(): Uint8Array {
	const type = 'Ambient Light';
	const name = 'Downtown_Tunnel_ambient_box';
	const values = [443.777, 0, 0, 0, 15.284, 0, 0, 0, 54.354, -606.059, -6.882, -941.581];
	const size = 4 + 4 + 4 + type.length + 4 + 4 + name.length + FLOATS_PER_RECORD * 4;
	const buf = new ArrayBuffer(size);
	const dv = new DataView(buf);
	let o = 0;
	dv.setUint32(o, 1); o += 4; // record_count
	dv.setUint32(o, 0xa3c09f74); o += 4; // typeHash
	dv.setUint32(o, type.length); o += 4;
	for (let i = 0; i < type.length; i++) { dv.setUint8(o++, type.charCodeAt(i)); }
	dv.setUint32(o, 0xd5a9bc78); o += 4; // nameHash
	dv.setUint32(o, name.length); o += 4;
	for (let i = 0; i < name.length; i++) { dv.setUint8(o++, name.charCodeAt(i)); }
	for (const v of values) { dv.setFloat32(o, v); o += 4; }
	return new Uint8Array(buf);
}
const INLINE_BYTES = buildInline();

const REAL_SUNSET = 'Environments/Levels/Downtown/LightRigs/sunset/sunset.gbx';
const REAL_EMPTY = 'Environments/Levels/Downtown/LightRigs/midday/midday.gbx';

describe('gbx parser', () => {
	it('parses count, hashes, len-prefixed strings, and 12 floats (inline)', () => {
		const m = parseGbx(INLINE_BYTES);
		expect(m.recordCount).toBe(1);
		const r0 = m.records[0];
		expect(r0.typeHash).toBe(0xa3c09f74);
		expect(r0.typeName).toBe('Ambient Light');
		expect(r0.nameHash).toBe(0xd5a9bc78);
		expect(r0.instanceName).toBe('Downtown_Tunnel_ambient_box');
		expect(r0.values).toHaveLength(12);
		expect(r0.values[0]).toBeCloseTo(443.777, 2);
		expect(r0.values[4]).toBeCloseTo(15.284, 2);
		expect(r0.values[9]).toBeCloseTo(-606.059, 2);
		// consumes exactly to EOF
		expect(m.bytesConsumed).toBe(INLINE_BYTES.byteLength);
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeGbx(parseGbx(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('parses an empty 4-byte stub', () => {
		const m = parseGbx(new Uint8Array([0, 0, 0, 0]));
		expect(m.recordCount).toBe(0);
		expect(m.records).toHaveLength(0);
	});

	it.skipIf(!hasSample(REAL_SUNSET))(
		'parses + round-trips the REAL Downtown/sunset.gbx (2 records)',
		() => {
			const raw = readSample(REAL_SUNSET);
			const m = gbxHandler.parseRaw(raw, ssCtx());
			expect(m.recordCount).toBe(2);
			expect(m.records[0].typeName).toBe('Ambient Light');
			expect(m.records[0].instanceName).toBe('Downtown_Tunnel_ambient_box');
			expect(m.records[0].values).toHaveLength(12);
			// the 12-float stride consumes the whole file with zero leftover
			expect(m.bytesConsumed).toBe(raw.byteLength);
			const out = gbxHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	it.skipIf(!hasSample(REAL_EMPTY))('parses the REAL empty Downtown/midday.gbx stub', () => {
		const raw = readSample(REAL_EMPTY);
		const m = gbxHandler.parseRaw(raw, ssCtx());
		expect(m.recordCount).toBe(0);
		expect(raw.byteLength).toBe(4);
	});
});
