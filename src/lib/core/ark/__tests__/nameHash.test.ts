import { describe, expect, it } from 'vitest';
import {
	ROSETTA_COUNT,
	ROSETTA_NAMES,
	computeNameHash,
	describeMember,
	hasName,
	hashKey,
	memberFileName,
	resolveName,
} from '../nameHash';

describe('Rosetta name resolution', () => {
	it('embeds all 309 corpus entries', () => {
		expect(ROSETTA_COUNT).toBe(309);
		expect(Object.keys(ROSETTA_NAMES)).toHaveLength(309);
	});

	it('resolves a known hash from texs_rosetta_corpus.json to its real name', () => {
		// 'Bootup/ESRB_rating' -> 8c5ecfcc (verified in the corpus).
		const hash = 0x8c5ecfcc;
		expect(resolveName(hash)).toBe('Bootup/ESRB_rating');
		expect(hasName(hash)).toBe(true);
		// Another spot-check from a different archive group.
		// 'HUD/Dials_Power_Gradient' -> 02874eb7.
		expect(resolveName(0x02874eb7)).toBe('HUD/Dials_Power_Gradient');
	});

	it('returns null for an unknown (Sector-member) hash', () => {
		// Level Sector hashes do not overlap the UI/texture corpus.
		expect(resolveName(0x000ecb73)).toBeNull();
		expect(hasName(0x000ecb73)).toBe(false);
	});

	it('hashKey is the lower-case 8-hex BE u32 form', () => {
		expect(hashKey(0x8c5ecfcc)).toBe('8c5ecfcc');
		expect(hashKey(0x000ecb73)).toBe('000ecb73');
	});

	it('every Rosetta key is a valid 8-hex string', () => {
		for (const k of Object.keys(ROSETTA_NAMES)) {
			expect(k).toMatch(/^[0-9a-f]{8}$/);
		}
	});
});

describe('memberFileName', () => {
	it('uses the real name (slashes flattened, ext appended) when known', () => {
		expect(memberFileName(0x8c5ecfcc, 'gputex')).toBe('Bootup_ESRB_rating.gputex');
	});

	it('falls back to "<hash8>.<ext>" when unknown', () => {
		expect(memberFileName(0x000ecb73, 'sobj')).toBe('000ecb73.sobj');
		expect(memberFileName(0x000ecb73)).toBe('000ecb73.bin');
	});
});

describe('describeMember', () => {
	it('returns the real name when resolvable', () => {
		expect(describeMember(0x8c5ecfcc)).toBe('Bootup/ESRB_rating');
	});

	it('labels with hex + detected type when not named', () => {
		const label = describeMember(0x000ecb73, undefined, {
			ext: 'sobj',
			category: 'model',
			label: 'serialized-object (02 00 00 08)',
		});
		expect(label).toContain('0x000ECB73');
		expect(label).toContain('sobj');
	});
});

describe('computeNameHash (documented stub)', () => {
	it('returns null until the hash is cracked', () => {
		expect(computeNameHash('CityStatic|q000_rig0')).toBeNull();
	});
});
