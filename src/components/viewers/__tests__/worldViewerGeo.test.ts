import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	isCheckpoints,
	isSectorInfo,
	buildCheckpoints,
	buildSectorInfo,
	extractCheckpointPositions,
	type CheckpointObject,
} from '../WorldViewer';
import { parseSectorInfo } from '@/lib/core/sectorInfo';
import { parseCheckpoints } from '@/lib/core/checkpoints';
import { DATA_ROOT, hasDataRoot, hasSample, readSample } from '@/test/dataRoot';

// Exercises the WorldViewer geometry builders that turn the deepened
// .sectorInfo / .checkpoints parser models into renderables:
//   - buildSectorInfo  → wireframe AABB cages (flat boxEdges segment list)
//   - buildCheckpoints → 0x484DC9B4-marked placement-transform points
// Pure logic only (no Canvas / three render), so it runs under the Node env.

const SECTOR_FIXTURE = 'Environments/Levels/Downtown/Sectors/Downtown.sectorInfo';
const CHECKPOINT_FIXTURE =
	'Environments/Levels/Downtown/Event/RACING/TrackLogic/A/Track.checkpoints';

/** Enumerate every real Track.checkpoints under the data root. */
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

/** Enumerate every real .sectorInfo under Environments/Levels/<L>/Sectors. */
function allSectorInfoFiles(): string[] {
	if (!hasDataRoot) return [];
	const levels = path.join(DATA_ROOT, 'Environments', 'Levels');
	if (!fs.existsSync(levels)) return [];
	const out: string[] = [];
	for (const lvl of fs.readdirSync(levels)) {
		const sdir = path.join(levels, lvl, 'Sectors');
		if (!fs.existsSync(sdir)) continue;
		for (const f of fs.readdirSync(sdir)) {
			if (f.toLowerCase().endsWith('.sectorinfo')) out.push(path.join(sdir, f));
		}
	}
	return out;
}

// ---- type guards ------------------------------------------------------------

describe('WorldViewer type guards', () => {
	it('isSectorInfo accepts a chunks+sectorCount model and rejects others', () => {
		expect(isSectorInfo({ chunks: [], sectorCount: 0 })).toBe(true);
		expect(isSectorInfo({ chunks: [{ tag: 'q000', offset: 0, length: 4, name: '' }], sectorCount: 1 })).toBe(true);
		expect(isSectorInfo(null)).toBe(false);
		expect(isSectorInfo({ chunks: [] })).toBe(false); // missing sectorCount
		expect(isSectorInfo({ sectorCount: 3 })).toBe(false); // missing chunks
		// A checkpoints-shaped model must NOT match the sector guard.
		expect(isSectorInfo({ version: 1, bodySize: 8, root: { elements: [] } })).toBe(false);
	});

	it('isCheckpoints requires the recursive root tree (no more body field)', () => {
		expect(isCheckpoints({ version: 0x30000, bodySize: 8, root: { elements: [], children: [], offset: 0, size: 8 } })).toBe(true);
		// The old body-only shape no longer satisfies the guard.
		expect(isCheckpoints({ version: 0x30000, bodySize: 8, body: new Uint8Array(8) })).toBe(false);
		expect(isCheckpoints(null)).toBe(false);
	});
});

// ---- buildSectorInfo (AABB wireframe cages) ---------------------------------

describe('buildSectorInfo → wireframe AABB cages', () => {
	it('emits 24 endpoints (12 edges) per AABB-bearing chunk', () => {
		const model = {
			constA: 1.92,
			constB: 300,
			sectorCount: 2,
			chunkTag0: 'q000',
			srcPath: '',
			chunks: [
				{ tag: 'q000', offset: 0, length: 4, name: '', aabb: undefined },
				{ tag: 'q001', offset: 4, length: 4, name: '', aabb: { min: [-10, -2, -10] as [number, number, number], max: [10, 2, 10] as [number, number, number] } },
			],
		};
		const r = buildSectorInfo(model);
		expect(r.strokes).toEqual([]);
		expect(r.points).toEqual([]);
		expect(r.boxEdges).toBeDefined();
		expect(r.boxEdges!.length).toBe(24); // one box × 12 edges × 2 endpoints
		expect(r.bounds).not.toBeNull();
		// Every emitted endpoint is a finite Vec3.
		for (const p of r.boxEdges!) {
			expect(p).toHaveLength(3);
			expect(p.every((c) => Number.isFinite(c))).toBe(true);
		}
	});

	it('reports an empty note when no chunk carries an AABB', () => {
		const r = buildSectorInfo({
			constA: 1.92,
			constB: 300,
			sectorCount: 1,
			chunkTag0: 'q000',
			srcPath: '',
			chunks: [{ tag: 'q000', offset: 0, length: 4, name: '' }],
		});
		expect(r.boxEdges).toEqual([]);
		expect(r.bounds).toBeNull();
		expect(r.emptyNote).toMatch(/no.*AABB|none carry/i);
	});

	it.skipIf(!hasSample(SECTOR_FIXTURE))(
		'builds wireframe cages for the REAL Downtown.sectorInfo',
		() => {
			const m = parseSectorInfo(readSample(SECTOR_FIXTURE));
			expect(isSectorInfo(m)).toBe(true);
			const r = buildSectorInfo(m);
			const withAabb = m.chunks.filter((c) => c.aabb).length;
			expect(withAabb).toBeGreaterThan(10);
			// 12 edges × 2 endpoints per AABB-bearing chunk.
			expect(r.boxEdges!.length).toBe(withAabb * 24);
			expect(r.bounds).not.toBeNull();
			// Centred geometry straddles the origin on at least one axis.
			expect(r.bounds!.radius).toBeGreaterThan(0);
		},
	);

	it.skipIf(!hasDataRoot)('builds non-empty cages on every real .sectorInfo', () => {
		const files = allSectorInfoFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const buf = fs.readFileSync(f);
			const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			const r = buildSectorInfo(parseSectorInfo(raw));
			expect(r.boxEdges!.length % 24, `edge count not a whole-box multiple for ${f}`).toBe(0);
			expect(r.boxEdges!.length, `no AABB cages for ${f}`).toBeGreaterThan(0);
		}
	});
});

// ---- buildCheckpoints (placement-transform points) --------------------------

describe('buildCheckpoints → placement-transform points', () => {
	// A minimal leaf tree carrying one 0x484DC9B4-marked interleaved triple:
	//   word[0] hash, MARK, X, sentinel, Y, sentinel, Z, …
	function leafWithTriple(x: number, y: number, z: number): CheckpointObject {
		const f2w = (f: number) => {
			const b = new ArrayBuffer(4);
			new DataView(b).setFloat32(0, f, false);
			return new DataView(b).getUint32(0, false);
		};
		return {
			offset: 0,
			size: 0x20,
			children: [],
			elements: [
				{ kind: 'word', word: 0x476b5fb3 }, // leading hash word
				{ kind: 'word', word: 0x484dc9b4 }, // placement MARK
				{ kind: 'word', word: f2w(x) }, // X
				{ kind: 'word', word: 0x3f4af922 }, // 0.793 sentinel
				{ kind: 'word', word: f2w(y) }, // Y
				{ kind: 'word', word: 0xa643a898 }, // -0.0 sentinel
				{ kind: 'word', word: f2w(z) }, // Z
				{ kind: 'end' },
			],
		};
	}

	it('extracts an interleaved world-space triple from a MARK-tagged leaf', () => {
		const root: CheckpointObject = {
			offset: 0,
			size: 0x40,
			children: [leafWithTriple(-1491, 14.07, 318.95)],
			elements: [{ kind: 'child', child: 0 }, { kind: 'end' }],
		};
		const pts = extractCheckpointPositions(root);
		expect(pts).toHaveLength(1);
		expect(pts[0][0]).toBeCloseTo(-1491, 0);
		expect(pts[0][1]).toBeCloseTo(14.07, 1);
		expect(pts[0][2]).toBeCloseTo(318.95, 1);
	});

	it('drops normalised-direction leaves (sub-unit X/Z fail the magnitude filter)', () => {
		const root: CheckpointObject = {
			offset: 0,
			size: 0x40,
			children: [leafWithTriple(0.875, 0.0, -0.483)],
			elements: [{ kind: 'child', child: 0 }, { kind: 'end' }],
		};
		expect(extractCheckpointPositions(root)).toHaveLength(0);
	});

	it('buildCheckpoints centres the recovered points and notes when none found', () => {
		const empty = {
			version: 0x30000,
			bodySize: 8,
			root: {
				offset: 0,
				size: 8,
				children: [],
				elements: [{ kind: 'end' as const }],
			} satisfies CheckpointObject,
			objectCount: 1,
		};
		const r = buildCheckpoints(empty);
		expect(r.points).toEqual([]);
		expect(r.bounds).toBeNull();
		expect(r.emptyNote).toMatch(/placement transform|no.*position/i);
	});

	it.skipIf(!hasSample(CHECKPOINT_FIXTURE))(
		'recovers a world-space start-line point from REAL Downtown route-A',
		() => {
			const m = parseCheckpoints(readSample(CHECKPOINT_FIXTURE));
			expect(isCheckpoints(m)).toBe(true);
			const pts = extractCheckpointPositions(m.root);
			// Exactly one true world-space placement (the start-line checkpoint).
			expect(pts.length).toBeGreaterThanOrEqual(1);
			const r = buildCheckpoints(m);
			expect(r.points.length).toBe(pts.length);
			expect(r.bounds).not.toBeNull();
		},
	);

	it.skipIf(!hasDataRoot)('recovers ≥1 placement point on every real .checkpoints', () => {
		const files = allCheckpointFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const buf = fs.readFileSync(f);
			const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			const m = parseCheckpoints(raw);
			const pts = extractCheckpointPositions(m.root);
			expect(pts.length, `no placement point recovered for ${f}`).toBeGreaterThanOrEqual(1);
		}
	});
});
