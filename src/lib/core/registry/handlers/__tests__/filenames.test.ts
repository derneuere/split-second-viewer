import { describe, expect, it } from 'vitest';
import { fileNamesHandler } from '../filenames';
import { parseFileNames, writeFileNames } from '../../../filenames';
import { ssCtx } from '../../handler';
import {
	hasSample,
	readSample,
	listSamplesByExt,
	readFileBytes,
} from '@/test/dataRoot';

// Inline fixture: headerless NUL-terminated list, two entries.
const INLINE_BYTES = new Uint8Array([
	0x42, 0x75, 0x74, 0x74, 0x6f, 0x6e, 0x5f, 0x50, 0x53, 0x33, 0x5f, 0x53,
	0x74, 0x61, 0x72, 0x74, 0x00, // "Button_PS3_Start"
	0x63, 0x69, 0x72, 0x63, 0x6c, 0x65, 0x73, 0x00, // "circles"
]);

const REAL_FIXTURE = 'UI/CommonUI/Textures/CommonUI.filenames';

describe('filenames parser', () => {
	it('parses a headerless NUL list (inline fixture)', () => {
		const m = parseFileNames(INLINE_BYTES);
		expect(m.names).toEqual(['Button_PS3_Start', 'circles']);
	});

	it('round-trips byte-exact (inline fixture)', () => {
		const out = writeFileNames(parseFileNames(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('handles an empty buffer', () => {
		expect(parseFileNames(new Uint8Array(0)).names).toEqual([]);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses + round-trips the REAL CommonUI.filenames',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = fileNamesHandler.parseRaw(raw, ssCtx());
			// First entry of the CommonUI atlas (confirmed in the raw bytes).
			expect(m.names[0]).toBe('Button_PS3_Start');
			expect(m.names.length).toBeGreaterThan(1);
			// every entry is a non-empty printable string.
			for (const n of m.names) expect(n.length).toBeGreaterThan(0);
			const out = fileNamesHandler.writeRaw!(m, ssCtx());
			expect(Array.from(out)).toEqual(Array.from(raw));
		},
	);

	const ALL = listSamplesByExt('.filenames');
	it.skipIf(ALL.length === 0)(
		`filenames round-trips real sample byte-for-byte (${ALL.length} files)`,
		() => {
			const ctx = ssCtx();
			const failures: string[] = [];
			for (const abs of ALL) {
				const raw = readFileBytes(abs);
				const out = fileNamesHandler.writeRaw!(fileNamesHandler.parseRaw(raw, ctx), ctx);
				if (!bytesEqual(out, raw)) failures.push(`${abs} (len ${out.length} vs ${raw.length})`);
			}
			expect(failures).toEqual([]);
			expect(ALL.length).toBeGreaterThan(1);
		},
	);
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
