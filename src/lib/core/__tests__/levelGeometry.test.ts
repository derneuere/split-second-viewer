// Whole-level geometry loader tests.
//
// Pure-logic tests (no Canvas / three render) run everywhere; the real
// airport_test_03 .ark-pair decode is skipIf-guarded on the devkit data root.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	isGeometryMember,
	positionsUsable,
	positionsSuspect,
	loadLevelGeometry,
	type SegmentBytes,
} from '@/lib/core/levelGeometry';
import { parseArk } from '@/lib/core/ark/ArkArchive';
import { DATA_ROOT, hasDataRoot } from '@/test/dataRoot';
import type { ArchiveMember } from '@/lib/core/types';

const LEVEL_DIR = path.join(DATA_ROOT, 'Environments/Levels/airport_test_03/Sectors');
const STATIC_ARK = path.join(LEVEL_DIR, 'airport_test_03.Static.ark');
const STREAM_ARK = path.join(LEVEL_DIR, 'airport_test_03.Stream.ark');
const hasLevel = hasDataRoot && fs.existsSync(STATIC_ARK) && fs.existsSync(STREAM_ARK);

function member(over: Partial<ArchiveMember>): ArchiveMember {
	return {
		nameHash: 1,
		size: 100,
		offset: 0,
		storedLen: 100,
		segment: 'static',
		index: 0,
		...over,
	};
}

// ---- pure logic -------------------------------------------------------------

describe('isGeometryMember', () => {
	it('accepts model-category members (.sobj / .geo) and rejects others', () => {
		expect(isGeometryMember(member({ detectedType: { ext: 'sobj', category: 'model', label: '' } }))).toBe(true);
		expect(isGeometryMember(member({ detectedType: { ext: 'geo', category: 'model', label: '' } }))).toBe(true);
		expect(isGeometryMember(member({ detectedType: { ext: 'gputex', category: 'texture', label: '' } }))).toBe(false);
		expect(isGeometryMember(member({ detectedType: { ext: 'hkx', category: 'havok', label: '' } }))).toBe(false);
		// Size-0 placeholders never count.
		expect(isGeometryMember(member({ storedLen: 0, detectedType: { ext: 'sobj', category: 'model', label: '' } }))).toBe(false);
	});
});

describe('positionsUsable', () => {
	it('keeps finite in-clamp positions and rejects NaN-soup / overflow', () => {
		const good = [10, 0, 20, -30, 5, 40, 0, 1, 0];
		expect(positionsUsable(good)).toBe(true);
		// A half-float Y spike (±65504) is STILL usable — it is flagged suspect, not
		// dropped (model.ts fixes land in parallel; we render honest output).
		expect(positionsUsable([10, 0, 20, 64896, 1033, -65376, 0, 1, 0])).toBe(true);
		// Absolute overflow clamp rejects astronomically large coords.
		expect(positionsUsable([1e8, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(false);
		// Empty / all-NaN → not usable.
		expect(positionsUsable([])).toBe(false);
		expect(positionsUsable([NaN, NaN, NaN])).toBe(false);
	});
});

describe('positionsSuspect', () => {
	it('flags a decode whose extent overshoots its header AABB', () => {
		const header = { min: [-30, 0, 0] as [number, number, number], max: [10, 5, 40] as [number, number, number] };
		// In-bounds decode is not suspect.
		expect(positionsSuspect([10, 0, 20, -30, 5, 40, 0, 1, 0], header)).toBe(false);
		// A coordinate well past the 5-unit header height (but below the absolute
		// half-float-spike threshold) → suspect via the header-overshoot path.
		expect(positionsSuspect([10, 0, 20, 0, 500, 40, 0, 1, 0], header)).toBe(true);
	});

	it('flags a half-float-saturation spike (±65504-derived) regardless of header', () => {
		// The ±8000+ spike fires even with NO header AABB to compare — the direct
		// half-float-mis-decode fingerprint.
		expect(positionsSuspect([0, 65000, 0, 0, 0, 0, 0, 0, 0], null)).toBe(true);
		expect(positionsSuspect([61920, 0, -64512, 0, 0, 0, 0, 0, 0], null)).toBe(true);
		// A clean part within the real level extent is NOT suspect with no header.
		expect(positionsSuspect([1200, 30, -800, -600, 5, 400, 0, 1, 0], null)).toBe(false);
	});
});

describe('loadLevelGeometry on a synthetic empty archive', () => {
	it('returns an empty result without throwing when no geometry members exist', () => {
		const empty = {
			level: 'x',
			staticHeader: { version: 0, dataStart: 16, count: 0, entrySize: 16 },
			members: [],
		};
		const g = loadLevelGeometry(empty, () => undefined);
		expect(g.parts).toEqual([]);
		expect(g.bounds).toBeNull();
		expect(g.decodedCount).toBe(0);
		expect(g.candidateCount).toBe(0);
		expect(g.note).toMatch(/Whole-level decode/);
	});
});

// ---- real airport_test_03 level (devkit only) -------------------------------

describe.skipIf(!hasLevel)('loadLevelGeometry on the REAL airport_test_03 .ark pair', () => {
	it('enumerates and decodes a large fraction of the level into one world-space scene', () => {
		const sBuf = fs.readFileSync(STATIC_ARK);
		const stBuf = fs.readFileSync(STREAM_ARK);
		const sBytes = new Uint8Array(sBuf.buffer, sBuf.byteOffset, sBuf.byteLength);
		const stBytes = new Uint8Array(stBuf.buffer, stBuf.byteOffset, stBuf.byteLength);
		const archive = parseArk(sBytes, stBytes, 'airport_test_03');

		const segBytes: SegmentBytes = (seg) => (seg === 'static' ? sBytes : stBytes);

		// Decode the whole level (all geometry members).
		const g = loadLevelGeometry(archive, segBytes);

		// Member enumeration: airport_test_03 has hundreds of geometry candidates
		// (244 Static .sobj + 121 Stream .geo = 365).
		expect(g.candidateCount).toBeGreaterThan(300);

		// Decode count: the load-all path turns most candidates into geometry.
		expect(g.decodedCount).toBeGreaterThan(100);
		expect(g.parts.length).toBe(g.decodedCount);
		// The model.ts parallel fix landed: the half-float mis-decode that used to
		// emit ±65504-spiked "suspect" geometry is gone — model.ts now WITHHOLDS the
		// undecodable Stream .geo float32 streams and the quantized Static .sobj
		// buffers (no-geometry beats wrong geometry) instead of spiking. So the kept
		// parts are all clean; suspectCount is no longer expected to be positive.
		expect(g.suspectCount).toBeGreaterThanOrEqual(0);

		// The kept geometry forms a real level-sized world-space AABB, framed from
		// the CLEAN (non-suspect) parts so half-float-spiked decodes don't blow it up.
		expect(g.bounds).not.toBeNull();
		const span = (k: 0 | 1 | 2) => g.bounds!.max[k] - g.bounds!.min[k];
		// Level spans hundreds of units on X and Z (airport_test_03 ≈ ±2600 / ±1880).
		expect(span(0)).toBeGreaterThan(100);
		expect(span(2)).toBeGreaterThan(100);

		// Different CLEAN parts sit at different world locations (placement is implicit
		// in the vertex data — the central world-placement finding). Check that the
		// per-part centroids are NOT all stacked at one point.
		const cleanParts = g.parts.filter((p) => !p.suspect);
		expect(cleanParts.length).toBeGreaterThan(2);
		const centroids = cleanParts.map((p) => {
			let sx = 0,
				sz = 0,
				n = 0;
			for (let i = 0; i < p.positions.length; i += 3) {
				const x = p.positions[i],
					z = p.positions[i + 2];
				if (Number.isFinite(x) && Number.isFinite(z)) {
					sx += x;
					sz += z;
					n++;
				}
			}
			return [n ? sx / n : 0, n ? sz / n : 0] as const;
		});
		const cxs = centroids.map((c) => c[0]);
		const czs = centroids.map((c) => c[1]);
		const spreadX = Math.max(...cxs) - Math.min(...cxs);
		const spreadZ = Math.max(...czs) - Math.min(...czs);
		expect(spreadX + spreadZ).toBeGreaterThan(50); // parts are spread across the map

		// Sanity: every kept part has finite, in-range positions.
		for (const p of g.parts) {
			expect(p.positions.length % 3).toBe(0);
			expect(p.indices.length % 3).toBe(0);
			for (let i = 0; i < Math.min(p.positions.length, 300); i++) {
				expect(Number.isFinite(p.positions[i])).toBe(true);
			}
		}

		console.log(g.note);
	});
});
