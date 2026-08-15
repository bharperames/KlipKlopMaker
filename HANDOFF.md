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
pillars get printed. **STILL OPEN — needs Brett's hands.**

### Steps 1–3 — DONE, see §8. Two candidates are built, gated and waiting.

### Step 4 — only then merge
A candidate ships by going into `buildCurveExportGeometry` behind the minimal
style, with a `tests/pieces.test.js` case, not by living in `test-parts/`.
Nothing has been merged: both candidates below are unprinted, and the whole
point of §3 is that a number is not a print.

---

## 6. Assumptions and open questions — all of them

1. ~~**That a flat-printing curve is achievable at all.**~~ Still unproven in
   plastic, but no longer unpromising. §8 takes the flat curve's long-run tail
   from 2,011 mm to 153–173 mm, against 24 mm for a straight that prints
   beautifully — an order of magnitude nearer the good part than the failed one.
   The helicoid argument stands and is beside the point: the fix is anchors, not
   flattening.
2. ~~**That 02/03's numbers survive the z-hop fix.**~~ MOOT. The bulkheads are
   dominated on every column by the honeycomb (§8) at comparable mass; there is
   no decision left that their numbers could inform. Not re-sliced, deliberately.
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
- **Do not read a single slice as a measurement.** Slicing one byte-identical
  3MF twice moved the `>20 mm` column by 54 mm and the max run by 18 mm — see
  §8.4. The mesh is deterministic; BambuStudio is not.
- **Do not compare a 3MF by file hash.** `fflate.zipSync` stamps entries with
  the current time, so identical geometry hashes differently every second. Hash
  `3D/3dmodel.model` after unzipping. Half an hour went into "nondeterministic
  meshes" that were nothing of the sort.

---

## 8. What the next session actually did — the honeycomb and the viaduct

Written 2026-08-15, same day, after §1–7. Everything here came out of one new
harness, `scripts/curve_variants.mjs`, which is §4's gate turned into code.

### 8.1 The harness

`node scripts/curve_variants.mjs [--slice] [--rescore] [--selftest]`
→ `test-parts/curve_variants/` (gitignored).

Variants are no longer built in scratchpad scripts. `buildPieceExportGeometry`
now takes an **`extraOps` hook** — handed the piece already in its own frame,
its ops go through `csgChain`/manifold-3d with everything else, so an
experiment is watertight by construction or it does not build. It is inserted
BEFORE `bossOps`, because the boss subtracts its socket bore and an addition
after that refills it. `csgChain` is exported for the same reason.

Before anything is written the harness checks, and **refuses to write, slice or
score a variant that fails any of them**:

1. `analyzeMesh` — manifold, consistent winding, outward volume;
2. the footprint rule, against the SAME piece built without its extra geometry
   (not a shared baseline — that is wrong the moment a variant moves the wall);
3. **the key can still be fitted** — the ray cast from `tests/pieces.test.js`,
   run on the untilted mesh. Under-deck geometry goes into the cavity the key
   rises through, and a variant that seals the throat is worthless however well
   it prints;
4. an underside render (`*_underside.png`, a software rasteriser, no browser) —
   the check nobody ran on the lattice whose tabs were visible at a glance.

`--selftest` builds a comb deliberately run through the end ribs and **passes
only if the gate rejects it**. A gate that has never rejected anything is not
known to work — that is precisely how the old detent test passed on a part
whose keys could not be fitted at all.

### 8.2 The bug that had to be fixed before any of it meant anything

**`unsupported_runs.mjs` parsed `G1` only, and Bambu ships with
`enable_arc_fitting = 1`.** A sliced curve is 13% arc moves — 58 903 `G2`/`G3`
against 389 026 `G1`. Two consequences, the second worse:

1. arcs never marked the occupancy grid, so supported material read as
   unsupported;
2. the nozzle position was never advanced by an arc, so the next `G1` was
   measured from a STALE point — a chord drawn clean across the empty concave
   side of a 90° curve. Those were the phantom 110–148 mm "bridges".

The tell was that they appeared at identical coordinates in every variant
INCLUDING the baseline. Real geometry differences do not do that.
`scripts/gcode_path.mjs` now flattens arcs and both scripts share it. A move is
yielded as a POLYLINE, because the run analysis calls a stretch "open-ended"
when it reaches either end of a move, and 100 separate chords would make every
stretch open.

**Two claims died with it, both of which were in this document:**

- *"Repeat slices of one file moved the >20 mm column by 54 mm."* The numbers
  did differ, but the cause was this parser, not BambuStudio. Sliced twice with
  the fix, one byte-identical file scores **identically**. The metric is stable.
- *"Wall 2.4 fixes the viaduct's arcade."* It does not — see 8.4.

### 8.3 The metric needed a second column, and Brett found the hole by hand

Brett, on straights printed from shipped geometry: *"obvious strands of plastic
across the underside of the deck, rough to feel and can grab and peel, not fully
melted together."*

A straight's open-ended total is **319 mm** — the metric called it near-perfect.
But its ceiling is flat and anchored on both rails, so nothing is open-ended;
what it has is **13 099 mm of bridges in the 40–48 mm band**, spanning the
channel, max 47.3 mm. That is what strands.

**Open-ended length predicts COLLAPSE. Bridge length predicts SURFACE.** Treating
a bridge as benign because it is anchored at both ends was the blind spot. Score
both.

### 8.4 The numbers

PETG HF, 0.20 mm Standard, P2S 0.4. `>20` and `max` are BRIDGE columns — the
ones that track stranding.

| part | g | time | bridge >20 | bridge max | open >10 | in plastic |
|---|---|---|---|---|---|---|
| minimal **straight** | 47.4 | 1h17 | 13 507 | 47.3 | 24 | **strands, mild** |
| minimal curve, baseline | 77.5 | 3h14 | 2 985 | 45.6 | 2 775 | **FAILED** |
| honeycomb 24 / 0.8 | 91.8 | 3h49 | 330 | 24.2 | 1 034 | unprinted |
| honeycomb 20 / 0.8 | 94.2 | 3h58 | 20 | 20.1 | 924 | unprinted |
| honeycomb 16 / 0.8 | 98.2 | 4h12 | **0** | 15.9 | 632 | unprinted |
| **honeycomb 12 / 0.8** | **104.8** | **4h40** | **0** | **12.2** | **276** | unprinted |
| honeycomb 8 / 0.8 | 117.9 | 5h57 | 0 | 12.2 | 224 | unprinted |
| honeycomb 12 / 1.6 | 131.6 | 5h24 | 0 | 12.2 | 224 | unprinted |
| honeycomb 8 / 1.6 | 155.6 | 7h14 | 0 | 12.2 | 238 | unprinted |
| posts 22 mm / 3.5 | 100.3 | 5h00 | 526 | 30.1 | 929 | unprinted |
| posts 14 mm / 3 | 122.6 | 7h51 | 0 | 13.0 | 387 | unprinted |
| viaduct, wall 1.6 — as printed | 76.0 | 3h21 | 1 885 | 47.2 | 6 430 | **FAILED** |
| viaduct, wall 2.4 — current | 83.2 | 3h44 | 1 834 | 55.1 | 6 729 | never printed |

**12 mm cells with 0.8 mm walls dominates.** Everything finer or thicker costs
mass and time for nothing measurable: 8/0.8 is +13 g and +1h17 for the same
bridge profile, 12/1.6 is +27 g for the same. The first sweep recommended
12/1.6 at 131.6 g, which Brett rejected as "far too much support structure
underneath". He was right, and it was also 30 g of no benefit.

**Posts lose to walls, decisively.** posts 14/3 costs 122.6 g and 7h51 to do
what 12/0.8 does for 104.8 g and 4h40. A wall anchors a bridge along its whole
length; a post anchors a point.

**The viaduct wall change does nothing for the arcade.** 1.6 → 2.4 moves
open >10 from 6 430 to 6 729 — marginally WORSE, not 3× better. The dramatic
118.9 → 39.7 reported earlier was the phantom-chord bug. The bed-contact
improvement (935 → 1031 mm², reproducing PLAN.md's independent 803 → 918) is
real, because that is measured off the mesh and not the gcode; it is a
stability argument for the pier, not a bridging one. The viaduct now has the
WORST open-ended profile of anything in the table.

**Two geometry errors found and fixed on the way**, both of which the gate or a
render caught:
- the hex holes were rotated 30° from the lattice they sat on, so they never
  tessellated — overlapping on one axis, leaving wedges on another. A 24 mm cell
  cost 17 cm³ instead of 7. Fixed with `hexPlan(af, PI/6)`.
- the first post grid was sized for a SQUARE lattice on a triangular one
  (`p/sqrt(2)` where it needed `p/sqrt(3)`), so the holes swallowed every post
  and all three variants came back byte-identical to the baseline. The gate now
  rejects a variant whose volume equals its own no-ops reference: a variant that
  adds nothing is a failed variant, not a good score.

### 8.5 What to print, in order

**`honeycomb_12_0p8.3mf`** — 104.8 g, 4h40 against the baseline's 77.5 g and
3h14. It is the only candidate worth plastic: zero bridges over 20 mm, longest
bridge 12.2 mm against the baseline's 45.6 and the shipped straight's 47.3.
Judge the MIDDLE THIRD of the walking surface.

**This is not only a curve fix, and on a straight it is nearly free.** The
strand complaint is about STRAIGHTS, and a straight is the worst part in the
whole table on the bridge columns. Measured, in `test-parts/straight_hc/`:

| straight | g | time | bridge >40 | bridge >20 | bridge max |
|---|---|---|---|---|---|
| baseline (strands today) | 47.4 | 1h17 | **13 099** | 13 507 | 47.3 |
| honeycomb 20 / 0.8 | 55.1 | 1h36 | 0 | 1 729 | 23.4 |
| **honeycomb 12 / 0.8** | **60.1** | **1h56** | **0** | **281** | **23.4** |

+12.7 g and +39 minutes removes every 40–48 mm span from a straight. The
open-ended column does not move at all (319 → 318), which is the point of §8.3:
the straight never had a collapse problem, it had a sagging-bridge problem, and
only the bridge columns can see it.

Do NOT print the viaduct on the strength of §8's earlier draft; that
recommendation rested on the arc bug. Judge nothing on the slicer's cantilever
warning — it fires on curves whatever the geometry.
