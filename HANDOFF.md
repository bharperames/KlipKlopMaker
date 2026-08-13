# Handoff — printing a minimal curve with no slicer warnings

The task: get `curveR` (and `curveL`, and the switch) to slice clean without
giving up the flat print orientation. This session put a REAL SLICER in the
loop, and that overturned three things the last handoff asserted. Read §2
before trusting any earlier number.

---

## 1. Where things stand

Clean tree, **357 tests passing**. `viaduct` is still `SPEC.skirt.style`;
`minimal` is opt-in in the Underside selector and is the variant this is about.

A `minimal` piece is exported **already tilted onto its own underside**
(`tiltOntoUnderside`, gated by `laysOnUnderside`). Do not re-orient it in the
slicer — that is the whole reason it is shaped the way it is.

| part | on the bed | tall | mass |
|---|---|---|---|
| straight | 1480 mm² | 30 mm | 69 g |
| curve | 1777 mm² | 41 mm | 106 g |
| switch | 2680 mm² | 43 mm | 158 g |

Support library: **foot · jog · risers 60/30/15 · one spacer (SPC 11.20)**.

---

## 2. THE LOOP IS CLOSED NOW — `scripts/slice_loop.mjs`

`slice_audit.mjs` reads a slice somebody made by hand. `slice_loop.mjs` makes
one:

```
node scripts/slice_loop.mjs                    # every piece, both styles
node scripts/slice_loop.mjs curveR minimal     # one part
node scripts/slice_loop.mjs --save             # rewrite reports/slice-baseline.json
```

BambuStudio ships a CLI inside the .app and the P2S presets are already on
disk, so build → 3MF → slice → feature totals runs headless in ~20 s. The
baseline for the whole library is committed at `reports/slice-baseline.json`
and every run diffs against it.

**The trap that invalidated a whole table before it was caught.** A Bambu
system preset is a LEAF: `0.16mm Standard @BBL P2S.json` contains no layer
height at all — that lives in `fdm_process_single_0.16`, via `inherits`. The
CLI does not follow `inherits` and does not say so. Passed the leaf, it keeps
0.2 mm layers and reports a clean run, so two "different" layer heights
produced byte-identical feature totals. `flatten()` resolves the chain; the
achieved layer height is then read back out of the gcode and printed in the
header, because the belt deserves braces. **Any slice made before this fix used
CLI defaults, not the P2S profile.**

Validation that it is the same slicer Brett drives by hand: on the shipped
curve the loop reports 517.9 mm of Floating vertical shell against the GUI's
513.9, and 17 647 mm of filament against ~17 600.

---

## 3. THREE CORRECTIONS TO THE LAST HANDOFF

**(a) "Concentrated in a 1.6 mm band at z 20.4–22.0" — no.** That reading came
from `slice_audit`'s "worst layers" list, whose `trouble` regex is
`/Bridge|Floating|Overhang|Support/` and is therefore dominated by Bridge. It
found where the slicer BRIDGES most, not where it floats. Floating + Overhang
alone is spread across **125 distinct layers, z 8 to 38.4** — essentially the
whole part. There is no local defect to patch; it is distributed along the
entire climb.

**(b) "A flatter fit is worth one measurement first" — measured, and it is
dead.** Refitting the plane to minimise the DECK's deviation instead of the
wall lines gives 4974 mm² in the 5–25° band against the shipped fit's 4914 —
very slightly WORSE. A brute-force search over every plane (±0.3 in both
slopes, interior optimum) bottoms out at 4641 mm², **5.5% better than what
ships**, and with a worse maximum angle. The shipped fit is already within a
few percent of the best a plane can do. Do not spend another session on it.

The reason is structural, not a tuning failure. The ceiling is a helicoid: its
normal leans ~11.2° off vertical everywhere, but its AZIMUTH follows the arc,
so over a 90° turn it sweeps 90° of azimuth. A plane has one normal. The locus
of ceiling normals has an angular diameter of 15.8°, so the best-centred plane
still leaves ±7.9° — no plane can bring a 90° curve's ceiling under 5°.

**(c) "Floating vertical shell" is not a synonym for broken.** It has a benign
floor: a flat ceiling produces one loop of it at the single layer where the
ceiling starts in mid-air, and is then bridged normally. A `minimal` straight,
whose ceiling is measurably **0.00°**, still prints 192.8 mm of it. What makes
a curve different is only that its ceiling arrives over ~50 layers instead of
one, so it pays that perimeter cost fifty times. **Compare parts against each
other, never against zero.**

---

## 4. What the library actually measures (0.20mm Standard @BBL P2S)

`Support` is **0.0 mm on every part in both styles** — nothing in the library
needs support material today. Trouble = (floating + overhang) / filament:

| part | minimal | viaduct |
|---|---|---|
| start | 1.19% | 1.19% |
| straight | **1.38%** | 12.20% |
| curveR | **4.56%** | 17.02% |
| lift | 1.43% | 12.37% |
| powered | 0.84% | 1.12% |
| end | 0.76% | 0.76% |
| switchL | **5.68%** | 13.83% |

Two things fall out of this table that nobody had looked at:

- **`minimal` is dramatically better than `viaduct` everywhere it differs** —
  a straight is 1.38% against 12.20%. The arcade is by far the bigger generator
  of floating shell, and `viaduct` is still the DEFAULT style.
- Only the **curve (4.56%) and the switch (5.68%)** stand out among `minimal`
  pieces; everything else sits near 1%. The curve's excess over a straight is
  about 570 mm of filament.

---

## 5. The mechanism, confirmed rather than argued

The ceiling climbs **across the channel** (4.70° mean, 8.11° peak) and barely
**along the arc** (1.18°) — the last handoff guessed this and it is right. So
its contour lines run ALONG the arc, and each 0.2 mm layer advances the ceiling
edge 1.3–1.8 mm sideways, more than an extrusion width, leaving each advancing
perimeter with nothing beneath it.

Confirmation is a shape match, not a story: mapping the ≥5° ceiling in bed
coordinates and histogramming it by azimuth gives peaks in the −150..−135° and
45..60° bins, and the gcode's trouble filament peaks **in the same two bins**.

Two levers were tested and are not worth pulling:

- **Layer height is not a lever.** 0.20 → 4.56%, 0.16 → 4.04%, 0.08 → **5.24%**
  (worse). Halving the sliver width also doubles the number of slivers.
- **Reducing the export tilt** trades the across-channel ceiling slope against
  depth, and the exchange rate is ruinous: the tilt is what holds the deck-to-
  plane distance to ±5.46 mm, and a level plane lets it vary by the full 44.75
  mm drop. Getting the ceiling under 5° needs ~60% of the tilt removed, which
  costs tens of cm³. This axis IS the viaduct↔minimal axis, and §4 shows which
  end of it wins.

---

## 6. RIBS DO NOT WORK — measured, not argued

The last candidate standing was **radial bridge-ribs**: thin fins running
ACROSS the channel (the advancing perimeter runs along the arc, so it crosses
them), each with a flat bottom parallel to the underside plane so the rib is
itself a bridge anchored on both skirt walls. It was prototyped at mesh level
and sliced. It makes things **worse at every pitch**:

| ribs | filament | floating | overhang | trouble |
|---|---|---|---|---|
| none (baseline) | 17 647 | 518.0 | 287.3 | **805.3** |
| 19 @ 10 mm | 18 830 | 566.0 | 313.9 | 879.8 |
| 38 @ 5 mm | 19 937 | 557.7 | 343.8 | 901.4 |
| 64 @ 3 mm | 21 511 | 712.5 | 382.1 | 1094.6 |

The reason is simple once seen: a rib only touches the advancing perimeter over
its own 0.8 mm thickness, so at 10 mm pitch it catches 8% of that perimeter's
length — while every rib contributes a full set of new perimeters and its own
floating bottom edge. Tightening the pitch adds cost faster than it adds
support. To actually land the perimeter you would need a pitch near one
extrusion width, which is a solid cavity, which is ~50 g.

Terracing the ceiling into flat treads was rejected earlier on the same kind of
measurement: with honest connected-component analysis only 27% of tread area at
0.6 mm steps lands on a band reaching BOTH walls, so 73% cantilevers. (A naive
per-level touch test says 93% and is wrong — one level is often two patches,
each hugging one wall.)

**So the recommendation is to stop.** Every geometric lever has now been
measured and every one is neutral or negative. What is left is not a defect:
support material is 0.0 mm, the part prints, and the residual is ~570 mm of
perimeter laid at a shallow overhang on the UNDERSIDE of the deck, which is
hidden in use.

The one open question is physical, not geometric, and only Brett can answer it
because he has the printed curve: **does any of that droop telegraph through
the 2 mm floor to the WALKING SURFACE?** That is the only place it could matter,
because that surface is the gait. If the walking surface is clean, the
"floating regions" warning should be documented as expected for a 90° curve and
left alone.

---

## 7. Things already tried, so nobody repeats them

- **Constant-depth underside on a curve.** A helicoid, 5.15 mm from its own
  best-fit plane. No rotation flattens it; the part rests on one end.
- **Removing the rim clamp without sloping the rib bottoms.** Bed contact goes
  to zero. Both halves have to move together.
- **A level face inside a tilted plane.** Cannot be flush — this bit the socket
  mouth (2.91 mm proud at D = 12) and the boss collar, and is why
  `minimalDepthMm` is 17.
- **A third spacer for the switch.** Avoided by snapping the seat onto the grid.
- **A fully coned socket ceiling in minimal.** Structurally impossible: the 45°
  bore needs 3.90 mm of headroom and has −1.07.
- **Refitting the underside plane** — §3(b). Within 5.5% of optimal already.
- **Layer height, and reducing the tilt** — §5.
- **Terracing the ceiling**, and **radial bridge-ribs** at 10/5/3 mm pitch — §6.
  The ribs were prototyped and sliced; they are worse at every pitch.

---

## 8. Rules this work established, worth not breaking

- **One expression of the underside.** `undersidePlane` is the only thing that
  says where it is. `tests/pieces.test.js` asserts nothing sits below a piece's
  own plane and that both end ribs and the boss reach it.
- **`laysOnUnderside` gates everything at once** — rim clamp, boss collar,
  export tilt. They were allowed to disagree once and a flat platform balanced
  on a 114 mm² ring.
- **Cutters that are solids of revolution eat the core.** Bore the cutter
  first, subtract the tube.
- **Stock scenes cannot go stale** (`tests/scene_currency.test.js`).
- **Flatten a slicer preset before believing it** — §2.
- **Nothing here has been printed except one curve.** Every other number in
  `reports/print-audit.md` is measured off a mesh; every number in
  `reports/slice-baseline.json` is measured off a real slice, but only the one
  curve has ever come off a printer.
