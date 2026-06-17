// .checkpoints parser — TrackLogic lap checkpoint table (PARTIAL).
//
// Unlike the other route files, Track.checkpoints is a fixed-size serialized
// record — exactly 348 bytes on every route — using Black Rock's tagged
// serialization framing (the same serializer as Track.logicinfo). The 12-byte
// header is fully decoded and constant:
//
//   0x00 u32 version  = 0x00030000 (v3.0)
//   0x04 u32 beginTag = 0xCDAB0DF0 ("begin object" sentinel)
//   0x08 u32 bodySize = 0x150 (336) = filesize - 12 (INCLUDES the closing
//                       sentinel(s); 0xC + 0x150 = 0x15C = 348 lands on EOF)
//   0x0C body[bodySize]  nested cd ab 0d f0 … ba dc ad de tagged blocks
//
// The 336-byte body holds nested checkpoint sub-objects (placement transforms,
// link indices, hit fractions, lap lengths per the EBOOT symbols mFirst/
// mLapCheckpoint/mLinkIndex/mHitFraction/mCircuitLength/…) whose precise byte
// offsets are not yet pinned, so the body is preserved verbatim and only the
// header + framing landmarks (begin/end sentinel scan) are surfaced. Marked
// PARTIAL. Ported from wiki/format-route.html and the verified Python probe.
//
// Pure module: imports only the binary helpers, NEVER the registry (acyclic).

import { BinReader } from './binary/BinReader';

/** Serializer "begin object" sentinel (shared with .logicinfo). */
export const CHECKPOINTS_BEGIN_TAG = 0xcdab0df0;
/** Serializer "end object" sentinel that closes each nested sub-object. */
export const CHECKPOINTS_END_TAG = 0xbadcadde;
/** Constant version word on every route. */
export const CHECKPOINTS_VERSION = 0x00030000;

/**
 * Decoded .checkpoints. The header is solid; `body` is kept verbatim because
 * the per-checkpoint sub-record offsets are not yet fully pinned (PARTIAL).
 */
export type ParsedCheckpoints = {
	/** 0x00030000 (v3.0) on every sampled route. */
	version: number;
	/** 0xCDAB0DF0 begin-object sentinel. */
	beginTag: number;
	/** Declared body length = filesize - 12 (includes the closing sentinels). */
	bodySize: number;
	/** The raw body bytes (length === bodySize). Not yet field-decoded. */
	body: Uint8Array;
	/** True when version/beginTag/bodySize match the documented constants. */
	headerValid: boolean;
	/**
	 * Count of 0xBADCADDE end-object sentinels found in the body (the file ends
	 * with three stacked sentinels closing the nested sub-objects).
	 */
	endSentinelCount: number;
};

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
	const body = r.readBytes(bodySize);

	// Count 0xBADCADDE end-object sentinels in the body (4-byte aligned scan).
	let endSentinelCount = 0;
	const bview = new DataView(body.buffer, body.byteOffset, body.byteLength);
	for (let off = 0; off + 4 <= body.byteLength; off += 4) {
		if (bview.getUint32(off, false) === CHECKPOINTS_END_TAG) endSentinelCount++;
	}

	const headerValid =
		version === CHECKPOINTS_VERSION &&
		beginTag === CHECKPOINTS_BEGIN_TAG;

	return { version, beginTag, bodySize, body, headerValid, endSentinelCount };
}
