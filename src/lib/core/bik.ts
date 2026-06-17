// .bik (RAD Bink) container header parser — metadata only.
//
// Bink is the full-motion-video middleware for Split/Second; all 29 movies live
// in Deferred/Movies/ as the classic BIKi (Bink 1) container. This module decodes
// just the self-describing fixed header + per-track audio descriptor block, which
// is enough for the Inspector summary and for routing to the video viewport. The
// actual frame bitstream is decoded by src/lib/core/bink/binkVideo.ts.
//
// IMPORTANT: unlike the rest of Split/Second (PS3 big-endian), the Bink container
// is LITTLE-ENDIAN even on PS3 — RAD's runtime byte-swaps internally. Every
// multi-byte field below is read little-endian. The byte layout matches the
// verified offsets in public/wiki/format-bik.html.
//
// Pure module: no React, no registry imports.

/** Bink audio flag bits (high 16 of the per-track audio_props word). */
const AUD_16BITS = 0x4000;
const AUD_STEREO = 0x2000;
const AUD_DCT = 0x1000;

const VIDEO_FLAG_ALPHA = 0x00100000;

export type BikAudioTrack = {
	index: number;
	/** Largest audio packet, bytes (sizes the per-track decode buffer). */
	maxPacketSize: number;
	sampleRate: number;
	/** Raw 16-bit audio flag word. */
	flags: number;
	channels: number;
	bitsPerSample: number;
	algorithm: 'DCT' | 'RDFT';
	trackId: number;
};

export type ParsedBik = {
	/** Always "BIK" for the formats here. */
	signature: string;
	/** Codec revision letter, e.g. 'i'. */
	version: string;
	/** Full four-character FourCC, e.g. "BIKi". */
	fourCC: string;
	/** True for the KB2* Bink 2 container (not decodable here). */
	isBink2: boolean;
	/** file_size field (on-disk size minus 8). */
	fileSizeField: number;
	numFrames: number;
	largestFrameSize: number;
	width: number;
	height: number;
	fpsDividend: number;
	fpsDivisor: number;
	/** Effective frames per second (dividend / divisor). */
	fps: number;
	/** Duration in seconds (numFrames * divisor / dividend). */
	durationSeconds: number;
	videoFlags: number;
	hasAlpha: boolean;
	numAudioTracks: number;
	audioTracks: BikAudioTrack[];
	/** Byte offset where the frame-offset table begins (end of the header). */
	headerSize: number;
};

function isBik(raw: Uint8Array): boolean {
	return raw.length >= 4 && raw[0] === 0x42 && raw[1] === 0x49 && raw[2] === 0x4b; // "BIK"
}

function isKb2(raw: Uint8Array): boolean {
	return raw.length >= 3 && raw[0] === 0x4b && raw[1] === 0x42 && raw[2] === 0x32; // "KB2"
}

export function parseBik(raw: Uint8Array): ParsedBik {
	if (raw.length < 4) {
		throw new Error(`bik: ${raw.length} bytes is too small for a FourCC`);
	}

	const bink2 = isKb2(raw);
	if (!isBik(raw) && !bink2) {
		const tag = String.fromCharCode(raw[0], raw[1], raw[2], raw[3] ?? 0x3f);
		throw new Error(`bik: not a Bink file (FourCC '${tag}')`);
	}

	if (raw.length < 44) {
		throw new Error(`bik: ${raw.length} bytes is too small for the 44-byte header`);
	}

	const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	const version = String.fromCharCode(raw[3]);
	const signature = bink2 ? 'KB2' : 'BIK';
	const fourCC = signature + version;

	const fileSizeField = dv.getUint32(0x04, true) >>> 0;
	const numFrames = dv.getUint32(0x08, true) >>> 0;
	const largestFrameSize = dv.getUint32(0x0c, true) >>> 0;
	// 0x10 = num_frames again (loop bound) — skipped.
	const width = dv.getUint32(0x14, true) >>> 0;
	const height = dv.getUint32(0x18, true) >>> 0;
	const fpsDividend = dv.getUint32(0x1c, true) >>> 0;
	const fpsDivisor = dv.getUint32(0x20, true) >>> 0;
	const videoFlags = dv.getUint32(0x24, true) >>> 0;
	const numAudioTracks = dv.getUint32(0x28, true) >>> 0;

	const fps = fpsDivisor ? fpsDividend / fpsDivisor : 0;
	const durationSeconds = fpsDividend ? (numFrames * fpsDivisor) / fpsDividend : 0;

	const audioTracks: BikAudioTrack[] = [];
	let p = 0x2c;
	if (numAudioTracks > 0) {
		const maxPackets: number[] = [];
		for (let i = 0; i < numAudioTracks; i++) {
			maxPackets.push(dv.getUint32(p, true) >>> 0);
			p += 4;
		}
		const props: number[] = [];
		for (let i = 0; i < numAudioTracks; i++) {
			props.push(dv.getUint32(p, true) >>> 0);
			p += 4;
		}
		for (let i = 0; i < numAudioTracks; i++) {
			const word = props[i];
			const sampleRate = word & 0xffff;
			const flags = (word >>> 16) & 0xffff;
			audioTracks.push({
				index: i,
				maxPacketSize: maxPackets[i],
				sampleRate,
				flags,
				channels: flags & AUD_STEREO ? 2 : 1,
				bitsPerSample: flags & AUD_16BITS ? 16 : 8,
				algorithm: flags & AUD_DCT ? 'DCT' : 'RDFT',
				trackId: dv.getUint32(p, true) >>> 0,
			});
			p += 4;
		}
	}

	return {
		signature,
		version,
		fourCC,
		isBink2: bink2,
		fileSizeField,
		numFrames,
		largestFrameSize,
		width,
		height,
		fpsDividend,
		fpsDivisor,
		fps,
		durationSeconds,
		videoFlags,
		hasAlpha: (videoFlags & VIDEO_FLAG_ALPHA) !== 0,
		numAudioTracks,
		audioTracks,
		headerSize: p,
	};
}

/** Format the frame rate compactly, e.g. "30", "29.97". */
export function formatBikFps(m: Pick<ParsedBik, 'fps'>): string {
	const r = Math.round(m.fps * 100) / 100;
	return Number.isInteger(r) ? String(r) : r.toFixed(2);
}
