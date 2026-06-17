// .bik registry handler — RAD Bink full-motion video.
//
// Thin wrapper around parseBik in src/lib/core/bik.ts (header metadata only).
// The decoded model routes to the bespoke BikViewer (viewport family 'video'),
// which decodes and plays the frames with the pure-TS decoder in
// src/lib/core/bink/. Read-only.

import { parseBik, formatBikFps, type ParsedBik } from '../../bik';
import type { ResourceHandler } from '../handler';

// "BIK" — the shared Bink 1 signature prefix (the 4th byte is the codec letter:
// b/d/f/g/h/i/k). Matching 3 bytes claims every Bink 1 revision; Bink 2 ("KB2*")
// is sniffed separately and reported as unsupported by the viewer.
const BIK_MAGIC = new Uint8Array([0x42, 0x49, 0x4b]);

export const bikHandler: ResourceHandler<ParsedBik> = {
	key: 'bik',
	name: 'Bink Video',
	description:
		"RAD Bink full-motion video (magic 'BIK' + codec letter, little-endian). " +
		'Self-describing header: resolution, frame count, frame-rate rational and ' +
		'embedded audio-track descriptors. Decoded and played in-browser by a pure-TS ' +
		'Bink 1 decoder — no transcoding.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.bik'],
	magic: BIK_MAGIC,
	wikiUrl: 'format-bik.html',

	parseRaw: (raw) => parseBik(raw),

	describe: (m) => {
		if (m.isBink2) return `Bink 2 (${m.fourCC}) — ${m.width}x${m.height} (decode unsupported)`;
		const dur = m.durationSeconds.toFixed(1);
		const audio =
			m.numAudioTracks === 0
				? 'no audio'
				: `${m.numAudioTracks} audio track${m.numAudioTracks === 1 ? '' : 's'}`;
		return `${m.fourCC} ${m.width}x${m.height} · ${formatBikFps(m)} fps · ${m.numFrames} frames (${dur}s) · ${audio}`;
	},

	fixtures: [
		{ file: 'Movies/Intro.bik', expect: { parseOk: true } },
		{ file: 'Movies/SS_Ident.bik', expect: { parseOk: true } },
	],
};
