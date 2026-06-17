// .deform registry handler — Black Rock DFM2 vehicle deformation cage.
// Read-only MVP (caps.write=false): header + vertex cage confirmed, part-group
// names recovered, spring interior surfaced as a byte range.

import { parseDeform, DEFORM_MAGIC, type ParsedDeform } from '../../deform';
import type { ResourceHandler } from '../handler';

export const deformHandler: ResourceHandler<ParsedDeform> = {
	key: 'deform',
	name: 'Vehicle Deformation (DFM2)',
	description:
		'Black Rock per-vehicle damage/deformation cage: DFM2 header + big-endian vec4 vertex array, ' +
		'mass-spring edges and named 100-byte rigid part-groups. Custom container, not Havok.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.deform'],
	magic: DEFORM_MAGIC, // 44 46 4d 02 "DFM" v2
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseDeform(raw),
	describe: (m) => {
		const groups = m.partGroups.length
			? `, groups: ${m.partGroups.slice(0, 4).map((g) => g.name).join('/')}${m.partGroups.length > 4 ? '…' : ''}`
			: '';
		const chassis = m.chassisLink ? `, chassis "${m.chassisLink}"` : '';
		return (
			`DFM v${m.header.version}: ${m.header.vertexCount} verts, ` +
			`${m.header.partGroupCount} part-groups, edgeCount ${m.header.edgeCount}${groups}${chassis}`
		);
	},

	fixtures: [
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.deform',
			expect: { parseOk: true },
		},
	],
};
