// .streamtex parser — the headerless full-resolution pixel payload for a
// sibling .textures stub (PS3, big-endian; see wiki/format-streamtex.html).
//
// A .streamtex has NO magic and NO table of its own — all structure (per-texture
// gcmFormat, width, height, mip count and offset) lives in the companion
// .textures descriptor file. On its own we can only record the raw payload and
// surface it for the texture viewer, which pairs it with the stub to decode.
//
// Pure module: imports nothing but the shared texture decoders/types. Never the
// registry (acyclic rule).

import {
	decodeSurface,
	mipChainSize,
	type ParsedTextures,
	type TextureDescriptor,
	type DecodedTexture,
} from './textures';

export type ParsedStreamtex = {
	/** Always true — there is no magic; this marks a recognized payload blob. */
	headerless: true;
	/** Total payload length in bytes. */
	byteLength: number;
	/** The raw payload bytes (full file). */
	payload: Uint8Array;
};

/**
 * "Parse" a .streamtex. It is a raw payload blob, so this only records the byte
 * length and keeps a reference to the bytes. Real interpretation needs the
 * sibling .textures stub (see decodeStreamtexWithStub).
 */
export function parseStreamtex(raw: Uint8Array): ParsedStreamtex {
	return {
		headerless: true,
		byteLength: raw.byteLength,
		payload: raw,
	};
}

/**
 * Decode the textures packed in a .streamtex using its companion .textures stub.
 * The stub's FULL-RESOLUTION descriptors (the larger of each repeated CRC pair)
 * are laid out consecutively from offset 0 of the stream, each as a full mip
 * chain. Returns one DecodedTexture per full-res descriptor (top mip only).
 */
export function decodeStreamtexWithStub(
	payload: Uint8Array,
	stub: ParsedTextures,
): DecodedTexture[] {
	// Full-resolution descriptors are those with the largest dimensions per CRC.
	// A frontend stub lists each texture twice (thumb + full); pick the full set.
	const byCrc = new Map<number, TextureDescriptor>();
	for (const d of stub.descriptors) {
		const prev = byCrc.get(d.crc);
		if (!prev || d.width * d.height > prev.width * prev.height) byCrc.set(d.crc, d);
	}
	// Preserve descriptor order for the full-res entries.
	const seen = new Set<number>();
	const fullRes: TextureDescriptor[] = [];
	for (const d of stub.descriptors) {
		const chosen = byCrc.get(d.crc)!;
		if (chosen.descOff === d.descOff && !seen.has(d.crc)) {
			seen.add(d.crc);
			fullRes.push(d);
		}
	}

	const out: DecodedTexture[] = [];
	let cursor = 0;
	for (const d of fullRes) {
		const start = cursor;
		const { rgba, swizzled } = decodeSurface(payload, start, d);
		out.push({
			width: d.width,
			height: d.height,
			format: d.format,
			mips: d.mipCount,
			rgba,
			pixelStart: start,
			name: d.name,
			swizzled,
			crc: d.crc,
		});
		// Advance by the full mip chain for this texture.
		cursor += mipChainSize(d.format, d.width, d.height, d.mipCount);
		if (cursor >= payload.byteLength) break;
	}
	return out;
}
