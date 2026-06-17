// .checkpoints parser — TrackLogic lap checkpoint table.
//
// Track.checkpoints is a fixed-size serialized record — exactly 348 bytes on
// every route — using Black Rock's tagged serialization framing (the same
// serializer as Track.logicinfo). The 12-byte header is constant:
//
//   0x00 u32 version  = 0x00030000 (v3.0)
//   0x04 u32 beginTag = 0xCDAB0DF0 ("begin object" sentinel)
//   0x08 u32 bodySize = 0x150 (336) = filesize - 12 (INCLUDES the closing
//                       sentinel(s); 0xC + 0x150 = 0x15C = 348 lands on EOF)
//   0x0C body[bodySize]  nested cd ab 0d f0 … ba dc ad de tagged blocks
//
// The body is a RECURSIVE tree of tagged objects. Each object is framed as:
//
//   u32  0xCDAB0DF0   begin tag
//   u32  size         byte length of the object's payload (NESTED objects and
//                     this object's closing 0xBADCADDE end tag are counted in
//                     `size`)
//   u8[size] payload  a mix of raw data words and nested child objects, ending
//                     in one (or more, stacked) 0xBADCADDE end tags
//
// Verified across every route on the devkit: the framing parses cleanly to EOF
// and the tree shape is identical on all 18 .checkpoints files (a 4-deep nest:
// root → object → object{leaf, object{3 leaves}, leaf} → 2 leaves). The leaf
// payloads carry the EBOOT-named fields (mLinkIndex, mHitFraction,
// mCircuitLength, mLapLength…, placement transforms) — a recurring float
// 0x484DC9B4 = 210726.8 marks the placement transforms. The exact field names
// per leaf are still Theory, so each object exposes its raw payload window
// (`dataSpans` — the byte ranges NOT consumed by child objects/end tags) which
// the writer replays verbatim for a byte-exact round-trip.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

/** Serializer "begin object" sentinel (shared with .logicinfo). */
export const CHECKPOINTS_BEGIN_TAG = 0xcdab0df0;
/** Serializer "end object" sentinel that closes each nested sub-object. */
export const CHECKPOINTS_END_TAG = 0xbadcadde;
/** Constant version word on every route. */
export const CHECKPOINTS_VERSION = 0x00030000;

/**
 * A single tagged sub-object in the recursive checkpoint tree. Children appear
 * in file order interleaved with `rawWords`; the original byte order of words
 * vs. children is recoverable from `elements`, which is what the writer replays.
 */
export type CheckpointObject = {
	/** Absolute byte offset of this object's 0xCDAB0DF0 begin tag. */
	offset: number;
	/** Declared payload byte length (the u32 after the begin tag). */
	size: number;
	/** Nested child objects, in file order. */
	children: CheckpointObject[];
	/**
	 * Ordered payload elements as they appear on disk, so the writer reproduces
	 * the exact byte stream. Each element is either a raw 4-byte word
	 * (`{ word }`), an inline end-tag (`{ end: true }`), or a nested object
	 * (`{ child: <index into children> }`).
	 */
	elements: CheckpointElement[];
};

export type CheckpointElement =
	| { kind: 'word'; word: number }
	| { kind: 'end' }
	| { kind: 'child'; child: number };

export type ParsedCheckpoints = {
	/** 0x00030000 (v3.0) on every sampled route. */
	version: number;
	/** 0xCDAB0DF0 begin-object sentinel. */
	beginTag: number;
	/** Declared body length = filesize - 12 (includes the closing sentinels). */
	bodySize: number;
	/** The decoded root object tree (the single top-level object at 0x04). */
	root: CheckpointObject;
	/** True when version/beginTag/bodySize match the documented constants. */
	headerValid: boolean;
	/** Total number of tagged objects in the tree (root included). */
	objectCount: number;
	/** Count of 0xBADCADDE end-object sentinels found in the body. */
	endSentinelCount: number;
};

/** Recursively decode one tagged object beginning at `r.position` (on its begin tag). */
function readObject(r: BinReader, hardEnd: number): CheckpointObject {
	const offset = r.position;
	const tag = r.readU32();
	if (tag !== CHECKPOINTS_BEGIN_TAG) {
		throw new Error(
			`checkpoints: expected begin tag 0x${CHECKPOINTS_BEGIN_TAG.toString(16)} at ` +
				`0x${offset.toString(16)}, got 0x${tag.toString(16)}`,
		);
	}
	const size = r.readU32();
	const payloadStart = r.position;
	const payloadEnd = payloadStart + size;
	if (payloadEnd > hardEnd) {
		throw new Error(
			`checkpoints: object at 0x${offset.toString(16)} payload (size ${size}) ` +
				`overruns 0x${hardEnd.toString(16)}`,
		);
	}

	const children: CheckpointObject[] = [];
	const elements: CheckpointElement[] = [];
	while (r.position < payloadEnd) {
		if (payloadEnd - r.position < 4) {
			// Should never happen on well-formed files; consume the stray bytes as a word-ish tail is not possible (sub-word). Bail loudly.
			throw new Error(
				`checkpoints: object at 0x${offset.toString(16)} has a ${payloadEnd - r.position}-byte sub-word tail`,
			);
		}
		const peek = r.peekU32();
		if (peek === CHECKPOINTS_BEGIN_TAG) {
			const child = readObject(r, payloadEnd);
			elements.push({ kind: 'child', child: children.length });
			children.push(child);
		} else if (peek === CHECKPOINTS_END_TAG) {
			r.skip(4);
			elements.push({ kind: 'end' });
		} else {
			elements.push({ kind: 'word', word: r.readU32() });
		}
	}

	return { offset, size, children, elements };
}

function countObjects(o: CheckpointObject): number {
	let n = 1;
	for (const c of o.children) n += countObjects(c);
	return n;
}

function countEndTags(o: CheckpointObject): number {
	let n = 0;
	for (const e of o.elements) if (e.kind === 'end') n++;
	for (const c of o.children) n += countEndTags(c);
	return n;
}

export function parseCheckpoints(raw: Uint8Array): ParsedCheckpoints {
	if (raw.byteLength < 12) {
		throw new Error(`checkpoints: ${raw.byteLength} bytes is too small for the 12-byte header`);
	}
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	const version = r.readU32();
	const beginTag = r.readU32();
	const bodySize = r.readU32();
	const expected = 12 + bodySize;
	if (raw.byteLength !== expected) {
		throw new Error(
			`checkpoints: size ${raw.byteLength} != 12 + bodySize ${bodySize} (${expected})`,
		);
	}
	if (beginTag !== CHECKPOINTS_BEGIN_TAG) {
		throw new Error(
			`checkpoints: bad begin tag 0x${beginTag.toString(16)} (expected 0x${CHECKPOINTS_BEGIN_TAG.toString(16)})`,
		);
	}

	// The root object begins at 0x04 (its begin tag IS the header beginTag); its
	// declared size is bodySize, so it spans 0x0C..0x0C+bodySize = EOF.
	r.seek(4);
	const root = readObject(r, raw.byteLength);
	if (r.position !== raw.byteLength) {
		throw new Error(
			`checkpoints: root object ended at 0x${r.position.toString(16)}, not EOF 0x${raw.byteLength.toString(16)}`,
		);
	}

	const headerValid =
		version === CHECKPOINTS_VERSION &&
		beginTag === CHECKPOINTS_BEGIN_TAG &&
		root.size === bodySize;

	return {
		version,
		beginTag,
		bodySize,
		root,
		headerValid,
		objectCount: countObjects(root),
		endSentinelCount: countEndTags(root),
	};
}

/** Re-serialize one object (begin tag + size + payload) onto the writer. */
function writeObject(w: BinWriter, o: CheckpointObject): void {
	w.writeU32(CHECKPOINTS_BEGIN_TAG);
	w.writeU32(o.size);
	for (const e of o.elements) {
		switch (e.kind) {
			case 'word':
				w.writeU32(e.word >>> 0);
				break;
			case 'end':
				w.writeU32(CHECKPOINTS_END_TAG);
				break;
			case 'child':
				writeObject(w, o.children[e.child]);
				break;
		}
	}
}

export function writeCheckpoints(model: ParsedCheckpoints): Uint8Array {
	const w = new BinWriter(12 + model.bodySize, false);
	w.writeU32(model.version >>> 0);
	// The root object's begin tag is the header beginTag word; writeObject emits
	// it, so we do NOT separately write beginTag/bodySize — they come from root.
	writeObject(w, model.root);
	return w.bytes.slice();
}
