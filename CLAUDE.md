# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
npm test        # all Jest tests (ES modules — uses --experimental-vm-modules)
npm start       # serve locally (npx serve .)
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/track.test.js  # single file
node scripts/generate_reports.mjs   # solve all scenes/ → reports/index.html (run from repo root)
```

## What this is

A client-side web app ("Klip Klop Konstructor") for designing 3D-printable ramp
towers for Fisher-Price-style passive dynamic walker toys. RCT-style path
building, gait physics simulation, and watertight STL/3MF export.
`PHYSICS.md` documents the physics model and its sources.

## Architecture rules

- **Pure modules** (`track.js`, `physics.js`, `geometry.js`, `clearance.js`,
  `engrave.js`, `mesh_utils.js`, `export_3mf.js`) must stay free of DOM and
  Three.js imports — they are Jest-tested directly. `pieces.js` (Three.js +
  manifold-3d WASM), `horse_model.js` (Three.js, display-only knight figure)
  and `app.js` (DOM) are the only impure layers.
- **Two halves of the physics.** `simulate.js` is motion ALONG the track;
  `clearance.js` is fit ACROSS it (rigid footprint swept against
  `innerWidthAt`, PHYSICS.md §8). Neither knows about the other. `clearance.js`
  imports `track.js`, so `checkChannelFit` is composed in by `app.js` rather
  than called from `layoutTrack` — going the other way is a real import cycle.
- **CSG goes through manifold-3d**, never three-bvh-csg (it leaves
  T-junction open edges). `initCSG()` must be awaited before any
  `build*ExportGeometry` call. Manifold guarantees watertight booleans.
- **Every exported part must pass `analyzeMesh`**: manifold, consistent
  winding, outward volume. `tests/pieces.test.js` enforces this — if you add a
  part type, add it there.
- **Physics envelope is load-bearing**: slope lock (8–14°, green 10–12°),
  waterfall seams (downhill floor 0.25 mm lower — never "fix" this), zero-bank
  sweeps (station `right` vectors stay horizontal), washboard pitch snapped so
  seams land in ridge valleys, ≥120 mm curve radius. These come from
  passive-walker physics (see PHYSICS.md); don't relax them to make geometry
  easier.
- Coordinates are **Y-up mm** internally; exporters rotate to Z-up via a
  *proper rotation* (X=x, Y=−z, Z=y). Never axis-swap — it mirrors chiral
  parts (curves, dovetails).
- Display meshes (coarse, no ridges/CSG) and export meshes (fine washboard +
  CSG joints) are separate paths — keep scene rebuilds cheap.
- **One simulator**: `js/simulate.js` is the single source of dynamics truth.
  The app's "Test ride" replays its trace; the harness (`tests/scenes.test.js`,
  `scripts/generate_reports.mjs`) asserts on it. Never re-add ad-hoc motion
  logic to `app.js`. It must stay pure and deterministic (no Date/random).
- **Scenes are tests**: files in `scenes/` carry an `expect` block and are
  auto-picked-up by the harness and the report generator. Keep expectations in
  the scene file, not hardcoded in tests.
- **Tracks are trees** (v2): a node is a segment string or a switch object
  `{type: switchL|switchR, gate, main: [], branch: []}` — switches must be the
  LAST node of their container. `layoutTrack` emits two role pieces per switch
  (exported merged); `resolveRidePath(pieces)` gives the gate-selected linear
  path — always simulate THAT, never the raw pieces array.
- **Vocabulary** (bottom to top of a track piece, as printed AND as used —
  these are the same orientation; the exporter maps app-up to printer-up, so
  "rim-down" and "deck-up" describe one thing, not a flip):
  *bed* = build plate · *rim* = flat bottom edge of the skirt walls, at a
  constant `rimY` per piece, the only thing touching the bed · *skirt* = the
  wedge between rim and deck, carved into a VIADUCT: *piers* standing on the
  bed with three-centred *arches* between them, and nothing internal (an
  earlier design put mullions, bulkheads and brackets in here; all deleted) ·
  *lintel* = the `ARCH.band` of skirt kept under the deck over each arch ·
  *floor*/*drumhead*/*deck* = the walking surface · *rails* above it.
  "Rim plane" is shorthand for the horizontal plane at `rimY`; it is this
  project's word, not a 3D-printing term (that would be "first layer").
- **Print-friendliness is a contract**: parts print rim-down with no supports.
  Never add geometry that protrudes past an end face or floats above the bed
  (the original dovetail tab failed in the slicer as a floating cantilever) —
  joints are bowtie keys in rib-recessed pockets; `tests/pieces.test.js`
  enforces the footprint rule.
- **ONE channel width everywhere** — `SPEC.curveWidenMm` is 0. A real Klip Klop
  figure measures 38 mm and its swept path fits 48 mm at every legal radius, so
  turns need nothing added. This is what makes each piece type a single shape
  (8 across the whole scene library, down from 16): with no width difference at
  a seam there is nothing to taper and no `_into_curve` / `_entry` variants.
  `resolveSeamWidths` and `SEAM_TAPER_MM` stay — correct and a no-op at the
  Standard — because `layoutTrack({ curveWidenMm })` can still ask for a
  widened turn. That path is where they are tested: asserting them at the
  Standard would pass on `48 === 48` and prove nothing.
  **`FIGURE.widthMm` is measured off the toy, never derived from the channel**;
  it used to be `channel − 4`, and that circularity is what kept the widening
  alive. See PHYSICS.md §8.
- **Every exported part is engraved with its code**, derived from
  `GEOMETRY_VERSION` (MAJOR.MINOR only — the code is a compatibility claim, and
  PATCH is defined as cosmetic). `engrave.js` is a STROKE font, deliberately
  not an outline font: at these sizes an outline font's stems fall under one
  extrusion width and the slicer drops them, whereas the stroke width *is*
  `SPEC.engrave.minFeature`. Round letters are Catmull-Rom splines through
  sparse skeletons (a pixel-matrix version was tried and read as coarse); they
  overshoot the nominal box the way real typefaces do, so the metrics measure
  the font's real extent rather than assuming the box.
- **Codes go on the INSIDE, never a show surface or a mating face.** Track
  pieces: the channel face of the `right` rail — vertical, inside, and the cut
  only ever widens the channel so it cannot bind a figure. SWITCHES take the
  gate rail and start past the gate slot (`switchEngraveSpot`): neither rail is
  free end to end there, and a code aimed at the slot cuts thin air. Risers:
  the whole
  code as two lines on ONE hex flat, turned on its side. Foot: its base. Key:
  its top. Not the end rib (pocket + windows leave ~10 mm panels, and it
  mates), not the drumhead underside (acoustic, and the boss reaches it), not
  the inner skirt wall (the arcade leaves only `ARCH.band` continuous).
  Engraving is EXPORT ONLY — builders shared with the scene
  (`buildRiserGeometry`, `buildKeyGeometry`, `buildSupportFootGeometry`) take
  an opt-in `{ code }` so rebuilds stay cheap. A code placed inside solid
  material becomes a sealed void and a second shell: `tests/pieces.test.js`
  catches that, and it is why `marginMm` clears the start platform's bumper.
- **The socket never moves.** Every track piece has ONE hex socket, at
  mid-piece. When the column under it would spear the tier below,
  `planPillarPositions` returns mode `'jog'` and the offset is carried by a
  separate part (`buildJogGeometry`) plugged into that same socket — not by
  moving the boss or growing an outrigger arm on the track, which is what used
  to make six extra track shapes out of a support problem. The jog is 45 mm
  (the socket is hex, so it can only point six ways and the worst is 60° off)
  and exactly one grid unit tall, so it substitutes for a 15 mm riser and
  `decomposeSupport(stackHeightMm(piece, support))` still lands on the grid.
  A piece's part signature must NOT key on support mode/station/side — the mesh
  is identical either way, and keying on it listed one curve as four.
- Interlock standard everywhere: hex tenon 8.6 mm AF ↔ socket 9 mm AF × 10 mm
  (pillars, towers, palm trunks, patio corners, track bosses, jogs).

## Browser verification

`npx serve -l 3311 .` then run the Playwright smoke script pattern (see git
history / scratchpad): load page, assert zero console errors, exercise
build → simulate → export, and confirm `#export-log` shows only "✔ watertight".
- **The Klip Klop Standard is load-bearing** (PHYSICS.md §6): slope 11.217°,
  curve R 143.64, width 48 — chosen so every tile drops whole 15 mm grid units
  and supports stack from five reusable riser designs. Never change STANDARD
  values casually; custom parameters are an explicit non-interoperable mode.
