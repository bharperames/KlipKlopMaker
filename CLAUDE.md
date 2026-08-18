# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
npm test        # all Jest tests (ES modules — uses --experimental-vm-modules)
npm start       # serve locally (npx serve .)
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/track.test.js  # single file
node scripts/generate_reports.mjs   # solve all scenes/ → reports/index.html (run from repo root)
node scripts/slice_loop.mjs         # build → slice with the real Bambu CLI → feature totals
node scripts/slice_audit.mjs f.gcode  # read a slice made by hand in the GUI
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
- **Nothing under the deck may have a LEVEL top.** The deck falls at the ramp
  slope, so a level top is always wrong at one edge: over `key.ribThk` = 12 mm
  the deck drops 2.4 mm through a 2 mm floor. Both the socket boss
  (`slantedCylinder`) and the end rib (`ribSolid`) take the deck height as a
  function of position for this reason — the rib did not, and surfaced through
  the walking surface as a fin across the washboard. `tests/pieces.test.js`
  checks the floor is the highest thing in the channel; it is a surface check,
  not a per-feature one, so the next feature to get this wrong is caught too.
- **Print-friendliness is a contract**, and the orientation is part of the
  part. A `viaduct` piece prints RIM-DOWN on its arcade with no supports. A
  `minimal` piece is exported already TILTED onto its own underside
  (`tiltOntoUnderside`, gated by `laysOnUnderside`) — do not re-orient it in
  the slicer, that is the reason it is that shape. Platforms, powered tiles
  and elevators are flat or block-bottomed and stay rim-down in both styles.
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
- **The socket never moves.** Every track piece has ONE hex socket, at the
  piece's CENTRE OF MASS (`massCentreS`) — not mid-length. The rim anchors at
  the piece's low end, so the skirt is as deep as the drop at the top and
  `skirtDepth` at the bottom, putting the weight at ~39% of a curve; a pier at
  50% is downhill of it and the piece tips toward the start. It is a constant
  per piece type, so this does not make variants. When the column under it
  would spear the tier below,
  `planPillarPositions` returns mode `'jog'` and the offset is carried by a
  separate part (`buildJogGeometry`) plugged into that same socket — not by
  moving the boss or growing an outrigger arm on the track, which is what used
  to make six extra track shapes out of a support problem. The jog is 45 mm
  (the socket is hex, so it can only point six ways and the worst is 60° off)
  and exactly one grid unit tall, so it substitutes for a 15 mm riser and
  `decomposeSupport(stackHeightMm(piece, support))` still lands on the grid.
  A piece's part signature must NOT key on support mode/station/side — the mesh
  is identical either way, and keying on it listed one curve as four.
- **The calibration button loads PARTS, it does not export.** It swaps the
  Print shop's job for the calibration set — coupons under one heading, cards
  and chips under another — so they get the same quantities, thumbnails, plate
  preview, packing, bed-contact warnings and export path as everything else,
  instead of a private pipeline reimplementing each. Reopening the shop from
  the toolbar rebuilds the design's catalogue (`builtFor` is stamped with a
  sentinel no design key can equal). Two things this cost, both now handled:
  `shopBuildList` renders only kinds in its own list, so a new kind packs and
  exports while showing an EMPTY list; and `shopApplyPreset` picks from the
  design's parts, so applied to this job it matches nothing and zeroes every
  count. The measurement sheet and nominals ride along in `shopExport`.
- **Our 3MF carries GEOMETRY ONLY, and that is the point.** BambuStudio 2.8.2+
  greets it with *"The 3mf file has invalid config, load geometry data only"* —
  an informational dialog, not an error. Bambu's own 3MFs embed ~53 KB of
  `Metadata/project_settings.config`; ours has no `Metadata/` at all, so the
  slicer keeps whatever filament and process the user has selected. Verified on
  2.8.2.60: the same file slices to 1h10m09s / 42.41 g against 2.07's 1h10m /
  42.39 g, and object names survive (they come from `<object name>`). Do NOT
  silence the dialog by writing a config — it would pin a filament into the
  file, override the user's preset, and go stale with the next Bambu release.
- **Calibration coupons come from the real builders, never redrawn.** A
  redrawn pocket would have to reproduce the flank clearance, the detent, the
  grip taper and the seat land, and would keep certifying the old number the
  day one changed. Prefer a WHOLE SHORT TILE over a band cut out of a long one:
  `cal_ramp` is laid out at `CALIBRATION.rampTileLenMm` (65) so it arrives rib
  to rib carrying a pocket at each end and the socket between, with no cut
  faces at all. A mid-piece band has two open bridged ends and they printed
  badly. Only where a whole part will not do — the gate bearing — is a band cut
  out, and then it gets its cut face closed with a plain wall and is capped at
  the deck so no thin proud rail is left behind. They also keep the part's FULL SECTION and print
  orientation and are shortened only in extent: a hole's printed size depends
  on the plastic around it, so a coupon thinned for print speed measures its
  own thinness. Nominals for the measurement sheet are read off `SPEC`, and
  `tests/pieces.test.js` asserts that (and that every coupon sits on the bed —
  one balanced on a corner prints skewed and every reading off it is fiction).
- **BED CONTACT IS A QUESTION ABOUT ISLANDS, NOT ABOUT AREA.** Summing every
  downward face and checking the total passes a part whose first layer is in
  separate pieces, each of which has to hold its own tower down alone. The
  collet test article scored 122 mm² and was THREE unbraced 35 mm² crescents
  10.5 mm tall — its slots are cut at the shaft's hex corners and run out past
  the 8.66 corner radius, so they sever the shell — and Brett got spaghetti off
  the one that printed first in the grid. `scripts/first_layer.mjs` rasterises
  the slab by ray-cast parity (a prism has mesh vertices only at its section
  boundaries, so sampling vertices near a height finds nothing mid-shaft) and
  floods it; **gate on the SMALLEST island**. For a collet the islands are
  inherent — the fingers must be free at the mouth and the mouth is at the bed
  — so that plate prints with a brim; tying the fingers with a ligament instead
  puts 18% strain in three 1 mm webs and cracks them.
- **THE CALIBRATION SET TRANSFERS A SETTLED GEOMETRY; IT DOES NOT DISCOVER ONE.**
  That is the whole reason it is 7 items and 83 g rather than the 20 items and
  144 g it was. An article earns its place only if it answers something the real
  coupons cannot, and once the fits were confirmed in plastic most of them
  stopped doing that. Removed, with the reason in each case:
  · the **section card** (140x100x1, plus 8 free islands and an ArUco workflow)
    built a graded Ø2-16 / AF 6-15 XY error CURVE for predicting feature sizes.
    Nothing reads that curve now — joints are measured directly and the joints
    are the truth — and it could never answer a MASS question anyway.
    `SECTION_NOMINALS.json` went with it; it existed so a script could match a
    photographed contour, and there is no photograph.
  · **`lad_pin`**, the gate-bore ladder. Brett: "if that is an approximation of
    the gate pin, we don't need it, the calibration parts print the gate. and
    the coupon that has the hole." The set already prints both halves as
    themselves.
  · **`lad_hex`**, the track-socket ladder — mass-dependent, see below.
  · **every chip.** `chip_tenon` was a bare hex cylinder that `cal_post_15`
    already carries as a real tenon; the two key chips were a 2.0-vs-2.4
    comparison that 2.3 settled. Four keys were being printed where one is
    needed — `cal_key` is now the ladder's chip as well as cal_ramp's mate.
  What survives is **six coupons that mate with each other** — cal_ramp with
  cal_key, the two posts with each other, cal_gate_paddle with cal_gate_bearing
  — and **one ladder card for the bowtie**, the only ladder that ever worked.
  Print the coupons on a new filament or printer; reach for the card only if a
  fit misses, because it tells you HOW FAR off and the coupons only tell you
  THAT. Its rungs are DERIVED from `fitClearanceMm - printComp.tipMm`, never
  listed: a hardcoded list was coarsened to include 0.12 and silently stopped
  containing 0.05, which is the rung that actually mates.
- **A LADDER CARD SETTLES A SHAPE QUESTION, NOT A MASS ONE.** The pillar joint
  proved the difference: its fault was believed to be that ONE drawing prints
  0.08 mm wider across corners on a broad foot than on a slender riser — since
  RETRACTED, Brett having remeasured: "Remove special cases for the foot tenon,
  it is behaving similar to a 15mm pillar as far as tenon size." The mass effect
  is real between a riser tube and a track boss (see the socket note); it is not
  real between a foot and a riser. Either way no rung on a 3 mm
  card — a third mass again — could have found it. `scripts/tenon_sweep.mjs
  --compare` did, by building REAL 15 mm risers and taking the mating half from
  parts already printed. Re-run that if the filament or printer changes. The
  card's genuine win is the KEY, and CLAUDE.md's own reason for it is the test
  of whether a card applies: its holes are uniform insets, so they report every
  direction at once.
- Interlock standard everywhere: hex tenon 8.6 mm AF ↔ socket 9 mm AF × 10 mm
  (pillars, towers, palm trunks, patio corners, track bosses, jogs).
- **THE BOWTIE KEY AND ITS SLOT ARE CONFIRMED AT 2.6.0 — DO NOT RETUNE THEM.**
  Brett, on the fit-test print: "this slot and key configuration is working very
  well at this revision." That is `fitClearanceMm` 0.12 with the DRIVE TAPER,
  `taperLeadMm` 0.05 under nominal at the lead end and `taperGripMm` 0.08 over
  at the grip end — the key enters at 0.17/side and wedges at 0.04 as it is
  driven home, and the engraved face is the lead end. The pocket is untouched
  from earlier revisions, so keys and track pieces stay cross-compatible.
  Prismatic keys had exactly ONE fit and no single clearance was both enterable
  and tight; the taper gives a range and the user drives it to the one that
  grips. Do not reach for `fitClearanceMm` again — the ladder already proved the
  drawn clearance was in band, and the taper is what closed it.
- **THE TENON LEAD-IN TAPER IS CONFIRMED, AND THE TRIMMED FOOT IS REJECTED.**
  Off the same print, on the posts: "the others provide a very nice friction fit
  with a little extra grip at the bottom of the push" — the extra grip at the
  bottom IS `tenonTaperAF` 0.30 doing its job. But the foot printed at
  `tenonTrimAF` 0.15: "The smaller tenon of the two tower feet is just not wide
  enough to provide any friction resistance at all." So the foot keeps the FULL
  tenon; the trim option stays at its 0 default and is a test article only.
  Also measured: one foot's tenon ran ~0.01 mm wider across corners than the
  other and that alone was enough to make it STICK in a bore. The joint is
  knife-edge at the hundredth — and the fix goes in the HOLE, never the tenon.
- **THE PILLAR JOINT IS A SLOTTED HEX SOCKET AT 8.60 AF, SETTLED IN PLASTIC.**
  `SPEC.socket.colletAF`. Measured against nine real base tenons, two copies of
  each rung agreeing: **8.75** (the shipped socket, slotted) too loose on the
  smallest · **8.60** acceptable on the smallest, "very snug on biggest, but
  acceptable because of collet flex" · **8.45** too tight on the largest.
  And the round bore is FINISHED as a friction joint — Brett, on the same
  plate: "none of the round bore hole collets felt like they worked with the
  range of tenons I have." The reason is now clear and it is not sizing: a
  cylinder can only touch a hex on its CORNERS, and corners are the one feature
  a 0.4 mm nozzle cannot reproduce — rounded off on a post, filled in in a hole.
  The grip rode on the least repeatable dimension on the part, which is why
  `boreDia` moved five times in one day. A hex beds on six FLATS over the whole
  engagement; three slots let it open for an oversize tenon.
  **THE TENON IS UNTOUCHED**, which was the constraint the whole search ran
  under: it still mates with every hex socket in every ramp and curve printed.
  EVERY shipped socket that a hex tenon plugs into takes `colletSocketOps` —
  riser, jog AND spacer. The spacer was briefly left as a round bore on the
  reasoning that "the collar rings a pillar rather than gripping it"; that is
  false, and the line's own comment says so — "the socket the riser stack plugs
  into". It is the same joint. Nothing shipped subtracts `boreDia` now;
  `roundSocketDia` keeps it reachable so a ladder can still be built.
  Cost, and it is real: the slots sever the shell, so a riser's first layer is
  three ~38 mm2 islands rather than one of 116. **These parts want a brim** —
  see the islands note above.
- **THE ROUND BORE WAS A COLLET FIRST. Measured against four real tenons, 2026-08-18.**
  Three bores were printed and pushed onto foot tenons spanning the real printed
  range. Sizes each handled, out of four:
  · **COLLET (three slots through the wall) — 3 of 4.** Good on the largest,
    acceptable on the next two, loose only on the smallest. Brett: "the spring
    sides (which flex nicely, so the design is good)" and "I'm pretty pleased
    with the functional behavior of the slit springs".
  · plain 9.70 bore — **1 of 4**. Jams the largest, tight on the second, loose
    below. This is the fit that had been moving all week; it cannot do better,
    because no fixed diameter spans a 0.28 mm tenon range.
  · ribs standing proud in an oversize bore — **1 of 4**, and only the largest,
    despite gripping NOMINALLY tighter at 9.60. Three small pads do not survive
    contact: they print short or crush flat on first insertion. DROPPED, not
    retuned.
  The collet works for the reason the gate pin already demonstrated — it absorbs
  its own variation instead of being sized around it. Its one gap is the
  smallest tenon, which is sizing rather than design: at a 9.70 resting bore the
  fingers never load. `scripts/collet_plate.mjs` ladders 9.45/9.55/9.65 plus a
  longer-finger variant to close it.
- **THE TENON DIMENSION IS INVARIANT. FIX THE ROUND BORE INSTEAD.**
  Brett: "We have kept the tenon dimension invariant because of these ramp
  sockets and I want to keep it that way", and "I think we are looking for a
  round hole solution, not a tenon fix." The hex tenon mates with the HEX SOCKET
  in every ramp and curve already printed and that pairing WORKS; changing it to
  suit the round bore would break the proven half to rescue the unproven one and
  invalidate a drawer of parts. Truncating its corners to a dodecagon was
  proposed and REJECTED on exactly that ground — do not raise it again.
  The bore side is where the arithmetic actually bites, and it is decisive: the
  same tenon drawing prints 9.65-9.93 across corners, so a bore that always
  ACCEPTS the largest needs D >= 9.93 and one that GRIPS the smallest needs
  D <= 9.65. No plain cylinder is both, which is why `boreDia` moved five times
  in one day. The hole has to be COMPLIANT, and the precedent is already here:
  the gate pin is a split C mating at 0.00 clearance and reads "a great fit,
  perfect". `scripts/fit_spread_plate.mjs` tests two ways — ribs standing proud
  inside an oversize bore, and a slotted collet — with the tenon untouched.
- **THREE FITS ARE CONFIRMED IN PLASTIC AND MUST NOT BE "IMPROVED".** Measured
  by hand off PETG prints, August 2026:
  · **hex tenon in socket** (0.20 mm/side) — "very nice and tight" pillar into
    pillar, and "about just right" tenon into the track boss. The interlock
    standard is right as drawn. The ROUND BORE that a hex tenon plugs into is a
    different question and it moved: see `SPEC.socket.boreDia`, now 9.75, after
    an identical file assembled on one plate and would not on another.
  · **gate pin in its bore** (0.00 mm/side, the split C grips) — "a great fit,
    perfect".
  · **zero-clearance round and square pairs** on the calibration card — disks
    and the 20 mm square drop into their own-size holes snugly, so ordinary
    features print on size and there is NO global XY offset to compensate.
  The ONLY loose joint is the bowtie key in its pocket, and the clearance
  ladder says the drawn clearance is already right (nominal key: will not enter
  0.00, extremely snug at 0.05, good tight fit at 0.10 AND 0.12, loose from
  0.15 — and 0.12 ships). So do not reach for `fitClearanceMm`, `printComp`, or
  a global `xy_hole_compensation`: a key widened on card evidence shipped for
  one commit and would have jammed every pocket in the field.
  **What is actually wrong is CLAMPING, not clearance.** Brett: "the biggest
  problem I have had connecting ramps is that the key won't keep them tight
  together and any exposed seam stops the klipklop." A bowtie in two half
  pockets LOCATES the pieces; nothing draws them together. The lever is the
  flare wedging as the key is driven up — i.e. `seatGripMm`, which is 0.03 and
  far too small to clamp — with `seatLandMm` kept so the ceiling still sets
  deck flushness. That is a POCKET change and helps new pieces only.

## Browser verification

`npx serve -l 3311 .` then run the Playwright smoke script pattern (see git
history / scratchpad): load page, assert zero console errors, exercise
build → simulate → export.

Do NOT look for `#export-log` — the div is still in `index.html` with its CSS,
but nothing in `js/` has written to it since export moved into the Print shop,
so it reads empty and a smoke test that waits on it passes for the wrong
reason. Drive `#btn-print-shop`, wait for "building part geometry…" to clear
AND for `#shop-list input[type=number]` to exist, re-fire `change` on
`#shop-preset` to populate quantities, then click `#shop-export` and assert on
the `download` event (a `..._Nplates_3mf.zip`). Watertightness is not reported
in the UI at all — `tests/pieces.test.js` and `analyzeMesh` are what enforce
it. The shop's part list also states each part's size, which is the quickest
check of which underside is in force: a minimal curve is 41 mm tall and a
viaduct curve 71 mm.
- **EXPERIMENT EXPORTS GO THROUGH `analyzeMesh` TOO — four of them did not, and
  every number taken off them is void.** The curve variants were built in
  scratchpad scripts that added ribs/spines/lattice by concatenating meshes
  instead of unioning them through manifold-3d, so added geometry interpenetrated
  the shell: 04 spine 236 non-manifold edges, 05 spines 472, 06 level ceiling
  6518, 07 lattice 1580, all with inconsistent winding, and Bambu reports the
  same 1580. `tests/pieces.test.js` gates SHIPPED parts; nothing gated these,
  and they were sliced anyway. A slicer's reading of a non-manifold mesh is
  undefined, SO THE SCORES DERIVED FROM THEM MEAN NOTHING — including the
  "lattice is the best flat candidate" claim that survived several sessions.
  The lattice also grew ragged tabs past the end face, which the footprint rule
  forbids and a glance at the render catches.
  **THERE IS NOW A GATE, AND EXPERIMENTS GO THROUGH IT** —
  `scripts/curve_variants.mjs`. Variants enter via `buildPieceExportGeometry`'s
  `extraOps` hook (handed the piece in its own frame, ops joined to the real
  builder's through `csgChain`, inserted BEFORE `bossOps` so the socket bore is
  still cut afterwards), and nothing is written, sliced or scored until it
  passes `analyzeMesh`, the footprint rule against its own no-ops reference,
  the key-throat ray cast, and an underside render. `--selftest` builds a comb
  through the end ribs and passes ONLY IF REJECTED, because a gate that has
  never rejected anything is not known to work. Do not build variants any other
  way.
- **PARSE `G2`/`G3`, OR EVERY GCODE NUMBER IS FICTION.** Bambu ships with
  `enable_arc_fitting = 1` and a sliced CURVE is 13% arc moves (58 903 against
  389 026 `G1` on the baseline). `unsupported_runs.mjs` and the first version of
  `curve_variants.mjs` parsed `G1` only, which broke two ways: arcs never marked
  the occupancy grid, so supported material read as unsupported; and the nozzle
  position was never advanced by an arc, so the NEXT `G1` was measured from a
  stale point — a chord drawn clean across the empty concave side of a 90°
  curve. That is where the phantom 110–148 mm "bridges" came from, and the tell
  was that they appeared at identical coordinates in every variant INCLUDING the
  baseline. Real geometry differences do not do that. `scripts/gcode_path.mjs`
  flattens arcs and both scripts share it; a move is yielded as a POLYLINE, not
  a segment, because the run analysis calls a stretch "open-ended" when it
  reaches either end of a move and 100 separate chords would make every stretch
  open. Two claims died with this bug: that the slicer is nondeterministic
  (it is not — the same file now scores identically twice), and that wall 2.4
  fixes the viaduct's arcade (it does not).
- **BAMBU'S CANTILEVER WARNING IS ABOUT THE UNDER-DECK CAVITY, AND A SOLID ONE
  CLEARS IT.** This overturns a claim that stood for most of the project — that
  it "fires on curves whatever the geometry" and could never be silenced. It
  went untested because nothing could READ it: the warning is in the slicer's
  `result.json` at `sliced_plates[0].warning_message`, verbatim "It seems object
  curveR_1 has floating regions", and `scripts/curve_variants.mjs` captures it
  on every slice now. The first control settled it, and Brett confirmed it in
  his own GUI — a ribbed curve warns, a solid-cavity one does not. The old
  "warns even with the arcade suppressed" evidence was a VIADUCT, a different
  underside; nobody had run the equivalent on a minimal curve.
  **THE WARNING IS STILL NOT A QUALITY SIGNAL.** Silencing it says nothing about
  whether the walking surface comes out clean, and every print verdict in this
  file was reached without it. Judge the middle third.
- **QUOTE YOUR OWN SLICER PROFILE, NOT THE HARNESS'S.** The scripts here use
  `0.20mm Standard @BBL P2S` + PETG HF + 15% infill, and Brett's GUI profile is
  not that. The SAME curve file: 89.8 g on the harness, 114 g in his GUI. Worse,
  the two disagree on the SIGN of a comparison — solid-vs-ribbed is +12 g on the
  harness and -14 g in his GUI, because a ribbed curve is mostly thin walls
  (which his wall settings inflate) while a solid one is mostly infill. Harness
  numbers are for RANKING variants; anything absolute has to come off his slicer.
- **A 3MF's file hash is not its content.** `fflate.zipSync` stamps zip entries
  with the current time, so identical geometry hashes differently every second.
  Compare `3D/3dmodel.model` after unzipping. Export meshes ARE deterministic
  across processes — verified, four builds, identical vertex count and volume.
- **OPEN-ENDED PREDICTS COLLAPSE; BRIDGE LENGTH PREDICTS SURFACE.** Treating a
  bridge as benign because it is anchored at both ends is the metric's blind
  spot, and Brett found it by hand: the shipped STRAIGHT, whose open-ended total
  is a mere 319 mm, has "obvious strands of plastic across the underside of the
  deck, rough to feel and can grab and peel, not fully melted together." Its
  ceiling is flat and anchored on both rails, so nothing is open-ended — but it
  carries 13 m of bridges in the 40–48 mm band, spanning the channel. That is
  what strands. Score both columns, always.

- **THE UNDER-DECK FIX IS ONE RULE: FILL THE CAVITY.** It used to be three
  rules chosen by shape — spines along a straight, ribs across a curve, nothing
  at all for the flat platforms — each with a flared capital at the ceiling so
  the slicer would anchor to it. `scripts/overhang_audit.mjs` measures the thing
  that actually decides whether a ceiling sags: how far a bridge has to reach
  before it lands on something. On that measure the old scheme left **24 mm**
  spans on a straight, 24 on a curve, 26 on a switch and **36** on a platform.
  Filling the cavity gives **6-12 mm** everywhere, and the filled part is
  FASTER despite weighing more, because sparse infill lays down quicker than
  tall thin walls:

  | part | before | after | worst span |
  |---|---|---|---|
  | start | 43.99 g / 1h17:52 | 51.86 g / 1h17:09 | 50 -> 10 |
  | straight | 50.36 g / 1h20:29 | 56.73 g / 1h15:12 | 24 -> 10 |
  | curve | 92.84 g / 3h46:00 | 100.74 g / 2h55:40 | 24 -> 12 |
  | end | 39.14 g / 1h03:05 | 47.12 g / 1h02:53 | 50 -> 18 |
  | switch | 134.16 g / 5h23:17 | 138.03 g / 3h57:15 | 26 -> 12 |

  The fill runs the FULL LENGTH, not rib to rib: inside an end rib it is a
  union with solid material and adds nothing, but at a face with NO rib — the
  start platform's bumper end — stopping at `ribThk` left a 24 mm span hanging
  over the first 11.5 mm, and that was the last cluster on the part.
  It goes in BEFORE the joints and the boss, because everything after it CARVES
  (bowtie pocket, socket bore, gate seat, engraved code). Filling last put the
  plastic back into the pocket that had just been cut and sealed the remains
  into an internal void, so the part exported as TWO SHELLS.
  `SPEC.underside` is gone with the scheme — a filled cavity has nothing to
  tune, and the slicer's infill density is the knob.
- **JUDGE A PART WITH `overhang_audit.mjs`, NOT WITH BRIDGE-MOVE COUNTS.** Once
  a cavity is filled, most "bridge" moves in the gcode are solid infill laid
  over SPARSE INFILL, not over air: a filled start platform still reports 180
  moves over 40 mm and has no unsupported ceiling at all. The audit reads the
  MESH — downward faces, how far they fall, how wide the unsupported stretch is
  — so it cannot be confused by infill and does not depend on a slicer profile.
  `tests/pieces.test.js` gates every minimal piece at **no span over 20 mm**,
  and that gate is known to reject: with the fill suppressed the same four
  parts report 20, 10, 57 and 14 spans over the limit.
- **THE VIADUCT STYLE FAILS THIS AUDIT AND IS LEFT ALONE DELIBERATELY.**
  `viaduct_straight` measures a 56 mm worst span over 14 clusters and
  `viaduct_curveR` 66 mm over 73, with 1067 mm2 ceilings open all the way to
  the bed. That is not a regression and not a false positive: the viaduct skirt
  is piers and arches with **nothing internal** by design, so its deck bridges
  the full channel. It also matches the one print result on record — the
  viaduct curve failed on its arched skirts. Filling it would erase the style,
  and bulkheads inside the arcade were tried and deleted once already. It stays
  excluded from the fill and from the test gate; the minimal style is what
  ships. Reopen this only with a design decision, not a tweak.

- **THE SOCKET MOUTH IS A LAND PLUS A CONE NOW, and that is what silenced the
  cantilever warning on every part.** The counterbore's roof used to be a flat
  annulus 4.15 mm wide, printed over the open recess — 266 mm2 of downward face
  sweeping layers 11-28 on cal_ramp (2.20-5.60 mm above the bed; it SWEEPS
  because the socket stands plumb in the tower and so tilts with the part), and
  it is the strands in every photograph of a ramp socket. Ablation named it:
  suppress `bossOps` and cal_ramp goes from WARNS to silent, nothing else does.
  It cannot simply be coned away because that annulus IS `socketMouthY`, the
  face the support column bears on — so `SPEC.socket.mouthLandMm` keeps 1 mm of
  flat for bearing and the remaining 3.15 mm becomes a 45 deg cone opening down
  into the recess. Near-horizontal area 266 -> 108 mm2, and **curve, switch,
  straight, start, end and cal_ramp all slice silent.** The cone is FREE: 116.30
  vs 116.34 g with and without. It does not cost the spacer its nest either —
  the recess keeps full `collarBoreR` below the cone.
  The old note here said every correction was worse than the defect and that a
  45 deg chamfer "does not geometrically fit". That was arithmetic against
  2.38 mm of recess when the run available is 2.20 on the low side and 5.60 on
  the high — the tilt means one side of the annulus can be made self-supporting
  and the other only improved. Partial by nature, and worth doing anyway.
- **THE UNDER-DECK FILL IS TAPERED, and both ends of the taper are paid for.**
  At the SOLE the fill must not run parallel to the wall: buried inside the
  2.4 mm wall at `innerWidth/2 + wall/2` it threw 100 degenerate triangles at
  the bed, which Brett saw as "a small kind of pie slice on the side that
  widens". Swept: 25.2 gives 100, the sole edge 26.4 gives 601, exactly ON the
  wall at 24.00 the mesh goes NON-MANIFOLD, 0.5 clear of it gives 5.
  But a fill that clears the wall for its whole height is a SEPARATE BODY, so
  the slicer runs perimeters down both sides of the gap instead of merging —
  +15.6 g and +29 min on a curve, and the same whether the gap is 0.1 or 0.5
  (all four measured ~116 g against 100.7 merged). The price is having a gap,
  not its width. So the fill is wide at the deck (`innerWidth/2 + wall`, merged)
  and clear at the sole (`innerWidth/2 - 0.5`): 102.8 g and 18 slivers, against
  116.3/5 straight-sided and 100.7/100 buried.

- **NO CURVE ORIENTATION HAS YET PRINTED ACCEPTABLY, and do not cite one as a
  fallback.** Both have been printed and both failed, differently: the VIADUCT
  curve failed on its arched skirts (its deck was clean); the MINIMAL curve's
  underside came out as spaghetti AND the damage telegraphed through the 2 mm
  floor into the riding surface. Brett: "the viaduct does not print fine ...
  and the riding surface does not print fine on the flat one". The tempting
  shorthand "the viaduct prints fine" is FALSE — it collapses a deck result
  into a part result, and it was used for a while to recommend rim-down curves
  as the safe option. Bulkheads across the channel and spines along the arc
  were measured and refuted: the long runs are DIAGONALS that already span wall
  to wall, so a wall across the channel cannot shorten them.
  **Two gated candidates now exist and both are UNPRINTED** (HANDOFF §8,
  `test-parts/curve_variants/`, gitignored):
  · the VIADUCT at the current `SPEC.wall` = 2.4. The failed print was taken at
    1.6, during the spell PLAN.md records; at 1.6 the arcade carries four
    open-ended runs of 92–119 mm and at 2.4 that cluster does not exist (worst
    39.7). The archived `curveR_viaduct.3mf` is 86.2 cm³ = the 2.4 build, so the
    "viaduct 4 356 mm" figure was always the un-printed geometry.
  · a full HONEYCOMB rising from the bed to the deck underside — Brett's own
    specification, built properly for the first time. It takes the runs over
    10 mm from 2 042 mm to 131–328 (a straight that prints beautifully has 24),
    and every remaining run over 20 mm is on a RAIL CREST 13.1 mm above the
    deck, not under it. Read `>10 mm`, never the total: a honeycomb multiplies
    short benign cell-rim runs while killing long ones. Wall thickness beat cell
    size — 12 mm/1.6 beats 8 mm/0.8 on every long-run column and prints faster.
  Judge any attempt on the middle third of the walking surface and on the
  skirt, not on the slicer's cantilever warning — that warning fires on curves
  whatever the geometry.

- **THE FROG'S EDGE AND ITS FLAT WERE ONE BUG, AND THE DECK BANKS NOW.** Both
  routes fall at the same rate along their OWN path and their headings differ by
  up to 45°, so their deck planes meet along a LINE and nowhere else.
  `frogDeckKnots` matched them along the branch CENTRELINE only; away from it
  they diverged at **0.11 mm/mm** — ±2.6 mm across a 48 mm channel. That one gap
  wore two costumes: the EDGE across the curve route (the surface followed
  whichever deck was lower and kinked at the main's channel boundary, 1.94 mm
  down across the branch's inboard half) and the FLAT (75 mm of branch and
  100 mm of main with NO washboard, because each route's clearance envelope is
  referenced to its own deck and so passed under the other's ridge crests and
  shaved them). Measure both with `scripts/deck_probe.mjs`, never from a render:
  shading makes a crease and a groove look identical.
  **THERE IS NO SHARE TO PICK.** Splitting the tilt half and half was built and
  the geometry refuses it — both along-slopes are already pinned (the main by
  its grade, the branch by frogDeckKnots), and those two constraints fix the
  common surface UNIQUELY as the main's plane, branch taking all the
  cross-slope. Half leaves ±1.3 mm, twice what the envelope needs to clear a
  crest, and measures barely better than nothing.
  **BANK THE SECTION, NEVER THE STATION.** Tilting the station frame takes the
  RIM with it: the underside stops being planar, worst span went 10 → 70 mm and
  the first layer 14 413 mm² in one island → 3 mm² in five. The tilt belongs in
  `channelProfile`, applied to everything hanging off the deck line — floor,
  fillets, rail crests, drumhead ceiling — with `rimAt` left alone. Three things
  must follow the lean or they undo it: the profile, the CLEARANCE ENVELOPE's
  floor (a level floor digs into its own raised side, 1.37 → 2.17 mm) and the
  UNDER-DECK FILL's top (a level top leaves a 3.7 mm wedge of void that the span
  audit cannot see but the slicer reports as a floating cantilever).
  Result, both hands: branch worst lateral step **1.37 → 0.43 mm**, flat samples
  69 → 22 and 63 → 22, span still 10 mm, first layer still one 14 413 mm²
  island, and **both slice silent**. `bankAt` is 0 for every piece but a
  switch's two halves, so zero-bank still holds everywhere else.
  One 0.90 mm step remains on the main at s 110 and it is NOT the bank —
  lengthening the unwind from 20 to 35 to 50 mm leaves it unchanged. It is the
  merged straight-and-curved wall where the channels part; rebuild that as one
  curve and tighten the test gate from 1.00 to 0.80.
- **The Klip Klop Standard is load-bearing** (PHYSICS.md §6): slope 11.217°,
  curve R 143.64, width 48 — chosen so every tile drops whole 15 mm grid units
  and supports stack from five reusable riser designs. Never change STANDARD
  values casually; custom parameters are an explicit non-interoperable mode.
