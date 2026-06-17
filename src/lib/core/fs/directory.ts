// File System Access API bridge: pick a Split/Second installation folder once,
// enumerate its STRUCTURE eagerly (folders + filenames — ~15k entries is fine),
// then read individual file bytes LAZILY on demand with an in-memory cache.
//
// Pure-ish module: depends only on the browser File System Access API and the
// ambient types in src/types/file-system-access.d.ts. No React, no registry.
// (CONTRACT note: this is an fs adapter, not a core *parser* — parsers under
// src/lib/core/<key>.ts still import only binary helpers.)

/** A node in the enumerated directory structure. File leaves carry their handle. */
export type DirEntry = {
	/** Base name (no path), e.g. 'Downtown.Static.ark'. */
	name: string;
	/** Slash-joined path from the picked root, e.g. 'Environments/Levels/Downtown'. */
	path: string;
	kind: 'dir' | 'file';
	/** Present on files — the handle used for lazy byte reads. */
	handle?: FileSystemFileHandle;
	/** Present on dirs — the handle (kept for re-enumeration if ever needed). */
	dirHandle?: FileSystemDirectoryHandle;
	/** Children, present on dirs (eagerly enumerated structure). */
	children?: DirEntry[];
};

/** Is the File System Access directory picker available (Chromium-family)? */
export function isDirectoryPickerSupported(): boolean {
	return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Prompt the user to pick a folder. Throws a tagged error when the API is
 * unavailable; re-throws the DOMException 'AbortError' verbatim when the user
 * cancels so callers can swallow it quietly.
 */
export async function openDirectory(): Promise<FileSystemDirectoryHandle> {
	if (!isDirectoryPickerSupported()) {
		throw new Error('UNSUPPORTED: showDirectoryPicker is not available in this browser.');
	}
	return window.showDirectoryPicker!({ id: 'split-second-steward', mode: 'read' });
}

/** Cap on entries enumerated, so a pathological tree can't hang the UI forever. */
const MAX_ENTRIES = 100_000;

/**
 * Recursively enumerate a directory handle into a DirEntry tree. Reads STRUCTURE
 * only (names + handles), never file bytes. Directories sort before files, then
 * by name (locale-insensitive, case-insensitive) for a stable tree.
 */
export async function enumerateDirectory(
	root: FileSystemDirectoryHandle,
): Promise<DirEntry> {
	let count = 0;

	async function walk(
		handle: FileSystemDirectoryHandle,
		path: string,
	): Promise<DirEntry> {
		const children: DirEntry[] = [];
		// `entries()` is the async-iterator surface in Chromium. Guard with the
		// iterator protocol so a missing impl degrades to an empty folder.
		for await (const [name, child] of handle.entries()) {
			if (++count > MAX_ENTRIES) break;
			const childPath = path ? `${path}/${name}` : name;
			if (child.kind === 'directory') {
				children.push(await walk(child as FileSystemDirectoryHandle, childPath));
			} else {
				children.push({
					name,
					path: childPath,
					kind: 'file',
					handle: child as FileSystemFileHandle,
				});
			}
		}
		children.sort(compareEntries);
		return {
			name: handle.name,
			path,
			kind: 'dir',
			dirHandle: handle,
			children,
		};
	}

	return walk(root, '');
}

function compareEntries(a: DirEntry, b: DirEntry): number {
	if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// Lazy byte reads with an in-memory cache keyed by path
// ---------------------------------------------------------------------------

const byteCache = new Map<string, Uint8Array>();

/**
 * Read a file's bytes via its handle, caching by `cacheKey` (the entry path).
 * Concurrent reads of the same key share one in-flight promise so a fast
 * double-select doesn't read twice.
 */
const inFlight = new Map<string, Promise<Uint8Array>>();

export async function readFileBytes(
	handle: FileSystemFileHandle,
	cacheKey: string,
): Promise<Uint8Array> {
	const cached = byteCache.get(cacheKey);
	if (cached) return cached;

	const pending = inFlight.get(cacheKey);
	if (pending) return pending;

	const promise = (async () => {
		const file = await handle.getFile();
		const bytes = new Uint8Array(await file.arrayBuffer());
		byteCache.set(cacheKey, bytes);
		inFlight.delete(cacheKey);
		return bytes;
	})();
	inFlight.set(cacheKey, promise);
	return promise;
}

/** Whether a path's bytes are already cached (lets callers skip a loading flash). */
export function isCached(cacheKey: string): boolean {
	return byteCache.has(cacheKey);
}

/** Synchronously fetch already-cached bytes, or undefined. */
export function getCachedBytes(cacheKey: string): Uint8Array | undefined {
	return byteCache.get(cacheKey);
}

/** Drop the byte cache (e.g. when a new directory is loaded). */
export function clearByteCache(): void {
	byteCache.clear();
	inFlight.clear();
}
