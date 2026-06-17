// .deform parser — Black Rock's per-vehicle damage/deformation cage (DFM2).
//
// Custom Black Rock binary, big-endian (PS3), NOT a Havok packfile. Magic
// "DFM" + version 0x02 (the 32-bit magic is 0x44464D02). Layout per the RE wiki
// (wiki/format-deform.html), cross-checked against all 46 real files:
//
//   0x00  char[3]+u8  magic         "DFM" + 0x02
//   0x04  u32         vertexCount A  CONFIRMED: 0x20 + A*16 = end of vertex array
//   0x08  u32         countB         ~vertexCount (deformable subset)        Theory
//   0x0C  u32         edgeCount C    spring/edge element count               Theory
//   0x10  u32         partGroupCount D  CONFIRMED: D * 100 = named-record block
//   0x14  u32         countE         sections / deformer-plane count         Theory
//   0x18  u32         countF         0 chassis / small body                  Theory
//   0x1C  u32         countG         0 chassis / 1 body (footer present)     Theory
//   0x20  vec4[A]     vertices       homogeneous (x,y,z,w=1.0) BE float32    CONFIRMED
//   ...   index + 10-byte spring records (restLen f32, u8 u8, u16 u16)       Theory
//   ...   D * 100-byte named part-group records (name, hash, ranges, weights) CONFIRMED stride
//   body files only: chassis-name C-string + 3 LE float32 scale footer
//
// DECODED with confidence: the header, the 16-byte big-endian vertex cage, the
// 100-byte part-group records (sized by D, ending the block right before the
// body-file footer) and the chassis-link footer. The spring/edge INTERIOR
// (between the vertex cage and the part-group block) is wiki-Theory, so it is
// preserved as a verbatim byte span. For a guaranteed byte-exact round-trip the
// entire region after the vertex cage is also retained verbatim (`tail`) — the
// part-group names and footer are read-only descriptive overlays computed from
// it, never re-encoded structurally. This makes writeRaw byte-exact regardless
// of the still-Theory interior layout.
//
// Pure module: binary helpers only, never the registry.

import { BinReader } from './binary/BinReader';
import { BinWriter } from './binary/BinWriter';

export const DEFORM_MAGIC = new Uint8Array([0x44, 0x46, 0x4d, 0x02]); // "DFM" v2

/** One homogeneous deformable vertex (big-endian float32 vec4, w == 1.0). */
export type DeformVertex = { x: number; y: number; z: number; w: number };

/** A named rigid part-group record (100-byte stride, name recovered). */
export type DeformPartGroup = {
	/** Null-terminated part-group name, e.g. "HUB_FR", "CHASSIS_FRONT". */
	name: string;
	/** Absolute file offset of the 100-byte record. */
	offset: number;
};

export type DeformHeader = {
	version: number;
	/** Field A — number of deformable vertices (CONFIRMED). */
	vertexCount: number;
	/** Field B — ~vertexCount (Theory). */
	countB: number;
	/** Field C — spring/edge element count (Theory). */
	edgeCount: number;
	/** Field D — named rigid part-group count (CONFIRMED). */
	partGroupCount: number;
	/** Field E — sections / deformer-plane count (Theory). */
	countE: number;
	/** Field F — 0 for chassis, small for body files (Theory). */
	countF: number;
	/** Field G — 0 for chassis, 1 for body files / footer present (Theory). */
	countG: number;
};

export type ParsedDeform = {
	header: DeformHeader;
	vertices: DeformVertex[];
	/**
	 * Everything after the vertex cage (springs + index data + part-group block
	 * + footer) preserved VERBATIM. The writer replays this for a byte-exact
	 * round-trip. Decoded overlays below are derived from it, read-only.
	 */
	tail: Uint8Array;
	/** Byte range [start,end) of the index+spring section (between verts and part-groups). Theory interior. */
	springSection: { offset: number; length: number };
	/** Named part-group records recovered from the trailing 100-byte stride. */
	partGroups: DeformPartGroup[];
	/** Body files only: the chassis the cage binds to (from the footer C-string). */
	chassisLink?: string;
	/** Body files only: the three footer scale floats (stored little-endian — exporter quirk). */
	footerScale?: [number, number, number];
	/** True if a chassis-link footer was present (body file). */
	hasFooter: boolean;
	byteLength: number;
};

const PART_GROUP_STRIDE = 100; // 0x64, CONFIRMED by walking Coupe.deform

function checkMagic(raw: Uint8Array): void {
	if (raw.byteLength < 0x20) {
		throw new Error(`deform: too small (${raw.byteLength} bytes, need >= 32 for header)`);
	}
	for (let i = 0; i < 4; i++) {
		if (raw[i] !== DEFORM_MAGIC[i]) {
			const got = [...raw.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
			throw new Error(`deform: bad magic ${got} (expected 44 46 4d 02 "DFM" v2)`);
		}
	}
}

/** Read a name from a 100-byte part-group record (NUL-terminated, printable). */
function readPartGroupName(raw: Uint8Array, offset: number): string {
	let end = offset;
	const limit = Math.min(offset + 0x20, raw.byteLength);
	while (end < limit && raw[end] !== 0) {
		// stop on non-printable to avoid swallowing binary fields
		if (raw[end] < 0x20 || raw[end] > 0x7e) break;
		end++;
	}
	return new TextDecoder('latin1').decode(raw.subarray(offset, end));
}

export function parseDeform(raw: Uint8Array): ParsedDeform {
	checkMagic(raw);
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);

	r.skip(3); // "DFM"
	const version = r.readU8(); // 0x02
	const header: DeformHeader = {
		version,
		vertexCount: r.readU32(),
		countB: r.readU32(),
		edgeCount: r.readU32(),
		partGroupCount: r.readU32(),
		countE: r.readU32(),
		countF: r.readU32(),
		countG: r.readU32(),
	};

	// Section 1 — deformable vertex cage. CONFIRMED: 0x20 + A*16 = array end.
	const vertexStart = 0x20;
	const vertexEnd = vertexStart + header.vertexCount * 16;
	if (vertexEnd > raw.byteLength) {
		throw new Error(
			`deform: vertex array (${header.vertexCount} verts) overruns file ` +
				`(end 0x${vertexEnd.toString(16)} > 0x${raw.byteLength.toString(16)})`,
		);
	}
	const vertices: DeformVertex[] = new Array(header.vertexCount);
	r.seek(vertexStart);
	for (let i = 0; i < header.vertexCount; i++) {
		vertices[i] = { x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() };
	}

	// Everything after the vertex cage, kept verbatim for the byte-exact writer.
	const tail = raw.slice(vertexEnd);

	// Section 3 — named part-group block (D * 100 bytes). On body files a short
	// chassis-link footer follows; on chassis files it runs to EOF. CONFIRMED
	// 100-byte stride; on body files the block ends exactly where the footer
	// (chassis name C-string) begins.
	const partGroupBlockLen = header.partGroupCount * PART_GROUP_STRIDE;
	const hasFooter = header.countG !== 0 || header.countF !== 0;
	let partGroupStart: number;
	if (!hasFooter) {
		// chassis: block ends exactly at EOF.
		partGroupStart = raw.byteLength - partGroupBlockLen;
	} else {
		// body: footer follows the block; locate the block by scanning back from
		// EOF for the last plausible printable part-group name on the 100-byte grid.
		partGroupStart = locatePartGroupBlock(raw, header.partGroupCount, vertexEnd);
	}

	const partGroups: DeformPartGroup[] = [];
	if (
		partGroupStart >= vertexEnd &&
		partGroupStart + partGroupBlockLen <= raw.byteLength
	) {
		for (let i = 0; i < header.partGroupCount; i++) {
			const off = partGroupStart + i * PART_GROUP_STRIDE;
			partGroups.push({ name: readPartGroupName(raw, off), offset: off });
		}
	}

	// Section 2 — index + spring data lives between the vertex cage and the
	// part-group block. Exposed as a byte range; interior is wiki-Theory.
	const springEnd = partGroupStart >= vertexEnd ? partGroupStart : raw.byteLength;
	const springSection = { offset: vertexEnd, length: Math.max(0, springEnd - vertexEnd) };

	// Footer — chassis link (body files): C-string + 3 LE float32 after the block.
	let chassisLink: string | undefined;
	let footerScale: [number, number, number] | undefined;
	if (hasFooter && partGroups.length === header.partGroupCount && partGroupStart >= vertexEnd) {
		const footerStart = partGroupStart + partGroupBlockLen;
		if (footerStart < raw.byteLength) {
			chassisLink = readPartGroupName(raw, footerStart) || undefined;
			// Trailing scale triple is stored little-endian (exporter quirk).
			if (raw.byteLength >= 12) {
				const le = new DataView(
					raw.buffer.slice(raw.byteLength - 12 + raw.byteOffset, raw.byteOffset + raw.byteLength),
				);
				footerScale = [le.getFloat32(0, true), le.getFloat32(4, true), le.getFloat32(8, true)];
			}
		}
	}

	return {
		header,
		vertices,
		tail,
		springSection,
		partGroups,
		chassisLink,
		footerScale,
		hasFooter,
		byteLength: raw.byteLength,
	};
}

/**
 * Re-encode a parsed .deform byte-for-byte: header (8 BE u32 words after the
 * magic) + the decoded vertex cage + the verbatim tail (springs, part-groups,
 * footer). Byte-exact because the cage rewrites the same float bits and the
 * still-Theory interior is replayed unchanged.
 */
export function writeDeform(model: ParsedDeform): Uint8Array {
	const w = new BinWriter(0x20 + model.vertices.length * 16 + model.tail.length, false);
	w.writeBytes(DEFORM_MAGIC);
	w.writeU32(model.header.vertexCount >>> 0);
	w.writeU32(model.header.countB >>> 0);
	w.writeU32(model.header.edgeCount >>> 0);
	w.writeU32(model.header.partGroupCount >>> 0);
	w.writeU32(model.header.countE >>> 0);
	w.writeU32(model.header.countF >>> 0);
	w.writeU32(model.header.countG >>> 0);
	for (const v of model.vertices) {
		w.writeF32(v.x);
		w.writeF32(v.y);
		w.writeF32(v.z);
		w.writeF32(v.w);
	}
	w.writeBytes(model.tail);
	return w.bytes.slice();
}

/**
 * Locate the D-record part-group block in a body file by scanning the 100-byte
 * grid backward from EOF for the first offset whose record reads as a printable
 * name and whose D-1 successors also do. Falls back to the EOF-anchored guess.
 */
function locatePartGroupBlock(raw: Uint8Array, count: number, minStart: number): number {
	const blockLen = count * PART_GROUP_STRIDE;
	const maxStart = raw.byteLength - blockLen;
	for (let start = maxStart; start >= minStart; start--) {
		// quick filter: the first byte must be a printable uppercase-ish name char
		const c = raw[start];
		if (c < 0x41 || c > 0x5a) continue; // names begin with A-Z (CHASSIS_, HUB_, …)
		let ok = true;
		for (let i = 0; i < count; i++) {
			const off = start + i * PART_GROUP_STRIDE;
			const name = readPartGroupName(raw, off);
			if (name.length === 0 || !/^[A-Za-z]/.test(name)) {
				ok = false;
				break;
			}
		}
		if (ok) return start;
	}
	return Math.max(minStart, maxStart);
}
