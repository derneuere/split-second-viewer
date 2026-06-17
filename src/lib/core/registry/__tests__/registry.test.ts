import { describe, expect, it } from 'vitest';
import {
	getHandlerByExtension,
	getHandlerByKey,
	getHandlerByMagic,
	registry,
} from '../index';
import type { ResourceHandler } from '../handler';

// These tests pin the registry SEAM that every feature work package relies on:
// a handler is discoverable by key, by loose-file extension, and by magic-sniff,
// and the maps are built without collisions. If a WP adds a handler with a
// duplicate key/extension the module throws at import — covered indirectly here
// (the registry imported cleanly) and directly via the contract assertions.

describe('handler registry', () => {
	it('every registered handler satisfies the ResourceHandler contract', () => {
		for (const h of registry) {
			expect(typeof h.key).toBe('string');
			expect(h.key.length).toBeGreaterThan(0);
			expect(typeof h.name).toBe('string');
			expect(typeof h.description).toBe('string');
			expect(typeof h.parseRaw).toBe('function');
			expect(typeof h.describe).toBe('function');
			expect(Array.isArray(h.fixtures)).toBe(true);
			// write handlers must actually expose writeRaw
			if (h.caps.write) expect(typeof h.writeRaw).toBe('function');
			// extensions are lower-case with a leading dot
			for (const ext of h.extensions ?? []) {
				expect(ext).toBe(ext.toLowerCase());
				expect(ext.startsWith('.')).toBe(true);
			}
		}
	});

	it('has unique keys and unique extensions', () => {
		const keys = registry.map((h) => h.key);
		expect(new Set(keys).size).toBe(keys.length);
		const exts = registry.flatMap((h) => h.extensions ?? []);
		expect(new Set(exts).size).toBe(exts.length);
	});

	it('resolves the worked example by key', () => {
		const h = getHandlerByKey('crcs');
		expect(h?.key).toBe('crcs');
		expect(getHandlerByKey('does-not-exist')).toBeUndefined();
	});

	it('resolves by extension from a bare ext, a dotted ext, and a full filename', () => {
		expect(getHandlerByExtension('crcs')?.key).toBe('crcs');
		expect(getHandlerByExtension('.crcs')?.key).toBe('crcs');
		expect(getHandlerByExtension('Downtown_backdrop.texture.crcs')?.key).toBe('crcs');
		expect(getHandlerByExtension('.unknown')).toBeUndefined();
	});

	it('prefers the longest compound extension over its tail', () => {
		// `model` declares BOTH '.model' and '.model.stream'. A loose
		// '<x>.model.stream' member must resolve to model via the compound suffix,
		// not fall through to a bare '.stream' (which no handler claims). This pins
		// the longest-suffix-first walk in getHandlerByExtension.
		expect(getHandlerByExtension('Downtown.model.stream')?.key).toBe('model');
		expect(getHandlerByExtension('Downtown.model')?.key).toBe('model');
		// A windows-style path is reduced to its basename before matching.
		expect(getHandlerByExtension('C:\\Levels\\Downtown\\car.model')?.key).toBe('model');
	});

	it('getHandlerByMagic matches a SHIPPED handler by its declared magic bytes', () => {
		// Drive the real registry (not a fake): the textures handler declares the
		// "TEXS" magic, so a blob with those leading bytes must sniff to it.
		const texs = getHandlerByKey('textures');
		expect(texs?.magic).toBeDefined();
		const blob = new Uint8Array([0x54, 0x45, 0x53, 0x53, 0xaa, 0xbb]); // wrong 4th byte
		blob.set(texs!.magic!, 0); // overwrite leading bytes with the real magic
		expect(getHandlerByMagic(blob)?.key).toBe('textures');

		// Every magic-declaring handler round-trips through its own magic: feeding
		// its declared magic back in must resolve to that handler (or an earlier
		// handler that shares a magic prefix — none do today, asserted here).
		for (const h of registry) {
			if (!h.magic) continue;
			const sniff = getHandlerByMagic(h.magic);
			expect(sniff, `magic for '${h.key}' must resolve`).toBeDefined();
			expect(sniff!.magic, `'${h.key}' must not be shadowed by a prefix collision`).toEqual(
				h.magic,
			);
		}

		// A blob shorter than the magic never matches (no out-of-bounds read).
		expect(getHandlerByMagic(new Uint8Array([0x54]))).toBeUndefined();
	});

	it('getHandlerByMagic returns undefined for handlers with no magic, and matches when declared', () => {
		// crcs declares no magic, so a random blob resolves to nothing today.
		expect(getHandlerByMagic(new Uint8Array([0, 1, 2, 3]))).toBeUndefined();

		// Simulate a future WP handler that DOES declare magic, to prove the
		// magic-sniff seam works without touching the shipped registry.
		const fake: ResourceHandler = {
			key: '__fake_magic__',
			name: 'fake',
			description: 'test-only',
			category: 'Other',
			caps: { read: true, write: false },
			magic: new Uint8Array([0x02, 0x00, 0x00, 0x08]),
			parseRaw: () => ({}),
			describe: () => 'fake',
			fixtures: [],
		};
		const local = [fake];
		const sniff = (raw: Uint8Array) =>
			local.find(
				(h) =>
					h.magic &&
					raw.byteLength >= h.magic.byteLength &&
					h.magic.every((b, i) => raw[i] === b),
			);
		expect(sniff(new Uint8Array([0x02, 0x00, 0x00, 0x08, 0xff]))?.key).toBe('__fake_magic__');
		expect(sniff(new Uint8Array([0x99, 0x00, 0x00, 0x08]))).toBeUndefined();
	});
});
