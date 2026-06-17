# Split/Second Steward

A browser-based editor for **Split/Second** (PS3, big-endian) game data. It opens
game archives and loose files into a **Workspace**, browses a unified typed
**Resource** tree, decodes + visualizes members, and **writes 23 formats back
byte-for-byte**. It is the Split/Second equivalent of the Burnout
`paradise-bundle-steward` editor, pruned and adapted to Split/Second's container
and platform.

> Status: registry + viewport dispatcher + **real `.ark` archive extraction** +
> **byte-exact write-back** + an **embedded RE wiki**. **32 resource handlers** are
> registered and CLI-validated against real devkit data; **23 of them round-trip
> write-back byte-for-byte** (see [Supported formats](#supported-formats)). The
> Workspace opens a `.ark` pair, routes every member to a bespoke viewer (or the
> Hex fallback) by sniffed type, supports per-member **Download** + per-archive
> **Extract all**, and ships the Split/Second reverse-engineering wiki inline at
> **`/docs`** (see [Embedded docs](#embedded-docs)). The `.ark` extractor is
> validated **byte-for-byte** against the authoritative Python tool
> (`_tools/ark_extract_full.py`) — all 864 written members of `airport_test_03`
> match exactly. The four gates — `tsc`, `build`, `test:run` (36 files / 280
> tests), `lint` — are green. The one remaining RE item is the full `nameHash`
> crack (members not in the Rosetta corpus stay `<hash8>.<ext>` — see
> [Naming](#naming-the-ark-namehash)).

## Platform & formats

- **PS3, big-endian by default.** `BinReader`/`BinWriter` default
  `littleEndian = false`. The two LE-on-PS3 container exceptions (`.gfx`, `.bik`)
  opt in explicitly.
- **Containers:** `.ark` — a paired `<Level>.Static.ark` + `<Level>.Stream.ark`.
  One logical **Archive** = the pair; each file is self-contained (offsets index
  their own file). Members are stored **raw** — there is **no** zlib/deflate step
  in the `.ark` pipeline. The only transform is stripping a 12-byte Stream
  sub-resource frame (`00000000 | innerSize | 00000000`) from framed members;
  Static serialized objects and unframed GPU textures are byte-identical to disk.
  (`getMemberPayload` still *attempts* a real `pako` inflate first, guarded by a
  genuine `0x78 01/9C/DA` zlib header, so the routine stays correct if a member
  ever is compressed.) A member's on-disk length is the **offset delta** to the
  next distinct non-placeholder offset; size-0 TOC entries are placeholders and
  never bound a live member.
- **Loose files** are first-class too: most devkit data ships as individual
  `.model / .textures / .track / .params / .crcs / ...` files. Both an `.ark`
  member and a loose file become a **Resource** in the same tree.

## Supported formats

32 `ResourceHandler`s are registered (`src/lib/core/registry/index.ts`). Each is
routed by **extension** when loose, or **magic bytes** when it appears as an
unresolved `.ark` member. `Caps` = `R` (read/parse) and `W` (write-back). A `W`
handler is **byte-exact round-trip-capable**: `writeRaw(parseRaw(bytes)) === bytes`
for every real devkit file (a registry contract test enforces that every `W`
handler ships a `writeRaw`, and the per-format suites prove the byte equality
against the devkit corpus). **23 of the 32 handlers are `R W`** — verified here
against real files, e.g. `crcs` over 1703 files, `splitlength` and `linkorigins`
over 18 files each, all 0 mismatches. Read-only handlers decode but do not yet
re-emit.

| Key | Format | Category | Extension(s) | Caps | Viewer |
| --- | --- | --- | --- | --- | --- |
| `crcs` | Texture CRC List | Data | `.crcs` | R W | Config |
| `splitlength` | Route Split Lengths | World | `.splitlength` | R W | World |
| `linkorigins` | Route Link Origins | World | `.linkorigins` | R W | World |
| `sideways` | Route Sideways Links | World | `.sideways` | R W | World |
| `checkpoints` | Route Checkpoints | World | `.checkpoints` | R W | World |
| `track` | TrackTivity Telemetry | World | `.track` | R W | World |
| `nis` | TrackLogic Route Manifest | World | `.nis` | R W | World |
| `gbx` | Light-Rig Overrides | World | `.gbx` | R W | World |
| `entities` | Catnip Entities | World | `.entities` | R W | World |
| `timelineInfo` | Timeline-Particle Index | World | `.timelineinfo` | R W | World |
| `logicinfo` | Track Logic Info | World | `.logicinfo` | R W | World |
| `sectorInfo` | Sector Partition | World | `.sectorinfo` | R W | World |
| `names` | Name Table | Data | `.names` | R W | Config |
| `filenames` | File Name Table | Data | `.filenames` | R W | Config |
| `parts` | Vehicle Part Hierarchy | Data | `.parts` | R W | Config |
| `dct` | Localisation Dictionary | Data | `.dct` | R W | Config |
| `global_regs` | Global Shader Registers | Data | `.global_regs` | R W | Config |
| `params` | Tuning Params | Data | `.params` | R W | Config |
| `xml` | XML Config | Data | `.xml` | R W | Config |
| `powerplays` | Powerplays (XML) | Data | `.powerplays` | R W | Config |
| `triggers` | Triggers (XML) | Data | `.triggers` | R W | Config |
| `textures` | Texture Set (TEXS) | Graphics | `.textures` | R | Texture |
| `streamtex` | Streamed Texture Payload | Graphics | `.streamtex` | R | Texture |
| `model` | Model (Crayon2 mesh) | Graphics | `.model`, `.model.stream` | R | Mesh |
| `skel` | Skeleton (ftsc rig) | Graphics | `.skel` | R | Mesh |
| `deform` | Vehicle Deformation (DFM2) | Graphics | `.deform` | R W | Mesh |
| `mcl` | Material Clip | Graphics | `.mcl` | R | Mesh |
| `shaders` | Shader Set (SHDR) | Graphics | `.shaders` | R | Config |
| `shaderinst` | Shader Instance (SDRI/INSS) | Graphics | `.shaderinst` | R | Config |
| `fxc` | FX Compiled | Graphics | `.fxc` | R | Config |
| `havok` | Havok Packfile | Physics | `.phys`, `.maincoll`, `.hkcoll`, `.hkpps`, `.hkrbs` | R | Config |

## `.ark` archive browsing & level extraction

Opening a `<Level>.Static.ark` + `<Level>.Stream.ark` pair (drag-drop or file
open) parses both TOCs into one **Archive** of typed members. Because the
`nameHash` is not yet computable (see [Naming](#naming-the-ark-namehash)), each
member's content type is **sniffed** in one pass at parse time
(`detectMemberType` in `src/lib/core/ark/ArkArchive.ts`):

- **magic** where one exists (serialized-object `02 00 00 08` → `.sobj`, Havok,
  FSB, GFX/CFX, DDS, PNG, BIK, XML), checked on the de-framed payload then the
  raw blob;
- else a framed Stream sub-resource → `.geo` (geometry/vertex/index stream);
- else a `0001xxxx`-header or mip-sized blob, or any unframed Stream blob →
  `.gputex` (PS3 swizzled/DXT GPU texture);
- else `.bin` (unknown).

This mirrors `classify()` in `_tools/ark_extract_full.py` exactly. On
`airport_test_03` the pair yields **866** TOC entries / **864** written members
(2 are size-0 placeholders): **365 model** (244 `.sobj` + 121 `.geo`) +
**499 texture** (`.gputex`), with **121** framed and **743** raw members.

**In the UI**, a selected member routes to a viewer by its sniffed category —
`model → MeshViewer`, `texture → TextureViewer`, unknown → Hex — and exposes:

- **Download** (Inspector) — the member's de-framed payload as
  `<real-name>` (Rosetta) or `<hash8>.<ext>`, via a zero-dependency
  Blob + `<a download>` helper (`src/lib/download.ts`);
- **Extract all** (tree, per Archive) — every member downloaded sequentially.

**On the CLI**, `extract` mirrors `ark_extract_full.py` (writes
`Static/` + `Stream/` member files + a `manifest.json`), and `list` prints the
merged TOC with a type histogram and naming stats:

```bash
npm run ark -- list    <Level.Static.ark> [Level.Stream.ark]
npm run ark -- extract <Level.Static.ark> [Level.Stream.ark] [--out DIR] [--limit N]
```

The TS extractor is verified **byte-for-byte** against `ark_extract_full.py`: a
`diff -rq` of both tools' `Static/` and `Stream/` output trees for
`airport_test_03` is empty (all 864 written members identical).

### Naming: the `.ark` `nameHash`

The 32-bit TOC `nameHash` is a **GF(2)-affine** hash of a resource-ID string
(`"<archiveTag>|<relpath>"`) whose closed form is **not yet cracked**, so member
names **cannot be computed** from scratch. The only source of real names is the
**Rosetta corpus** — **309** hash→name pairs harvested from the UI/texture packs,
embedded as `ROSETTA_NAMES` (`src/lib/core/ark/rosettaNames.ts`, generated by
`scripts/gen-rosetta.ts` from `_tools/texs_rosetta_corpus.json`). `resolveName()`
returns the real name when the hash is in the corpus (e.g. `0x8c5ecfcc →
Bootup/ESRB_rating`), else `null`; unresolved members fall back to
`<hash8>.<detected-ext>`.

`computeNameHash()` (`src/lib/core/ark/nameHash.ts`) is a documented stub
recording the proven facts (GF(2)-affine; per-character contribution universal by
distance-from-end; within-byte LFSR poly `0xDB710641`; ruled out as any standard
CRC32/FNV/djb2/Murmur). **Open future work:** crack the affine matrix, then build
a reverse `name → hash` map inside `resolveName()` — every consumer already routes
through it, so naming *all* members becomes a one-line change.

## Viewers

`ViewportRouter` (`src/components/viewers/ViewportRouter.tsx`) guard-parses the
selected resource and dispatches to one bespoke viewer per **viewport family**.
The mapping is a pure function — `viewportFor(handler)` in
`src/components/viewers/viewportFamily.ts` — derived from the handler's
`category` enum plus a small set of keys, so it is unit-tested headlessly
(`viewportFamily.test.ts`). A missing handler, a parse failure, or an unmapped
family always falls back to the generic Hex view, which never throws.

| Viewer | Family | Handles | Routed by |
| --- | --- | --- | --- |
| `TextureViewer` | `texture` | `textures`, `streamtex` | key set |
| `MeshViewer` | `mesh` | `model`, `skel`, `deform`, `mcl` | key set |
| `WorldViewer` | `world` | every `World`-category handler (telemetry `.track`, routes, entities, sectors, NIS, light rigs, …) | `category === 'World'` |
| `ConfigViewer` | `config` | `Data` + `Physics` handlers, plus the shader sets (`shaders`/`shaderinst`/`fxc`) and `crcs` — generic field table | `category` + shader key set |
| `HexView` | `binary` | no handler, parse failure, or any unmapped family | fallback |

## Embedded docs

The Split/Second **reverse-engineering wiki** (the navigable HTML reference built
from devkit NPXX00575 — engine, formats & systems) ships **inside the app**. It is
copied verbatim into `public/wiki/` (64 pages + `assets/`) and served by Vite at
`/wiki/`, so it is bundled into `dist/` on every `npm run build` (no external
folder dependency at runtime).

- **`/docs` route** (`src/pages/Docs.tsx`) renders the wiki in a full-pane
  `<iframe>` whose base URL is `/wiki/`, so the wiki's own sidebar, search, and
  internal links keep working untouched. `Home.tsx` and `AppHeader.tsx` link to it.
- **Deep-linking:** `/docs?page=format-model.html` points the iframe straight at
  that page. `safePage()` only serves bare same-origin `*.html` names (rejects
  `..`, absolute, and protocol-relative URLs).
- **Inspector "Format docs" link** (`src/components/Inspector.tsx`) resolves the
  selected resource to its exact wiki page via the
  `docLinks` map (`src/lib/core/registry/docLinks.ts`) — `docUrlForHandler()` tries
  the handler key, then its extensions, then its category; `docUrlForName()`
  handles loose files with no resolved handler (e.g. `car.model.stream →
  format-model.html`). Every map target is a page that **exists** under
  `public/wiki` — a headless contract test (`docLinks.test.ts`) asserts every
  registered handler resolves to an on-disk page, so no broken "Format docs" link
  can ship.

## How to run

> **Node 18+ required** (Vite 5 / Vitest 2 / tsx). `package.json` pins
> `engines.node >= 20`. If your default shell Node is older (e.g. v16), use an
> fnm/nvm-managed Node 20+ — a `.node-version` is committed so `fnm`/`nvm` pick
> it up automatically in this directory.

```bash
npm install

# dev server (Vite, port 8080)
npm run dev

# production build + preview
npm run build
npm run preview

# tests (vitest, Node environment)
npm run test        # watch
npm run test:run    # once

# lint / typecheck
npm run lint
npx tsc -p tsconfig.app.json --noEmit

# headless CLI over the .ark parser + handler registry
npm run ark -- list      <Level.Static.ark> [Level.Stream.ark]   # TOC + type histogram + naming stats
npm run ark -- extract   <Level.Static.ark> [Level.Stream.ark] [--out DIR] [--limit N]   # write members + manifest.json
npm run ark -- parse     <file> [--type <key>]
npm run ark -- roundtrip <file> [--type <key>]
npm run ark -- stress    <file> [--type <key>] [--scenario <name>]
```

Tests read **real sample files** from the devkit data root when present
(`SS_DATA_ROOT`, default
`D:\Program Files (x86)\rpcs3\dev_hdd0\game\NPXX00575\USRDIR\Deferred`). Without
the devkit they fall back to inline byte fixtures via
`describe.skipIf(!hasDataRoot)`.

## Architecture overview

The core is **registry-first and UI-agnostic**: every format is a
`ResourceHandler` (parser + writer + capabilities + fixtures + stress scenarios)
that is *Node-importable*. The CLI and vitest exercise handlers with zero React
involvement; the UI is a thin shell over the same registry.

```
src/
  lib/core/
    binary/         BinReader.ts / BinWriter.ts   (big-endian default)
    registry/
      handler.ts    ResourceHandler<T> contract + ResourceCtx + ssCtx()
      index.ts      registry array + byKey / byExtension / byMagic lookup
      handlers/     ONE FILE PER FORMAT (crcs.ts is the worked example)
    ark/
      ArkArchive.ts header + TOC parse, storedLen derivation, getMemberPayload
                    (raw / frame-strip / guarded zlib) + type sniff + extractMember
      nameHash.ts   nameHash -> name via Rosetta + memberFileName + computeNameHash stub
      rosettaNames.ts  309 hash->name pairs (generated; scripts/gen-rosetta.ts)
    loose/          ingest a loose File -> Resource by extension
    crcs.ts         per-format parser/writer modules (no registry import)
    types.ts        ArkHeader / ArchiveMember / ParsedArchive / ResourceRef
  lib/
    download.ts     zero-dep Blob download (per-member + Extract all)
  context/
    WorkspaceContext.tsx   loaded Archives + loose files as ONE Resource tree,
                           selection + per-node visibility (undo: TODO)
  components/
    layout/         AppHeader + resizable 3-pane WorkspaceLayout
    ResourceTree.tsx        virtualized unified tree
    Inspector.tsx           metadata + handler describe()
    hexviewer/HexView.tsx   generic fallback viewer (every Resource gets one)
    ui/             lean shadcn/ui subset
  pages/
    Home.tsx                landing + drag-drop / file open
    WorkspaceEditor.tsx     wires tree + viewport + inspector (HexView fallback)
scripts/
  ark-cli.ts        Node CLI dispatcher over the registry + .ark parser
                    (list / extract / parse / roundtrip / stress)
  gen-rosetta.ts    regenerate rosettaNames.ts from texs_rosetta_corpus.json
```

**Dependency rule (load-bearing):** parser modules (`src/lib/core/*.ts`) must
never import the registry or React. The registry imports the parsers, keeping
the graph acyclic and the handlers headless. Adding a format = one parser module
+ one handler file + one line in `registry/index.ts`.

### Adding a handler

Use `src/lib/core/registry/handlers/crcs.ts` as the template:

1. Write the pure parser/writer in `src/lib/core/<key>.ts`.
2. Wrap it in `src/lib/core/registry/handlers/<key>.ts` (parser + caps +
   `describe` + real-file `fixtures` + `stressScenarios`).
3. Register it: one import + one array entry in `registry/index.ts`.
4. CLI-validate headlessly (`npm run ark -- roundtrip ...`, `stress ...`) before
   building any bespoke UI.

## Reference

- Split/Second RE wiki: **bundled** at `public/wiki/` and viewable in-app at
  `/docs` (format pages: `format-ark.html`, `format-model.html`,
  `format-textures.html`, `format-track.html`, `engine-overview.html`).
- Port brief: `../_reference/PORT-BRIEF.md`.
- Domain language: `../_reference/paradise-bundle-steward/CONTEXT.md`.
