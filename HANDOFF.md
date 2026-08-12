# Handoff — printing a minimal curve with no slicer warnings

The task for the next session: get `curveR` (and `curveL`, and the switch) to
slice clean — no *"has floating regions"* warning and no tree supports —
without giving up the flat print orientation. Everything below is measured,
and the last section is what has NOT been tried.

---

## 1. Where things stand

Clean tree, **357 tests passing**, no console errors, every printable part
watertight. `viaduct` is still `SPEC.skirt.style`; `minimal` is opt-in in the
Underside selector and is the variant this is all about.

A `minimal` piece is exported **already tilted onto its own underside**
(`tiltOntoUnderside`, gated by `laysOnUnderside`). Do not re-orient it in the
slicer — that is the whole reason it is shaped the way it is.

| part | on the bed | tall | mass |
|---|---|---|---|
| straight | 1480 mm² | 30 mm | 69 g |
| curve | 1777 mm² | 41 mm | 106 g |
| switch | 2680 mm² | 43 mm | 158 g |

Support library: **foot · jog · risers 60/30/15 · one spacer (SPC 11.20)**.
Straights, lifts and switches need no spacer at all — their socket seat snaps
onto a 15 mm grid line. Only a curve is off-grid, by 11.2 mm.

---

## 2. HOW TO READ A SLICE — the capability this session added

`scripts/slice_audit.mjs` takes either a `.3mf` or a `.gcode`:

```
node scripts/slice_audit.mjs part.3mf      # downward area by angle band
node scripts/slice_audit.mjs part.gcode    # filament by FEATURE, worst layers
```

**This is the tool that settled the argument, and it should settle the next
one too.** Whether a downward surface needs support is not decidable from the
model: it depends on how the surface ARRIVES layer by layer, and the only
thing that knows is the slicer. Bambu tags every extrusion move with
`; FEATURE: ...`, so a sliced file is a direct readout of its judgement.

Notes for anyone extending it:

- Bambu emits **no `;LAYER_CHANGE` and no `;Z:`** in this profile. Track Z off
  the layer-change `G1` move itself, and note it writes `Z.4`, not `Z0.4`.
- `; FEATURE:` is a **comment**. The firmware never sees it. The actual
  behaviour is entirely in the F (speed), E (flow) and fan values the slicer
  emits for those moves — so the gcode IS the complete specification of head
  action, and "bridge" survives in it only as different numbers.
- Skip negative E (retractions) or the totals are meaningless.
- 3MF is **Z-up**; the app's meshes are Y-up. The exporter rotates X=x, Y=−z,
  Z=y on the way out.

---

## 3. What the slicer actually says about a curve

From `curveR_1_PLA_3h2m.gcode`, a real Bambu P2S slice of the shipped part:

| feature | filament | share |
|---|---|---|
| Internal solid infill | 3330.7 mm | 18.9% |
| **Bridge** | **3052.6 mm** | **17.3%** |
| Sparse infill | 3051.4 mm | 17.3% |
| Outer wall | 2235.4 mm | 12.7% |
| Inner wall | 2064.8 mm | 11.7% |
| Top surface | 1564.5 mm | 8.9% |
| Gap infill | 1477.4 mm | 8.4% |
| **Floating vertical shell** | **513.9 mm** | **2.9%** |
| **Overhang wall** | **286.9 mm** | **1.6%** |

Worst layers, by trouble filament: **z = 20.4 to 22.0** — a 1.6 mm band. That
is the same layer 102 / z 20.40 that looked wrong on screen.

**The slicer is already bridging most of it.** 17.3% Bridge means the ceiling
is being spanned, not supported. The problem is the 2.9% + 1.6%.

---

## 4. THE DIAGNOSIS — anchored at both ends is not enough

A bridge needs its two anchors **in the same layer**.

- A **flat** ceiling arrives all at once: one layer contains the whole 48 mm
  span, wall to wall. True bridge, no support.
- A ceiling climbing at α arrives as a **series of slivers**, each stepping
  sideways by `layerHeight / tan α`. At 8° that is **1.4 mm per 0.2 mm layer**,
  many times an extrusion width. The interior of each sliver still gets bridge
  treatment — that is the 17.3% — but its **leading perimeter has nothing
  beneath it**. That is `Floating vertical shell`, and it is literally what the
  warning names.

Measured on the meshes, the 5–25° band is the one that costs:

| part | flat <5° (bridged) | **5–25° (supported)** |
|---|---|---|
| straight | 5783 mm² | **645** |
| **curve** | 5457 mm² | **4680** |

**Seven times the shallow-sloping area.** And the cause is precise: the plane
cut made the curve's *bottom* flat, but its *top* is still a helicoid. On a
straight the deck is parallel to the underside plane, so the drumhead ceiling
is parallel to the bed. On a curve the deck wanders **±5.46 mm** off the fitted
plane, so 4680 mm² of ceiling ends up tilted 5–25°.

It has nothing to do with the walls, nothing to do with the arcade, and
nothing to do with the old Bambu cantilever warning.

---

## 5. The target for the next session

**Give each advancing perimeter something to land on.** Not "support the
ceiling" — the ceiling is largely fine. The 514 mm of floating vertical shell
is the leading edge of each sliver as the ceiling climbs around the arc, and
it is concentrated in a 1.6 mm band of Z.

Ideas, none tried:

- **Sacrificial ribs** from the underside plane up to the drumhead, spaced so
  each layer's advancing edge lands on one. They only have to catch the
  perimeter, not carry the ceiling, so they can be thin and snap off. This is
  the viaduct arcade's job re-aimed at the ceiling instead of the walls.
- **Rib direction matters and should be derived, not guessed.** The ceiling
  climbs fastest across the channel (~8°, from the ±5.46 mm plane deviation)
  and slowly along the arc. Ribs should run along the direction of steepest
  ascent so a sliver's edge crosses them.
- **Iterate against the slicer, not against intuition.** Change geometry →
  export → slice → `slice_audit.mjs` → watch `Floating vertical shell` and
  `Overhang wall` fall. That loop now exists and is fast.
- A **flatter fit** is worth one measurement first: the plane is currently
  fitted to the two wall bottom lines by least squares. Fitting to minimise the
  DECK's deviation instead would trade bed contact for a flatter ceiling. The
  numbers to compare are 1777 mm² of contact against 4680 mm² of 5–25°.

---

## 6. Things already tried, so nobody repeats them

- **Constant-depth underside on a curve.** It is a helicoid, 5.15 mm from its
  own best-fit plane. No rotation flattens it; the part rests on one end.
- **Removing the rim clamp without sloping the rib bottoms.** The end rib's
  level bottom then protrudes below the plane and bed contact goes to **zero**.
  Both halves have to move together.
- **A level face inside a tilted plane.** It cannot be flush. This bit the
  socket mouth (2.91 mm proud at D = 12) and the boss collar, and it is why
  `minimalDepthMm` is 17.
- **A third spacer for the switch.** Avoided — snapping the seat down onto the
  grid line was better and deleted a spacer instead of adding one.
- **A fully coned socket ceiling in minimal.** Structurally impossible:
  `socketMouthY` defines the seat one socket depth below the floor, so the
  ceiling is always ~2 mm under the deck. Measured, the 45° bore needs 3.90 mm
  of headroom and has **−1.07**. It now closes at 45° in the room that does
  exist — 85 mm² of flat down to 29, and 5.8 mm is a hole any slicer bridges.

---

## 7. Rules this work established, worth not breaking

- **One expression of the underside.** `undersidePlane` is the only thing that
  says where it is. Three places once had their own copy of `deck − D`; they
  agreed for straights and diverged the moment a curve's plane was fitted, and
  the boss ended up 5.3 mm in the air. `tests/pieces.test.js` asserts the
  invariant: nothing below a piece's own plane, and both end ribs and the boss
  all reach it.
- **`laysOnUnderside` gates everything at once** — the shell's rim clamp, the
  boss collar, and the export tilt. They were allowed to disagree once and a
  flat platform balanced on a 114 mm² ring.
- **Cutters that are solids of revolution eat the core.** Sweeping closed
  profiles makes a solid containing the axis; subtracting one as a "groove"
  left the spacer a 0.76 mm shell. Bore the cutter first, subtract the tube.
- **Stock scenes cannot go stale.** `tests/scene_currency.test.js` requires
  every scene to carry the canonical `GEOMETRY_VERSION`, lay out from its
  sequence alone, and pin no parameters.
- **Nothing here has been printed except the one curve above.** Every other
  number in `reports/print-audit.md` is measured off a mesh.
