# Split/Second Steward

A browser-based, **read-only MVP** editor for **Split/Second** (PS3, big-endian)
game data. It opens game archives and loose files into a **Workspace**, browses a
unified typed **Resource** tree, and decodes + visualizes members. It is the
Split/Second equivalent of the Burnout `paradise-bundle-steward` editor, pruned
and adapted to Split/Second's container and platform.

> Status: registry + viewport dispatcher integrated. **31 resource handlers**
> are registered and CLI-validated against real devkit data, the Workspace routes
> every selection to a bespoke viewer (or the Hex fallback), and the four gates —
> `tsc`, `build`, `test:run` (33 files / 186 tests), `lint` — are green. The
> remaining work package is full `.ark` member round-trip + `nameHash` ->
> filename resolution (see [Supported formats](#supported-formats)).

## Platform & formats

- **PS3, big-endian by default.** `BinReader`/`BinWriter` default
  `littleEndian = false`. The two LE-on-PS3 container exceptions (`.gfx`, `.bik`)
  opt in explicitly.
- **Containers:** `.ark` — a paired `<Level>.Static.ark` + `<Level>.Stream.ark`.
  One logical **Archive** = the pair; each file is self-contained (offsets index
  their own file). Static members are uncompressed; Stream members are
  deflate-packed (inflate via `pako` — boundary framing is a follow-up WP).
- **Loose files** are first-class too: most devkit data ships as individual
  `.model / .textures / .track / .params / .crcs / ...` files. Both an `.ark`
  member and a loose file become a **Resource** in the same tree.

## Supported formats

31 `ResourceHandler`s are registered (`src/lib/core/registry/index.ts`). Each is
routed by **extension** when loose, or **magic bytes** when it appears as an
unresolved `.ark` member. `Caps` = `R` (read/parse) and `W` (write-back, i.e. a
byte round-trip via the CLI `roundtrip`/`stress` commands); read-only handlers
decode but do not yet re-emit.

| Key | Format | Category | Extension(s) | Caps | Viewer |
| --- | --- | --- | --- | --- | --- |
| `crcs` | Texture CRC List | Data | `.crcs` | R W | Config |
| `splitlength` | Route Split Lengths | World | `.splitlength` | R | World |
| `linkorigins` | Route Link Origins | World | `.linkorigins` | R | World |
| `sideways` | Route Sideways Links | World | `.sideways` | R | World |
| `checkpoints` | Route Checkpoints | World | `.checkpoints` | R | World |
| `track` | TrackTivity Telemetry | World | `.track` | R W | World |
| `nis` | TrackLogic Route Manifest | World | `.nis` | R W | World |
| `gbx` | Light-Rig Overrides | World | `.gbx` | R W | World |
| `entities` | Catnip Entities | World | `.entities` | R W | World |
| `timelineInfo` | Timeline-Particle Index | World | `.timelineinfo` | R W | World |
| `logicinfo` | Track Logic Info | World | `.logicinfo` | R W | World |
| `sectorInfo` | Sector Partition | World | `.sectorinfo` | R | World |
| `names` | Name Table | Data | `.names` | R W | Config |
| `filenames` | File Name Table | Data | `.filenames` | R W | Config |
| `parts` | Vehicle Part Hierarchy | Data | `.parts` | R | Config |
| `dct` | Localisation Dictionary | Data | `.dct` | R | Config |
| `global_regs` | Global Shader Registers | Data | `.global_regs` | R | Config |
| `params` | Tuning Params | Data | `.params` | R | Config |
| `xml` | XML Config | Data | `.xml` | R W | Config |
| `powerplays` | Powerplays (XML) | Data | `.powerplays` | R W | Config |
| `triggers` | Triggers (XML) | Data | `.triggers` | R W | Config |
| `textures` | Texture Set (TEXS) | Graphics | `.textures` | R | Texture |
| `streamtex` | Streamed Texture Payload | Graphics | `.streamtex` | R | Texture |
| `model` | Model (Crayon2 mesh) | Graphics | `.model`, `.model.stream` | R | Mesh |
| `skel` | Skeleton (ftsc rig) | Graphics | `.skel` | R | Mesh |
| `deform` | Vehicle Deformation (DFM2) | Graphics | `.deform` | R | Mesh |
| `mcl` | Material Clip | Graphics | `.mcl` | R | Mesh |
| `shaders` | Shader Set (SHDR) | Graphics | `.shaders` | R | Config |
| `shaderinst` | Shader Instance (SDRI/INSS) | Graphics | `.shaderinst` | R | Config |
| `fxc` | FX Compiled | Graphics | `.fxc` | R | Config |
| `havok` | Havok Packfile | Physics | `.phys`, `.maincoll`, `.hkcoll`, `.hkpps`, `.hkrbs` | R | Config |

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
npm run ark -- list      <Level.Static.ark> [Level.Stream.ark]
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
      ArkArchive.ts header + TOC parse, storedLen derivation, pako inflate stub
      nameHash.ts   nameHash -> filename stub + magic-sniff fallback
    loose/          ingest a loose File -> Resource by extension
    crcs.ts         per-format parser/writer modules (no registry import)
    types.ts        ArkHeader / ArchiveMember / ParsedArchive / ResourceRef
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

- Split/Second RE wiki: `../wiki/` (format pages: `format-ark.html`,
  `format-model.html`, `format-textures.html`, `format-track.html`,
  `engine-overview.html`).
- Port brief: `../_reference/PORT-BRIEF.md`.
- Domain language: `../_reference/paradise-bundle-steward/CONTEXT.md`.
