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

### 8.2 The numbers

PETG HF, 0.20 mm Standard, P2S 0.4 — the material this project actually prints.
Two control points frame the table: a minimal STRAIGHT prints beautifully, and
the two curves marked FAILED are the prints in Brett's hands.

| part | g | time | open-ended | >5 | >10 | >20 | max | in plastic |
|---|---|---|---|---|---|---|---|---|
| minimal **straight** (control) | 47.4 | 1h17 | 270 | 93 | 24 | 24 | 23.8 | **prints beautifully** |
| minimal curve, baseline | 77.5 | 3h14 | 16 355 | 4681 | 2042 | 406 | 39.3 | **FAILED** |
| honeycomb 12 mm / 0.8 wall | 108.6 | 6h24 | 9 409 | 1292 | 328 | 54 | 31.8 | unprinted |
| honeycomb 12 mm / 1.6 wall | 129.5 | 7h00 | 7 585 | 1004 | 153 | 0 | 17.6 | unprinted |
| honeycomb 8 mm / 0.8 wall | 117.5 | 7h38 | 6 334 | 492 | 142 | 0 | 13.8 | unprinted |
| honeycomb 8 mm / 1.6 wall | 154.4 | 10h59 | 4 568 | 499 | 131 | 0 | 12.8 | unprinted |
| viaduct, wall 1.6 — **as printed** | 76.0 | 3h21 | 4 830 | 3830 | 3195 | 1860 | **118.9** | **FAILED** |
| viaduct, wall 2.4 — current code | 83.2 | 3h44 | 4 305 | 3131 | 2610 | 1266 | 39.7 | **never printed** |

**Brett's honeycomb works, and the total is the wrong column to read it in.**
A honeycomb multiplies SHORT runs — every cell rim is a new one — while killing
long ones, so the total falls only 3.5× while the tail that actually droops
falls 13×. Read `>10 mm`: 2 042 → 131–328, against 24 for a part that prints.

**Every open-ended run over 20 mm in a honeycomb variant is on a RAIL CREST,
not under the deck.** Located, not assumed: the recurring 31.8 mm and 22.7 mm
runs sit 13.1 mm above the deck at lateral 24.4 mm — `railHeight` is 14 and the
rail wall spans 24–26.4. They are a tilt artefact the straight has too. The
longest genuinely under-deck run in any honeycomb variant is **18.2 mm**,
against the baseline's 39.3 and the failed viaduct's 118.9.

**Wall thickness beats cell size, which was not the prior.** 12 mm/1.6 beats
8 mm/0.8 on every long-run column while costing 38 minutes less. Do not chase
8 mm cells; the old "8 mm lattice" figure was void anyway (§3.2).

### 8.3 The viaduct — the record was wrong about which part failed

`test-parts/curve_experiments/curveR_viaduct.3mf` measures **86.2 cm³**, which
is exactly the wall-**2.4** build; the wall-1.6 build is 73.8 cm³. So the
"viaduct 4,356 mm, valid" row in §3.3 describes geometry that **has never been
printed**. The part that failed in Brett's hands was the 1.6 wall.

Sliced at the wall it actually had, that part carries a cluster of four runs of
**92, 96, 103 and 119 mm**, all at z 13.6–19.4 in one region — the arcade,
which is exactly what failed. At wall 2.4 that cluster **does not exist**; the
worst run is 39.7 mm. Bed contact goes 935 → 1031 mm², reproducing PLAN.md's
independently measured 803 → 918 to within the tolerance of a different method.

So Brett's recollection was right and it is now quantified: **the viaduct
curve's arcade failure has a fix that has already shipped, and the part has
never been reprinted.**

### 8.4 Caveats, stated plainly

- **Nothing here is a print.** Every row marked unprinted is a slicer number,
  and this project's whole recent history is about the gap between the two.
- **Slicer noise is real and bigger than some of the differences above.** The
  same byte-identical 3MF sliced twice gave `>20` = 54 and 0, max 31.8 and
  13.8 — the rail-crest runs appear in some slices and not others. Under-deck
  columns were stable to ~2%. The mesh is deterministic across processes
  (verified); BambuStudio is not. Treat 12/1.6 vs 8/0.8 vs 8/1.6 as a tie on
  the long-run tail; only 12/0.8 and the baseline separate from the pack.
- **The viaduct at 2.4 still carries far more long-run plastic than any
  honeycomb** — 2 610 mm over 10 mm against 131–328. It is recommended first on
  COST and on its known-clean deck, not because its numbers are better.
- The honeycomb has not been checked for anything but printability and the key
  throat: not mass in a tower, not the spacer, not whether a 154 g curve is a
  toy anyone wants.

### 8.5 What to print, in order

1. **`viaduct_wall2p4_current.3mf`** — 83.2 g, 3h44. Cheapest and fastest of
   everything here, its deck is already known clean, and the one thing that
   failed on it is measurably 3× better. Judge the ARCADE.
2. **`honeycomb_12_1p6.3mf`** — 129.5 g, 7h00. Brett's own idea, built properly
   for the first time. Judge the MIDDLE THIRD of the walking surface.

Both are gated and sitting in `test-parts/curve_variants/`. Judge neither on
the slicer's cantilever warning — it fires on curves whatever the geometry.
