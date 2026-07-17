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

A client-side web app ("Klip Klop Maker") for designing 3D-printable ramp
towers for Fisher-Price-style passive dynamic walker toys. RCT-style path
building, gait physics simulation, and watertight STL/3MF export.
`PHYSICS.md` documents the physics model and its sources.

## Architecture rules

- **Pure modules** (`track.js`, `physics.js`, `geometry.js`, `mesh_utils.js`,
  `export_3mf.js`) must stay free of DOM and Three.js imports — they are
  Jest-tested directly. `pieces.js` (Three.js + manifold-3d WASM) and `app.js`
  (DOM) are the only impure layers.
- **CSG goes through manifold-3d**, never three-bvh-csg (it leaves
  T-junction open edges). `initCSG()` must be awaited before any
  `build*ExportGeometry` call. Manifold guarantees watertight booleans.
- **Every exported part must pass `analyzeMesh`**: manifold, consistent
  winding, outward volume. `tests/pieces.test.js` enforces this — if you add a
  part type, add it there.
- **Physics envelope is load-bearing**: slope lock (8–14°, green 10–12°),
  waterfall seams (downhill floor 0.25 mm lower — never "fix" this), zero-bank
  sweeps (station `right` vectors stay horizontal), washboard pitch snapped so
  seams land in ridge valleys, ≥120 mm curve radius, +3 mm curve widening.
  These come from passive-walker physics (see PHYSICS.md); don't relax them to
  make geometry easier.
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
- **Print-friendliness is a contract**: parts print rim-down with no supports.
  Never add geometry that protrudes past an end face or floats above the bed
  (the original dovetail tab failed in the slicer as a floating cantilever) —
  joints are bowtie keys in rib-recessed pockets; `tests/pieces.test.js`
  enforces the footprint rule.
- Interlock standard everywhere: hex tenon 8.6 mm AF ↔ socket 9 mm AF × 10 mm
  (pillars, towers, palm trunks, patio corners, track bosses).

## Browser verification

`npx serve -l 3311 .` then run the Playwright smoke script pattern (see git
history / scratchpad): load page, assert zero console errors, exercise
build → simulate → export, and confirm `#export-log` shows only "✔ watertight".
- **The Klip Klop Standard is load-bearing** (PHYSICS.md §6): slope 11.217°,
  curve R 143.64, width 48 — chosen so every tile drops whole 15 mm grid units
  and supports stack from five reusable riser designs. Never change STANDARD
  values casually; custom parameters are an explicit non-interoperable mode.
