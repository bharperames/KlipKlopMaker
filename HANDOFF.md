# Handoff — the curve, done properly this time

Written 2026-08-15, at the end of a session that got the joints right and the
curve badly wrong. Read the whole of §3 before touching the curve; it is a list
of things that have already been tried, and two of them were tried twice.

---

## 1. Where the repo is

`GEOMETRY_VERSION 2.3.0`, clean tree, 364 tests passing, `main`.

Three joint changes shipped this session, each from a fit Brett measured by
hand in PETG. **PETG is now the only material** — no fit needs a material
hedge, and PLA-era readings are history, not constraints.

| change | version | what moved |
|---|---|---|
| key drawn 0.07/side wider on the flanks | 2.1.0 | `printComp.tipMm` / `neckMm` |
| every socket cut to the track's undersize | 2.2.0 | `socketShrinkAF`, was track-only |
| **key depth 18.00 → 18.60** | 2.3.0 | `printComp.depthMm` |

The third is the one that matters. **2.1.0 was a mistake worth understanding:**
it moved the flanks 0.07 mm per side — about one clearance-ladder step — on a
joint Brett described as falling right out, and he printed a whole plate to
discover it felt identical. The real slop was 0.80 mm, in the DEPTH direction,
which is the axis the two ramps separate along. He found it by hand
("the back of the key to the back of the slot ... almost a full 1mm") after two
versions of me tuning the wrong axis. It came straight from
`depthClearanceMm: 0.4` per side. The key now spans 18.60 into an 18.80 cavity,
leaving 0.10 per side.

Only the key moved — `bowtiePocketPlan` never sees `printComp` — so every
pocket already printed stays valid.

**On Brett's printer right now:** `plate_01_13parts_208g.3mf`, verified to be
genuinely 2.3.0 (key measures 18.600, riser sockets 8.75 AF). Contents:
`straight ×2`, `bowtie_key ×3`, `support_foot ×3`, `riser 15/30/60`.

Two results to collect from it, and they gate different things:

- **Two straights + a key = a real seam.** Does it close and stay shut? This is
  the original complaint ("any exposed seam stops the klipklop") and the first
  honest test of it.
- **Riser into riser = pillar-on-pillar.** This is 2.2.0 and it is the
  RISKIER change: it is reasoned from "pillars aren't tight", not measured. If
  a riser needs real force into another riser, `socketShrinkAF` (0.25) went too
  far — one-line revert. Riser into a track boss did not move and should feel
  exactly as before.

---

## 2. The goal

**A curve that prints acceptably, whole.** Not a clean score, not an absent
warning — a part that comes off the plate with an intact riding surface and an
intact skirt.

---

## 3. The curve: what is actually known

### 3.1 Both orientations have been printed and both FAILED

This is the fact most easily lost, and I lost it twice in one session.

| | outcome |
|---|---|
| **viaduct** curve | FAILED on the arched skirts. Its deck was clean. |
| **minimal** (flat) curve | FAILED — spaghetti underside, and it telegraphed through the 2 mm floor into the riding surface. |

**Never say "the viaduct prints fine."** That sentence collapses a deck result
into a part result. I used it as an anchor fact for most of a session and built
a "just print curves rim-down" recommendation on top of it. Brett's correction:
*"the viaduct does not print fine ... and the riding surface does not print
fine on the flat one."*

So there is **no known-good way to print a curve**, and no fallback.

### 3.2 Four of the eight experiment meshes are broken, and their scores are void

`test-parts/curve_experiments/` (gitignored). Audited with
`node scripts/audit_3mf.mjs test-parts/curve_experiments/*.3mf`:

| file | manifold | non-manifold edges | winding |
|---|---|---|---|
| 01_BASELINE_curve_minimal_asis | OK | 0 | consistent |
| 02_BULKHEADS_across_channel_30mm_pitch | OK | 0 | consistent |
| 03_BULKHEADS_across_channel_20mm_pitch | OK | 0 | consistent |
| 04_SPINE_along_arc_centre | **FAIL** | 236 | inconsistent |
| 05_SPINES_along_arc_pair | **FAIL** | 472 | inconsistent |
| 06_LEVEL_CEILING_across_channel | **FAIL** | 6518 | inconsistent |
| 07_LATTICE_8mm_sanity_check | **FAIL** | 1580 | inconsistent |
| curveR_viaduct | OK | 0 | consistent |

Bambu independently reports the same 1580 on the lattice.

**Cause:** the scratchpad scripts that generated the variants added ribs,
spines and lattice by CONCATENATING meshes instead of unioning them through
manifold-3d. Added geometry interpenetrates the shell. `tests/pieces.test.js`
enforces `analyzeMesh` on shipped parts; nothing gated the experiments, and I
sliced them and published the numbers anyway.

**Consequence, and it is the whole point:** a slicer's reading of a
non-manifold mesh is undefined, so **every score derived from 04–07 is
meaningless** — including the 6,124 mm that made the lattice "the best flat
candidate" and that Brett was told twice to print.

Additionally the lattice has ragged tabs protruding **past the end face** —
forbidden by the footprint rule, and visible at a glance in the render. Nobody
looked at the render.

### 3.3 What is still valid

Only meshes 01, 02, 03 and the viaduct were ever sound.

- **01 baseline: 16,274 mm open-ended.** Valid, and the number to beat.
- **viaduct: 4,356 mm open-ended.** Valid — but remember 3.1: that part's
  DECK printed clean while its skirts failed. It is a good ceiling, not a good
  part.
- **02 / 03 bulkheads:** meshes are sound, but they were scored under the OLD
  metric (`segs >20 mm`) and I am not certain they were re-scored after the
  z-hop fix. **Treat their numbers as unverified** and re-run
  `scripts/unsupported_runs.mjs` on fresh slices before citing them.

Under the old metric, bulkheads at 30 mm and 20 mm pitch bought four
percentage points for ten grams. The REASON is the durable part and it should
shape any new attempt: **the long unsupported runs are DIAGONALS that already
span wall to wall.** The channel is 48 mm; the baseline's worst run was 66 mm.
A bulkhead ACROSS the channel cannot shorten a diagonal that already reaches
both walls, and a spine ALONG the channel does not move the maximum at all.

### 3.4 The measurement instrument, and the bug that poisoned it

`scripts/unsupported_runs.mjs` (rescued from scratchpad this session).

It rasterises each layer's extrusions into an occupancy grid, then walks every
bridge move in the next layer and measures the runs passing over empty cells.
It classifies each run:

- **anchored at both ends** — a real bridge; prints fine
- **open-ended** — stops in mid-air; this is what droops

That distinction is the whole value. The slicer's cantilever warning fires on
AREA and cannot make it — which is why it fires on curves regardless of
geometry, and why it is useless as a pass/fail signal.

**The z-hop bug (fixed, do not reintroduce):** Bambu z-hops on travel moves,
and a hop is a bare `G1 Z...` indistinguishable by pattern from a layer change.
Keying layer boundaries on "Z changed" wiped the occupancy grid several times
per layer, so nearly everything scored as unsupported — and the viaduct (clean
deck) scored WORSE than the minimal curve that actually failed. The fix: take
the boundary from the Z of the last EXTRUSION move. A hop extrudes nothing, so
this is immune by construction.

An earlier metric — raw bridge SEGMENT length — is also wrong and is kept in
the history only as a warning: a single `G1` move can pass straight over
intervening solid material, so its length says nothing about unsupported
distance. That is what made a lattice with 8 mm anchors report a 65 mm
"segment".

---

## 4. The process gate — do this first, it is cheap

Nothing below is trustworthy without it.

1. **Build variants through `csgChain` / manifold-3d**, from the real builders
   in `js/pieces.js`. Never concatenate meshes.
2. **Assert `analyzeMesh` BEFORE writing any 3MF** — manifold, consistent
   winding, outward volume. Refuse to write the file otherwise. This is the
   single check that would have prevented the entire mess.
3. **Look at the render.** The lattice's tabs past the end face were visible.
4. **Check the footprint rule**: nothing protrudes past an end face, nothing
   floats above the bed.
5. Only then slice, and only then score.

Worth doing properly: promote the variant generator out of scratchpad into
`scripts/`, with the `analyzeMesh` assert wired in, so the next person cannot
skip it either.

---

## 5. Plan of attack

### Step 0 — collect the joint results (blocks nothing else, do it first)
From the plate already printing: does the seam close, and is riser-on-riser
right? If the riser is interference-tight, revert `socketShrinkAF` before any
pillars get printed.

### Step 1 — rebuild Brett's honeycomb, properly
This is HIS test and it has never actually been run. His specification, in his
words: *"you should be able to put a full 'honeycomb' rising from the floor
just like the side rails so there is no unsupported bed, but it is the anchor
points that are key to reduce the bridge length."*

- full height, **from the bed up to the deck underside** — the 07 file was a
  shallow waffle on the underside and never reached the bed, so it did not
  implement this
- unioned through manifold, `analyzeMesh` clean, nothing past the end faces
- score with `scripts/unsupported_runs.mjs` against **01's 16,274**

It is a WORST-CASE / sanity article: if a full honeycomb does not bring the
open-ended runs down, then no amount of under-deck anchoring will, and the
answer is orientation or support. That is a genuinely informative negative
result, which is why it is worth doing first.

### Step 2 — attack diagonals, not spans
If step 1 helps, the follow-up is not more walls. Per §3.3 the killer runs are
diagonals across exposed ceiling patches. Anchors need to be distributed in
BOTH directions — a grid, not a comb — with spacing chosen so no straight line
across the ceiling exceeds roughly the channel width before meeting one.

### Step 3 — re-examine the two non-geometry options honestly
Both were dismissed too fast on the strength of the false "viaduct prints fine".

- **Slicer support on the flat curve:** measured at 3 h 58 m / 128 g, 37.7%
  support. The cavity opens downward onto the bed in this orientation, so the
  support is reachable and removable. Ugly, but it is a printable curve, and
  nothing else currently is.
- **Viaduct orientation:** its DECK is the best ceiling result on record
  (4,356). Its skirts failed. **Nobody has investigated the skirt failure** —
  and Brett noted the failures were "made worse by the walling thinning we had
  previously done, but now have undone", which means the failure may already be
  partly addressed and has simply never been reprinted. **This is probably the
  cheapest real shot at a printable curve and it has been sitting unexamined.**

### Step 4 — only then merge
A candidate ships by going into `buildCurveExportGeometry` behind the minimal
style, with a `tests/pieces.test.js` case, not by living in `test-parts/`.

---

## 6. Assumptions and open questions — all of them

1. **That a flat-printing curve is achievable at all.** Unproven. A 90° helicoid
   ceiling sweeps 90° of azimuth, so no plane fit flattens it — established
   earlier and still true. Step 1 is partly a test of whether to keep trying.
2. **That 02/03's numbers survive the z-hop fix.** Unverified — re-score.
3. **That the key fix works.** 0.10 per side comes from a ladder rung in a 3 mm
   card; the printed slot may differ. `depthMm` (0.3) is the one number to
   adjust. Brett will know by hand — unlike 2.1.0, this is 0.6 mm.
4. **That 8.75 suits a pillar socket.** Reasoned, not measured, and it
   contradicts its own premise: the two sockets differed BECAUSE identical
   drawings print differently in different plastic masses, and the fix assumes
   they now won't. The hex ladder (`chip_tenon` down `lad_hex_00…30`) settles
   it.
5. **That the slicer warning means anything.** It does not — it fires on area,
   on curves, regardless of geometry. Judge prints, and judge them on the
   middle third of the riding surface and on the skirt.

---

## 7. Traps

- **Do not print `07_LATTICE_8mm_sanity_check.3mf`.** It is broken geometry.
- **Do not cite 6,124 mm.** Void.
- **Do not reach for `fitClearanceMm`, `printComp` or a global XY offset on
  the key's flanks.** Three fits are confirmed in plastic (hex tenon, gate pin,
  zero-clearance pairs) and the flank clearance is not the defect — see
  CLAUDE.md.
- **Do not tune a joint by an amount you cannot feel.** 0.07 mm per side cost a
  print and a day. If the symptom is "falls right out", measure the slop before
  changing anything.
- **Do not trust a ladder card to stand in for a real part** without saying so.
  It was right about the key in the end — Brett said so and he was correct —
  but only because its holes are uniform insets that report every direction at
  once. Read it that way.
