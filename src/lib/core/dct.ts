// .dct parser — Split/Second localisation dictionary.
//
// LITTLE-ENDIAN (the one LE format in this cluster besides .gfx). Verified
// against Dictionary/ENGLISH_PS3.dct; layout per wiki format-misc.html:
//
//   off 0x00  'DICT'                       ASCII magic
//   off 0x04  u32 LE version        = 0x2000
//   off 0x08  u32 LE fileHash               whole-file/content hash
//   off 0x0C  u32 LE constant       = 19    (constant across all 16 dictionaries)
//   off 0x10  u32 LE entryCount             scales with content (142 EN, 394 DE…)
//   off 0x14  record[entryCount]            { u32 hash, u32 stringOffset, u32 reserved }
//   tail      packed NUL-separated UTF-8 string blob (readable UI text)
//
// CONFIRMED: header + the 12-byte record table parse cleanly and entryCount
// tracks dictionary size. PARTIAL: the base that `stringOffset` is measured from
// did not resolve cleanly to string boundaries in testing, so hash→string
// resolution is NOT byte-verified. We therefore decode the header + record table
// and additionally extract the readable string blob from the tail (NUL-split),
// without claiming a one-to-one hash↔string mapping.
//
// Pure module: imports only the binary helpers, NEVER the registry.

import { BinReader } from './binary/BinReader';

const DICT = 0x44494354; // 'DICT' (read big-endian to compare the literal bytes)

export type DctRecord = {
	/** Name hash (LE u32). */
	hash: number;
	/** String offset field (LE u32). Base is unverified — see module note. */
	stringOffset: number;
	/** Reserved word (LE u32), 0 in all observed records. */
	reserved: number;
};

export type ParsedDct = {
	version: number;
	fileHash: number;
	/** Constant field at 0x0C (19 across all shipped dictionaries). */
	constant: number;
	entryCount: number;
	records: DctRecord[];
	/** Absolute byte offset where the packed string blob begins (table end). */
	stringBlobOffset: number;
	/** Readable strings extracted from the tail blob (NUL-separated). */
	strings: string[];
	/**
	 * False when hash→string resolution is not byte-verified. Always false for
	 * now: header + table are Confirmed, the offset base is Partial.
	 */
	stringsResolved: boolean;
	/**
	 * Verbatim original bytes. The string-offset base is unverified so the model
	 * is not a full structural representation; the writer reproduces the file from
	 * these bytes (byte-exact passthrough). A copy, independent of the caller's
	 * buffer.
	 */
	raw: Uint8Array;
};

export function parseDct(raw: Uint8Array): ParsedDct {
	if (raw.byteLength < 0x14) throw new Error('dct: too small for DICT header');
	// Magic is the literal bytes 'DICT' regardless of endianness.
	const magicBE =
		(raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
	if ((magicBE >>> 0) !== DICT) {
		throw new Error(`dct: bad magic 0x${(magicBE >>> 0).toString(16)} (expected 'DICT')`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		true, // little-endian
	);
	r.skip(4); // 'DICT'
	const version = r.readU32();
	const fileHash = r.readU32();
	const constant = r.readU32();
	const entryCount = r.readU32();

	const records: DctRecord[] = [];
	const total = raw.byteLength;
	for (let i = 0; i < entryCount; i++) {
		if (r.position + 12 > total) break;
		const hash = r.readU32();
		const stringOffset = r.readU32();
		const reserved = r.readU32();
		records.push({ hash, stringOffset, reserved });
	}

	const stringBlobOffset = r.position;
	const strings = extractStrings(raw, stringBlobOffset);

	return {
		version,
		fileHash,
		constant,
		entryCount,
		records,
		stringBlobOffset,
		strings,
		stringsResolved: false,
		raw: raw.slice(), // independent verbatim copy for the byte-exact writer
	};
}

/**
 * Byte-exact passthrough writer. hash→string resolution (the stringOffset base)
 * is unverified, so we do not rebuild the string blob; instead we reproduce the
 * verbatim source bytes captured at parse time. writeRaw(parse(b)) === b for any
 * input. (Editing dictionary strings is out of scope until the offset base is
 * pinned down.)
 */
export function writeDct(model: ParsedDct): Uint8Array {
	return model.raw.slice();
}

/**
 * Extract printable runs (len >= 2) from the tail string blob, splitting on NUL
 * and other non-printable bytes. Mirrors how the readable UI text is stored.
 */
function extractStrings(raw: Uint8Array, start: number): string[] {
	const out: string[] = [];
	let cur: number[] = [];
	for (let i = start; i < raw.byteLength; i++) {
		const b = raw[i];
		// Printable ASCII (UI text is plain ASCII in the shipped dictionaries).
		if (b >= 0x20 && b < 0x7f) {
			cur.push(b);
		} else {
			if (cur.length >= 2) out.push(String.fromCharCode(...cur));
			cur = [];
		}
	}
	if (cur.length >= 2) out.push(String.fromCharCode(...cur));
	return out;
}
