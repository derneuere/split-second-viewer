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
