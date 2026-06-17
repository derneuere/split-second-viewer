# Split/Second Steward

A browser-based, **read-only MVP** editor for **Split/Second** (PS3, big-endian)
game data. It opens game archives and loose files into a **Workspace**, browses a
unified typed **Resource** tree, and decodes + visualizes members. It is the
Split/Second equivalent of the Burnout `paradise-bundle-steward` editor, pruned
and adapted to Split/Second's container and platform.

> Status: scaffold (WP-0). The registry/Workspace/.ark seams are in place and
> CLI-validated. Feature work packages (textures, model, telemetry, XML/params,
> the full handler set) build on top of this foundation.

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

## How to run

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
