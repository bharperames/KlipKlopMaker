# Two open pieces of work — closed, with what changed on the way

Both items in this plan are done. Kept rather than deleted because the plan was
explicit about which of its claims were measured and which were judgement, and
the answers turned out to matter: one of the judgements was wrong, and the
build deviated from the plan twice for reasons worth having on record.

What is still open is at the bottom.

---

## 1. One curve part per direction — DONE, by the other route

**The plan's question.** Collapsing `_entry`/`_through`/`_exit` into one curve
means pinning every mating face to the base 48 mm, which necks the channel at
each curve-to-curve seam. Nobody had measured whether that matters.

**Phase 1 built as specified.** `js/clearance.js`: rigid footprint (the figure's
extent *below rail height*, 47.5 × 44 mm at full pendulum swing) swept along the
centreline, yaw taken as half the turn the tangent makes in one stride. It
reproduces the straight channel at exactly its stated 4 mm of play, wants
50.03 mm at the standard radius and 50.52 at the 120 mm minimum — so the +3 mm
widening and the 120 mm floor both fall out of the figure's own geometry.
PHYSICS.md §8 is the write-up, and it is explicit that the yaw law and the 3 mm
clearance floor are still argument, not measurement.

**Phase 2 answered — and neither branch was right.** The plan set up a binary:
collapse the taper, or keep the variants for a measured reason. The measurement
found a third thing. Worst side-to-side play over the eleven stock scenes:

| Seam rule | Worst play |
|---|---|
| Every face at base width (the collapse) | 0.97 mm |
| Narrower face wins (what the project did) | 1.87 mm |
| No match at all — stepped, ledge and all | 2.28 mm |
| **Wider face wins (now)** | **2.79 mm** |
| Uniform 51 mm channel | 3.22 mm |

The taper was pointing the wrong way. A footprint is 47.5 mm long, so at a curve
mouth half the figure is already round the corner: the channel has to carry the
curve's width for half a footprint on *either* side of the turn, not shed it at
the join. `resolveSeamWidths` now takes the max. 51 is the ceiling any seam can
reach, so every curve face is 51 and a curve is one solid wherever it sits —
the plan's goal, reached by fixing the rule rather than by collapsing it.

The cost is real and worth naming: the variance moves onto the straights that
flank a turn (`_into_curve`, `_out_of_curve`, `_between_curves`). Across the
stock scenes that is curves 29 → 13 distinct width-shapes and straights
33 → 51 — near enough a wash on count, but it lands on the family a tower has
two or three of instead of the one it has twelve of, and straights are not
chiral.

**Uniform 51 was the only rule with positive margin everywhere.** It is also the
only one that deletes the seam-width mechanism entirely. It was not taken,
because it changes `STANDARD.innerWidth` — a MAJOR geometry bump, a new figure
width, and a spec range to move. That is a call to make deliberately, not as a
side effect of a taper fix. The number is on the table if it is ever wanted.

**Phase 3 not done.** No print has been run. The model predicts 2.79 mm of play
at a curve mouth; the plastic has not been asked.

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

**The outrigger axis.** Untouched by any of the above. `_outrigger` comes from
support planning, not from width: measured across four designs, supports are
almost all `center @75` (straight mid) or `center @113` (curve mid), the
outliers being two nudged positions and five outriggers out of ~48.
Standardising the socket to mid-piece on every piece would remove the axis. It
changes where a pier can land, so it is a separate decision.

**Parts still unmarked.** The gate paddle, scenery (tower, palm, patio) and the
figure carry no code. The gate and the figure have no compatibility axis worth
a version claim; the scenery does, and a flat face exists on each — it just was
not done. `engraveFlatOps` takes an origin and two spanning vectors, so adding
one is a few lines per family.

**A uniform 51 mm channel.** See above. Deliberately not taken; the measurement
that would justify it is in PHYSICS.md §8 if it is ever wanted.
