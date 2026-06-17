// .skel registry handler — Black Rock 'ftsc' bone-hierarchy / animation rig.
//
// Category: mesh (rig that drives skinned .model meshes). Read-only MVP.
// Confirmed layout — see src/lib/core/skel.ts and wiki/format-skel.html.

import { parseSkel, rootBoneIndex, type ParsedSkel } from '../../skel';
import type { ResourceHandler } from '../handler';

// Magic "ftsc" = 66 74 73 63.
const SKEL_MAGIC_BYTES = new Uint8Array([0x66, 0x74, 0x73, 0x63]);

export const skelHandler: ResourceHandler<ParsedSkel> = {
	key: 'skel',
	name: 'Skeleton (ftsc rig)',
	description:
		"Black Rock 'ftsc' bone hierarchy for powerplay animation rigs: parent " +
		'indices, two 4x4 bind matrices per bone, three 16-byte vectors, and ' +
		'fixed 64-byte joint names. Maps onto Havok hkaSkeleton at load.',
	category: 'Graphics', // viewport family: mesh
	caps: { read: true, write: false },
	extensions: ['.skel'],
	magic: SKEL_MAGIC_BYTES,
	wikiUrl: 'format-skel.html',

	parseRaw: (raw) => parseSkel(raw),
	describe: (m) => {
		const root = rootBoneIndex(m);
		const rootName = root >= 0 ? m.bones[root].name : '(none)';
		const sample = m.bones
			.slice(0, 3)
			.map((b) => b.name)
			.filter(Boolean)
			.join(', ');
		return (
			`${m.boneCount} bone${m.boneCount === 1 ? '' : 's'} (v${m.version}), ` +
			`root "${rootName}"${sample ? `; ${sample}${m.boneCount > 3 ? ' …' : ''}` : ''}`
		);
	},

	fixtures: [
		{
			file: 'Powerplays/Animations/airport_test_03/Generic/PG02_Helicopter/PG02_Helicopter_A.skel',
			expect: { parseOk: true },
		},
	],
};
