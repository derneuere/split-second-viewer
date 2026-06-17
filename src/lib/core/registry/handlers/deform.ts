// .deform registry handler — Black Rock DFM2 vehicle deformation cage.
// Header + vertex cage CONFIRMED and decoded; part-group names and chassis-link
// footer recovered as read-only overlays; the still-Theory spring interior is
// preserved verbatim in `tail`. writeRaw re-emits header + cage + verbatim tail,
// which is byte-exact (verified against real body + chassis files), so
// caps.write = true.

import {
	parseDeform,
	writeDeform,
	DEFORM_MAGIC,
	type ParsedDeform,
} from '../../deform';
import type { ResourceHandler } from '../handler';

export const deformHandler: ResourceHandler<ParsedDeform> = {
	key: 'deform',
	name: 'Vehicle Deformation (DFM2)',
	description:
		'Black Rock per-vehicle damage/deformation cage: DFM2 header + big-endian vec4 vertex array, ' +
		'mass-spring edges and named 100-byte rigid part-groups. Custom container, not Havok. Byte-exact round-trip.',
	category: 'Graphics',
	caps: { read: true, write: true },
	extensions: ['.deform'],
	magic: DEFORM_MAGIC, // 44 46 4d 02 "DFM" v2
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseDeform(raw),
	writeRaw: (model) => writeDeform(model),
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
			// body file (has chassis-link footer)
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01.deform',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			// chassis file (no footer; part-group block runs to EOF)
			file: 'Vehicles/Chassis/Coupe/Coupe.deform',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'identity: header + cage + tail re-serialize byte-for-byte',
			mutate: (m) => m,
			verify: (before, after) =>
				after.vertices.length === before.vertices.length &&
				after.header.partGroupCount === before.header.partGroupCount
					? []
					: ['vertex/part-group count mismatch'],
		},
	],
};
