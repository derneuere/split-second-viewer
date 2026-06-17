// Browser download helpers for extracting .ark members / loose files to disk.
//
// Zero-dependency: a Blob + a synthetic <a download> click. "Extract all" is a
// simple sequential per-member download (a tiny stagger keeps the browser from
// dropping rapid-fire downloads); zipping is intentionally avoided to stay
// dependency-free.

/** Trigger a browser download of `bytes` as `filename`. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
	// Copy into a standalone ArrayBuffer so the Blob never aliases a
	// SharedArrayBuffer-backed view (which the DOM Blob typing rejects).
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const blob = new Blob([copy], { type: 'application/octet-stream' });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		// Revoke on the next tick so the click has a chance to start the download.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}

/** Sleep `ms` milliseconds (used to stagger bulk downloads). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ExtractItem = { bytes: Uint8Array | null; filename: string };

/**
 * Download many members sequentially. Skips items with no bytes. Returns how
 * many were actually downloaded. A small per-item delay avoids the browser
 * coalescing/dropping a burst of programmatic downloads.
 */
export async function extractAll(
	items: readonly ExtractItem[],
	opts: { delayMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<number> {
	const delayMs = opts.delayMs ?? 120;
	let done = 0;
	for (const item of items) {
		if (item.bytes) {
			downloadBytes(item.bytes, item.filename);
			done++;
			opts.onProgress?.(done, items.length);
			await sleep(delayMs);
		}
	}
	return done;
}
