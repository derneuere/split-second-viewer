import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkpointsHandler } from '../checkpoints';
import {
	parseCheckpoints,
	writeCheckpoints,
	CHECKPOINTS_BEGIN_TAG,
	CHECKPOINTS_END_TAG,
	CHECKPOINTS_VERSION,
} from '../../../checkpoints';
import { ssCtx } from '../../handler';
import { DATA_ROOT, hasDataRoot, hasSample, readSample } from '@/test/dataRoot';

// Inline fixture: the documented 12-byte header (version 3.0, beginTag
// CDAB0DF0, bodySize=8) — i.e. a single root object whose 8-byte payload holds
// one float word and one closing BADCADDE sentinel.
const INLINE_BYTES = new Uint8Array([
	0x00, 0x03, 0x00, 0x00, // version 0x00030000
	0xcd, 0xab, 0x0d, 0xf0, // root begin tag
	0x00, 0x00, 0x00, 0x08, // bodySize / root size = 8
	0x49, 0x39, 0xa9, 0x9a, // body float (760473.6) — first payload word per wiki
	0xba, 0xdc, 0xad, 0xde, // closing end-object sentinel
]);

const REAL_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.checkpoints';

/** Enumerate every real Track.checkpoints under the data root (skipIf-guarded). */
function allCheckpointFiles(): string[] {
	if (!hasDataRoot) return [];
	const levels = path.join(DATA_ROOT, 'Environments', 'Levels');
	if (!fs.existsSync(levels)) return [];
	const out: string[] = [];
	for (const lvl of fs.readdirSync(levels)) {
		const tl = path.join(levels, lvl, 'Event', 'RACING', 'TrackLogic');
		if (!fs.existsSync(tl)) continue;
		for (const route of fs.readdirSync(tl)) {
			const f = path.join(tl, route, 'Track.checkpoints');
			if (fs.existsSync(f)) out.push(f);
		}
	}
	return out;
}

describe('checkpoints parser', () => {
	it('decodes the documented header + root object (inline fixture)', () => {
		const m = parseCheckpoints(INLINE_BYTES);
		expect(m.version).toBe(CHECKPOINTS_VERSION);
		expect(m.beginTag).toBe(CHECKPOINTS_BEGIN_TAG);
		expect(m.bodySize).toBe(8);
		expect(m.headerValid).toBe(true);
		expect(m.root.size).toBe(8);
		expect(m.objectCount).toBe(1);
		expect(m.endSentinelCount).toBe(1);
		// root payload: one raw word then an inline end tag
		expect(m.root.elements).toEqual([
			{ kind: 'word', word: 0x4939a99a },
			{ kind: 'end' },
		]);
	});

	it('round-trips the inline fixture byte-for-byte', () => {
		const out = writeCheckpoints(parseCheckpoints(INLINE_BYTES));
		expect(Array.from(out)).toEqual(Array.from(INLINE_BYTES));
	});

	it('decodes a nested child object', () => {
		// root(size=0x10) { child(size=4){ end } end }
		const bytes = new Uint8Array([
			0x00, 0x03, 0x00, 0x00,
			0xcd, 0xab, 0x0d, 0xf0, // root begin
			0x00, 0x00, 0x00, 0x10, // root size = 16
			0xcd, 0xab, 0x0d, 0xf0, // child begin
			0x00, 0x00, 0x00, 0x04, // child size = 4
			0xba, 0xdc, 0xad, 0xde, // child end (inside child payload)
			0xba, 0xdc, 0xad, 0xde, // root end
		]);
		const m = parseCheckpoints(bytes);
		expect(m.objectCount).toBe(2);
		expect(m.root.children).toHaveLength(1);
		expect(m.root.children[0].size).toBe(4);
		expect(Array.from(writeCheckpoints(m))).toEqual(Array.from(bytes));
	});

	it('rejects a body-size mismatch', () => {
		const bad = INLINE_BYTES.slice(0, 16); // drops the sentinel → 4 body bytes < 8
		expect(() => parseCheckpoints(bad)).toThrow(/bodySize/);
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses the REAL Downtown route-A .checkpoints',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = checkpointsHandler.parseRaw(raw, ssCtx());
			expect(raw.byteLength).toBe(348);
			expect(m.version).toBe(CHECKPOINTS_VERSION);
			expect(m.beginTag).toBe(CHECKPOINTS_BEGIN_TAG);
			expect(m.bodySize).toBe(0x150);
			expect(m.headerValid).toBe(true);
			// The recursive tree fully parses: many nested objects.
			expect(m.objectCount).toBeGreaterThan(5);
			// File ends with three stacked BADCADDE sentinels.
			expect(m.endSentinelCount).toBeGreaterThanOrEqual(3);
		},
	);

	it.skipIf(!hasDataRoot)(
		'checkpoints round-trips real sample byte-for-byte',
		() => {
			const files = allCheckpointFiles();
			expect(files.length).toBeGreaterThan(0);
			for (const f of files) {
				const buf = fs.readFileSync(f);
				const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
				const out = checkpointsHandler.writeRaw!(checkpointsHandler.parseRaw(raw, ssCtx()), ssCtx());
				expect(Array.from(out), `round-trip mismatch for ${f}`).toEqual(Array.from(raw));
			}
		},
	);
});

// silence unused-import lint when END tag constant isn't otherwise referenced
void CHECKPOINTS_END_TAG;
