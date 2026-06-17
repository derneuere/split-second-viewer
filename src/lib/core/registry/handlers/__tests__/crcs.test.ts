import { describe, expect, it } from 'vitest';
import { crcsHandler } from '../crcs';
import { parseCrcs, writeCrcs } from '../../../crcs';
import { ssCtx } from '../../handler';
import {
	hasSample,
	readSample,
	listSamplesByExt,
	readFileBytes,
} from '@/test/dataRoot';

// An inline fixture used when the devkit data root isn't present: 4 big-endian
// uint32s. Bytes are exactly what writeCrcs should reproduce.
const INLINE_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x58, // 0x00000058
	0x00, 0x00, 0x00, 0xc1, // 0x000000c1
	0x00, 0x00, 0x00, 0x21, // 0x00000021
	0xca, 0xfe, 0xba, 0xbe, // 0xcafebabe
]);
const INLINE_EXPECTED = [0x00000058, 0x000000c1, 0x00000021, 0xcafebabe];

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Backdrop/Downtown_backdrop.texture.crcs';

describe('crcs parser', () => {
	it('parses a flat big-endian uint32[] (inline fixture)', () => {
		const model = parseCrcs(INLINE_BYTES);
		expect(model.crcs).toEqual(INLINE_EXPECTED);
	});

	it('round-trips byte-exact (inline fixture)', () => {
		const out = writeCrcs(parseCrcs(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('rejects a non-multiple-of-4 length', () => {
		expect(() => parseCrcs(new Uint8Array([1, 2, 3]))).toThrow(/multiple of 4/);
	});

	it('describe() summarizes the list', () => {
		const model = parseCrcs(INLINE_BYTES);
		expect(crcsHandler.describe(model)).toContain('4 CRCs');
		expect(crcsHandler.describe(model)).toContain('0x00000058');
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips a REAL .crcs from the devkit',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const model = crcsHandler.parseRaw(raw, ssCtx());
			// N = filesize / 4
			expect(model.crcs.length).toBe(raw.byteLength / 4);
			// every value is a valid u32
			for (const c of model.crcs) expect(c).toBe(c >>> 0);
			// byte-exact round-trip
			const out = crcsHandler.writeRaw!(model, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	const ALL = listSamplesByExt('.crcs');
	it.skipIf(ALL.length === 0)(
		`crcs round-trips real sample byte-for-byte (${ALL.length} files)`,
		() => {
			const ctx = ssCtx();
			const failures: string[] = [];
			for (const abs of ALL) {
				const raw = readFileBytes(abs);
				const out = crcsHandler.writeRaw!(crcsHandler.parseRaw(raw, ctx), ctx);
				if (!bytesEqual(out, raw)) failures.push(`${abs} (len ${out.length} vs ${raw.length})`);
			}
			expect(failures).toEqual([]);
			// Proven against many real files, not just one.
			expect(ALL.length).toBeGreaterThan(1);
		},
	);
});

/** Byte-exact comparison without building two huge JS arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
