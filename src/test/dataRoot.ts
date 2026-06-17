// Test helper: locate the real Split/Second sample data on the devkit and read
// fixtures from it. CI without the devkit still runs the synthetic subset via
// `describe.skipIf(!hasDataRoot)`.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DATA_ROOT =
	process.env.SS_DATA_ROOT ??
	'D:\\Program Files (x86)\\rpcs3\\dev_hdd0\\game\\NPXX00575\\USRDIR\\Deferred';

export const hasDataRoot = fs.existsSync(DATA_ROOT);

/** Read a sample file relative to DATA_ROOT as a Uint8Array. */
export function readSample(rel: string): Uint8Array {
	const buf = fs.readFileSync(path.join(DATA_ROOT, rel));
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** True if a sample file exists relative to DATA_ROOT. */
export function hasSample(rel: string): boolean {
	return hasDataRoot && fs.existsSync(path.join(DATA_ROOT, rel));
}

/**
 * Recursively list every file under DATA_ROOT whose name ends with `ext`
 * (case-insensitive, e.g. '.splitlength'). Returns absolute paths. Empty when
 * the devkit isn't present. Used by the multi-file byte-exact round-trip suites.
 */
export function listSamplesByExt(ext: string): string[] {
	if (!hasDataRoot) return [];
	const want = ext.toLowerCase();
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.toLowerCase().endsWith(want)) out.push(p);
		}
	};
	walk(DATA_ROOT);
	out.sort();
	return out;
}

/** Read an absolute file path as a Uint8Array (companion to readSample). */
export function readFileBytes(abs: string): Uint8Array {
	const buf = fs.readFileSync(abs);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
