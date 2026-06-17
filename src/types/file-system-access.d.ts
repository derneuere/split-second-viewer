// Minimal ambient declarations for the File System Access API.
//
// The configured TS `lib` (ES2020 + DOM + DOM.Iterable) predates these types,
// so we declare just the surface we use: showDirectoryPicker() and the handle
// hierarchy that directory.ts walks. Chromium ships these at runtime; the
// feature-detect in directory.ts guards non-Chromium browsers.

export {};

declare global {
	interface FileSystemHandle {
		readonly kind: 'file' | 'directory';
		readonly name: string;
		isSameEntry?(other: FileSystemHandle): Promise<boolean>;
	}

	interface FileSystemFileHandle extends FileSystemHandle {
		readonly kind: 'file';
		getFile(): Promise<File>;
	}

	interface FileSystemDirectoryHandle extends FileSystemHandle {
		readonly kind: 'directory';
		/** Async iterator over [name, handle] entries (Chromium). */
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		keys(): AsyncIterableIterator<string>;
		getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
		getDirectoryHandle(
			name: string,
			options?: { create?: boolean },
		): Promise<FileSystemDirectoryHandle>;
		[Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
	}

	interface ShowDirectoryPickerOptions {
		id?: string;
		mode?: 'read' | 'readwrite';
		startIn?: FileSystemHandle | string;
	}

	interface Window {
		showDirectoryPicker?: (
			options?: ShowDirectoryPickerOptions,
		) => Promise<FileSystemDirectoryHandle>;
	}
}
