// .skel parser — Black Rock 'ftsc' bone-hierarchy container (PS3 big-endian).
//
// Pure module: imports ONLY the binary helpers, NEVER the registry (acyclic
// rule). Importable from Node by the CLI and vitest.
//
// Faithful port of wiki/format-skel.html (Confirmed status). Layout:
//   0x00  char[4]    magic "ftsc"
//   0x04  uint16     version  (0x0064 = 100)
//   0x06  uint16     stride/align (0x0010 = 16)
//   0x08  uint32     reserved (0)
//   0x0C  uint16     bone_count
//   0x0E  uint16     pad (0)
//   0x10  uint32[8]  offset_table  (absolute file offsets to per-bone arrays)
//   0x30  uint32     end_offset    (duplicates offset_table[7] = name-block start)
// The eight offsets point at (per bone, in order):
//   [0] uint16 parent_index[]   (0xFFFF = root)
//   [1] uint16 bone_order[]
//   [2] float32[16] matrix_A[]   (reference-pose 4x4, row-major)
//   [3] float32[16] matrix_B[]   (world / inverse-bind 4x4)
//   [4] float32[4]  vec_C[]
//   [5] float32[4]  vec_D[]
//   [6] float32[4]  vec_E[]
//   [7] char[64]    names[]      (one fixed 64-byte NUL-padded name per bone)

import { BinReader } from './binary/BinReader';

export const SKEL_MAGIC = 'ftsc';

export type SkelBone = {
	index: number;
	/** Parent bone index; -1 for a root (stored as 0xFFFF). */
	parent: number;
	/** Second index array entry (bone ordering / remap). */
	order: number;
	/** 4x4 reference-pose matrix (row-major, 16 floats). */
	matrixA: number[];
	/** 4x4 world / inverse-bind matrix (row-major, 16 floats). */
	matrixB: number[];
	/** 16-byte vectors C/D/E (4 floats each). */
	vecC: [number, number, number, number];
	vecD: [number, number, number, number];
	vecE: [number, number, number, number];
	/** Joint name (NUL-trimmed from the 64-byte slot). */
	name: string;
};

export type ParsedSkel = {
	version: number;
	stride: number;
	boneCount: number;
	/** The 8 absolute offsets from the header table. */
	offsetTable: number[];
	bones: SkelBone[];
};

function read16(r: BinReader, off: number, count: number): number[] {
	r.seek(off);
	const out: number[] = new Array(count);
	for (let i = 0; i < count; i++) out[i] = r.readU16();
	return out;
}

function readFloats(r: BinReader, off: number, count: number): number[] {
	r.seek(off);
	const out: number[] = new Array(count);
	for (let i = 0; i < count; i++) out[i] = r.readF32();
	return out;
}

export function parseSkel(raw: Uint8Array): ParsedSkel {
	if (raw.byteLength < 0x40) {
		throw new Error(`skel: too small (${raw.byteLength} bytes)`);
	}
	// Copy by byteOffset: extractResourceRaw may hand back a view over a larger buffer.
	const r = new BinReader(
		raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		false, // big-endian
	);
	r.seek(0);
	const magic = r.readFixedString(4);
	if (magic !== SKEL_MAGIC) {
		throw new Error(`skel: bad magic "${magic}" (expected "ftsc")`);
	}
	const version = r.readU16();
	const stride = r.readU16();
	r.readU32(); // reserved
	const boneCount = r.readU16();
	r.readU16(); // pad

	const offsetTable: number[] = new Array(8);
	r.seek(0x10);
	for (let i = 0; i < 8; i++) offsetTable[i] = r.readU32();

	const [oParent, oOrder, oMatA, oMatB, oVecC, oVecD, oVecE, oNames] = offsetTable;

	const parents = read16(r, oParent, boneCount);
	const orders = read16(r, oOrder, boneCount);

	const bones: SkelBone[] = new Array(boneCount);
	for (let i = 0; i < boneCount; i++) {
		const matrixA = readFloats(r, oMatA + i * 64, 16);
		const matrixB = readFloats(r, oMatB + i * 64, 16);
		const vecC = readFloats(r, oVecC + i * 16, 4) as [number, number, number, number];
		const vecD = readFloats(r, oVecD + i * 16, 4) as [number, number, number, number];
		const vecE = readFloats(r, oVecE + i * 16, 4) as [number, number, number, number];
		r.seek(oNames + i * 64);
		const name = r.readFixedString(64);
		const parentRaw = parents[i];
		bones[i] = {
			index: i,
			parent: parentRaw === 0xffff ? -1 : parentRaw,
			order: orders[i],
			matrixA,
			matrixB,
			vecC,
			vecD,
			vecE,
			name,
		};
	}

	return { version, stride, boneCount, offsetTable, bones };
}

/** Index of the root bone (parent === -1), or -1 if none. */
export function rootBoneIndex(s: ParsedSkel): number {
	return s.bones.findIndex((b) => b.parent === -1);
}
