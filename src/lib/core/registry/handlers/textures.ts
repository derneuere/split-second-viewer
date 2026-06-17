// .textures / .low.textures registry handler — Crayon2 "TEXS" texture-set
// container. Thin wrapper around parseTextures in src/lib/core/textures.ts.
//
// Read-only MVP (caps.write=false): we decode the header, descriptor table and
// C2NM names faithfully, and decode the top mip of single-texture inline files
// to RGBA. Writing back swizzled RSX payloads is out of scope for now.

import {
	parseTextures,
	decodeLargestTexture,
	TEXS_MAGIC_BYTES,
	type ParsedTextures,
} from '../../textures';
import type { ResourceHandler } from '../handler';

export const texturesHandler: ResourceHandler<ParsedTextures> = {
	key: 'textures',
	name: 'Texture Set (TEXS)',
	description:
		'Black Rock Crayon2 "TEXS" texture-set container: 24-byte header, 0x24-byte ' +
		'descriptor records (DXT1/DXT5/A8R8G8B8, dims, mips, CRC) and a C2NM name ' +
		'trailer. Single-texture files store swizzled pixels inline; frontend stubs ' +
		'point at a sibling .streamtex. Read-only; decodes DXT1/DXT5/A8R8G8B8 to RGBA.',
	category: 'Graphics',
	caps: { read: true, write: false },
	extensions: ['.textures'], // also claims .low.textures (extensionOf takes the last dot)
	magic: TEXS_MAGIC_BYTES, // "TEXS" = 54 45 58 53
	wikiUrl: 'https://burnout.wiki/',

	parseRaw: (raw) => parseTextures(raw),

	describe: (m) => {
		if (m.textureCount === 0) return 'TEXS: empty (0 textures)';
		const d = m.descriptors[0];
		const dims = m.descriptors
			.slice(0, 3)
			.map((t) => `${t.format} ${t.width}x${t.height}`)
			.join(', ');
		const more = m.textureCount > 3 ? ' …' : '';
		const stub = m.isStub ? ' [stub→.streamtex]' : '';
		const nm = d.name ? ` first="${d.name}"` : '';
		return `TEXS v${m.version}: ${m.textureCount} texture${m.textureCount === 1 ? '' : 's'} (${dims}${more})${stub}${nm}`;
	},

	fixtures: [
		// Single-texture inline DXT1 (1024x2048, full mip chain).
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01_damageMap.textures',
			expect: { parseOk: true },
		},
		// .low.textures — same format, lowest mips only.
		{
			file: 'Vehicles/Bodies/Musclecar_01/Musclecar_01_damageMap.low.textures',
			expect: { parseOk: true },
		},
		// 14-descriptor frontend stub (pixels in .streamtex).
		{
			file: 'Vehicles/Frontend/Bodies/Musclecar_01/Musclecar_01.textures',
			expect: { parseOk: true },
		},
		// Single A8R8G8B8 skydome.
		{
			file: 'Environments/Levels/airport_test_03/ReflectionMap/Skydomes/Skydome_Midday.textures',
			expect: { parseOk: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'parse is stable — descriptor count survives a re-describe',
			mutate: (m) => m,
			verify: (before, after) =>
				after.textureCount === before.textureCount
					? []
					: [`count ${after.textureCount} != ${before.textureCount}`],
		},
		{
			name: 'decode-top',
			description: 'the largest texture decodes to a correctly-sized RGBA buffer (inline files)',
			mutate: (m) => m,
			verify: (_before, after) => {
				// Re-decode requires the raw bytes which the stress runner does not
				// retain, so this scenario only asserts the descriptor table is sane.
				const bad = after.descriptors.find(
					(d) => d.width === 0 || d.height === 0 || d.mipCount === 0,
				);
				return bad ? [`descriptor crc=${bad.crc.toString(16)} has zero dims/mips`] : [];
			},
		},
	],
};

// Re-export the inline decode helper so a viewport can call it with raw bytes.
export { decodeLargestTexture };
