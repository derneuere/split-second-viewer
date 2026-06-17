#!/usr/bin/env tsx
// Regenerate src/lib/core/ark/rosettaNames.ts from the Rosetta corpus.
//
// The corpus (_tools/texs_rosetta_corpus.json) maps archive-group -> { name ->
// hash(hex) } for 309 real UI/texture-pack resources. We flatten it to a single
// hash(hex) -> "<group>/<name>" table embedded as a TS const, the only source of
// real member names until the nameHash function is fully cracked.
//
// Usage (from the repo root):  npx tsx scripts/gen-rosetta.ts [corpus.json]

import * as fs from 'node:fs';
import * as path from 'node:path';

const CORPUS_DEFAULT = path.resolve(
	__dirname,
	'../../_tools/texs_rosetta_corpus.json',
);
const OUT = path.resolve(__dirname, '../src/lib/core/ark/rosettaNames.ts');

function main() {
	const corpusPath = process.argv[2] ?? CORPUS_DEFAULT;
	const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as Record<
		string,
		Record<string, string>
	>;

	const items: [string, string][] = [];
	for (const [group, mapping] of Object.entries(corpus)) {
		for (const [name, hex] of Object.entries(mapping)) {
			const key = ((parseInt(hex, 16) >>> 0) & 0xffffffff)
				.toString(16)
				.padStart(8, '0');
			const full = `${group}/${name}`.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
			items.push([key, full]);
		}
	}
	items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

	const header = [
		'// AUTO-GENERATED -- do not edit by hand.',
		'//',
		`// Source: _tools/texs_rosetta_corpus.json (${items.length} real name->hash pairs harvested`,
		'// from the UI/texture packs of the NPXX00575 devkit). Regenerate with',
		'// scripts/gen-rosetta.ts.',
		'//',
		'// This is the hash->name lookup table that backs resolveName() in nameHash.ts.',
		'// The nameHash function itself is only PARTIALLY cracked (GF(2)-affine, within-',
		'// byte poly 0xDB710641), so member names CANNOT be computed yet -- this corpus is',
		'// the only source of real names. Members whose BE u32 hash appears here get their',
		'// real name; all others fall back to <hash8>.<detected-ext>.',
		'//',
		'// Keyed by the lower-case 8-hex-digit nameHash. Names are <archiveGroup>/<name>.',
		'',
		`/** nameHash (lower-case 8 hex) -> real resource name. ${items.length} entries. */`,
		'export const ROSETTA_NAMES: Readonly<Record<string, string>> = {',
	];
	const body = items.map(([key, full]) => `\t'${key}': '${full}',`);
	const footer = [
		'};',
		'',
		'/** Number of name->hash pairs embedded from the Rosetta corpus. */',
		`export const ROSETTA_COUNT = ${items.length};`,
		'',
	];

	const text = [...header, ...body, ...footer].join('\n');
	fs.writeFileSync(OUT, text, 'ascii');
	console.log(`wrote ${items.length} entries -> ${OUT}`);
}

main();
