// Havok packfile registry handler (container + collision geometry + fields).
//
// Covers every Split/Second physics packfile: .phys, .mainColl, .hkColl,
// .hkPPs, .hkRBs. They share the identical Havok-5.5.0 container, so one
// handler claims all five extensions and sniffs unresolved .ark members by the
// 0x57E0E057 / 0x10C0C010 magic.
//
// Read-only (caps.write = false). Decodes the self-documenting container
// (magic, hkPackfileHeader, section table, __classnames__ registry, root
// class), the __types__ class reflection, and COLLISION GEOMETRY from the
// __data__ object graph:
//   * hkpConvexVerticesShape -> real per-hull vertices (vehicle .mainColl /
//     .phys), triangulated into a renderable convex-hull mesh (-> MeshViewer).
//   * hkpExtendedMeshShape   -> subpart metadata + an AABB box (level .hkColl);
//     the triangle buffers themselves are SERIALIZE_IGNORED and absent from the
//     file, so only the AABB box is renderable (geometryComplete=false).
// Surfaces hkpMaterial friction/restitution where present. Honest partial: the
// level triangle soup is not in the file; the convex hulls are fully recovered.

import { parseHavok, isHavokPackfile, type ParsedHavok } from '../../havok';
import type { ResourceHandler } from '../handler';

const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

// Magic: 57 E0 E0 57 10 C0 C0 10 (both signatures, big-endian as stored).
const HAVOK_MAGIC = new Uint8Array([
	0x57, 0xe0, 0xe0, 0x57, 0x10, 0xc0, 0xc0, 0x10,
]);

export const havokHandler: ResourceHandler<ParsedHavok> = {
	key: 'havok',
	name: 'Havok Packfile',
	description:
		'Havok 5.5.0 binary packfile (magic 0x57E0E057) used by every Split/Second physics asset ' +
		'(.phys/.mainColl/.hkColl/.hkPPs/.hkRBs). Decodes the container header, the ' +
		'__classnames__/__types__/__data__ section table, the embedded class reflection, and ' +
		'collision GEOMETRY: hkpConvexVerticesShape hulls (vehicle .mainColl/.phys) are fully ' +
		'recovered + triangulated; hkpExtendedMeshShape (level .hkColl) yields subpart metadata + an ' +
		'AABB box only (its triangle buffers are SERIALIZE_IGNORED, absent from the file). Surfaces ' +
		'hkpMaterial friction/restitution. Some level packs ship an *Xml twin on disk.',
	category: 'Physics',
	caps: { read: true, write: false },
	extensions: ['.phys', '.maincoll', '.hkcoll', '.hkpps', '.hkrbs'],
	magic: HAVOK_MAGIC,
	wikiUrl: 'format-hkcoll.html',

	parseRaw: (raw) => {
		if (!isHavokPackfile(raw)) {
			throw new Error('havok: not a Havok packfile (magic mismatch)');
		}
		return parseHavok(raw);
	},

	describe: (m) => {
		const root = m.rootClassName ?? '(unresolved)';
		const banner = m.header.contentsVersion || '(no banner)';
		// Geometry summary.
		const convex = m.shapes.filter((s) => s.className === 'hkpConvexVerticesShape');
		const ext = m.shapes.filter((s) => s.className === 'hkpExtendedMeshShape');
		const geomParts: string[] = [];
		if (convex.length) {
			const verts = convex.reduce((a, s) => a + (s.numVertices ?? 0), 0);
			geomParts.push(`${convex.length} convex hull${convex.length === 1 ? '' : 's'} (${verts} verts)`);
		}
		if (ext.length) {
			const tris = ext.reduce((a, s) => a + (s.numTriangles ?? 0), 0);
			geomParts.push(
				`${ext.length} mesh shape${ext.length === 1 ? '' : 's'} (${tris} tris — AABB box only, ` +
					`triangle buffers not in file)`,
			);
		}
		const geom = geomParts.length ? ` · ${geomParts.join(', ')}` : '';
		// Physics fields.
		const fric = m.fields.find((f) => f.name === 'friction');
		const rest = m.fields.find((f) => f.name === 'restitution');
		const phys =
			fric || rest
				? ` · material{${fric ? `friction=${fric.value.toFixed(3)}` : ''}${fric && rest ? ', ' : ''}${rest ? `restitution=${rest.value.toFixed(3)}` : ''}}`
				: '';
		return (
			`${banner} root=${root} · ${m.classNames.length} classes · ${m.sections.length} sections` +
			geom +
			phys +
			` · userTag=${m.header.userTag} · ${m.fileSize}B`
		);
	},

	fixtures: [
		// Per-vehicle .phys (root hkpPhysicsSystem, 41 classes, no XML twin).
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.phys',
			expect: { parseOk: true },
		},
		// Per-vehicle .mainColl (root hkRootLevelContainer).
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.mainColl',
			expect: { parseOk: true },
		},
		// Level collision pack — these ship .hkCollXml twins.
		{
			file: 'Environments/Levels/Downtown/Physics/Downtown.hkColl',
			expect: { parseOk: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'parse the container header unchanged (read-only handler)',
			mutate: (m) => m,
			verify: (before, after) =>
				after.rootClassName === before.rootClassName &&
				after.sections.length === before.sections.length
					? []
					: [
							`root ${after.rootClassName} != ${before.rootClassName} or ` +
								`sections ${after.sections.length} != ${before.sections.length}`,
						],
		},
		{
			name: 'classlist',
			description: 'the __classnames__ registry survives a re-describe',
			mutate: (m) => m,
			verify: (before, after) =>
				after.classNames.length === before.classNames.length
					? []
					: [`class count ${after.classNames.length} != ${before.classNames.length}`],
		},
		{
			name: 'geometry',
			description: 'the recovered collision shapes/meshes are stable',
			mutate: (m) => m,
			verify: (before, after) =>
				after.shapes.length === before.shapes.length &&
				after.meshes.length === before.meshes.length
					? []
					: [
							`shapes ${after.shapes.length} != ${before.shapes.length} or ` +
								`meshes ${after.meshes.length} != ${before.meshes.length}`,
						],
		},
	],
};

// Re-export for callers that want the formatter (kept internal otherwise).
export { hex as formatHavokHex };
