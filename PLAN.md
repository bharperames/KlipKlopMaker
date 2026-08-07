# Two open pieces of work — closed, with what changed on the way

Both items in this plan are done. Kept rather than deleted because the plan was
explicit about which of its claims were measured and which were judgement, and
the answers turned out to matter: one of the judgements was wrong, and the
build deviated from the plan twice for reasons worth having on record.

What is still open is at the bottom.

---

## 1. One curve part per direction — DONE, and it was the wrong question

**The plan's question.** Collapsing `_entry`/`_through`/`_exit` into one curve
means pinning every mating face to the base 48 mm, which necks the channel at
each curve-to-curve seam. Nobody had measured whether that matters.

**Phase 1 built as specified.** `js/clearance.js`: rigid footprint (the figure's
extent *below rail height*, at full pendulum swing) swept along the centreline,
yaw taken as half the turn the tangent makes in one stride.

**Phase 2 first answer — flip the taper.** The measurement said the taper was
pointing the wrong way: a footprint is 47.5 mm long, so at a curve mouth half
the figure is already round the corner and the channel has to carry the curve's
width for half a footprint on *either* side of the turn. `resolveSeamWidths`
took the max instead of the min, which made every curve one shape and moved the
variance onto the straights that flank a turn.

**That was wrong, and the count showed it once counted properly.** The first
tally was per-scene and summed, which double-counts a straight appearing in
eight scenes and hides all cross-scene reuse — the entire point of a parts bin.
Counted as DISTINCT shapes across the whole library the change made things
worse, not neutral: 14 → 16. It bought 0.9 mm of clearance and cost two part
numbers.

**The real answer came from the bench.** A real Klip Klop figure measures
**38 mm**. The project's printed figure was 44, because it was defined as
`channel − 4` — a number with no physical referent, which then justified the
channel that defined it. At 38 mm the swept path fits a **uniform 48 mm
channel at every legal radius**, tightest turn included, with 3.4 mm to spare.

So `SPEC.curveWidenMm` is 0 and there is nothing to taper anywhere:

| Configuration | Distinct shapes | Worst play |
|---|---|---|
| 44 mm figure, tapered, narrower face wins | 14 | 1.87 mm |
| 44 mm figure, tapered, wider face wins | 16 | 2.79 mm |
| **38 mm figure, uniform 48** | **8** | **5.84 mm** |

Eight is one shape per piece type — the floor. Fewer parts *and* more clearance,
which is what an answer looks like when the thing blocking it was a wrong
assumption rather than a real trade. A second printed measurement (a 48 mm
channel comes out at 47.68) is now subtracted in the fit check, so it reports
what the plastic does rather than what the CAD does.

The taper machinery is kept, correct and tested: a custom-parameter build can
still ask for a widened turn, and there the wider-face rule and the `_into_curve`
naming still apply. At the Standard neither can fire.

**Phase 3 not done.** No print. The yaw law and the 3 mm clearance floor are
still reasoned rather than measured.

**The lesson worth keeping.** Two numbers in this project justified each other
in a loop — the figure was `channel − 4` and the channel was sized for the
figure — and no amount of modelling inside that loop could see out of it. It
took one caliper reading on the actual toy.

---

## 2. Engraved part codes — DONE, with a different font strategy

Every exported part carries its code, cut 0.5 mm deep: `CURVEL 1.1`,
`STR IN 1.1`, `PLAT 1.1`, `KEY 1.1`, `R120 1.1`. Derived from
`GEOMETRY_VERSION`, MAJOR.MINOR only.

**Deviation 1 — a stroke font, not opentype.js.** The plan's own
`minStroke` note is the reason. At these sizes an outline font's stems are
under one extrusion width, and a slicer does not render a thin stem faintly —
it drops it, and the part arrives with holes in its code. A pixel
A stroke font makes the constraint structural rather than advisory: a glyph is
a centreline, the stroke width is the pen, and no part of a letter can come out
thinner than you ask for. No dependency, no bundled font file.

Two pixel-matrix versions were tried on the way — 3 × 5, then 5 × 7 — and both
were rejected for reading as coarse. A pixel grid satisfies the minimum-feature
rule too, but at 3.5 mm cap height a 5 × 7 grid is 0.5 mm per pixel and every
curve in the alphabet becomes a visible staircase. The stroke font gets the
same guarantee with round letters: the skeletons are sparse and the round ones
run through a Catmull-Rom spline before they are inked. They overshoot the
nominal box slightly, as every typeface's round letters do, so the metrics
measure the font's real extent rather than assuming the box — clamping the
overshoot back was worse than the disease, since the flat spot it left is a
corner in the middle of a curve.

**Deviation 2 — the channel wall, not the end rib.** The plan chose the end rib
for being planar even on a curve. Measured, the rib's usable face is not
51 × 26 mm: the bowtie pocket takes the middle and the two lightening windows
take most of what is left, leaving a pair of ~10 mm panels — too small for a
code at a readable cap height. And the rib is a *mating* face, the one surface
on the part where half a millimetre matters.

The rule that settled it: on the inside, never a show surface and never a
mating face. Four candidates were built and measured before one stuck.

| Face | Why not |
|---|---|
| End rib | pocket + windows leave ~10 mm panels; it mates |
| Outer rail | the show surface of an assembled tower |
| Drumhead underside | the acoustic membrane, and the Ø19 boss rises to meet it — text over the boss is a sealed void, not a pocket |
| Inner skirt wall | the arcade cuts arches through it; the only band continuous end to end is `ARCH.band` less the floor, 1.6 mm |
| **Channel face of a rail** | **vertical, inside, 1.6 mm of wall, and the cut only widens the channel so it cannot bind a figure** |

Curves cost an arc-following placement, which the station machinery already
had. Small parts follow the same rule: a riser takes the whole code as two
lines on ONE hex flat, turned on its side (upright it does not fit an 8.66 mm
face); the foot takes its base, where a 24.8 mm disc has room to spare.

Orientation is not a preference. Text reads correctly iff `read × up` points at
the reader — get it backwards and the whole library ships mirrored. There is a
test, written as that invariant rather than as "runs with travel", so it keeps
working whichever plane the code lands on.

**One trap worth remembering.** A code placed inside solid material does not
fail loudly — it becomes a sealed void, invisible and a second shell in a part
that must be one solid. The start platform's bumper fills the channel 2–10 mm
in and swallowed the first glyph at the original 6 mm margin. The single-shell
test caught it; `SPEC.engrave.marginMm` is 14 because of it.

---

## Still open

**Physical validation (was Phase 3).** Print one helix tier and run a figure
through it. The clearance model predicts 2.79 mm of play at the tightest point —
the curve mouth — and 3.97 mm through a curve body. If the plastic disagrees,
the yaw law is what is wrong and it needs the print's data before anything else
in §8 is trusted. This is the single highest-value thing left.

**The outrigger axis — DONE.** It was never a track problem. Measured over the
stock scenes, 120 of 137 supports already sat at mid-piece; the other 17 moved
only because the column under them would have speared the tier below, and each
one cost a track part. The offset now lives in a JOG: an offset riser with a
hex tenon up into the standard mid socket and a hex socket down for the stack,
45 mm long and one grid unit tall so it substitutes for a 15 mm riser.

45 mm is forced by the hex: a jog can only point six ways, so the worst
orientation is 60° off and its useful reach is 45·sin 60° = 39 mm. Measured,
42 mm places every support in the library, 40 leaves three helix curves
unsupportable, and the old integral arm's 37.5 leaves thirteen.

Six track variants became one small shared part, every piece of a type now
exports byte-identically whatever is under it, and a two-tier spiral tower
needs 11 distinct printed parts in total.

**Not yet printed.** The jog is a 45 mm cantilever on a 9 mm AF hex joint,
carrying tower weight in bending where the old arm carried it rigidly. That is
the one thing about it that CAD cannot answer.

**Parts still unmarked.** The gate paddle, scenery (tower, palm, patio) and the
figure carry no code. The gate and the figure have no compatibility axis worth
a version claim; the scenery does, and a flat face exists on each — it just was
not done. `engraveFlatOps` takes an origin and two spanning vectors, so adding
one is a few lines per family.

**Play on straights, and whether 48 is still the right number.** A straight now
gives the figure ~9.7 mm of side-to-side play, where the old rule gave 4. The
reference toy's own ramp uses a tight 39.5 mm groove; ours is a walled channel
with 14 mm rails and re-centring floor fillets, which is a different philosophy,
but 9.7 mm is a lot of room to wander and every wall contact costs gait energy.

Worth knowing if this is ever revisited: **channel width is the one Klip Klop
Standard value that is not geometrically derived.** Slope, tile drop, curve
radius and the riser stack all fall out of the 15 mm grid; 48 was picked as
"centre of the 46–50 mm spec" and nothing else depends on it. The floor is now
measured — a real 38 mm toy swept through R 120 needs 44.60 mm, plus the
0.32 mm a print loses, so ~45 mm. Dropping to 45 or 46 would halve the wander
and cost only compatibility with parts already printed at 48; it would not
disturb the grid, the slope, or the supports. Cross-system interoperability is
explicitly NOT a goal of this project, so nothing outside it is at stake.
