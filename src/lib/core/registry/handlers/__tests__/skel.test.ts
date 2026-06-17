import { describe, expect, it } from 'vitest';
import { skelHandler } from '../skel';
import { parseSkel, rootBoneIndex } from '../../../skel';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// ---------------------------------------------------------------------------
// Inline fixture: a faithful 2-bone "ftsc" rig built to the exact byte layout
// of the real PG02_Helicopter_A.skel (576 bytes, verified on the devkit). This
// lets the test run anywhere without the devkit data root.
// ---------------------------------------------------------------------------
function buildInlineSkel(): Uint8Array {
	const bones = 2;
	const oParent = 0x40, oOrder = 0x50, oMatA = 0x60, oMatB = 0xe0;
	const oVecC = 0x160, oVecD = 0x180, oVecE = 0x1a0, oNames = 0x1c0;
	const total = oNames + bones * 0x40; // 0x240 = 576
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	const ascii = (s: string, at: number) => {
		for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
	};
	ascii('ftsc', 0);
	dv.setUint16(0x04, 0x0064, false); // version 100
	dv.setUint16(0x06, 0x0010, false); // stride 16
	dv.setUint32(0x08, 0, false); // reserved
	dv.setUint16(0x0c, bones, false); // bone_count
	dv.setUint16(0x0e, 0, false); // pad
	const tbl = [oParent, oOrder, oMatA, oMatB, oVecC, oVecD, oVecE, oNames];
	tbl.forEach((o, i) => dv.setUint32(0x10 + i * 4, o, false));
	dv.setUint32(0x30, oNames, false); // end_offset dup
	// parents: bone0 = root (0xFFFF), bone1 -> 0
	dv.setUint16(oParent, 0xffff, false);
	dv.setUint16(oParent + 2, 0, false);
	// bone_order 0,1
	dv.setUint16(oOrder, 0, false);
	dv.setUint16(oOrder + 2, 1, false);
	// matrix_A identity (diagonal 1.0) for both bones
	for (let b = 0; b < bones; b++) {
		const base = oMatA + b * 64;
		dv.setFloat32(base + 0, 1, false);
		dv.setFloat32(base + 20, 1, false);
		dv.setFloat32(base + 40, 1, false);
		dv.setFloat32(base + 60, 1, false);
	}
	// matrix_B identity, bone1 carries a translation at float index 12 (byte +48)
	for (let b = 0; b < bones; b++) {
		const base = oMatB + b * 64;
		dv.setFloat32(base + 0, 1, false);
		dv.setFloat32(base + 20, 1, false);
		dv.setFloat32(base + 40, 1, false);
		dv.setFloat32(base + 60, 1, false);
	}
	dv.setFloat32(oMatB + 64 + 48, 2.5, false); // bone1 matrixB[12] = 2.5
	// names
	ascii('root_group1_export', oNames);
	ascii('joint_Explosive1', oNames + 64);
	return buf;
}

const INLINE = buildInlineSkel();

const REAL_FIXTURE =
	'Powerplays/Animations/airport_test_03/Generic/PG02_Helicopter/PG02_Helicopter_A.skel';

describe('skel parser', () => {
	it('parses the ftsc header (inline fixture)', () => {
		const m = parseSkel(INLINE);
		expect(m.version).toBe(100);
		expect(m.stride).toBe(16);
		expect(m.boneCount).toBe(2);
		expect(m.offsetTable).toEqual([0x40, 0x50, 0x60, 0xe0, 0x160, 0x180, 0x1a0, 0x1c0]);
	});

	it('decodes the bone hierarchy and names (inline fixture)', () => {
		const m = parseSkel(INLINE);
		expect(m.bones).toHaveLength(2);
		// bone 0 is the root (0xFFFF -> -1)
		expect(m.bones[0].parent).toBe(-1);
		expect(m.bones[0].name).toBe('root_group1_export');
		// bone 1 is a child of bone 0
		expect(m.bones[1].parent).toBe(0);
		expect(m.bones[1].name).toBe('joint_Explosive1');
		// matrix_A is identity
		expect(m.bones[0].matrixA[0]).toBeCloseTo(1, 5);
		expect(m.bones[0].matrixA[5]).toBeCloseTo(1, 5);
		// bone1 matrix_B carries the translation we wrote
		expect(m.bones[1].matrixB[12]).toBeCloseTo(2.5, 5);
		// rootBoneIndex helper
		expect(rootBoneIndex(m)).toBe(0);
	});

	it('rejects a bad magic', () => {
		const bad = new Uint8Array(0x40);
		bad.set([0x66, 0x61, 0x69, 0x6c]); // "fail"
		expect(() => parseSkel(bad)).toThrow(/bad magic/);
	});

	it('describe() summarizes bones and root', () => {
		const m = parseSkel(INLINE);
		const s = skelHandler.describe(m);
		expect(s).toContain('2 bones');
		expect(s).toContain('root_group1_export');
	});

	it.skipIf(!hasSample(REAL_FIXTURE))(
		'parses a REAL .skel from the devkit (PG02_Helicopter_A)',
		() => {
			const raw = readSample(REAL_FIXTURE);
			const m = skelHandler.parseRaw(raw, ssCtx());
			// Concrete decoded values verified against the wiki hex walkthrough.
			expect(m.version).toBe(100);
			expect(m.stride).toBe(16);
			expect(m.boneCount).toBe(2);
			expect(m.bones[0].parent).toBe(-1); // root
			expect(m.bones[1].parent).toBe(0);
			expect(m.bones[0].name).toBe('root_group1_export');
			expect(m.bones[1].name).toBe('joint_Explosive1');
		},
	);
});
