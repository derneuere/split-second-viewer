// material.ts — per-submesh MATERIAL resolution for a Crayon2 renderable.
//
// Joins the four sibling files of a .model so a mesh can be drawn with its real
// surface instead of a flat colour:
//
//   .model       geometry — N submeshes (one per node). N == shaderinst nodes.
//   .shaderinst  per-node material-combo binding + constant/texture OVERRIDES.
//   .shaders     the combo register-block sets (which sampler/const symbols a
//                combo uses) — used for diagnostics + a names→combo map.
//   .textures    the TEXS container holding the named maps, keyed by CRC.
//   .tex.crcs    (optional) the flat CRC dependency list for the model.
//
// Pure module: imports ONLY the other pure parsers (textures / shaderinst /
// shaders / crcs) and the binary helpers — NEVER the registry or React (acyclic
// rule, see registry/handler.ts). Big-endian (PS3).
//
// =====================================================================
// THE BINDING SCHEME (reverse-engineered against the devkit helicopter
// Generic/Models/Helicopter_Bell206B_01, the self-contained variant that ships
// .model + .fxc + .shaders + .shaderinst + .textures in one folder)
// =====================================================================
//
// 1. SUBMESH -> NODE.   The base .model header's nodeCount equals the
//    .shaderinst INSS node_count (heli: both == 6). The decoded submeshes come
//    out in node order, so submesh[i] is rendered with shaderinst node[i]. (When
//    the counts disagree we fall back to index-clamped pairing and flag it.)
//
// 2. NODE -> COMBO.     Each shaderinst node carries an 8-hex-digit material
//    combo CRC string (node[2] = "0x7982350f"). That CRC is a key into the
//    paired .shaders set (which lists the sampler/const symbols the combo uses).
//
// 3. NODE -> DIFFUSE TEXTURE.  Each node has a list of constant OVERRIDES, each
//    a length-prefixed NAME followed by a typed VALUE. The value's first
//    non-zero byte is a KIND tag:
//        kind 2  -> float / float-vector constant (paintColour, fresnel, …)
//        kind 3  -> TEXTURE SAMPLER. Layout: 03 00 00 00 SS <CRC:u32 BE> …
//                   where SS is the sampler slot and the 4 bytes after it are the
//                   big-endian texture-name CRC.
//    GENERALIZED ALBEDO RULE (not heli-specific). A sampler is detected by its
//    KIND tag, never by name — many real albedo samplers are named plainly. The
//    diffuse for a node is chosen as:
//        (a) a name-classified 'diffuse' override (e.g. "*diffuseMap"), else
//        (b) the LOWEST-SLOT non-reflection/normal/specular sampler.
//    Slot 1 is the primary albedo sampler in every model inspected. The CRC then
//    indexes the .textures C2NM table. Verified across:
//        heli  node[2] "VehiclePaintFast_0_diffuseMap" (slot1) -> Attack_Chopper 1024² (DXT1)
//        heli  node[1] "alphablend_0_texture"          (slot1) -> LIT_Glow_Ornage_Red (decal)
//        skycrane "Diffuse_IPR_0_diffuse" (slot1) -> generic_skycrane_military 1024×512   [albedo]
//                 "Diffuse_IPR_0_ipr"     (slot2) -> *_ipr 512×256                          [reflection]
//                 "Diffuse_IPR_0_cubemap" (slot3) -> Docks_Outsource_World_Sunset 32×32     [sky cube]
//                 — the name suffix "cubemap"/"ipr" demotes those to role 'other'
//                 so slot-1 "diffuse" wins (the heli-naming over-fit that bound the
//                 32×32 sky cube as albedo is gone).
//        trailer/nemtruck "texture_0_texture" (slot1) -> car_generic / barrelN  [albedo]
//    A 0xFFFFFFFF sampler CRC is the "no texture bound" sentinel (NemTruckBarrels
//    Low/Mid, whose 76-byte .textures stub has no pixels and no .streamtex) — it
//    binds nothing, so those submeshes fall back to flat. Nodes with no sampler
//    (glass, emissive-pulse) likewise get no diffuse.
//
// 4. CRC -> PIXELS.     The .textures TEXS container is decoded by the existing
//    textures.ts (decodeAllInline / decodeStreamtex). We index the decoded set
//    by CRC and hand back the RGBA8 top mip for the diffuse CRC.
//
// Sampler-type override names seen across vehicle assets: *diffuseMap,
// *_texture, *Map, *_tex, *normalMap, *specularMap. We classify a few of these
// (diffuse / normal / specular) by name suffix; everything else is recorded
// generically under params.textures so nothing is silently dropped.

import { BinReader } from './binary/BinReader';
import {
	parseTextures,
	decodeAllInline,
	decodeLargestTexture,
	type DecodedTexture,
	type ParsedTextures,
} from './textures';
import { parseShaderInst, type ParsedShaderInst } from './shaderinst';
import { parseShaders, type ParsedShaders } from './shaders';
import { parseCrcs } from './crcs';

/** A texture override pulled from a shaderinst node (name + resolved CRC). */
export type TextureBinding = {
	/** The override symbol, e.g. "VehiclePaintFast_0_diffuseMap". */
	name: string;
	/** Big-endian texture-name CRC the sampler binds (key into .textures C2NM). */
	crc: number;
	/** RSX sampler slot index from the override (SS in 03 00 00 00 SS …). */
	slot: number;
	/** Classified role derived from the name suffix. */
	role: 'diffuse' | 'normal' | 'specular' | 'other';
};

/** A non-texture (numeric) override constant — kept for params display. */
export type ConstBinding = {
	name: string;
	/** Decoded float scalars (1..4), best-effort. Empty when not float-typed. */
	values: number[];
};

/** Everything resolved for one submesh's material. */
export type SubmeshMaterial = {
	/** Index of the submesh / shaderinst node. */
	index: number;
	/** The material-combo CRC string this submesh binds, e.g. "0x7982350f". */
	comboCrc: string;
	/** Per-node instance CRC (diagnostic). */
	instCrc: number;
	/** Decoded RGBA8 diffuse/albedo for this submesh, when one was resolved. */
	diffuseTexture?: DecodedTexture;
	/** All texture bindings on the node (diffuse + decals + masks). */
	textures: TextureBinding[];
	/** Numeric constant overrides (paintColour, fresnel, …). */
	constants: ConstBinding[];
	/** Free-form params surfaced for the UI / inspector. */
	params: {
		/** Base colour [r,g,b] in 0..1 from a *paintColour / *colour const, if any. */
		baseColor?: [number, number, number];
		/** Whether this combo's symbol list names a diffuseMap sampler. */
		usesDiffuseMap: boolean;
		/** The shader combo's symbol list from the .shaders set, when matched. */
		comboSymbols?: string[];
	};
};

export type BuiltMaterials = {
	/** One entry per submesh (model node), in node order. */
	submeshes: SubmeshMaterial[];
	/** Every decoded texture in the .textures container, indexed by CRC. */
	textureByCrc: Map<number, DecodedTexture>;
	/** Resolved name for each texture CRC (from the C2NM trailer). */
	nameByCrc: Map<number, string>;
	/** True when nodeCount/submesh count matched the shaderinst node count. */
	countsMatched: boolean;
	/** Human-readable note about how the binding resolved. */
	note: string;
};

/** Raw bytes of the four sibling assets (any may be absent). */
export type MaterialAssets = {
	/** The .textures (TEXS) container bytes. */
	textures?: Uint8Array | null;
	/** The .shaderinst (SDRI) bytes. */
	shaderinst?: Uint8Array | null;
	/** The .shaders (SHDR) bytes. */
	shaders?: Uint8Array | null;
	/** The .tex.crcs CRC list bytes (optional). */
	texCrcs?: Uint8Array | null;
	/**
	 * Streamtex bytes paired with a .textures STUB (pixels live there). Optional;
	 * inline single-file .textures (the heli) doesn't need it.
	 */
	streamtex?: Uint8Array | null;
	/** Number of submeshes the model decoded into (for the i<->node pairing). */
	submeshCount?: number;
};

// ---------------------------------------------------------------------------
// Override-value walking (the value layout shaderinst.ts deliberately leaves as
// Partial — we decode just enough to lift texture CRCs and float constants).
// ---------------------------------------------------------------------------

/** Read a big-endian u32 at o (bounds-checked; -1 on overrun). */
function u32be(b: Uint8Array, o: number): number {
	if (o < 0 || o + 4 > b.byteLength) return -1;
	return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Read a big-endian float at o (NaN on overrun). */
function f32be(b: Uint8Array, o: number): number {
	if (o < 0 || o + 4 > b.byteLength) return NaN;
	return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);
}

/** A length-prefixed printable ASCII name at off, or null. */
function lenStringAt(b: Uint8Array, off: number, maxLen = 64): { str: string; next: number } | null {
	const len = u32be(b, off);
	if (len < 1 || len > maxLen || off + 4 + len > b.byteLength) return null;
	const ns = off + 4;
	for (let k = 0; k < len - 1; k++) {
		const c = b[ns + k];
		if (c < 0x20 || c > 0x7e) return null;
	}
	if (b[ns + len - 1] !== 0x00) return null;
	return { str: new TextDecoder('latin1').decode(b.subarray(ns, ns + len - 1)), next: ns + len };
}

/**
 * Classify a texture override's role from its name suffix.
 *
 * Texture overrides are detected by their decoded KIND tag (kind 3), NOT by name
 * (see readNodeOverrides) — many real albedo samplers are named plainly, e.g.
 * skycrane's "Diffuse_IPR_0_diffuse" or trailer's "texture_0_texture", neither of
 * which ends in "map"/"texture". The name only chooses the ROLE.
 *
 * Order matters: reflection/cubemap/environment/normal/specular maps are checked
 * BEFORE the diffuse rule, because a name can legitimately contain "diffuse" as a
 * prefix while being a reflection probe (skycrane "Diffuse_IPR_0_cubemap" is a
 * 32×32 sky cubemap, NOT the body albedo — binding it as diffuse was the prime
 * over-fit to the heli's clean naming).
 */
function classifyRole(name: string): TextureBinding['role'] {
	const n = name.toLowerCase();
	// Non-albedo maps first so a "Diffuse_*_cubemap" can't be mistaken for diffuse.
	if (n.includes('normal') || n.includes('_norm') || n.includes('bump')) return 'normal';
	if (n.includes('specular') || n.includes('_spec') || n.includes('gloss')) return 'specular';
	if (
		n.includes('cubemap') ||
		n.includes('cube') ||
		n.includes('reflect') ||
		n.includes('_ipr') ||
		n.endsWith('ipr') ||
		n.includes('_env') ||
		n.includes('environment') ||
		n.includes('paraboloid')
	) {
		return 'other';
	}
	// Real albedo: ends in "diffuse"/"diffusemap", or a name that is "*diffuse*"
	// with none of the reflection/normal/spec markers above.
	if (n.endsWith('diffuse') || n.endsWith('diffusemap') || n.includes('diffuse') || n.includes('albedo')) {
		return 'diffuse';
	}
	return 'other';
}

/**
 * Decode one override value that starts at `valStart` (just past the name's
 * NUL). Returns the kind, an optional texture CRC + sampler slot (kind 3), and
 * any float scalars (kind 2). The layout, byte-verified on the heli:
 *
 *   <zero padding…> KIND ...
 *     KIND==2: ...  02 00 00 00 SS 00 00 00 NN <f32 × NN>   (numeric const)
 *     KIND==3: ...  03 00 00 00 SS <CRC:u32 BE> 00 00 00 09 (texture sampler)
 *
 * `scanLimit` bounds the search so we never cross into the next override.
 */
function decodeOverrideValue(
	b: Uint8Array,
	valStart: number,
	scanLimit: number,
): { kind: number; crc?: number; slot?: number; floats: number[] } {
	// Skip leading zero bytes to the first non-zero KIND byte.
	let k = valStart;
	const hardEnd = Math.min(scanLimit, valStart + 12);
	while (k < hardEnd && b[k] === 0) k++;
	const kind = k < b.byteLength ? b[k] : -1;

	if (kind === 3) {
		// 03 00 00 00 SS <CRC:4 BE>. The slot word is the u32 at k+1; the CRC is
		// the 4 bytes immediately after it.
		const slot = u32be(b, k + 1);
		const crc = u32be(b, k + 5);
		if (crc > 0) return { kind, crc, slot: slot >= 0 ? slot & 0xff : 0, floats: [] };
		return { kind, floats: [] };
	}

	if (kind === 2) {
		// 02 00 00 00 SS 00 00 00 NN <f32×NN>. Pull NN (component count) and floats.
		const nn = u32be(b, k + 5);
		const floats: number[] = [];
		if (nn >= 1 && nn <= 4) {
			for (let i = 0; i < nn; i++) {
				const v = f32be(b, k + 9 + i * 4);
				if (Number.isFinite(v)) floats.push(v);
			}
		}
		return { kind, floats };
	}

	return { kind, floats: [] };
}

/** One node's decoded overrides (texture + numeric). */
type NodeOverrides = { textures: TextureBinding[]; constants: ConstBinding[] };

/**
 * Walk a shaderinst node's override region [start,end) and lift its texture
 * bindings and numeric constants. We re-scan the bytes (rather than relying on
 * shaderinst.ts's name-only list) because we also need the VALUES.
 */
function readNodeOverrides(b: Uint8Array, start: number, end: number): NodeOverrides {
	const textures: TextureBinding[] = [];
	const constants: ConstBinding[] = [];
	let off = start;
	while (off + 4 <= end) {
		const rec = lenStringAt(b, off, 64);
		// A real override name starts with a letter; the combo CRC ("0x…") and the
		// "unnamed" node name are not overrides — skip anything that doesn't look
		// like a symbol.
		if (rec && rec.str.length >= 3 && /^[A-Za-z]/.test(rec.str)) {
			const name = rec.str;
			const val = decodeOverrideValue(b, rec.next, end);
			// A texture sampler is identified by its decoded KIND tag (3), NOT by the
			// override name — real albedo samplers are often named plainly ("diffuse",
			// "texture_0_texture"). 0xFFFFFFFF is the "no texture bound" sentinel
			// (NemTruckBarrels Low/Mid stub) — skip it so it never resolves a map.
			if (val.kind === 3 && val.crc && val.crc !== 0xffffffff) {
				textures.push({ name, crc: val.crc, slot: val.slot ?? 0, role: classifyRole(name) });
			} else if (val.floats.length > 0) {
				constants.push({ name, values: val.floats });
			}
			off = rec.next;
			continue;
		}
		off++;
	}
	return { textures, constants };
}

/**
 * Locate each node's override region. The .shaderinst node records are
 * inst_crc + lenStr(nodeName) + lenStr(comboCrc) + overrides…, terminated by the
 * next node's inst_crc or the "INSE" tag. We resync to node boundaries by the
 * same signature shaderinst.ts uses: a name string immediately followed by a
 * "0x…"-form combo string.
 */
function nodeOverrideRegions(b: Uint8Array, nodeCount: number): {
	instCrc: number;
	comboCrc: string;
	start: number;
	end: number;
}[] {
	const out: { instCrc: number; comboCrc: string; start: number; end: number }[] = [];
	const isComboStr = (s: string) => /^0x[0-9a-fA-F]+$/.test(s);

	const findRecord = (from: number): number => {
		const limit = b.byteLength - 4;
		for (let off = from; off <= limit; off++) {
			if (b[off] === 0x49 && b[off + 1] === 0x4e && b[off + 2] === 0x53 && b[off + 3] === 0x45) {
				return -1; // INSE
			}
			if (off < 4) continue;
			const nm = lenStringAt(b, off, 64);
			if (!nm || nm.str.length === 0) continue;
			const cc = lenStringAt(b, nm.next, 32);
			if (!cc || !isComboStr(cc.str)) continue;
			return off - 4; // back up to inst_crc
		}
		return -1;
	};

	let cursor = 0x10;
	for (let i = 0; i < nodeCount; i++) {
		const recStart = findRecord(cursor);
		if (recStart < 0) break;
		const instCrc = u32be(b, recStart);
		const nm = lenStringAt(b, recStart + 4, 64);
		if (!nm) break;
		const cc = lenStringAt(b, nm.next, 32);
		if (!cc) break;
		const ovStart = cc.next;
		const nextStart = findRecord(ovStart);
		const end = nextStart < 0 ? b.byteLength - 4 : nextStart;
		out.push({ instCrc, comboCrc: cc.str, start: ovStart, end });
		cursor = nextStart < 0 ? b.byteLength : nextStart;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Texture decode + indexing
// ---------------------------------------------------------------------------

/** Decode every texture in the container and index it by CRC. */
function decodeTextureSet(
	rawTex: Uint8Array,
	parsed: ParsedTextures,
	streamtex?: Uint8Array | null,
): { byCrc: Map<number, DecodedTexture>; nameByCrc: Map<number, string> } {
	const byCrc = new Map<number, DecodedTexture>();
	const nameByCrc = new Map<number, string>();
	for (const d of parsed.descriptors) {
		if (d.name !== undefined) nameByCrc.set(d.crc >>> 0, d.name);
	}

	// Inline single-file containers (the heli) decode every texture directly.
	const inline = decodeAllInline(rawTex, parsed);
	for (const t of inline) {
		if (t.rgba) byCrc.set(t.crc >>> 0, t);
	}

	// Stub container whose pixels live in a .streamtex: decode the largest (the
	// inline path returns nothing for stubs). We can only place the biggest
	// texture reliably from the stream, so index just that one.
	if (byCrc.size === 0 && parsed.isStub && streamtex && streamtex.byteLength > 0) {
		const big = decodeLargestTexture(rawTex, parsed, streamtex);
		if (big?.rgba) byCrc.set(big.crc >>> 0, big);
	}

	return { byCrc, nameByCrc };
}

/**
 * Choose the diffuse/albedo binding for a node, generalized across models.
 *
 * Priority:
 *   1. A name-classified 'diffuse' role (heli "VehiclePaintFast_0_diffuseMap").
 *   2. The lowest-slot NON-special texture (skycrane "Diffuse_IPR_0_diffuse" is
 *      slot 1; its ipr/cubemap are slots 2/3 — albedo is consistently the first
 *      sampler slot across every inspected vehicle/prop). 'other'-role textures
 *      named plainly ("texture_0_texture") qualify; normal/specular/reflection
 *      maps are skipped as last resorts.
 *   3. Any texture at all (last resort, so a normal-only node still shows pixels).
 */
function pickDiffuse(textures: TextureBinding[]): TextureBinding | undefined {
	if (textures.length === 0) return undefined;
	const bySlot = (a: TextureBinding, b: TextureBinding) => a.slot - b.slot;

	// 1. Explicit diffuse role wins (lowest slot if several).
	const diffuse = textures.filter((t) => t.role === 'diffuse').sort(bySlot);
	if (diffuse.length > 0) return diffuse[0];

	// 2. Lowest-slot albedo candidate (anything that isn't a normal/spec/reflection
	//    map). Plain "other" names like texture_0_texture / *_texture land here.
	const albedoish = textures
		.filter((t) => t.role !== 'normal' && t.role !== 'specular')
		.sort(bySlot);
	if (albedoish.length > 0) return albedoish[0];

	// 3. Nothing albedo-like — fall back to the lowest-slot texture so the submesh
	//    still renders with *some* map rather than going flat.
	return [...textures].sort(bySlot)[0];
}

/** Extract a base colour from a *paintColour / *colour float3 constant, if present. */
function pickBaseColor(constants: ConstBinding[]): [number, number, number] | undefined {
	const c =
		constants.find((k) => /paintcolour|paintcolor/i.test(k.name)) ??
		constants.find((k) => /colour|color/i.test(k.name) && k.values.length >= 3);
	if (c && c.values.length >= 3) {
		return [c.values[0], c.values[1], c.values[2]];
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve per-submesh materials from a model's sibling assets.
 *
 * The .shaderinst is the spine: it lists the nodes (== submeshes), each binding
 * a material combo and overriding constants/textures. We decode every texture in
 * the .textures container up front, then for each node pick its diffuse texture
 * by the (name-suffix → first) rule documented at the top of this file.
 *
 * Tolerant of missing files: with no .shaderinst we can't bind textures to
 * submeshes (returns an empty submesh list but still decodes + indexes the
 * texture set, so a viewer can at least show the maps).
 */
export function buildMaterials(assets: MaterialAssets): BuiltMaterials {
	let textureByCrc = new Map<number, DecodedTexture>();
	let nameByCrc = new Map<number, string>();
	let parsedTex: ParsedTextures | null = null;

	if (assets.textures && assets.textures.byteLength >= 0x2c) {
		try {
			parsedTex = parseTextures(assets.textures);
			const decoded = decodeTextureSet(assets.textures, parsedTex, assets.streamtex);
			textureByCrc = decoded.byCrc;
			nameByCrc = decoded.nameByCrc;
		} catch {
			/* leave maps empty — diffuse simply won't resolve */
		}
	}

	// Shader combo symbol map (combo CRC string -> its symbol list), for params.
	let shaders: ParsedShaders | null = null;
	if (assets.shaders && assets.shaders.byteLength >= 0x10) {
		try {
			shaders = parseShaders(assets.shaders);
		} catch {
			/* shaders are diagnostic-only; ignore parse failure */
		}
	}
	const symbolsByCombo = new Map<string, string[]>();
	if (shaders) {
		for (const c of shaders.combos) {
			if (c.comboCrc) symbolsByCombo.set(c.comboCrc, c.symbols);
		}
	}

	// Optional .tex.crcs — surfaced so callers can sanity-check dependency lists.
	if (assets.texCrcs && assets.texCrcs.byteLength % 4 === 0 && assets.texCrcs.byteLength > 0) {
		try {
			const { crcs } = parseCrcs(assets.texCrcs);
			// Record any names we already know; mostly a coverage cross-check.
			for (const c of crcs) {
				if (!nameByCrc.has(c >>> 0) && parsedTex) {
					const d = parsedTex.descriptors.find((x) => (x.crc >>> 0) === (c >>> 0));
					if (d?.name) nameByCrc.set(c >>> 0, d.name);
				}
			}
		} catch {
			/* ignore */
		}
	}

	// Without a .shaderinst we cannot map submeshes -> combos/textures.
	let shaderInst: ParsedShaderInst | null = null;
	if (assets.shaderinst && assets.shaderinst.byteLength >= 0x10) {
		try {
			shaderInst = parseShaderInst(assets.shaderinst);
		} catch {
			shaderInst = null;
		}
	}

	if (!shaderInst) {
		return {
			submeshes: [],
			textureByCrc,
			nameByCrc,
			countsMatched: false,
			note:
				textureByCrc.size > 0
					? `No .shaderinst — decoded ${textureByCrc.size} texture(s) but cannot bind them to submeshes.`
					: 'No .shaderinst and no decodable textures — material resolution unavailable.',
		};
	}

	const regions = nodeOverrideRegions(assets.shaderinst!, shaderInst.nodeCount);
	const submeshes: SubmeshMaterial[] = [];

	for (let i = 0; i < regions.length; i++) {
		const reg = regions[i];
		const { textures, constants } = readNodeOverrides(assets.shaderinst!, reg.start, reg.end);
		const diffuseBinding = pickDiffuse(textures);
		const diffuseTexture = diffuseBinding
			? textureByCrc.get(diffuseBinding.crc >>> 0)
			: undefined;
		const comboSymbols = symbolsByCombo.get(reg.comboCrc);
		submeshes.push({
			index: i,
			comboCrc: reg.comboCrc,
			instCrc: reg.instCrc,
			diffuseTexture,
			textures,
			constants,
			params: {
				baseColor: pickBaseColor(constants),
				usesDiffuseMap:
					textures.some((t) => t.role === 'diffuse') ||
					(comboSymbols?.some((s) => /diffusemap/i.test(s)) ?? false),
				comboSymbols,
			},
		});
	}

	const submeshCount = assets.submeshCount ?? regions.length;
	const countsMatched = submeshCount === shaderInst.nodeCount && regions.length === shaderInst.nodeCount;
	const withDiffuse = submeshes.filter((s) => s.diffuseTexture).length;

	return {
		submeshes,
		textureByCrc,
		nameByCrc,
		countsMatched,
		note:
			`Resolved ${submeshes.length}/${shaderInst.nodeCount} node material(s); ` +
			`${withDiffuse} have a diffuse texture. ` +
			(countsMatched
				? `Submesh count (${submeshCount}) matches node count — submesh[i] uses node[i].`
				: `Submesh count (${submeshCount}) != node count (${shaderInst.nodeCount}); ` +
				  `pairing is index-clamped (best-effort).`),
	};
}

/**
 * Convenience: get the material for submesh `i`, clamping to the available
 * node materials (so an extra geometry buffer reuses the last node's material
 * rather than going untextured). Returns undefined when no materials resolved.
 */
export function materialForSubmesh(
	built: BuiltMaterials,
	i: number,
): SubmeshMaterial | undefined {
	if (built.submeshes.length === 0) return undefined;
	if (i < built.submeshes.length) return built.submeshes[i];
	return built.submeshes[built.submeshes.length - 1];
}
