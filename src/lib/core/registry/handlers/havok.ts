// Havok packfile registry handler (PARTIAL — container header only).
//
// Covers every Split/Second physics packfile: .phys, .mainColl, .hkColl,
// .hkPPs, .hkRBs. They share the identical Havok-5.5.0 container, so one
// handler claims all five extensions and sniffs unresolved .ark members by the
// 0x57E0E057 / 0x10C0C010 magic.
//
// Read-only MVP (caps.write = false): we decode the self-documenting container
// (magic, hkPackfileHeader, section table, __classnames__ registry, root
// class) but do NOT deserialize the Havok object graph in __data__. Marked
// partial honestly — only the header is decoded.

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
		'__classnames__/__types__/__data__ section table and the embedded class registry; the Havok ' +
		'object graph itself is not deserialized (partial). Some level packs ship an *Xml twin on disk.',
	category: 'Physics',
	caps: { read: true, write: false },
	extensions: ['.phys', '.maincoll', '.hkcoll', '.hkpps', '.hkrbs'],
	magic: HAVOK_MAGIC,
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => {
		if (!isHavokPackfile(raw)) {
			throw new Error('havok: not a Havok packfile (magic mismatch)');
		}
		return parseHavok(raw);
	},

	describe: (m) => {
		const root = m.rootClassName ?? '(unresolved)';
		const sectionSizes = m.sections
			.map((s) => `${s.tag.replace(/^__|__$/g, '')}=${s.size}B`)
			.join(', ');
		const banner = m.header.contentsVersion || '(no banner)';
		return (
			`${banner} root=${root} · ${m.classNames.length} classes · ` +
			`${m.sections.length} sections [${sectionSizes}] · userTag=${m.header.userTag} · ` +
			`${m.fileSize}B`
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
	],
};

// Re-export for callers that want the formatter (kept internal otherwise).
export { hex as formatHavokHex };
