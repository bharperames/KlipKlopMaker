# Two open pieces of work

Written at the end of the session that raised them, so the next one starts from
evidence rather than from memory.

---

## 1. One curve part per direction

**Goal.** `curveL` and `curveR` as single parts. Today a helix produces four
variants — `_entry`, `_through`, `_exit`, plus `_outrigger` — which are genuinely
different solids, cannot be swapped, and are indistinguishable in a parts bin.

**What blocks it.** `tests/track.test.js` → *"a helix is not pinched at its
interior seams"*. Collapsing the variants means pinning every mating face to the
base 48 mm, which makes the channel neck from 51 back to 48 at each
curve-to-curve seam: a waist ~60 mm long, 3 mm narrower, twice in the middle of
a continuous turn. See the review diagram for what that looks like drawn from
the real `innerWidthAt` smoothstep.

**Why the test cannot currently be argued with.** It encodes a judgement, not a
measurement. `simulate.js` models motion *along* the track — speed, slope,
friction, walk/slide regimes, stall, tumble — and **never reads channel width**.
So it will report the ride as unchanged under either rule, and a green suite
after the collapse would be evidence of nothing. Nobody in this project has
measured whether 4 mm of play (a ~44 mm figure in a 48 mm channel) is enough
mid-turn, where 7 mm is what the +3 mm widening currently provides.

### Phase 1 — give the simulator a lateral model

This is the load-bearing work; the rest falls out of it.

- New pure module, e.g. `js/clearance.js`, no DOM/Three, Jest-tested directly.
- Model the figure as a rigid footprint of length `L` (hoof contact to hoof
  contact) and width `W`, travelling the centreline with a yaw `ψ` relative to
  the local tangent. Swept lateral envelope ≈ `W·cos ψ + L·sin ψ`.
- `ψ` is not free. A passive walker tacks: it pivots on alternating hooves, so
  yaw oscillates at the step cadence. `physics.js` already produces cadence and
  speed from the rimless-wheel gait — take `ψ` amplitude from step geometry and
  turn radius rather than inventing it.
- Export `requiredWidthAt(piece, s, walker)` → the channel width that envelope
  needs, plus a clearance margin.
- Assert `innerWidthAt(piece, s) >= requiredWidthAt(...)` at every station of
  every scene in `scenes/`. That is the test that should exist; the pinch test
  is a proxy for it.

**Inputs to pin down first:** figure length between hoof contacts, figure width
(the 44 mm figure in `figureVolumeEstimate(44)` / `buildFigureGeometries(48)`),
and whether yaw amplitude is set by step length over turn radius or by the
rimless-wheel geometry directly. Get these from PHYSICS.md before coding.

### Phase 2 — answer the pinch question with the model

Run `requiredWidthAt` through a helix seam under both rules.

- **Clears 48 mm with margin** → collapse the taper in `resolveSeamWidths`
  (every face = base), delete the pinch test and replace it with the envelope
  assertion, and all curves become one part. `_entry/_through/_exit` disappear.
- **Does not clear** → keep the variants, now for a measured reason rather than
  an inherited one, and leave the naming and accordion as they are.

Either outcome is a win: one removes the variants, the other justifies them.

### Phase 3 — physical validation

Print one helix tier under whichever rule wins and run a figure through it. The
model should predict what the plastic does; if it does not, the model is wrong
and needs the print's data before anything ships.

### Second lever, independent of the above

The `_outrigger` variant comes from support planning, not from width. Measured
across four designs, supports are almost all `center @75` (straight mid) or
`center @113` (curve mid); the outliers were two nudged positions and five
outriggers out of ~48. Standardising the socket to mid-piece on every piece
would remove that axis. It changes where a pier can land, so it is a separate
decision from the width work.

### Constraints to respect

- The +3 mm widening is in the published physics rule set (readme, PHYSICS.md).
  Changing it is a documentation change too, not just code.
- `SPEC.innerWidth` is stated as 46–50 mm, but curves already run at 51.
  Reconcile that while you are in there.
- Whatever changes, every export must still pass `analyzeMesh`, and the seam
  step-edge property (no lateral ledge at any joint) must hold — that is what
  the taper was invented for in the first place.

---

## 2. Engraved part codes

**Goal.** Every printed part carries a code, engraved, readable on the bench
after it leaves the slicer.

**Scheme.** Semver with a short type prefix, mirroring the part name but
simplified:

```
Str 1.1        CurveL 1.1      CurveR 1.1
Lift 1.1       Elev 1.1        Pwr 1.1
Switch 1.1     Gate 1.1        Key 1.1
Foot 1.1       R15 1.1  R30 1.1  R60 1.1  R120 1.1
```

The version comes from `GEOMETRY_VERSION`, which is already semver with exactly
the right semantics — *"bump MAJOR when printed parts stop mating (joint/socket/
grid changes), MINOR for additive compatible geometry"*. So a code reads as a
compatibility claim: `CurveL 1.x` mates with `Str 1.y`, and a major bump tells
you the bin of old parts no longer fits. Derive it, never maintain it by hand.

**Placement.** The end-rib connector face: flat, vertical, structural but not a
sealing surface, and — importantly — planar even on a curve, since the end faces
are radial planes. No arc-following text. About 51 × 26 mm with the bowtie
pocket through the middle, so two short lines fit at 4 mm caps.

Parts without an end rib (keys, risers, feet, scenery, figure) need a face
chosen per family — a flat vertical wall where there is one, otherwise the
underside.

**Implementation.**

1. Add `opentype.js` and bundle an OFL-licensed font with simple contours.
2. New pure module `js/engrave.js`:
   - `textRings(str, opts)` → closed polygon rings per glyph, outer plus
     counters, flattened from opentype's quadratic/cubic commands at a tolerance
     consistent with `SIMPLIFY_TOL_MM`.
   - Pure, no CSG, no Three — Jest-testable on ring counts, winding and bounds.
3. In `pieces.js`, `engraveOps(piece, text, face)`:
   - place rings on the end-rib plane via `planToWorld`,
   - `extrudePolygonY` each outer ring, subtract its counters (an `A` needs its
     hole back), union all glyphs into **one** solid,
   - a single `SUBTRACTION` against the part.
4. `SPEC.engrave = { depth: 0.5, capHeight: 4, tracking: 0.6, minStroke: 0.8 }`.
   Depth 0.5 into a 1.6 mm wall leaves three perimeters at a 0.4 nozzle; stroke
   0.8 is two line widths, below which a slicer drops the stroke entirely.
5. Export geometry only. Never engrave display meshes — scene rebuilds stay cheap.

**Tests.** Rings close and wind consistently; an engraved part still passes
`analyzeMesh` (manifold, consistent, outward); engrave depth never exceeds a
third of `SPEC.wall`; the code string derives from `GEOMETRY_VERSION` so a
version bump changes every part's code.

**Watch.** CSG cost — union the glyphs before subtracting or export time grows
noticeably, and the arcade booleans are already the slow part of an export.
