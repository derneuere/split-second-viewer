import { describe, expect, it } from 'vitest';
import { logicInfoHandler } from '../logicinfo';
import {
	parseLogicInfo,
	writeLogicInfo,
	LOGICINFO_SIZE,
	LOGICINFO_MAGIC,
	LOGICINFO_FOOTER,
	VAL_OFFSETS,
} from '../../../logicinfo';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: a faithful 288-byte Downtown/A Track.logicinfo reconstructed
// from the wiki's annotated hex. Header constants + the five per-track floats at
// 0x34/0x3C/0x44/0x4C/0x54 (val0=5002.66, val1=189.43, val2=4838.22,
// val3=5002.66, val4=24.99) + the 0xBADCADDE footer; the rest is the documented
// constant CRC interleave / zero-fill.
function buildInline(): Uint8Array {
	const buf = new ArrayBuffer(LOGICINFO_SIZE);
	const dv = new DataView(buf);
	const u8 = new Uint8Array(buf);
	// header
	dv.setUint16(0x00, 3); // major
	dv.setUint16(0x02, 0); // minor
	dv.setUint32(0x04, LOGICINFO_MAGIC);
	dv.setUint32(0x08, LOGICINFO_SIZE - 12); // payloadLen = 276
	// constant CRC/float interleave (subset that matters for round-trip + header check)
	dv.setUint32(0x0c, 0x4939a99a);
	dv.setUint32(0x10, 0x48e65b4b); // const float 471770.3
	dv.setUint32(0x14, 0x3f800000); // 1.0
	dv.setUint32(0x18, 0x1789c8e5);
	dv.setUint32(0x20, 0x8d958330);
	dv.setUint32(0x28, 0xdc56bf96);
	dv.setUint32(0x30, 0xe6e575e2);
	// per-track floats
	dv.setUint32(0x34, 0x459c5547); // val0 = 5002.66
	dv.setUint32(0x38, 0xc9f4444c); // crc
	dv.setUint32(0x3c, 0x433d6ced); // val1 = 189.43
	dv.setUint32(0x40, 0x898e1347); // crc
	dv.setUint32(0x44, 0x459731ca); // val2 = 4838.22
	dv.setUint32(0x48, 0xf818f29c); // crc
	dv.setUint32(0x4c, 0x459c5546); // val3 = 5002.66 (≈ val0)
	dv.setUint32(0x50, 0x85e29acf); // crc
	dv.setUint32(0x54, 0x41c7eb5b); // val4 = 24.99
	dv.setUint32(0x58, 0x571fe3aa); // crc
	// footer
	dv.setUint32(0x11c, LOGICINFO_FOOTER);
	return u8;
}
const INLINE_BYTES = buildInline();

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.logicinfo';

describe('logicinfo parser', () => {
	it('parses the fixed 288-byte header, floats and footer (inline)', () => {
		const m = parseLogicInfo(INLINE_BYTES);
		expect(m.versionMajor).toBe(3);
		expect(m.versionMinor).toBe(0);
		expect(m.magic >>> 0).toBe(LOGICINFO_MAGIC);
		expect(m.payloadLen).toBe(276);
		expect(m.footer >>> 0).toBe(LOGICINFO_FOOTER);
		expect(m.headerOk).toBe(true);
		expect(m.vals).toHaveLength(VAL_OFFSETS.length);
		expect(m.vals[0]).toBeCloseTo(5002.66, 1); // val0
		expect(m.vals[1]).toBeCloseTo(189.43, 1); // val1
		expect(m.vals[2]).toBeCloseTo(4838.22, 1); // val2
		expect(m.vals[4]).toBeCloseTo(24.99, 1); // val4 (angle/extent)
	});

	it('round-trips byte-exact (inline)', () => {
		const out = writeLogicInfo(parseLogicInfo(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('editing a per-track float survives a write/parse cycle', () => {
		const m = parseLogicInfo(INLINE_BYTES);
		m.vals[1] = 999.5;
		const m2 = parseLogicInfo(writeLogicInfo(m));
		expect(m2.vals[1]).toBeCloseTo(999.5, 2);
		// other vals untouched
		expect(m2.vals[0]).toBeCloseTo(5002.66, 1);
	});

	it('rejects a wrong-size file', () => {
		expect(() => parseLogicInfo(new Uint8Array(287))).toThrow(/expected 288/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips a REAL .logicinfo from the devkit',
		() => {
			const raw = readSample(REAL_FIXTURE);
			expect(raw.byteLength).toBe(288);
			const m = logicInfoHandler.parseRaw(raw, ssCtx());
			expect(m.headerOk).toBe(true);
			expect(m.payloadLen).toBe(raw.byteLength - 12);
			// val0 == val3 in every shipped file
			expect(m.vals[0]).toBeCloseTo(m.vals[3], 3);
			expect(m.vals[0]).toBeCloseTo(5002.66, 1); // Downtown
			const out = logicInfoHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);
});
