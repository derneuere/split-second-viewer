import { describe, expect, it } from 'vitest';
import { havokHandler } from '../havok';
import {
	parseHavok,
	isHavokPackfile,
	HAVOK_MAGIC0,
	HAVOK_MAGIC1,
} from '../../../havok';
import { ssCtx } from '../../handler';
import { hasSample, readSample } from '@/test/dataRoot';

// A minimal but byte-valid Havok packfile, generated to match the real layout:
//   userTag=1, fileVersion=5, layoutRules 04 00 01 01, numSections=2,
//   contentsSectionIndex=1 (__data__), contentsClassNameSectionIndex=0,
//   contentsClassNameSectionOffset=37 -> "hkRootLevelContainer".
// __classnames__ holds hkClass / hkClassMember / hkRootLevelContainer.
// (See gen-comment in the parser; bytes verified by parseHavok below.)
const INLINE_BYTES = new Uint8Array([
	87, 224, 224, 87, 16, 192, 192, 16, 0, 0, 0, 1, 0, 0, 0, 5, 4, 0, 1, 1, 0, 0,
	0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 37, 72, 97, 118, 111, 107,
	45, 53, 46, 53, 46, 48, 45, 114, 49, 0, 255, 255, 255, 255, 255, 255, 255,
	255, 255, 95, 95, 99, 108, 97, 115, 115, 110, 97, 109, 101, 115, 95, 95, 0,
	0, 0, 0, 0, 255, 0, 0, 0, 160, 0, 0, 0, 58, 0, 0, 0, 58, 0, 0, 0, 58, 0, 0,
	0, 58, 0, 0, 0, 58, 0, 0, 0, 58, 95, 95, 100, 97, 116, 97, 95, 95, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 224, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0,
	16, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0, 16, 56, 119, 31, 142, 9, 104, 107, 67,
	108, 97, 115, 115, 0, 165, 36, 15, 87, 9, 104, 107, 67, 108, 97, 115, 115,
	77, 101, 109, 98, 101, 114, 0, 245, 152, 163, 78, 9, 104, 107, 82, 111, 111,
	116, 76, 101, 118, 101, 108, 67, 111, 110, 116, 97, 105, 110, 101, 114, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

describe('havok packfile parser', () => {
	it('recognises the magic', () => {
		expect(isHavokPackfile(INLINE_BYTES)).toBe(true);
		expect(isHavokPackfile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
		expect(HAVOK_MAGIC0).toBe(0x57e0e057);
		expect(HAVOK_MAGIC1).toBe(0x10c0c010);
	});

	it('decodes the fixed header (inline fixture)', () => {
		const m = parseHavok(INLINE_BYTES);
		expect(m.header.magic0).toBe(0x57e0e057);
		expect(m.header.magic1).toBe(0x10c0c010);
		expect(m.header.userTag).toBe(1);
		expect(m.header.fileVersion).toBe(5);
		expect(m.header.layoutRules).toEqual([4, 0, 1, 1]);
		expect(m.header.pointerSize).toBe(4);
		expect(m.header.littleEndian).toBe(false);
		expect(m.header.numSections).toBe(2);
		expect(m.header.contentsSectionIndex).toBe(1);
		expect(m.header.contentsClassNameSectionIndex).toBe(0);
		expect(m.header.contentsClassNameSectionOffset).toBe(37);
		expect(m.header.contentsVersion).toBe('Havok-5.5.0-r1');
		expect(m.fileSize).toBe(240);
	});

	it('decodes the section table (inline fixture)', () => {
		const m = parseHavok(INLINE_BYTES);
		expect(m.sections.map((s) => s.tag)).toEqual(['__classnames__', '__data__']);
		const cn = m.sections[0];
		expect(cn.nullByte).toBe(0x000000ff);
		expect(cn.absoluteDataStart).toBe(0xa0);
		expect(cn.endOffset).toBe(58);
		expect(cn.size).toBe(58);
		const data = m.sections[1];
		expect(data.absoluteDataStart).toBe(0xe0);
		expect(data.size).toBe(16);
		// __classnames__ ends exactly where __data__ begins (0xa0 + 0x40-padded).
		expect(cn.absoluteDataStart + cn.size).toBeLessThanOrEqual(data.absoluteDataStart);
	});

	it('enumerates the class registry and resolves the root class (inline fixture)', () => {
		const m = parseHavok(INLINE_BYTES);
		expect(m.classNames.map((c) => c.name)).toEqual([
			'hkClass',
			'hkClassMember',
			'hkRootLevelContainer',
		]);
		expect(m.classNames[0].signature).toBe(0x38771f8e);
		expect(m.classNames[2].signature >>> 0).toBe(0xf598a34e);
		expect(m.rootClassName).toBe('hkRootLevelContainer');
	});

	it('rejects a non-Havok blob', () => {
		expect(() => havokHandler.parseRaw(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), ssCtx())).toThrow(
			/magic|Havok/i,
		);
	});

	it('describe() summarizes root + sections + class count', () => {
		const m = parseHavok(INLINE_BYTES);
		const d = havokHandler.describe(m);
		expect(d).toContain('Havok-5.5.0-r1');
		expect(d).toContain('hkRootLevelContainer');
		expect(d).toContain('3 classes');
		expect(d).toContain('2 sections');
	});

	// ---- REAL devkit samples ----

	const PHYS = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.phys';
	it.skipIf(!hasSample(PHYS))(
		'decodes a REAL .phys packfile (hkpPhysicsSystem root, 62208 B)',
		() => {
			const raw = readSample(PHYS);
			const m = havokHandler.parseRaw(raw, ssCtx());
			expect(m.fileSize).toBe(62208);
			expect(m.header.userTag).toBe(5);
			expect(m.header.fileVersion).toBe(5);
			expect(m.header.contentsVersion).toBe('Havok-5.5.0-r1');
			expect(m.header.numSections).toBe(3);
			expect(m.sections.map((s) => s.tag)).toEqual([
				'__classnames__',
				'__types__',
				'__data__',
			]);
			// Section arithmetic from the wiki: classnames @0xD0, types @0x480,
			// data @0x51A0; data.absoluteDataStart + data.size == fileSize.
			const cn = m.sections[0];
			const types = m.sections[1];
			const data = m.sections[2];
			expect(cn.absoluteDataStart).toBe(0xd0);
			expect(cn.absoluteDataStart + cn.endOffset).toBe(types.absoluteDataStart);
			expect(types.absoluteDataStart).toBe(0x480);
			expect(data.absoluteDataStart).toBe(0x51a0);
			expect(data.absoluteDataStart + data.endOffset).toBe(m.fileSize);
			// 41 registered classes per the wiki; root is hkpPhysicsSystem.
			expect(m.classNames.length).toBe(41);
			expect(m.classNames[0].name).toBe('hkClass');
			expect(m.rootClassName).toBe('hkpPhysicsSystem');
			expect(m.header.contentsClassNameSectionOffset).toBe(0xac);
		},
	);

	const MAINCOLL = 'Vehicles/Bodies/Musclecar_01/Musclecar_01.mainColl';
	it.skipIf(!hasSample(MAINCOLL))(
		'decodes a REAL .mainColl packfile (hkRootLevelContainer root, 4992 B)',
		() => {
			const raw = readSample(MAINCOLL);
			const m = havokHandler.parseRaw(raw, ssCtx());
			expect(m.fileSize).toBe(4992);
			expect(m.header.userTag).toBe(1);
			expect(m.rootClassName).toBe('hkRootLevelContainer');
			expect(m.header.contentsClassNameSectionOffset).toBe(0x4b);
			expect(m.sections.length).toBe(3);
		},
	);

	const HKCOLL = 'Environments/Levels/Downtown/Physics/Downtown.hkColl';
	it.skipIf(!hasSample(HKCOLL))(
		'decodes a REAL level .hkColl packfile',
		() => {
			const raw = readSample(HKCOLL);
			const m = havokHandler.parseRaw(raw, ssCtx());
			expect(m.header.magic0).toBe(0x57e0e057);
			expect(m.header.contentsVersion).toBe('Havok-5.5.0-r1');
			expect(m.classNames.length).toBeGreaterThan(0);
			expect(m.rootClassName && m.rootClassName.length).toBeGreaterThan(0);
		},
	);
});
