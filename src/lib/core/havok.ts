// Havok 5.5.0 binary packfile parser (PARTIAL — container header only).
//
// Every Split/Second physics asset (.phys, .mainColl, .hkColl, .hkPPs,
// .hkRBs) is a stock Havok packfile (`hkPackfileWriter` serialization) with
// magic 0x57E0E057. This module decodes the SELF-DOCUMENTING container layer:
//
//   - the two file signatures + the fixed hkPackfileHeader,
//   - the section table (__classnames__ / __types__ / __data__) — each a
//     0x30-byte hkPackfileSectionHeader,
//   - the __classnames__ registry (4-byte signature + 0x09 + NUL string),
//   - the root object's class name, resolved by following
//     contentsClassNameSectionIndex/Offset into __classnames__.
//
// It deliberately does NOT deserialize the Havok object graph in __data__
// (rigid bodies, shapes, motions) nor walk the three fixup tables — only their
// presence/offsets are surfaced. Hence the handler is marked partial.
//
// Byte layout verified against the RE wiki (wiki/format-havok.html) AND real
// devkit samples Musclecar_01.phys (62208 B) / Musclecar_01.mainColl (4992 B).
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

/** Parsed model returned by parseHavok. */
export type ParsedHavok = {
	header: HavokHeader;
	sections: HavokSection[];
	classNames: HavokClassName[];
	/** Resolved name of the top-level object's class, or undefined if unresolvable. */
	rootClassName?: string;
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

	return { header, sections, classNames, rootClassName, fileSize };
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
