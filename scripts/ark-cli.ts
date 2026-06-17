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
} from '../src/lib/core/ark/ArkArchive';
import { describeMember } from '../src/lib/core/ark/nameHash';
import { ingestLoose } from '../src/lib/core/loose';
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
	console.log('  idx  segment  nameHash      size        storedLen   offset      type');
	console.log('  ' + '-'.repeat(78));

	for (const m of archive.members) {
		const segBytes = m.segment === 'static' ? staticBytes : streamBytes;
		const leading = segBytes ? segBytes.subarray(m.offset, Math.min(m.offset + 16, segBytes.byteLength)) : undefined;
		const label = describeMember(m.nameHash, leading);
		console.log(
			`  ${String(m.index).padStart(4)}  ${m.segment.padEnd(7)}  ${hex(m.nameHash)}  ` +
				`${hex(m.size).padEnd(10)}  ${hex(m.storedLen).padEnd(10)}  ${hex(m.offset).padEnd(10)}  ${label}`,
		);
	}
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
			console.log('  parse     <file> [--type <key>]                   parse + describe()');
			console.log('  roundtrip <file> [--type <key>]                   parse→write→compare');
			console.log('  stress    <file> [--type <key>] [--scenario <n>]  run stress scenarios');
			if (cmd && cmd !== 'help') process.exitCode = 1;
	}
}

main();
