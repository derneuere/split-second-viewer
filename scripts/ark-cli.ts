#!/usr/bin/env tsx
// Split/Second Steward CLI — a Node dispatcher over the .ark parser and the
// handler registry. Exercises the parsers WITHOUT the UI (PORT-BRIEF §8).
//
// Usage (from the repo root):
//   npm run ark -- list      <Level.Static.ark> [Level.Stream.ark]
//   npm run ark -- parse     <file> [--type <key>]
//   npm run ark -- roundtrip <file> [--type <key>]
//   npm run ark -- stress    <file> [--type <key>] [--scenario <name>]
//
// `list` prints the .ark TOC (and, for a pair, the merged member list with a
// magic-sniffed type per member). `parse` routes a loose file to its handler by
// extension (or `--type`) and prints describe().

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	parseArk,
	levelFromFilename,
	extractMember,
} from '../src/lib/core/ark/ArkArchive';
import {
	describeMember,
	memberFileName,
	resolveName,
	ROSETTA_COUNT,
} from '../src/lib/core/ark/nameHash';
import { ingestLoose } from '../src/lib/core/loose';
import type { ArchiveMember } from '../src/lib/core/types';
import {
	getHandlerByExtension,
	getHandlerByKey,
	ssCtx,
	type ResourceHandler,
} from '../src/lib/core/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(p: string): Uint8Array {
	const buf = fs.readFileSync(p);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function sha1(bytes: Uint8Array): string {
	return createHash('sha1').update(bytes).digest('hex');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

function hex(n: number, w = 8): string {
	return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
}

type CliArgs = { positional: string[]; options: Map<string, string> };

function parseArgs(argv: string[]): CliArgs {
	const positional: string[] = [];
	const options = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				options.set(key, next);
				i++;
			} else {
				options.set(key, 'true');
			}
		} else {
			positional.push(arg);
		}
	}
	return { positional, options };
}

function resolveHandler(file: string, args: CliArgs): ResourceHandler | undefined {
	const typeKey = args.options.get('type');
	if (typeKey) {
		const h = getHandlerByKey(typeKey);
		if (!h) throw new Error(`no handler with key '${typeKey}'`);
		return h;
	}
	return getHandlerByExtension(file);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(args: CliArgs) {
	const [staticPath, streamPath] = args.positional;
	if (!staticPath) throw new Error('list: expected <Level.Static.ark> [Level.Stream.ark]');

	const staticBytes = readFile(staticPath);
	const streamBytes = streamPath ? readFile(streamPath) : undefined;
	const level = levelFromFilename(path.basename(staticPath));
	const archive = parseArk(staticBytes, streamBytes, level);

	const sh = archive.staticHeader;
	console.log(`Archive: ${level}`);
	console.log(
		`  Static header: version=${sh.version} dataStart=${hex(sh.dataStart)} ` +
			`count=${sh.count} entrySize=${hex(sh.entrySize, 4)}`,
	);
	if (archive.streamHeader) {
		const st = archive.streamHeader;
		console.log(
			`  Stream header: version=${st.version} dataStart=${hex(st.dataStart)} ` +
				`count=${st.count} entrySize=${hex(st.entrySize, 4)}`,
		);
	}
	console.log(`  Members: ${archive.members.length}`);
	console.log('');
	console.log('  idx  segment  nameHash      storedLen   offset      type      label');
	console.log('  ' + '-'.repeat(86));

	const buckets: Record<string, number> = {};
	let named = 0;
	let framed = 0;
	for (const m of archive.members) {
		const segBytes = m.segment === 'static' ? staticBytes : streamBytes;
		const leading = segBytes
			? segBytes.subarray(m.offset, Math.min(m.offset + 16, segBytes.byteLength))
			: undefined;
		const label = describeMember(m.nameHash, leading, m.detectedType);
		const ext = m.detectedType?.ext ?? '?';
		if (m.detectedType) buckets[m.detectedType.category] = (buckets[m.detectedType.category] ?? 0) + 1;
		if (resolveName(m.nameHash)) named++;
		if (m.framed) framed++;
		console.log(
			`  ${String(m.index).padStart(4)}  ${m.segment.padEnd(7)}  ${hex(m.nameHash)}  ` +
				`${hex(m.storedLen).padEnd(10)}  ${hex(m.offset).padEnd(10)}  ${ext.padEnd(8)}  ${label}`,
		);
	}

	console.log('');
	console.log(`  type histogram: ${Object.entries(buckets).map(([k, v]) => `${k}=${v}`).join('  ')}`);
	console.log(`  named ${named}/${archive.members.length}  ·  framed ${framed}  ·  Rosetta entries ${ROSETTA_COUNT}`);
}

// ---------------------------------------------------------------------------
// extract — mirror _tools/ark_extract_full.py: write a level pair to disk.
// ---------------------------------------------------------------------------

function cmdExtract(args: CliArgs) {
	const [staticPath, streamPath] = args.positional;
	if (!staticPath) {
		throw new Error('extract: expected <Level.Static.ark> [Level.Stream.ark] [--out DIR]');
	}
	const staticBytes = readFile(staticPath);
	const streamBytes = streamPath ? readFile(streamPath) : undefined;
	const level = args.options.get('level') ?? levelFromFilename(path.basename(staticPath));
	const outRoot = args.options.get('out') ?? path.join(process.cwd(), 'level_extract');
	const limit = args.options.has('limit') ? Number(args.options.get('limit')) : undefined;
	const archive = parseArk(staticBytes, streamBytes, level);

	const outDir = path.join(outRoot, level);
	fs.mkdirSync(outDir, { recursive: true });

	console.log(`Level: ${level} -> ${outDir}`);
	console.log(`Rosetta dictionary entries: ${ROSETTA_COUNT}`);

	const grand = { total: 0, written: 0, named: 0, framed: 0, raw: 0 };
	const grandBuckets: Record<string, number> = {};
	const archivesManifest: Record<string, unknown> = {};

	for (const [tag, segBytes] of [
		['Static', staticBytes],
		['Stream', streamBytes],
	] as const) {
		if (!segBytes) continue;
		const seg = tag === 'Static' ? 'static' : 'stream';
		const sub = path.join(outDir, tag);
		fs.mkdirSync(sub, { recursive: true });
		const segMembers = archive.members.filter((m) => m.segment === seg);
		const counts = { total: 0, written: 0, named: 0, framed: 0, raw: 0 };
		const buckets: Record<string, number> = {};
		const used = new Set<string>();
		const recs: unknown[] = [];
		let n = 0;

		for (const m of segMembers as ArchiveMember[]) {
			counts.total++;
			if (m.storedLen === 0) {
				recs.push({ idx: m.index, nameHash: hex(m.nameHash), empty: true });
				continue;
			}
			if (limit !== undefined && n >= limit) break;
			const { payload, framed, type } = extractMember(segBytes, m);
			if (framed) counts.framed++;
			else counts.raw++;
			buckets[type.category] = (buckets[type.category] ?? 0) + 1;

			const real = resolveName(m.nameHash);
			if (real) counts.named++;
			let fn = memberFileName(m.nameHash, type.ext);
			if (used.has(fn)) {
				const base = fn.replace(/\.[^.]+$/, '');
				const ext = fn.slice(base.length);
				let k = 1;
				do {
					fn = `${base}_${k}${ext}`;
					k++;
				} while (used.has(fn));
			}
			used.add(fn);
			fs.writeFileSync(path.join(sub, fn), payload);
			counts.written++;
			recs.push({
				idx: m.index,
				nameHash: hex(m.nameHash),
				name: real,
				offset: m.offset,
				storedLen: m.storedLen,
				payloadLen: payload.byteLength,
				framed,
				ext: type.ext,
				category: type.category,
				file: fn,
			});
			n++;
		}

		console.log(`\n[${tag}] ${path.basename(seg === 'static' ? staticPath : streamPath!)}`);
		console.log(
			`  count=${counts.total}  written=${counts.written}  named=${counts.named}  ` +
				`framed=${counts.framed}  raw=${counts.raw}`,
		);
		console.log(
			`  type histogram: ${Object.entries(buckets).map(([k, v]) => `${k}=${v}`).join('  ')}`,
		);
		archivesManifest[tag] = { counts, buckets, members: recs };
		grand.total += counts.total;
		grand.written += counts.written;
		grand.named += counts.named;
		grand.framed += counts.framed;
		grand.raw += counts.raw;
		for (const [k, v] of Object.entries(buckets)) grandBuckets[k] = (grandBuckets[k] ?? 0) + v;
	}

	const manifest = {
		level,
		outDir,
		grandTotals: grand,
		typeHistogram: grandBuckets,
		archives: archivesManifest,
	};
	fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

	console.log(`\n=== GRAND TOTALS (${level}) ===`);
	console.log(
		`  members=${grand.total}  written=${grand.written}  named=${grand.named}  ` +
			`framed=${grand.framed}  raw=${grand.raw}`,
	);
	console.log(`  type histogram: ${Object.entries(grandBuckets).map(([k, v]) => `${k}=${v}`).join('  ')}`);
	console.log(`\nmanifest -> ${path.join(outDir, 'manifest.json')}`);
}

function cmdParse(args: CliArgs) {
	const [file] = args.positional;
	if (!file) throw new Error('parse: expected <file> [--type <key>]');
	const handler = resolveHandler(file, args);
	if (!handler) {
		throw new Error(`parse: no handler for ${path.basename(file)} (pass --type <key>)`);
	}
	const loose = ingestLoose(path.basename(file), readFile(file));
	const model = handler.parseRaw(loose.bytes, ssCtx());
	console.log(`${handler.name} (${handler.key}): ${handler.describe(model)}`);
}

function cmdRoundtrip(args: CliArgs) {
	const [file] = args.positional;
	if (!file) throw new Error('roundtrip: expected <file> [--type <key>]');
	const handler = resolveHandler(file, args);
	if (!handler) throw new Error(`roundtrip: no handler for ${path.basename(file)}`);
	if (!handler.writeRaw) throw new Error(`roundtrip: handler '${handler.key}' is read-only`);

	const raw = readFile(file);
	const model = handler.parseRaw(raw, ssCtx());
	const written = handler.writeRaw(model, ssCtx());
	const exact = bytesEqual(raw, written);
	console.log(`raw    sha1 ${sha1(raw)} (${raw.byteLength} bytes)`);
	console.log(`written sha1 ${sha1(written)} (${written.byteLength} bytes)`);
	console.log(exact ? 'byte-exact round-trip: OK' : 'byte-exact round-trip: MISMATCH');
	if (!exact) process.exitCode = 1;
}

function cmdStress(args: CliArgs) {
	const [file] = args.positional;
	if (!file) throw new Error('stress: expected <file> [--type <key>] [--scenario <name>]');
	const handler = resolveHandler(file, args);
	if (!handler) throw new Error(`stress: no handler for ${path.basename(file)}`);
	if (!handler.writeRaw) throw new Error(`stress: handler '${handler.key}' is read-only`);
	if (!handler.stressScenarios?.length) {
		console.log(`stress: handler '${handler.key}' has no scenarios`);
		return;
	}

	const filter = args.options.get('scenario');
	const raw = readFile(file);
	const base = handler.parseRaw(raw, ssCtx());

	let failures = 0;
	for (const sc of handler.stressScenarios) {
		if (filter && sc.name !== filter) continue;
		const clone = structuredClone(base);
		const mutated = sc.mutate(clone);
		const written = handler.writeRaw(mutated, ssCtx());
		const reparsed = handler.parseRaw(written, ssCtx());
		const problems = sc.verify ? sc.verify(mutated, reparsed) : [];
		// idempotence check
		const written2 = handler.writeRaw(reparsed, ssCtx());
		if (!bytesEqual(written, written2)) problems.push('writer not idempotent');
		if (problems.length === 0) {
			console.log(`  [OK]   ${sc.name}`);
		} else {
			failures++;
			console.log(`  [FAIL] ${sc.name}: ${problems.join('; ')}`);
		}
	}
	if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);

	switch (cmd) {
		case 'list':
			cmdList(args);
			break;
		case 'extract':
			cmdExtract(args);
			break;
		case 'parse':
			cmdParse(args);
			break;
		case 'roundtrip':
			cmdRoundtrip(args);
			break;
		case 'stress':
			cmdStress(args);
			break;
		default:
			console.log('Split/Second Steward CLI');
			console.log('');
			console.log('Commands:');
			console.log('  list      <Level.Static.ark> [Level.Stream.ark]   print the .ark TOC');
			console.log('  extract   <Level.Static.ark> [Level.Stream.ark] [--out DIR] [--limit N]');
			console.log('            extract every member to disk + manifest.json (mirrors ark_extract_full.py)');
			console.log('  parse     <file> [--type <key>]                   parse + describe()');
			console.log('  roundtrip <file> [--type <key>]                   parse→write→compare');
			console.log('  stress    <file> [--type <key>] [--scenario <n>]  run stress scenarios');
			if (cmd && cmd !== 'help') process.exitCode = 1;
	}
}

main();
