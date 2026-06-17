// .highlighttags parser/writer — Split/Second HUD highlight-marker table.
//
// Ported faithfully from wiki/format-highlighttags.html. Unlike most level data
// this file is PLAINTEXT XML (UTF-8/ASCII): one file per level, named after the
// level (e.g. Downtown/Downtown.highlighttags). It lists the on-screen highlight
// markers the HUD draws over powerplay locations.
//
//   <Root FileVersion="2.0000000">                       (self-closing when empty)
//     <HighlightTag id="<int>.<int>" idCRC="0x…" icon="0" relative_transform="true|false">
//        <transformation>
//           <Row0 X= Y= Z=/>   3x3 basis (row-major)
//           <Row1 X= Y= Z=/>
//           <Row2 X= Y= Z=/>
//           <Row3 X= Y= Z=/>   translation (marker position)
//        </transformation>
//        <Powerplay id="<int>.<int>" idCRC="0x…"/>        linked powerplay
//     </HighlightTag>
//     …
//   </Root>
//
// Because it is text, the byte-exact round-trip is achieved the same way as the
// sibling .xml/.powerplays/.triggers handlers: the verbatim source string is kept
// in the model and the writer re-emits it untouched. On top of that verbatim
// layer this module decodes the typed HighlightTag records and surfaces
// world-space points (Row3 translations) so a World viewport can render the
// markers as positioned indicators rather than raw text.
//
// Pure module: imports ONLY the shared XML parser (also pure), never the registry.

import {
	parseXmlResource,
	writeXmlResource,
	type ParsedXml,
	type XmlNode,
} from './xmlResource';

/** A 4x3 affine transform: 3x3 basis (row-major) + a translation row. */
export type Transform4x3 = {
	/** Nine basis floats, row-major (Row0..Row2). */
	basis: number[];
	/** Row3 translation: marker position [x, y, z]. */
	translation: [number, number, number];
};

export type PowerplayRef = {
	/** Two-part Catnip object id, e.g. "1239805449.2". */
	id: string;
	/** 32-bit CRC of the id as a 0x-prefixed string, e.g. "0x13887213". */
	idCRC: string;
};

export type HighlightTag = {
	/** Two-part Catnip object id, e.g. "1263809359.-611452811". */
	id: string;
	/** 32-bit CRC of the id as a 0x-prefixed string. */
	idCRC: string;
	/** HUD icon index (always 0 in the shipped build). */
	icon: number;
	/** true = transform relative to linked powerplay; false = absolute world. */
	relativeTransform: boolean;
	/** 4x3 marker placement. */
	transform: Transform4x3;
	/** The powerplay this marker highlights (omitted if absent). */
	powerplay?: PowerplayRef;
};

export type ParsedHighlightTags = {
	/** Root @FileVersion attribute, e.g. "2.0000000". */
	fileVersion: string;
	/** Decoded markers in document order. */
	tags: HighlightTag[];
	/** Convenience: number of markers (== tags.length). */
	count: number;
	/**
	 * World-space marker positions (Row3 translations), one [x,y,z] per tag, in
	 * document order. A World viewport draws these as instanced points / labels.
	 * (For relative_transform="true" tags these are offsets from the linked
	 * powerplay, not absolute world coords — surfaced as-is for overlay use.)
	 */
	points: [number, number, number][];
	/** The underlying parsed XML tree (full fidelity for tree/inspector views). */
	xml: ParsedXml;
};

function parseFloat3(node: XmlNode | undefined): [number, number, number] {
	if (!node) return [0, 0, 0];
	return [
		Number(node.attrs.X ?? 0),
		Number(node.attrs.Y ?? 0),
		Number(node.attrs.Z ?? 0),
	];
}

function decodeTag(node: XmlNode): HighlightTag {
	const transformNode = node.children.find((c) => c.tag === 'transformation');
	const rows = ['Row0', 'Row1', 'Row2', 'Row3'].map((t) =>
		transformNode?.children.find((c) => c.tag === t),
	);
	const [r0, r1, r2] = rows.map(parseFloat3);
	const translation = parseFloat3(rows[3]);
	const basis = [...r0, ...r1, ...r2];

	const ppNode = node.children.find((c) => c.tag === 'Powerplay');
	const powerplay: PowerplayRef | undefined = ppNode
		? { id: ppNode.attrs.id ?? '', idCRC: ppNode.attrs.idCRC ?? '' }
		: undefined;

	return {
		id: node.attrs.id ?? '',
		idCRC: node.attrs.idCRC ?? '',
		icon: Number(node.attrs.icon ?? 0),
		relativeTransform: node.attrs.relative_transform === 'true',
		transform: { basis, translation },
		powerplay,
	};
}

export function parseHighlightTags(raw: Uint8Array | string): ParsedHighlightTags {
	const xml = parseXmlResource(raw);
	const root = xml.root;
	if (!root || root.tag !== 'Root') {
		throw new Error(
			`highlighttags: expected <Root>, got <${root?.tag ?? '(none)'}>`,
		);
	}
	const fileVersion = root.attrs.FileVersion ?? '';
	const tagNodes = root.children.filter((c) => c.tag === 'HighlightTag');
	const tags = tagNodes.map(decodeTag);
	const points = tags.map((t) => t.transform.translation);
	return { fileVersion, tags, count: tags.length, points, xml };
}

/**
 * Text-preserving writer: re-emit the verbatim source bytes. The decoded `tags`
 * are a read-only projection over the same XML tree, so the byte-exact guarantee
 * comes for free from the shared XML writer.
 */
export function writeHighlightTags(model: ParsedHighlightTags): Uint8Array {
	return writeXmlResource(model.xml);
}
