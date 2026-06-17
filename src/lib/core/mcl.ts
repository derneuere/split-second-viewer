// .mcl parser — Black Rock material-clip / material-combo override list.
//
// Despite the "Mesh Collision" filing it is NOT a Havok file and holds no
// geometry: it is a custom SDRI/INSS container of animated material-parameter
// overrides (colour fades, UV scrolls, fresnel tweaks, texture swaps) applied
// to props during powerplay sequences. Big-endian (PS3). Layout per the RE wiki
// (wiki/format-mcl.html):
//
//   0x00  char[4]  magic         "SDRI" (53 44 52 49)
//   0x04  u32      headerSize    0x08 in every sample
//   0x08  char[4]  chunkTag      "INSS" — instance set start
//   0x0C  u32      instanceCount big-endian (0..41 across the corpus)
//   0x10  u32      setId / hash  per-file 32-bit id
//   ...   instance[instanceCount]
//   EOF-4 char[4]  endTag        "INSE" — instance set end
//
//   instance := u32 nameLen char[] name ("unnamed");
//               u32 hashLen char[] materialHash ("0x622715a2");
//               (flags / paramCount / param value bytes — wiki-Partial)
//   param    := u32 nameLen char[] name; u32 type; u32 slot; value(s)
//
// CONFIDENCE: the outer SDRI/INSS/INSE framing, instanceCount, setId, and the
// readable name strings are decoded with confidence. The exact per-param value
// widths are wiki-Partial, so instances are recovered by ANCHORING on the
// confirmed "name + 0x...hash" pair, and parameter NAMES are recovered by
// scanning each instance's byte span for length-prefixed ASCII symbols (the
// "<effect>_<index>_<property>" pattern). We never assert undecoded value bytes.
//
// Pure module: binary helpers only, never the registry.

export const MCL_MAGIC = new Uint8Array([0x53, 0x44, 0x52, 0x49]); // "SDRI"
const INSS = 0x494e5353; // "INSS"
const INSE = 0x494e5345; // "INSE"

/** A single material-parameter override name recovered from the instance span. */
export type MclParam = {
	name: string;
};

/** One material-instance record. */
export type MclInstance = {
	name: string;
	/** ASCII hex material/shader hash this clip retints, e.g. "0x622715a2". */
	materialHash: string;
	/** Parameter override names recovered from this instance's byte span. */
	params: MclParam[];
};

export type ParsedMcl = {
	/** headerSize word at 0x04 (0x08 in every sample). */
	headerSize: number;
	/** Instance count from the INSS chunk header. */
	instanceCount: number;
	/** Per-file 32-bit set id / hash. */
	setId: number;
	instances: MclInstance[];
	/** True if the file's last 4 bytes are the "INSE" terminator. */
	hasEndTag: boolean;
	/** True if every declared instance was anchored. */
	fullyParsed: boolean;
	byteLength: number;
};

function checkMagic(raw: Uint8Array): void {
	if (raw.byteLength < 0x10) {
		throw new Error(`mcl: too small (${raw.byteLength} bytes, need >= 16)`);
	}
	for (let i = 0; i < 4; i++) {
		if (raw[i] !== MCL_MAGIC[i]) {
			const got = [...raw.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
			throw new Error(`mcl: bad magic ${got} (expected 53 44 52 49 "SDRI")`);
		}
	}
}

const be32 = (raw: Uint8Array, o: number) =>
	((raw[o] << 24) | (raw[o + 1] << 16) | (raw[o + 2] << 8) | raw[o + 3]) >>> 0;

/** Read a length-prefixed string at `off`, or null if it isn't a plausible one. */
function lenStringAt(raw: Uint8Array, off: number, maxLen = 128): { str: string; next: number } | null {
	if (off + 4 > raw.byteLength) return null;
	const len = be32(raw, off);
	if (len < 1 || len > maxLen || off + 4 + len > raw.byteLength) return null;
	const ns = off + 4;
	// printable up to the trailing NUL
	for (let k = 0; k < len - 1; k++) {
		const c = raw[ns + k];
		if (c < 0x20 || c > 0x7e) return null;
	}
	if (raw[ns + len - 1] !== 0x00) return null;
	return { str: new TextDecoder('latin1').decode(raw.subarray(ns, ns + len - 1)), next: ns + len };
}

/**
 * Find the next instance anchor at/after `from`: a length-prefixed name string
 * immediately followed by a length-prefixed material-hash string ("0x........").
 * Returns the name offset + parsed name/hash, or null if none before INSE/EOF.
 */
function findInstanceAnchor(
	raw: Uint8Array,
	from: number,
): { offset: number; name: string; hash: string; after: number } | null {
	const limit = raw.byteLength - 4;
	for (let off = from; off <= limit; off++) {
		// stop at the end terminator
		if (raw[off] === 0x49 && raw[off + 1] === 0x4e && raw[off + 2] === 0x53 && raw[off + 3] === 0x45) {
			return null; // "INSE"
		}
		const nameRec = lenStringAt(raw, off, 64);
		if (!nameRec || nameRec.str.length === 0) continue;
		const hashRec = lenStringAt(raw, nameRec.next, 32);
		if (!hashRec) continue;
		if (!/^0x[0-9a-fA-F]+$/.test(hashRec.str)) continue;
		return { offset: off, name: nameRec.str, hash: hashRec.str, after: hashRec.next };
	}
	return null;
}

/**
 * Collect parameter-name symbols within [start,end): length-prefixed printable
 * names that look like material params (contain an underscore, start with a
 * letter). Excludes bare hashes.
 */
function collectParamNames(raw: Uint8Array, start: number, end: number): MclParam[] {
	const params: MclParam[] = [];
	let off = start;
	while (off + 4 <= end) {
		const rec = lenStringAt(raw, off, 64);
		if (rec && /^[A-Za-z]/.test(rec.str) && rec.str.includes('_') && !/^0x/.test(rec.str)) {
			params.push({ name: rec.str });
			off = rec.next;
			continue;
		}
		off++;
	}
	return params;
}

export function parseMcl(raw: Uint8Array): ParsedMcl {
	checkMagic(raw);

	const headerSize = be32(raw, 0x04);
	const chunkTag = be32(raw, 0x08);
	if (chunkTag !== INSS) {
		throw new Error(`mcl: expected "INSS" chunk at 0x08, got 0x${chunkTag.toString(16)}`);
	}
	const instanceCount = be32(raw, 0x0c);
	const setId = be32(raw, 0x10);

	const hasEndTag = raw.byteLength >= 4 && be32(raw, raw.byteLength - 4) === INSE;

	// First instance anchor begins after the 0x14-byte header (name + hash pair).
	const anchors: { offset: number; name: string; hash: string; after: number }[] = [];
	let cursor = 0x14;
	for (let i = 0; i < instanceCount; i++) {
		const a = findInstanceAnchor(raw, cursor);
		if (!a) break;
		anchors.push(a);
		cursor = a.after;
	}

	const instances: MclInstance[] = anchors.map((a, i) => {
		// param span = end of this instance's hash → start of the next anchor (or INSE/EOF)
		const spanEnd = i + 1 < anchors.length ? anchors[i + 1].offset : Math.max(a.after, raw.byteLength - 4);
		return { name: a.name, materialHash: a.hash, params: collectParamNames(raw, a.after, spanEnd) };
	});

	return {
		headerSize,
		instanceCount,
		setId,
		instances,
		hasEndTag,
		fullyParsed: instances.length === instanceCount,
		byteLength: raw.byteLength,
	};
}
