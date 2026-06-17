// Havok 5.5.0 binary packfile parser (container + __data__ geometry + __types__
// reflection).
//
// Every Split/Second physics asset (.phys, .mainColl, .hkColl, .hkPPs,
// .hkRBs) is a stock Havok packfile (`hkPackfileWriter` serialization) with
// magic 0x57E0E057. This module decodes:
//
//   - the two file signatures + the fixed hkPackfileHeader,
//   - the section table (__classnames__ / __types__ / __data__) — each a
//     0x30-byte hkPackfileSectionHeader,
//   - the __classnames__ registry (4-byte signature + 0x09 + NUL string),
//   - the three per-section fixup tables (local / global / virtual) — the
//     virtual table is the master object→class index; the local table resolves
//     in-section pointers (hkArray data, char*),
//   - the __types__ class reflection (hkClass.name + declaredMembers[] each
//     {name, type, offset}) for the registered classes,
//   - COLLISION GEOMETRY from the __data__ object graph:
//       * hkpConvexVerticesShape -> rotatedVertices (SIMD FourVectors, SoA) =
//         real per-hull vertices (vehicle .mainColl / .phys). Triangulated into
//         a renderable convex-hull mesh.
//       * hkpExtendedMeshShape   -> trianglesSubpart metadata + AABB box (level
//         .hkColl). NOTE: the triangle vertex/index buffers themselves are
//         SERIALIZE_IGNORED in this devkit build (vertexBase/indexBase are not
//         written to disk), so only the AABB box + subpart stats are recovered;
//         no triangle coordinates exist in the file to extract.
//   - key physics fields (hkpMaterial friction/restitution, hkpMotion mass)
//     where present, read via the __types__ member offsets.
//
// The returned model carries `meshes: { positions, indices }[]` (the shape the
// MeshViewer consumes) plus `shapes[]` and `fields[]` for describe()/inspection.
//
// Byte layout verified against the RE wiki (wiki/format-havok.html,
// format-hkcoll.html, format-phys.html), the .hkCollXml twins (used as the
// schema reference for member offsets), AND real devkit samples
// (Musclecar_01.phys/.mainColl, Downtown/Subtracks tl.hkColl, Common cl.hkColl).
//
// All multi-byte values are BIG-ENDIAN (PS3 PPC). This module is pure: it
// imports only the binary helpers and NEVER the registry (acyclic rule).

import { BinReader } from './binary/BinReader';

/** Havok packfile signatures (constant across every Split/Second sample). */
export const HAVOK_MAGIC0 = 0x57e0e057;
export const HAVOK_MAGIC1 = 0x10c0c010;

/** A single entry in the __classnames__ registry. */
export type HavokClassName = {
	/** 4-byte type signature / hash (big-endian). */
	signature: number;
	/** The class name string (e.g. "hkpPhysicsSystem"). */
	name: string;
	/** Byte offset of the NAME (after the 0x09 separator) within __classnames__. */
	offset: number;
};

/** One 0x30-byte hkPackfileSectionHeader. */
export type HavokSection = {
	/** Section tag: "__classnames__", "__types__" or "__data__". */
	tag: string;
	/** Padding/sentinel word (0x000000FF in every Split/Second sample). */
	nullByte: number;
	/** Absolute file offset where this section's payload begins. */
	absoluteDataStart: number;
	/** Offset (relative to absoluteDataStart) of the local fixup table. */
	localFixupsOffset: number;
	/** Offset of the global (cross-section) fixup table. */
	globalFixupsOffset: number;
	/** Offset of the virtual fixup table (object -> classname binding). */
	virtualFixupsOffset: number;
	/** Offset of the named-export table (unused -> equals endOffset). */
	exportsOffset: number;
	/** Offset of the import table (unused -> equals endOffset). */
	importsOffset: number;
	/** Total section length (relative to absoluteDataStart). */
	endOffset: number;
	/** Convenience: payload byte length (== endOffset). */
	size: number;
};

/** The fixed hkPackfileHeader. */
export type HavokHeader = {
	magic0: number;
	magic1: number;
	userTag: number;
	fileVersion: number;
	/** Raw 4-byte layout rules: [bytesInPointer, littleEndian, reusePadding, emptyBaseClass]. */
	layoutRules: [number, number, number, number];
	pointerSize: number;
	/** True when layoutRules[1] !== 0. Always false for Split/Second (PS3 BE). */
	littleEndian: boolean;
	numSections: number;
	contentsSectionIndex: number;
	contentsSectionOffset: number;
	contentsClassNameSectionIndex: number;
	contentsClassNameSectionOffset: number;
	/** NUL-terminated version banner, e.g. "Havok-5.5.0-r1". */
	contentsVersion: string;
};

/** One reflected class member (from __types__): name + on-disk byte offset + type. */
export type HavokMember = {
	name: string;
	/** Havok TYPE_* enum value (e.g. 11 = TYPE_REAL/float, 24 = TYPE_ENUM). */
	type: number;
	/** Byte offset of the member within its object (per the reflection). */
	offset: number;
};

/** One reflected class (from __types__): its name and declared members. */
export type HavokClass = {
	name: string;
	objectSize: number;
	members: HavokMember[];
};

/** A decoded collision submesh — the shape MeshViewer renders. */
export type HavokMesh = {
	/** Flat float positions [x0,y0,z0, x1,y1,z1, …] in shape-local space. */
	positions: number[];
	/** Triangle-list indices (convex-hull triangulation, or AABB box faces). */
	indices: number[];
	/** Vertex count (positions.length / 3). */
	vertexCount: number;
};

/** A decoded collision shape from the __data__ object graph. */
export type HavokShape = {
	/** Havok class name, e.g. 'hkpConvexVerticesShape' / 'hkpExtendedMeshShape'. */
	className: string;
	/** Data-section-relative offset of the object. */
	offset: number;
	/** Optional human label (the named-variant string for vehicle hulls). */
	name?: string;
	/** Vertex count when known (convex hull numVertices, or mesh subpart sum). */
	numVertices?: number;
	/** Triangle count when known (extended-mesh subpart sum). */
	numTriangles?: number;
	/** Number of triangle subparts (extended mesh only). */
	subpartCount?: number;
	/** AABB half-extents (extended mesh / convex hull), shape-local. */
	aabbHalfExtents?: [number, number, number];
	/** AABB center, shape-local. */
	aabbCenter?: [number, number, number];
	/** The renderable mesh for this shape (convex hull, or AABB box fallback). */
	mesh?: HavokMesh;
	/**
	 * True when this shape's geometry is fully recovered (convex hull vertices).
	 * False when only metadata + an AABB box is available (extended mesh —
	 * triangle buffers are SERIALIZE_IGNORED and absent from the file).
	 */
	geometryComplete: boolean;
};

/** A surfaced scalar physics field (read via __types__ member offsets). */
export type HavokField = {
	/** Owning class, e.g. 'hkpMaterial'. */
	className: string;
	/** Member name, e.g. 'friction'. */
	name: string;
	/** Decoded value. */
	value: number;
};

/** Parsed model returned by parseHavok. */
export type ParsedHavok = {
	header: HavokHeader;
	sections: HavokSection[];
	classNames: HavokClassName[];
	/** Resolved name of the top-level object's class, or undefined if unresolvable. */
	rootClassName?: string;
	/** Reflected classes from __types__ (name + member offsets). Empty if absent. */
	types: HavokClass[];
	/** Collision shapes recovered from __data__ (in object order). */
	shapes: HavokShape[];
	/** Renderable collision meshes (the shape MeshViewer consumes). */
	meshes: HavokMesh[];
	/** Surfaced scalar physics fields (friction/restitution/mass) where present. */
	fields: HavokField[];
	/**
	 * True when at least one mesh carries real recovered vertices (convex hulls).
	 * False for level .hkColl whose triangle buffers are not serialized.
	 */
	hasGeometry: boolean;
	/** Total file size in bytes. */
	fileSize: number;
};

function readLayoutRules(buf: ArrayBuffer, at: number): [number, number, number, number] {
	const b = new Uint8Array(buf, at, 4);
	return [b[0], b[1], b[2], b[3]];
}

/**
 * Parse a Havok packfile container. Throws if the magic is wrong or the header
 * is structurally impossible (truncated, absurd section count).
 */
export function parseHavok(raw: Uint8Array): ParsedHavok {
	// Slice to this member's window — extractResourceRaw may hand back a view
	// over a larger buffer (the whole .ark / file). `.slice()` always yields a
	// fresh standalone ArrayBuffer.
	const buf: ArrayBuffer = raw.buffer.slice(
		raw.byteOffset,
		raw.byteOffset + raw.byteLength,
	) as ArrayBuffer;
	const fileSize = buf.byteLength;
	const r = new BinReader(buf, false /* big-endian */);

	if (fileSize < 0x40) {
		throw new Error(`havok: file too small (${fileSize} bytes) for a packfile header`);
	}

	const magic0 = r.readU32();
	const magic1 = r.readU32();
	if (magic0 !== HAVOK_MAGIC0 || magic1 !== HAVOK_MAGIC1) {
		throw new Error(
			`havok: bad magic 0x${magic0.toString(16)} 0x${magic1.toString(16)} ` +
				`(expected 0x57e0e057 0x10c0c010)`,
		);
	}

	const userTag = r.readI32();
	const fileVersion = r.readI32();
	const layoutRules = readLayoutRules(buf, 0x10);
	r.skip(4); // layoutRules already read as bytes
	const pointerSize = layoutRules[0];
	const littleEndian = layoutRules[1] !== 0;
	const numSections = r.readI32();
	const contentsSectionIndex = r.readI32();
	const contentsSectionOffset = r.readI32();
	const contentsClassNameSectionIndex = r.readI32();
	const contentsClassNameSectionOffset = r.readI32();

	if (numSections < 0 || numSections > 256) {
		throw new Error(`havok: implausible numSections ${numSections}`);
	}

	// contentsVersion: NUL-terminated banner at 0x28, then 0xFF padding to the
	// next 16-byte boundary; the section table begins at the first such boundary
	// at or after the NUL. The wiki fixes this at 0x40 for the SS samples.
	r.seek(0x28);
	const contentsVersion = r.readCString();

	const header: HavokHeader = {
		magic0,
		magic1,
		userTag,
		fileVersion,
		layoutRules,
		pointerSize,
		littleEndian,
		numSections,
		contentsSectionIndex,
		contentsSectionOffset,
		contentsClassNameSectionIndex,
		contentsClassNameSectionOffset,
		contentsVersion,
	};

	// Section headers begin at 0x40, each 0x30 bytes.
	const SECTION_TABLE_START = 0x40;
	const SECTION_STRIDE = 0x30;
	const sections: HavokSection[] = [];
	for (let i = 0; i < numSections; i++) {
		const base = SECTION_TABLE_START + i * SECTION_STRIDE;
		if (base + SECTION_STRIDE > fileSize) {
			throw new Error(
				`havok: section header ${i} at 0x${base.toString(16)} runs past EOF`,
			);
		}
		r.seek(base);
		const tag = r.readFixedString(0x10);
		const nullByte = r.readU32();
		const absoluteDataStart = r.readU32();
		const localFixupsOffset = r.readU32();
		const globalFixupsOffset = r.readU32();
		const virtualFixupsOffset = r.readU32();
		const exportsOffset = r.readU32();
		const importsOffset = r.readU32();
		const endOffset = r.readU32();
		sections.push({
			tag,
			nullByte,
			absoluteDataStart,
			localFixupsOffset,
			globalFixupsOffset,
			virtualFixupsOffset,
			exportsOffset,
			importsOffset,
			endOffset,
			size: endOffset,
		});
	}

	// __classnames__ registry. Find it by tag (falls back to header index).
	const classNames: HavokClassName[] = [];
	let cnSection = sections.find((s) => s.tag === '__classnames__');
	if (!cnSection && contentsClassNameSectionIndex < sections.length) {
		cnSection = sections[contentsClassNameSectionIndex];
	}
	if (cnSection) {
		const start = cnSection.absoluteDataStart;
		const end = Math.min(start + cnSection.endOffset, fileSize);
		// Entry = 4-byte signature + 0x09 separator + NUL-terminated name.
		// Padding bytes (0xFF) after the last entry terminate the scan.
		r.seek(start);
		while (r.position + 5 <= end) {
			const peek = r.position;
			// 0xFFFFFFFF or trailing padding marks the end of real entries.
			const sig = r.readU32();
			if (sig === 0xffffffff) break;
			const sep = r.readU8();
			if (sep !== 0x09) {
				// Not a valid entry boundary — stop (likely padding/garbage).
				r.seek(peek);
				break;
			}
			const nameOffset = r.position; // offset of the name, after 0x09
			const name = r.readCString();
			if (name.length === 0) break;
			classNames.push({ signature: sig, name, offset: nameOffset });
		}
	}

	// Resolve the root object's class name by following
	// contentsClassNameSectionIndex/Offset into __classnames__.
	let rootClassName: string | undefined;
	const rootSection = sections[contentsClassNameSectionIndex];
	if (rootSection) {
		const abs = rootSection.absoluteDataStart + contentsClassNameSectionOffset;
		if (abs >= 0 && abs < fileSize) {
			r.seek(abs);
			const name = r.readCString();
			if (name.length > 0) rootClassName = name;
		}
	}

	// --- Deep decode: __types__ reflection + __data__ collision geometry. -----
	// Guarded: a structural surprise in the object graph must never sink the
	// container-level parse (which is rock-solid). On any error we fall back to
	// empty geometry and let describe()/the viewer report "metadata only".
	let types: HavokClass[] = [];
	let shapes: HavokShape[] = [];
	let meshes: HavokMesh[] = [];
	let fields: HavokField[] = [];
	try {
		const dv = new DataView(buf);
		const typesSection = sections.find((s) => s.tag === '__types__');
		const dataSection = sections.find((s) => s.tag === '__data__');
		const cnForData = sections.find((s) => s.tag === '__classnames__');
		if (typesSection) {
			types = parseTypes(dv, buf, typesSection, fileSize);
		}
		if (dataSection && cnForData) {
			const res = parseData(dv, buf, dataSection, cnForData, types, fileSize);
			shapes = res.shapes;
			meshes = res.meshes;
			fields = res.fields;
		}
	} catch {
		// keep the container parse; geometry stays empty (honest partial)
	}

	// hasGeometry = real recovered geometry (convex-hull vertices), NOT the
	// synthetic AABB box a level extended-mesh falls back to. Honest signal so
	// the viewer/describe() don't overstate level .hkColl coverage.
	const hasGeometry = shapes.some((s) => s.geometryComplete && (s.mesh?.positions.length ?? 0) >= 9);

	return {
		header,
		sections,
		classNames,
		rootClassName,
		types,
		shapes,
		meshes,
		fields,
		hasGeometry,
		fileSize,
	};
}

// ---------------------------------------------------------------------------
// Fixup tables + reflection + geometry (the __types__/__data__ deep decode)
// ---------------------------------------------------------------------------

/**
 * Build the local-fixup map for a section: source-offset → destination-offset,
 * both relative to the section's absoluteDataStart. The table is a run of
 * (uint32 srcOffset, uint32 dstOffset) pairs from localFixupsOffset to
 * globalFixupsOffset; 0xFFFFFFFF marks an empty slot. Verified against
 * Musclecar_01.mainColl and tl.hkColl.
 */
function buildLocalFixups(
	dv: DataView,
	section: HavokSection,
	fileSize: number,
): Map<number, number> {
	const map = new Map<number, number>();
	const start = section.absoluteDataStart + section.localFixupsOffset;
	const end = Math.min(section.absoluteDataStart + section.globalFixupsOffset, fileSize);
	for (let o = start; o + 8 <= end; o += 8) {
		const src = dv.getUint32(o, false);
		if (src === 0xffffffff) continue;
		const dst = dv.getUint32(o + 4, false);
		map.set(src, dst);
	}
	return map;
}

/** Read a NUL-terminated latin1 string at an absolute file offset. */
function cString(buf: ArrayBuffer, abs: number, fileSize: number): string {
	const bytes = new Uint8Array(buf);
	let p = abs;
	let s = '';
	while (p < fileSize && bytes[p] !== 0) {
		s += String.fromCharCode(bytes[p]);
		p++;
	}
	return s;
}

/**
 * Walk the __classnames__ registry into an offset→name map (offset relative to
 * the section start, pointing at the NAME, i.e. just after the 0x09 separator).
 */
function classNameMap(
	dv: DataView,
	buf: ArrayBuffer,
	cn: HavokSection,
	fileSize: number,
): Map<number, string> {
	const map = new Map<number, string>();
	const bytes = new Uint8Array(buf);
	let o = cn.absoluteDataStart;
	const end = Math.min(cn.absoluteDataStart + cn.endOffset, fileSize);
	while (o + 5 <= end) {
		const sig = dv.getUint32(o, false);
		if (sig === 0xffffffff) break;
		if (bytes[o + 4] !== 0x09) break;
		const nameAbs = o + 5;
		const name = cString(buf, nameAbs, fileSize);
		if (name.length === 0) break;
		map.set(nameAbs - cn.absoluteDataStart, name);
		o = nameAbs + name.length + 1;
	}
	return map;
}

/**
 * Enumerate the objects in a section via its virtual-fixup table. Each 12-byte
 * entry is (uint32 objOffset, uint32 classnameSectionIndex, uint32
 * classnameOffset); the classnameOffset indexes the __classnames__ map. Returns
 * objects in file order (data-relative offsets). Verified: the virtual table is
 * the authoritative object index in both .mainColl and .hkColl.
 */
function enumerateObjects(
	dv: DataView,
	section: HavokSection,
	cnMap: Map<number, string>,
	fileSize: number,
): { offset: number; className: string }[] {
	const out: { offset: number; className: string }[] = [];
	const start = section.absoluteDataStart + section.virtualFixupsOffset;
	const end = Math.min(section.absoluteDataStart + section.exportsOffset, fileSize);
	for (let o = start; o + 12 <= end; o += 12) {
		const objOffset = dv.getUint32(o, false);
		const cnOffset = dv.getUint32(o + 8, false);
		const className = cnMap.get(cnOffset);
		if (className === undefined) continue;
		out.push({ offset: objOffset, className });
	}
	return out;
}

// Havok hkClass on-disk layout (ptr32, big-endian) — confirmed by byte trace:
//   +0x00 name (char*)   +0x04 parent   +0x08 objectSize (int32)
//   +0x0C numImplementedInterfaces   +0x10 declaredEnums (hkArray ptr,size)
//   +0x18 declaredMembers (hkArray ptr@0x18, size@0x1C)  …
// hkClassMember stride = 0x18 (24 bytes):
//   +0x00 name (char*)   +0x04 class   +0x08 enum   +0x0C type(u8)
//   +0x0D subtype(u8)    +0x0E cArraySize(u16)   +0x10 flags(u16)
//   +0x12 offset(u16)    +0x14 attributes (ptr)
const HKCLASS_OBJSIZE = 0x08;
const HKCLASS_DECLMEMBERS_PTR = 0x18;
const HKCLASS_DECLMEMBERS_SIZE = 0x1c;
const HKMEMBER_STRIDE = 0x18;
const HKMEMBER_TYPE = 0x0c;
const HKMEMBER_OFFSET = 0x12;

/**
 * Parse the __types__ section into reflected classes. Each object is an hkClass
 * whose `name` (char*) and `declaredMembers` array we resolve via local fixups.
 * Verified: yields hkpMaterial {responseType@0, friction@4, restitution@8} etc.
 */
function parseTypes(
	dv: DataView,
	buf: ArrayBuffer,
	types: HavokSection,
	fileSize: number,
): HavokClass[] {
	const local = buildLocalFixups(dv, types, fileSize);
	const base = types.absoluteDataStart;
	// Each hkClass object is a virtual-fixup entry; but the virtual table only
	// tags them all as "hkClass". The real class name is the object's own
	// `name` pointer. Enumerate via the virtual table for the object offsets.
	const start = base + types.virtualFixupsOffset;
	const end = Math.min(base + types.exportsOffset, fileSize);
	const out: HavokClass[] = [];
	for (let v = start; v + 12 <= end; v += 12) {
		const objOff = dv.getUint32(v, false); // data-relative
		const nameRel = local.get(objOff + 0x00);
		if (nameRel === undefined) continue;
		const name = cString(buf, base + nameRel, fileSize);
		if (!name) continue;
		const objectSize = dv.getInt32(base + objOff + HKCLASS_OBJSIZE, false);
		const dmRel = local.get(objOff + HKCLASS_DECLMEMBERS_PTR);
		const dmSize = dv.getInt32(base + objOff + HKCLASS_DECLMEMBERS_SIZE, false);
		const members: HavokMember[] = [];
		if (dmRel !== undefined && dmSize > 0 && dmSize < 4096) {
			for (let m = 0; m < dmSize; m++) {
				const mb = dmRel + m * HKMEMBER_STRIDE;
				const mnRel = local.get(mb + 0x00);
				const mname = mnRel !== undefined ? cString(buf, base + mnRel, fileSize) : '';
				const type = new Uint8Array(buf)[base + mb + HKMEMBER_TYPE];
				const offset = dv.getUint16(base + mb + HKMEMBER_OFFSET, false);
				members.push({ name: mname, type, offset });
			}
		}
		out.push({ name, objectSize, members });
	}
	return out;
}

// Havok TYPE_* enum values (subset, from the embedded reflection).
const TYPE_REAL = 11; // float32

// hkpConvexVerticesShape on-disk layout (ptr32, BE) — confirmed by byte trace:
//   +0x10 radius (f32)
//   +0x20 aabbHalfExtents (vec4)   +0x30 aabbCenter (vec4)
//   +0x40 rotatedVertices (hkArray: ptr@0x40, size@0x44)  -> FourVectors[]
//   +0x4C numVertices (int32)
//   +0x50 planeEquations (hkArray: ptr@0x50, size@0x54)
// Each hkpConvexVerticesShapeFourVectors packs 4 verts SoA: xxxx(16) yyyy(16)
// zzzz(16) = 48 bytes; the array size == ceil(numVertices/4).
const CVS_AABB_HALF = 0x20;
const CVS_AABB_CENTER = 0x30;
const CVS_ROTVERTS_PTR = 0x40;
const CVS_NUMVERTS = 0x4c;
const FOURVECTORS_STRIDE = 48;

// hkpExtendedMeshShape on-disk layout (ptr32, BE) — confirmed by byte trace:
//   +0x30 aabbHalfExtents (vec4)   +0x40 aabbCenter (vec4)
//   +0x50 trianglesSubparts (hkArray: ptr@0x50, size@0x54)
// On-disk subpart stride = 0x40 (NOT the 112-byte in-memory objectSize):
//   +0x10 numTriangleShapes (int32)   +0x18 vertexStriding (int32=16)
//   +0x1C numVertices (int32)   +0x34 indexStriding (int32=12)
// vertexBase / indexBase are SERIALIZE_IGNORED -> NOT on disk.
const EMS_AABB_HALF = 0x30;
const EMS_AABB_CENTER = 0x40;
const EMS_SUBPARTS_PTR = 0x50;
const EMS_SUBPART_STRIDE = 0x40;
const EMS_SUB_NUMTRI = 0x10;
const EMS_SUB_NUMVERTS = 0x1c;

function readVec3(dv: DataView, abs: number): [number, number, number] {
	return [
		dv.getFloat32(abs, false),
		dv.getFloat32(abs + 4, false),
		dv.getFloat32(abs + 8, false),
	];
}

/**
 * Decode an hkpConvexVerticesShape's rotatedVertices (SIMD FourVectors, SoA)
 * into a flat positions[] and a convex-hull triangulation. Returns the shape +
 * its renderable mesh, or just metadata when the vertex array is unresolvable.
 */
function decodeConvexShape(
	dv: DataView,
	dataAbs: number,
	objOff: number,
	local: Map<number, number>,
): HavokShape {
	const numVertices = dv.getInt32(dataAbs + objOff + CVS_NUMVERTS, false);
	const aabbHalfExtents = readVec3(dv, dataAbs + objOff + CVS_AABB_HALF);
	const aabbCenter = readVec3(dv, dataAbs + objOff + CVS_AABB_CENTER);
	const shape: HavokShape = {
		className: 'hkpConvexVerticesShape',
		offset: objOff,
		numVertices,
		aabbHalfExtents,
		aabbCenter,
		geometryComplete: false,
	};
	const rvRel = local.get(objOff + CVS_ROTVERTS_PTR);
	if (rvRel === undefined || numVertices <= 0 || numVertices > 100000) return shape;
	const fvCount = Math.ceil(numVertices / 4);
	const positions: number[] = [];
	for (let fv = 0; fv < fvCount; fv++) {
		const fb = dataAbs + rvRel + fv * FOURVECTORS_STRIDE;
		// SoA: xxxx (4 floats), yyyy (4), zzzz (4)
		for (let k = 0; k < 4; k++) {
			const idx = fv * 4 + k;
			if (idx >= numVertices) break;
			const x = dv.getFloat32(fb + k * 4, false);
			const y = dv.getFloat32(fb + 16 + k * 4, false);
			const z = dv.getFloat32(fb + 32 + k * 4, false);
			positions.push(x, y, z);
		}
	}
	const indices = convexHullTriangles(positions);
	shape.mesh = { positions, indices, vertexCount: positions.length / 3 };
	shape.geometryComplete = true;
	return shape;
}

/**
 * Decode an hkpExtendedMeshShape: sum the triangle subparts' numVertices /
 * numTriangleShapes (metadata) and synthesize an AABB box mesh. The actual
 * triangle vertex/index buffers are SERIALIZE_IGNORED in this build and absent
 * from the file, so geometryComplete=false.
 */
function decodeExtendedMeshShape(
	dv: DataView,
	dataAbs: number,
	objOff: number,
	local: Map<number, number>,
): HavokShape {
	const aabbHalfExtents = readVec3(dv, dataAbs + objOff + EMS_AABB_HALF);
	const aabbCenter = readVec3(dv, dataAbs + objOff + EMS_AABB_CENTER);
	const subPtr = local.get(objOff + EMS_SUBPARTS_PTR);
	const subSize = dv.getInt32(dataAbs + objOff + EMS_SUBPARTS_PTR + 4, false);
	let numVertices = 0;
	let numTriangles = 0;
	let subpartCount = 0;
	if (subPtr !== undefined && subSize > 0 && subSize < 100000) {
		subpartCount = subSize;
		for (let i = 0; i < subSize; i++) {
			const sb = dataAbs + subPtr + i * EMS_SUBPART_STRIDE;
			numTriangles += dv.getInt32(sb + EMS_SUB_NUMTRI, false);
			numVertices += dv.getInt32(sb + EMS_SUB_NUMVERTS, false);
		}
	}
	const shape: HavokShape = {
		className: 'hkpExtendedMeshShape',
		offset: objOff,
		numVertices,
		numTriangles,
		subpartCount,
		aabbHalfExtents,
		aabbCenter,
		// AABB box mesh so the level extent is visualizable even without tris.
		mesh: aabbBoxMesh(aabbCenter, aabbHalfExtents),
		geometryComplete: false,
	};
	return shape;
}

/**
 * Resolve the named-variant labels for vehicle hulls. A .mainColl's
 * hkRootLevelContainer holds hkRootLevelContainerNamedVariant entries
 * (Vs_Environment / Vs_Object / Vs_Vehicle / Core). We map them positionally to
 * the convex shapes in object order (best-effort labelling).
 */
const VEHICLE_HULL_NAMES = ['Vs_Environment', 'Vs_Object', 'Vs_Vehicle', 'Core'];

/**
 * Walk the __data__ object graph and extract collision geometry + key fields.
 */
function parseData(
	dv: DataView,
	buf: ArrayBuffer,
	data: HavokSection,
	cn: HavokSection,
	types: HavokClass[],
	fileSize: number,
): { shapes: HavokShape[]; meshes: HavokMesh[]; fields: HavokField[] } {
	const local = buildLocalFixups(dv, data, fileSize);
	const cnMap = classNameMap(dv, buf, cn, fileSize);
	const objects = enumerateObjects(dv, data, cnMap, fileSize);
	const dataAbs = data.absoluteDataStart;

	const shapes: HavokShape[] = [];
	const meshes: HavokMesh[] = [];
	let convexIdx = 0;
	for (const obj of objects) {
		if (obj.className === 'hkpConvexVerticesShape') {
			const s = decodeConvexShape(dv, dataAbs, obj.offset, local);
			// Positional vehicle-hull label (only when the count matches the 4
			// known target hulls — otherwise leave unlabeled to stay honest).
			if (convexIdx < VEHICLE_HULL_NAMES.length) s.name = VEHICLE_HULL_NAMES[convexIdx];
			convexIdx++;
			shapes.push(s);
			if (s.mesh && s.mesh.positions.length >= 9) meshes.push(s.mesh);
		} else if (obj.className === 'hkpExtendedMeshShape') {
			const s = decodeExtendedMeshShape(dv, dataAbs, obj.offset, local);
			shapes.push(s);
			if (s.mesh && s.mesh.positions.length >= 9) meshes.push(s.mesh);
		}
	}

	const fields = extractFields(dv, buf, data, cnMap, types, fileSize);
	return { shapes, meshes, fields };
}

// The hkpMaterial block in __data__ is NOT a top-level (virtual-fixup) object —
// it is embedded inside each hkpRigidBody. Per the wiki byte-trace it is laid
// out as { responseType, friction(f32), restitution(f32) } with responseType
// stored as the byte-packed enum RESPONSE_SIMPLE_CONTACT, i.e. the big-endian
// word 0x01000000. We anchor on that exact word and require the two trailing
// floats to be plausible friction/restitution, which uniquely and reliably
// recovers the documented 0.5 / 0.4 across .phys and .hkColl (and correctly
// finds nothing in .mainColl / cl.hkColl, which carry no rigid body).
const RESPONSE_SIMPLE_CONTACT_WORD = 0x01000000;

/**
 * Surface scalar physics fields (hkpMaterial friction/restitution) by scanning
 * the __data__ section for the anchored hkpMaterial signature and reading the
 * adjacent floats. The member NAMES come from the __types__ reflection
 * (hkpMaterial.friction / .restitution) so they are schema-driven, not
 * hard-coded. Returns the distinct material value pairs found (deduped). Honest
 * partial: this is an anchored heuristic — only values matching the exact
 * RESPONSE_SIMPLE_CONTACT word + plausible float ranges are surfaced.
 */
function extractFields(
	dv: DataView,
	_buf: ArrayBuffer,
	data: HavokSection,
	_cnMap: Map<number, string>,
	types: HavokClass[],
	fileSize: number,
): HavokField[] {
	const material = types.find((t) => t.name === 'hkpMaterial');
	if (!material) return [];
	// Reflected member names for the two TYPE_REAL members, in declared order.
	const realMembers = material.members.filter((m) => m.type === TYPE_REAL);
	const fricName = realMembers[0]?.name ?? 'friction';
	const restName = realMembers[1]?.name ?? 'restitution';

	const dataAbs = data.absoluteDataStart;
	const dataEnd = Math.min(dataAbs + data.endOffset, fileSize);
	const seen = new Set<string>();
	const out: HavokField[] = [];
	for (let o = dataAbs; o + 12 <= dataEnd; o += 4) {
		if (dv.getUint32(o, false) !== RESPONSE_SIMPLE_CONTACT_WORD) continue;
		const friction = dv.getFloat32(o + 4, false);
		const restitution = dv.getFloat32(o + 8, false);
		if (!Number.isFinite(friction) || !Number.isFinite(restitution)) continue;
		// Physically plausible bounds (rejects denormal near-zero noise).
		if (friction < 0.001 || friction >= 10 || restitution < 0 || restitution >= 2) continue;
		const key = `${friction.toFixed(4)}/${restitution.toFixed(4)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ className: 'hkpMaterial', name: fricName, value: friction });
		out.push({ className: 'hkpMaterial', name: restName, value: restitution });
		if (seen.size >= 4) break; // a few representative materials is plenty
	}
	return out;
}

// ---------------------------------------------------------------------------
// Geometry helpers (convex hull triangulation + AABB box)
// ---------------------------------------------------------------------------

/**
 * Build a triangle list for the convex hull of a small point set (flat xyz[]).
 *
 * Incremental 3D convex hull: start from a non-degenerate tetrahedron oriented
 * so every face normal points away from the hull's interior centroid, then add
 * each remaining point — removing the faces it can "see" and stitching the
 * horizon to the new point. Every face is oriented consistently outward by the
 * running interior centroid (the tetra centroid), which stays strictly inside
 * the hull throughout, so winding is stable. Tolerances are scale-relative so
 * thin hulls (small extent on one axis) triangulate correctly.
 *
 * Returns [] (the MeshViewer's point-soup fallback) only when the points are
 * genuinely coplanar/degenerate (no enclosed volume).
 */
export function convexHullTriangles(positions: number[]): number[] {
	const n = positions.length / 3;
	if (n < 4) return [];
	const P = (i: number): [number, number, number] => [
		positions[i * 3],
		positions[i * 3 + 1],
		positions[i * 3 + 2],
	];
	const sub = (a: number[], b: number[]): [number, number, number] => [
		a[0] - b[0],
		a[1] - b[1],
		a[2] - b[2],
	];
	const cross = (a: number[], b: number[]): [number, number, number] => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
	const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

	// Scale-relative epsilons from the bounding-box diagonal.
	const mn = [Infinity, Infinity, Infinity];
	const mx = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++) {
		const p = P(i);
		for (let k = 0; k < 3; k++) {
			mn[k] = Math.min(mn[k], p[k]);
			mx[k] = Math.max(mx[k], p[k]);
		}
	}
	const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
	const epsLen = diag * 1e-7;
	const epsVol = diag * diag * diag * 1e-9;

	// i0,i1: the most-separated pair (seed the longest edge).
	let i0 = 0;
	let i1 = 1;
	let bestD = -1;
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			const d = dot(sub(P(i), P(j)), sub(P(i), P(j)));
			if (d > bestD) {
				bestD = d;
				i0 = i;
				i1 = j;
			}
		}
	if (bestD <= epsLen * epsLen) return []; // all coincident

	// i2: farthest from the line i0-i1 (largest triangle area).
	let i2 = -1;
	let bestArea = epsLen * epsLen;
	for (let i = 0; i < n; i++) {
		if (i === i0 || i === i1) continue;
		const a = cross(sub(P(i1), P(i0)), sub(P(i), P(i0)));
		const area = dot(a, a);
		if (area > bestArea) {
			bestArea = area;
			i2 = i;
		}
	}
	if (i2 < 0) return []; // collinear

	// i3: farthest from the plane i0-i1-i2 (largest tetra volume).
	const nrm = cross(sub(P(i1), P(i0)), sub(P(i2), P(i0)));
	let i3 = -1;
	let bestVol = epsVol;
	for (let i = 0; i < n; i++) {
		if (i === i0 || i === i1 || i === i2) continue;
		const vol = Math.abs(dot(nrm, sub(P(i), P(i0))));
		if (vol > bestVol) {
			bestVol = vol;
			i3 = i;
		}
	}
	if (i3 < 0) return []; // coplanar — no volume

	// Interior reference: the centroid of the seed tetra is strictly inside the
	// final hull, so it orients every face's outward normal unambiguously.
	const interior: [number, number, number] = [
		(P(i0)[0] + P(i1)[0] + P(i2)[0] + P(i3)[0]) / 4,
		(P(i0)[1] + P(i1)[1] + P(i2)[1] + P(i3)[1]) / 4,
		(P(i0)[2] + P(i1)[2] + P(i2)[2] + P(i3)[2]) / 4,
	];

	type Face = [number, number, number];
	const faces: Face[] = [];
	// Push (a,b,c) oriented so its normal points away from `interior`.
	const pushOutward = (a: number, b: number, c: number) => {
		const fn = cross(sub(P(b), P(a)), sub(P(c), P(a)));
		faces.push(dot(fn, sub(interior, P(a))) > 0 ? [a, c, b] : [a, b, c]);
	};
	pushOutward(i0, i1, i2);
	pushOutward(i0, i1, i3);
	pushOutward(i0, i2, i3);
	pushOutward(i1, i2, i3);

	const faceNormal = (f: Face) => cross(sub(P(f[1]), P(f[0])), sub(P(f[2]), P(f[0])));
	// A point "sees" a face when it lies outside the face plane. The threshold
	// is a small fraction of epsLen so near-coplanar hull points still split the
	// face they sit on (avoids leaving un-triangulated coplanar patches that
	// would show as non-manifold gaps on the larger hulls).
	const seeEps = epsLen * 0.01;
	const sees = (f: Face, p: number) => {
		const fn = faceNormal(f);
		const len = Math.hypot(fn[0], fn[1], fn[2]) || 1;
		return dot(fn, sub(P(p), P(f[0]))) / len > seeEps;
	};

	const seed = new Set([i0, i1, i2, i3]);
	for (let p = 0; p < n; p++) {
		if (seed.has(p)) continue;
		const vis: Face[] = [];
		const keep: Face[] = [];
		for (const f of faces) (sees(f, p) ? vis : keep).push(f);
		if (vis.length === 0) continue; // strictly inside the current hull

		// Horizon = directed edges that appear in exactly one visible face.
		const edges = new Map<string, [number, number]>();
		const key = (a: number, b: number) => `${a}_${b}`;
		for (const f of vis) {
			const tri: [number, number][] = [
				[f[0], f[1]],
				[f[1], f[2]],
				[f[2], f[0]],
			];
			for (const [a, b] of tri) {
				const rev = key(b, a);
				if (edges.has(rev)) edges.delete(rev); // shared with another visible face
				else edges.set(key(a, b), [a, b]);
			}
		}

		faces.length = 0;
		faces.push(...keep);
		// Each surviving horizon edge (a→b) gets a new outward face (a,b,p).
		for (const [a, b] of edges.values()) pushOutward(a, b, p);
	}

	const out: number[] = [];
	for (const f of faces) out.push(f[0], f[1], f[2]);
	return out;
}

/** Build a 12-triangle box mesh from an AABB center + half-extents. */
export function aabbBoxMesh(
	center: [number, number, number],
	half: [number, number, number],
): HavokMesh {
	const [cx, cy, cz] = center;
	const [hx, hy, hz] = half.map((v) => Math.max(Math.abs(v), 1e-4)) as [number, number, number];
	const positions: number[] = [];
	for (const sx of [-1, 1])
		for (const sy of [-1, 1])
			for (const sz of [-1, 1]) positions.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
	// vertex index = (sx>0?4:0)+(sy>0?2:0)+(sz>0?1:0)
	const v = (sx: number, sy: number, sz: number) =>
		(sx > 0 ? 4 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 1 : 0);
	const quad = (a: number[], b: number[], c: number[], d: number[]) => {
		const ai = v(a[0], a[1], a[2]);
		const bi = v(b[0], b[1], b[2]);
		const ci = v(c[0], c[1], c[2]);
		const di = v(d[0], d[1], d[2]);
		indices.push(ai, bi, ci, ai, ci, di);
	};
	const indices: number[] = [];
	quad([-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]); // -X
	quad([1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]); // +X
	quad([-1, -1, -1], [-1, -1, 1], [1, -1, 1], [1, -1, -1]); // -Y
	quad([-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]); // +Y
	quad([-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]); // -Z
	quad([-1, -1, 1], [-1, 1, 1], [1, 1, 1], [1, -1, 1]); // +Z
	return { positions, indices, vertexCount: 8 };
}

/** True if the leading bytes are the Havok packfile magic. */
export function isHavokPackfile(raw: Uint8Array): boolean {
	return (
		raw.byteLength >= 8 &&
		raw[0] === 0x57 &&
		raw[1] === 0xe0 &&
		raw[2] === 0xe0 &&
		raw[3] === 0x57 &&
		raw[4] === 0x10 &&
		raw[5] === 0xc0 &&
		raw[6] === 0xc0 &&
		raw[7] === 0x10
	);
}
