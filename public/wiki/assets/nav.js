/* Split/Second RE Wiki — page registry (grouped, ordered). Consumed by wiki.js. */
window.WIKI_NAV = [
  { cat: "Overview", pages: [
    { title: "Home", file: "index.html", summary: "Start here — wiki overview" },
    { title: "Engine Architecture", file: "engine-overview.html", summary: "Black Rock engine, subsystems, codenames" },
    { title: "Build & File Layout", file: "build-layout.html", summary: "Devkit build, USRDIR/Deferred tree, title ID" },
    { title: "All File Formats (Index)", file: "format-index.html", summary: "Master map of every extension → its page" },
    { title: "Extraction Tooling & Status", file: "tooling.html", summary: "Build-or-buy tool matrix: what works, what needs custom code" },
    { title: "Glossary & Codenames", file: "glossary.html", summary: "Catnip, Crayon2, Megabowles, LDC, SSAI…" }
  ]},
  { cat: "Engine & Tech", pages: [
    { title: "Rendering Pipeline", file: "engine-rendering.html", summary: "Deferred G-Buffer, SPULight, HDR, motion blur" },
    { title: "Threading & JobStream", file: "engine-jobstream.html", summary: "SPURS job system, main/loader threads" },
    { title: "Middleware Stack", file: "engine-middleware.html", summary: "Havok 5.5, FMOD Ex 4.28, Quazal, Bink, Scaleform, Edge" },
    { title: "Audio Engine", file: "engine-audio.html", summary: "LLAudio2, DynamicMixer, reverb, soundbanks" },
    { title: "Networking & Online", file: "engine-networking.html", summary: "Quazal NetZ/RV duplicated objects, ATVNet, voice" },
    { title: "Resources & Streaming", file: "engine-resources.html", summary: "Residency, loaders, .ark archives" }
  ]},
  { cat: "Data & Config", pages: [
    { title: ".params Tuning System", file: "data-params.html", summary: "Text key/value tuning format with slider ranges" },
    { title: "Global Registry", file: "data-globalregs.html", summary: ".global_regs master default config" },
    { title: "Catnip Entity System", file: "data-catnip.html", summary: "Entities, timelines, triggers, interactive objects" },
    { title: "XML Conventions", file: "data-xml.html", summary: "Where/why XML is used; Havok tagfiles" }
  ]},
  { cat: "Formats · Geometry & Render", pages: [
    { title: "Model (.model)", file: "format-model.html", summary: "Crayon2 mesh/renderable container" },
    { title: "Shaders (.shaders/.shaderinst)", file: "format-shaders.html", summary: "Shader sets and instances" },
    { title: "FX Compiled (.fxc)", file: "format-fxc.html", summary: "Compiled effect/material data" },
    { title: "Textures (.textures)", file: "format-textures.html", summary: "GPU textures + .low LOD variants" },
    { title: "Streaming (.stream/.streamtex)", file: "format-streamtex.html", summary: "Streamed geometry and textures" },
    { title: "Skeletons (.skel)", file: "format-skel.html", summary: "Animation skeletons" },
    { title: "CRC Tables (.crcs)", file: "format-crcs.html", summary: "Asset/texture CRC reference lists" }
  ]},
  { cat: "Formats · Physics (Havok)", pages: [
    { title: "Havok Packfiles", file: "format-havok.html", summary: "Magic 0x57E0E057, classnames, XML twins" },
    { title: "Vehicle Physics (.phys)", file: "format-phys.html", summary: "Per-car Havok rigid body + handling" },
    { title: "Collision (.hkColl/.mainColl)", file: "format-hkcoll.html", summary: "Level & vehicle collision meshes" },
    { title: "Physics Packs (.hkPPs)", file: "format-hkpps.html", summary: "Packaged physics + XML twin" },
    { title: "Rigid Bodies (.hkRBs)", file: "format-hkrbs.html", summary: "Rigid body / hinge body variants" },
    { title: "Deformation (.deform)", file: "format-deform.html", summary: "Damage/deformation models" },
    { title: "Mesh Collision (.mcl)", file: "format-mcl.html", summary: "Powerplay/prop collision meshes" }
  ]},
  { cat: "Formats · Audio & Video", pages: [
    { title: "FMOD Sound Banks (.fsb)", file: "format-fsb.html", summary: "FMOD streamed/sample banks" },
    { title: "FMOD Events (.fev)", file: "format-fev.html", summary: "FMOD Designer event project data" },
    { title: "Lip Sync (.lip)", file: "format-lip.html", summary: "Voice lip-sync data" },
    { title: "Tonic (.tonic/.tonic2)", file: "format-tonic.html", summary: "Custom audio/music format" },
    { title: "Bink Video (.bik)", file: "format-bik.html", summary: "RAD Bink movies" },
    { title: "Sequences (.nis/.gbx)", file: "format-nis.html", summary: "Non-interactive sequence data" }
  ]},
  { cat: "Formats · FX & Particles", pages: [
    { title: "Emitters (.emitter*)", file: "format-emitter.html", summary: "Particle emitter controllers & surfaces" },
    { title: "Lights (.lights)", file: "format-lights.html", summary: "Light placement & light rigs" }
  ]},
  { cat: "Formats · Gameplay (Catnip)", pages: [
    { title: "Entities (.entities)", file: "format-entities.html", summary: "Catnip entity instances" },
    { title: "Powerplays (.powerplays)", file: "format-powerplays.html", summary: "Powerplay definitions" },
    { title: "Triggers (.triggers)", file: "format-triggers.html", summary: "Trigger volumes/buttons" },
    { title: "Timelines (.timelineInfo)", file: "format-timeline.html", summary: "Catnip timeline sequencing" },
    { title: "Logic Info (.logicinfo)", file: "format-logicinfo.html", summary: "Gameplay logic metadata" },
    { title: "Highlight Tags (.highlighttags)", file: "format-highlighttags.html", summary: "Replay/highlight tagging" }
  ]},
  { cat: "Formats · Track & Route", pages: [
    { title: "Route Data (.checkpoints…)", file: "format-route.html", summary: "checkpoints/sideways/splitlength/linkorigins" },
    { title: "Sectors (.sectorInfo)", file: "format-sectors.html", summary: "Track sector partitioning" },
    { title: "Name Tables (.names)", file: "format-names.html", summary: ".names/.filenames/dirlist string tables" },
    { title: "Powerplay Info (.dat)", file: "format-powerplayinfo.html", summary: "Per-level powerplayInfo.dat" }
  ]},
  { cat: "Formats · Archive & Misc", pages: [
    { title: "Archives (.ark)", file: "format-ark.html", summary: "Packed asset archive format" },
    { title: "nameHash (CRC) & RAM Dump", file: "format-namehash.html", summary: "TOC hash cracked; offline blocked; RPCS3 RAM-dump attempt" },
    { title: "Scaleform UI (.gfx)", file: "format-gfx.html", summary: "Flash/GFx UI assets" },
    { title: "Misc & Raw", file: "format-misc.html", summary: ".data/.rdata/.bin/.ker/.bed/.dct/.controllerTemplate" }
  ]},
  { cat: "Formats · Telemetry", pages: [
    { title: "TrackTivity (.track)", file: "format-track.html", summary: "Telemetry/replay sample stream" }
  ]},
  { cat: "Game Systems", pages: [
    { title: "Game Modes", file: "system-gamemodes.html", summary: "Race, Elimination, Survival, Detonator, Demolition…" },
    { title: "Powerplay System", file: "system-powerplay.html", summary: "Power bar, triggers, danger zones, sequences" },
    { title: "AI (SSAI)", file: "system-ai.html", summary: "LDC tables, power bar, evolution test harness" },
    { title: "Vehicles", file: "system-vehicles.html", summary: "Classes, roster, colours, damage" },
    { title: "Cameras & Director", file: "system-cameras.html", summary: "Camera director, splines, takedown sequences" },
    { title: "Scoring & Progression", file: "system-scoring.html", summary: "Scoring, Season, unlock criteria" },
    { title: "Tracks & Levels", file: "system-tracks.html", summary: "Level pipeline, subtracks, time-of-day" },
    { title: "Post-Processing DB", file: "system-postprocess.html", summary: "Per-area colour grading & post FX" },
    { title: "Area of Effects", file: "system-areaofeffects.html", summary: "Explosion forces & handling effects" },
    { title: "Difficulty & Race Director", file: "system-difficulty.html", summary: "Catchup, respot, teleport, difficulty modifiers" },
    { title: "HUD & Frontend", file: "system-hud.html", summary: "GameModeHUDs, Scaleform frontend" },
    { title: "Nemesis & Heli Modes", file: "system-nemesis.html", summary: "Nemesis truck & helicopter boss modes" }
  ]}
];
