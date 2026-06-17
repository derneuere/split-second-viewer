# Split/Second Viewer

A browser-based viewer/editor for **Split/Second** (PS3, big-endian) game data.
Point it at your **whole game install folder** once; it walks the folder
structure, loads any file **on demand**, decodes and visualizes it, browses
`.ark` archives, and **writes 23 formats back byte-for-byte**. It is the
Split/Second equivalent of the Burnout `paradise-bundle-steward` editor, pruned
and adapted to Split/Second's containers and platform.

Byte-level format detail lives in the **embedded RE wiki** at **`/docs`** (see
[Embedded docs](#embedded-docs)) — this README stays high-level.

## Quick start

> **Node 18+ required** (Vite 5 / Vitest 2 / tsx). `package.json` pins
> `engines.node >= 20`; a `.node-version` is committed so `fnm`/`nvm` pick the
> right Node in this directory. If your shell default is older (e.g. v16):
> `fnm use 22` (or `nvm use`) and confirm `node -v` >= 18.

```bash
npm install

npm run dev        # Vite dev server (hot-reload; commonly :5173)
npm run build      # production build to dist/
npm run preview    # serve the production build

npm run test       # vitest (watch)
npm run test:run   # vitest (once)
npm run lint
npx tsc -p tsconfig.app.json --noEmit
```

Headless CLI over the same registry + `.ark` parser (no React):

```bash
npm run ark -- list      <Level.Static.ark> [Level.Stream.ark]   # TOC + type histogram + naming stats
npm run ark -- extract   <Level.Static.ark> [Level.Stream.ark] [--out DIR] [--limit N]
npm run ark -- parse     <file> [--type <key>]
npm run ark -- roundtrip <file> [--type <key>]
```

Tests read **real devkit files** when present (`SS_DATA_ROOT`, default
`D:\Program Files (x86)\rpcs3\dev_hdd0\game\NPXX00575\USRDIR\Deferred`); without
the devkit they fall back to inline byte fixtures via `describe.skipIf`.

## Folder-picker workflow

The app is **one primary page** (`/` = the Workspace editor). On first load a
**start dialog** (`StartScreen` in `src/pages/WorkspaceEditor.tsx`) offers:

- **Select folder** — uses the **File System Access API**
  (`window.showDirectoryPicker`, Chromium only) to pick your install directory
  (e.g. `…\USRDIR\Deferred`, or the game root). `enumerateDirectory`
  (`src/lib/core/fs/directory.ts`) walks the handle tree **structure-only**
  (folders + filenames, no bytes), so even a ~15k-file install loads instantly.
  Empty folders are pruned and `.Stream.ark` twins fold into their `.Static.ark`
  sibling.
- **Drag-drop / Open files** — the fallback (and the only path on non-Chromium
  browsers): drop a `.Static.ark` with its `.Stream.ark` to open the pair, or any
  loose file.

Once a folder is loaded, **bytes are read lazily on selection**: clicking a leaf
calls `getResourceBytes(ref)`, which reads + caches the file from its directory
handle, then routes the bytes through the handler → viewport. Selecting an `.ark`
leaf opens the archive in place (pairing its Static/Stream sibling) under an
**"Opened archives"** group. Nothing is uploaded — all reads are local.

## Features & format support

`Caps` = `R` (read/parse), `W` (byte-exact write-back). A `W` handler satisfies
`writeRaw(parseRaw(bytes)) === bytes` for every real devkit file (a registry
contract test enforces it). **33 handlers registered; 23 round-trip `R W`.** For
the byte-level layout of any format, follow the linked wiki page.

| Format | Category | Ext(s) | Caps | Wiki |
| --- | --- | --- | --- | --- |
| Archive (`.ark` Static/Stream pair) | Container | `.ark` | R | [format-ark](public/wiki/format-ark.html) |
| Texture Set (TEXS) | Graphics | `.textures` `.low.textures` | R | [format-textures](public/wiki/format-textures.html) |
| Streamed Texture Payload | Graphics | `.streamtex` | R | [format-streamtex](public/wiki/format-streamtex.html) |
| Model (Crayon2 mesh, base + skinned `02 01 00 08`) | Graphics | `.model` `.model.stream` | R | [format-model](public/wiki/format-model.html) |
| Skeleton | Graphics | `.skel` | R | [format-skel](public/wiki/format-skel.html) |
| Vehicle Deformation (DFM2) | Graphics | `.deform` | R W | [format-deform](public/wiki/format-deform.html) |
| Material Clip | Graphics | `.mcl` | R | [format-mcl](public/wiki/format-mcl.html) |
| Shader Set (SHDR) | Graphics | `.shaders` | R | [format-shaders](public/wiki/format-shaders.html) |
| Shader Instance (SDRI/INSS) | Graphics | `.shaderinst` | R | [format-shaders](public/wiki/format-shaders.html) |
| FX Compiled (RSX microcode) | Graphics | `.fxc` | R | [format-fxc](public/wiki/format-fxc.html) |
| Havok Packfile | Physics | `.phys` `.maincoll` `.hkcoll` `.hkpps` `.hkrbs` | R | [format-havok](public/wiki/format-havok.html) |
| Bink Video (FMV) | Graphics | `.bik` | R | [format-bik](public/wiki/format-bik.html) |
| Texture CRC List | Data | `.crcs` | R W | [format-crcs](public/wiki/format-crcs.html) |
| Tuning Params · XML · Powerplays · Triggers | Data | `.params` `.xml` `.powerplays` `.triggers` | R W | [data-params](public/wiki/data-params.html) |
| Name / File / Part / Dict / Global-reg tables | Data | `.names` `.filenames` `.parts` `.dct` `.global_regs` | R W | [format-names](public/wiki/format-names.html) |
| Route & track world data | World | `.track` `.nis` `.gbx` `.entities` `.checkpoints` `.splitlength` `.linkorigins` `.sideways` `.timelineinfo` `.logicinfo` `.sectorinfo` | R W | [format-track](public/wiki/format-track.html) |

The Workspace routes each selected file/member to a bespoke viewer by sniffed
type (or the Hex fallback), and offers per-member **Download** and per-archive
**Extract all**.

### Bink video + audio decode (highlights)

- **`.bik` movies play in-browser with sound** via a from-scratch **pure-TypeScript
  Bink 1 decoder** (`src/lib/core/bink/`) — no ffmpeg, no transcoding, no WASM. It is
  a faithful port of the FFmpeg-derived xoreos decoder.
- **Video** — a 32-bit-LE LSB-first bit reader, the 16 Huffman codebooks, all nine
  data-source bundles, every block type (skip/motion/run/residue/intra/fill/inter/
  pattern/raw + the 16×16 scaled variants), the Bink integer IDCT, and BT.601
  YUV→RGBA. Output is **byte-for-byte identical to ffmpeg's reference decoder** (a
  guarded vitest regression decodes real devkit clips and diffs the YUV planes).
  ~49 fps decode for 1280×720, ~150 fps for 256×256.
- **Audio** — `binkaudio_dct` / `binkaudio_rdft` with a ported split-radix
  **FFT/RDFT/DCT** (`dsp.ts`, twiddle tables generated at runtime), band
  quantisation, and float overlap-add. Decoded up front to an `AudioBuffer` and
  played through the Web Audio API in sync with the video. Because Bink audio is
  float-FFT based (and ffmpeg uses a SIMD float FFT), the PCM is **sample-accurate
  to within 1 LSB and ≥99.8% bit-exact** against ffmpeg — an inaudible (−90 dB)
  difference; a guarded vitest regression pins `maxDiff ≤ 1`.
- The `BikViewer` drives a `requestAnimationFrame` play/seek/loop/mute transport.

### Texture & model decode (highlights)

- **Textures** — full BCn decoders to RGBA8 (**DXT1/BC1, DXT3/BC2, DXT5/BC3**)
  plus **A8R8G8B8** (the GCM `0xAA1B` little-endian ARGB → B,G,R,A byte order,
  verified against real skydome/ColorCubes assets), a **PS3 RSX Morton
  de-swizzle** path gated behind a linear-vs-swizzled coherence heuristic
  (shipped data is linear), inline multi-texture layouts, and `.textures` stubs
  whose pixels live in a sibling `.streamtex`.
- **Models** — `.model.stream` (12-byte header + 4×half-float vertices +
  `0xFFFF` tri-strips), base `.model` via its explicit **VB table** (`0x24`-strided
  `{size, stride, vcount}`) + **32-byte draw-call/index table**, with vertex-format
  auto-detect (half-float P4 vs float32 P3+UV), and the **skinned variant**
  (`02 01 00 08`, `0x48`-strided records) emitted as positions-only point meshes
  (its triangle topology lives in the un-cracked Havok skinning section).

See [format-textures](public/wiki/format-textures.html) and
[format-model](public/wiki/format-model.html) for byte layouts.

## `.ark` archives & extraction

A `<Level>.Static.ark` + `<Level>.Stream.ark` pair parses both 16-byte-entry
TOCs into one **Archive** of typed members. Members are stored **raw** (no
zlib/deflate); the only transform is stripping a 12-byte Stream sub-resource
frame from framed members. A member's on-disk length is the **offset delta** to
the next distinct non-placeholder offset (size-0 TOC entries are placeholders).
Each member's content type is **sniffed** in one pass (`detectMemberType` in
`src/lib/core/ark/ArkArchive.ts`), mirroring `classify()` in
`_tools/ark_extract_full.py`. The TS extractor is verified **byte-for-byte**
against that Python tool (all 864 written members of `airport_test_03` match).

### nameHash status: cracked, offline-blocked

The 32-bit TOC `nameHash` is a **reflected table-driven CRC**:
`H = (H >> 8) ^ T[(H ^ c) & 0xFF]` over the resource-ID string, **seed
`0xDEAFD00D`**, polynomial **`0xDB710641`**, **no final XOR**. The algorithm
itself is **solved** (see [format-ark → Naming](public/wiki/format-ark.html)).

It is **offline-blocked**, not unknown: the 256-entry table `T` is built at
runtime into the EBOOT's BSS, so computing a hash from a name needs that table
(or the resource-ID corpus that pins every byte of it) — neither is available
offline yet. Until then, real names come only from the **Rosetta corpus** (309
hash→name pairs harvested from the UI/texture packs, `ROSETTA_NAMES` in
`src/lib/core/ark/rosettaNames.ts`); `resolveName()` returns the real name when
the hash is in the corpus, else members fall back to `<hash8>.<detected-ext>`.
`computeNameHash()` (`src/lib/core/ark/nameHash.ts`) is the documented seam where
the table-CRC implementation drops in once `T` is recovered — every consumer
already routes through `resolveName()`, so naming all members becomes a one-line
change.

## Architecture

The core is **registry-first and UI-agnostic**: every format is a
`ResourceHandler` (parser + writer + caps + fixtures + stress scenarios) that is
*Node-importable*. The CLI and vitest exercise handlers with zero React; the UI
is a thin shell over the same registry. This mirrors `paradise-bundle-steward`'s
**Workspace / Archive / Resource / Handler / Viewport** model:

- **Workspace** (`src/context/WorkspaceContext.tsx`) — the directory tree (lazy
  bytes) + opened Archives + loose files as one Resource tree.
- **Archive** (`src/lib/core/ark/ArkArchive.ts`) — header + TOC parse, stored-len
  derivation, `getMemberPayload` (raw / frame-strip / guarded zlib), type sniff.
- **Resource** — any tree leaf (an `.ark` member or a loose file), routed by
  extension when loose or magic bytes when an unresolved member.
- **Handler** (`src/lib/core/registry/`) — one file per format under
  `handlers/`; the pure parser/writer lives in `src/lib/core/<key>.ts` and never
  imports the registry or React (acyclic rule). Adding a format = one parser
  module + one handler file + one line in `registry/index.ts`.
- **Viewport** (`src/components/viewers/`) — `ViewportRouter` dispatches to one
  bespoke viewer per family (`TextureViewer`, `MeshViewer`, `WorldViewer`,
  `ConfigViewer`, `BikViewer`) via the pure `viewportFor(handler)`; a missing handler or parse
  failure always falls back to the never-throwing `HexView`.

```
src/lib/core/
  binary/     BinReader.ts / BinWriter.ts        (big-endian default)
  registry/   handler.ts (contract) · index.ts (lookup) · handlers/<key>.ts
  ark/        ArkArchive.ts · nameHash.ts · rosettaNames.ts
  fs/         directory.ts (File System Access adapter; FS API + types only)
  loose/      ingest a loose File -> Resource by extension
  <key>.ts    pure per-format parser/writer modules (e.g. model.ts, textures.ts)
```

## Embedded docs

The Split/Second **reverse-engineering wiki** (built from devkit NPXX00575 —
engine, formats & systems) ships **inside the app**, copied verbatim into
`public/wiki/` and served by Vite at `/wiki/` (bundled into `dist/` on build).

- **`/docs` route** (`src/pages/Docs.tsx`) renders the wiki in a full-pane
  `<iframe>` whose base URL is `/wiki/`, so its own sidebar, search, and internal
  links keep working. `AppHeader` links to it from every page.
- **Deep-linking** — `/docs?page=format-model.html` points the iframe straight at
  a page; `safePage()` only serves bare same-origin `*.html` names.
- **Inspector "Format docs"** resolves the selected resource to its exact wiki
  page (`docLinks` map); a contract test asserts every handler resolves to an
  on-disk page, so no broken link ships.

## Reference

- Split/Second RE wiki: **bundled** at `public/wiki/`, in-app at `/docs`.
- Port brief: `../_reference/PORT-BRIEF.md`.
- Domain language: `../_reference/paradise-bundle-steward/CONTEXT.md`.
