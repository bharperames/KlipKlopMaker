# 🐴 Klip Klop Konstructor

A Roller-Coaster-Tycoon-style web app for designing, physics-simulating, and
3D-printing **gravity-trot ramp towers** compatible with Fisher-Price
Little People "Klip Klop" passive dynamic walker figures — plus a printable,
tunable walker figure of its own.

![concept: multi-tier spiral tower on tree-trunk pillars]

## Run it

```bash
npm install
npm start          # serves at http://localhost:3000 (or npx serve -l <port> .)
npm test           # 56 Jest tests incl. watertightness proofs for every part
```

Open the served URL in any modern browser. Everything runs client-side.

## What you can do

- **Build (RCT-style)**: snap together straights, curves, spiral tiers,
  **powered lift ramps**, and **gated Y-switches** that fork the track into
  branches. Bouncing construction arrows mark every open end — click one to
  move the build point, hover a palette button for a ghost preview, select any
  placed piece to convert/insert/delete it in place (downstream re-lays out
  via Auto-Z), and click a switch to flip its gate. Decorate with the
  interlocking scenery family (towers, palm islands, patios) — everything
  shares one hex tenon/socket standard.
- **Simulate**: hit *Test ride* — a physics-driven horse trots the track with
  synthesized klip-klop audio. It will genuinely stall, slide, or tumble if
  your parameters leave the walkable envelope (see the Physics lab panel).
- **Understand**: the Physics lab shows the slope-zone gauge, the
  rimless-wheel gait verdict (speed, cadence, descent time), a ballast plan,
  and the troubleshooting matrix. See [PHYSICS.md](PHYSICS.md) for derivations.
- **Export**: one click generates a ZIP of **watertight** (Manifold-CSG
  verified) STL or 3MF meshes, pre-oriented for printing with **zero
  overhangs** (slicer-verified). Choose one file per *part*, or
  **packed plates** — a chosen PRINT SET laid out over full 256 mm beds (Bambu
  X1 / X1C / P1S / P2S) by a MaxRects packer, one file per plate, so a tower is
  a handful of print jobs instead of one per part. Sets are *Everything*,
  *Sample run* (one of each distinct part plus spare keys — a fit test before
  committing to a full batch), *Track only*, *Supports only*, *Connector keys
  only* and *Scenery only*; a set only filters and re-counts, never changes
  geometry, so anything proven on a sample holds for the batch. Copies of a
  part share a single mesh in the file and differ only by their build
  transform. For anything the presets do not cover there is the **Print shop**:
  a quantity stepper per part with a rendered thumbnail of its real export
  geometry, and a live 3D view of the plates filling up as you change the
  numbers — as many plates as the order needs, side by side:
  - track pieces with **washboard friction floors**, an **arcade skirt** of
    piers and three-centred arches under the deck, **waterfall seams**
    (downhill floor 0.25 mm lower — a seam can never trip the toy), and hex
    **pillar sockets**
  - **bowtie connector keys** (Hot-Wheels-style separate connectors that drop
    into pockets recessed in bed-supported end ribs — the print-friendly
    replacement for protruding dovetails)
  - merged **switch parts** with gate-pin bores plus printable **gate paddles**
  - auto-cut support **pillars**, plus any placed **scenery** parts
  - the **walker figure** (body + pendulum lying on their sides so hoof cams
    print smooth) and choke-safety **plugs** — Print shop only; the per-part
    ZIPs cover track construction, which is what a design implies
  - a README with print settings, quantities, and assembly/safety steps

  The Print shop catalogues every printable part, not just the ones the current
  design uses: all six track types plus a switch (built at STANDARD parameters
  when the canvas has none), gates, keys, the four riser sizes and a foot, all
  scenery, and the figure.

## Physics rule set (enforced, not suggested)

Slope locked 8–14° (green 10–12°) · zero bank on curves and spirals ·
curve radius ≥ 120 mm with +3 mm dynamic widening, carried half a footprint
into the straights either side · base channel 46–50 mm · 2 mm floor fillets ·
≥100 mm vertical clearance between overlapping tiers.

The widening is derived, not assumed: `js/clearance.js` sweeps the figure's
real footprint (47.5 × 44 mm below rail height) along the centreline and asks
what the channel has to be. It wants 50.03 mm at the standard radius and 50.52
at the 120 mm minimum — so +3 is the smallest whole millimetre that covers the
legal range. PHYSICS.md §8 has the derivation and is explicit about which parts
of it are measured and which are still argument.

- **Persist & share**: designs save/load as portable `.klipklop.json` scene
  files (versioned format, `js/scene_format.js`). Bundled example scenes live
  in `scenes/` and load from the in-app picker or via `?scene=<name>`.

## Verification harness & reports

The dynamics engine (`js/simulate.js`) is pure and deterministic — the
interactive "Test ride" replays the exact trace the tests verify. It models
the WALK regime (rimless-wheel gait) and the SLIDE regime
(`v̇ = g(sinθ − μₖcosθ)`, covering skiing *and* coasting to a stop), plus
stall/tumble terminal outcomes, with an energy-budget invariant
(½v² ≤ gΔh — the integrator can never create energy).

- `scenes/*.json` — 8 scenarios spanning success, slide, stall, tumble, and
  layout-violation regimes, each with an embedded `expect` block.
- `tests/scenes.test.js` — solves every scene and checks its expectations;
  adding a scene file automatically adds it to the harness.
- `tests/simulate.test.js` — regime physics against closed-form solutions.
- `node scripts/generate_reports.mjs` — writes `reports/index.html`, a
  self-contained visual report: per-scene 3D view, expectation checks,
  speed/elevation charts with regime underlays, and event timelines.

## Architecture

| File | Role |
|---|---|
| `index.html` | UI shell, CSS, import map |
| `js/app.js` | scene, path builder, trace-replay simulation, audio, export orchestration |
| `js/track.js` | pure layout engine: Auto-Z slope lock, waterfall seams, clearance checks |
| `js/physics.js` | pure rimless-wheel gait model, friction presets, ballast planner |
| `js/simulate.js` | pure deterministic dynamics (walk/slide/stall/tumble), energy invariant |
| `js/scene_format.js` | versioned scene persistence (serialize/validate/deserialize) |
| `js/geometry.js` | pure watertight mesh construction (ear-clip, zero-bank sweeps, profiles) |
| `js/pieces.js` | Three.js + Manifold-WASM CSG assembly of printable parts |
| `js/mesh_utils.js` | manifold/orientation verification, welding, volume |
| `js/export_3mf.js` | 3MF XML + binary STL writers (proper rotation, no mirroring) |
| `js/plate_pack.js` | pure MaxRects bin packing of part footprints onto build plates |
| `js/export_sets.js` | pure named print sets (everything / sample run / track / supports / keys / scenery) |

Pure modules have no DOM/Three.js dependencies and are covered by Jest —
including tests that prove every exported part is a closed, consistently
outward-wound manifold.

## Safety

Designed for toddler use per the original toy's class: no printed axles
(use 3 mm metal rod), and **all ballast bores and axle ends must be sealed
with glued plugs** — BBs and rods are choke hazards. (Perimeter count used to
be listed here as a safety measure; it is not one. The track is a 1.6 mm
shell — four lines wide at a 0.4 nozzle — so it prints solid regardless of
the setting.)
