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

## What the first real print said (2026-08-08)

A ramp → curve → ramp assembly test came back. Three findings, all now fixed in
geometry, and one of them is a lesson about the tests rather than the part.

**The wall was too thin, and the saving was never real.** `SPEC.wall` had been
cut 2.4 → 1.6 to save plastic — the shell is ~75% of all track plastic, so it
looked like 15% off the whole job. Printed, the skirt walls were too slender to
stand up while being built: a pier is `ARCH.pier` = 8 mm long, so at 1.6 it met
the bed on 12.8 mm² and carried a 40 mm wall above it. A centre pier on the
straight shifted on the plate and welded back on crooked. Back to 2.4, which
puts 19.2 mm² under the same pier; measured bed contact on a curve goes
803 → 918 mm².

**The keys would not go in.** A shelf ran right round the pocket that nothing
could enter past. The detent was 0.35 mm proud AS A SQUARE STEP, and the
arithmetic nobody had done says why: the pocket is drawn 0.2 mm/side clear of
the key, but a printed slot comes out ~0.16 mm/side narrow, so the plain throat
is already at zero clearance — the detent then added 0.35 on top. 0.82 mm of
interference across a 16 mm neck, against a rib far too stiff to flex. Now
0.15 mm proud and led in over a 0.8 mm ramp, so the key rides up a wedge
instead of shearing through a wall.

**The test that should have caught it did not exist.** There WAS a detent test,
and it passed: it proved the detent existed and was a ledge rather than a plug —
both true of a detent so proud the key could never reach it. It tested the
feature, not the function. The replacement sweeps the key's real footprint up
the slot through the FINISHED mesh and requires the whole travel to be clear;
run against the old geometry it reports `blocked at y=31.80 (lateral -8.3)`,
which is the shelf, at the key's neck edge.

The curve's arches printed badly and the floating-cantilever warning was real.
The thicker wall stiffens the arch ribs but does NOT change the span that
causes it: the deck still bridges the full channel, 47.4 mm, at every layer.
See the entry below.

## Tuning the joints from the printed set (2026-08-08)

Both joints came back wrong, in ways that sound contradictory until you measure
them, and `bowtieFitTrials` in geometry.js now runs the printing variation
rather than assuming a nominal.

**The key was tight and loose at the same time, and that is one fault.** At the
shipped 0.2 mm clearance the flanks had 0.18 mm of gap while the four TIP
corners interfered by 0.20 mm — a pocket's far corners are internal, a 0.4 mm
nozzle leaves a ~0.30 mm radius in them, and a sharp key tip cannot enter that.
So the key stood on its corners and rattled everywhere else, which is exactly
what it felt like in the hand.

**The chamfer was the binding constraint, not the clearance.** That is what the
simulation was worth: at 0.8 mm of tip chamfer the joint only tolerates a corner
radius up to 0.37 mm, and the radius is 0.30 ± 0.08, so a fifth of printed keys
still bound. Past ~1.2 mm the corner stops being the limiter at all. 1.4 mm
tolerates 0.58 mm, past three sigma, and more buys nothing.

    printed set (0.20, no chamfer)   P(goes in)  9%   P(snug) 17%   P(both)  0%
    now         (0.08, 1.4 chamfer)  P(goes in) 96%   P(snug) 77%   P(both) 73%

**What the simulation will not do is guarantee it.** Swept over an unknown
process bias of ±0.10 mm/side, no clearance keeps a good fraction — 0.10 mm of
bias alone eats the whole fit window. The honest next step is to MEASURE the
bias off a calibration coupon (one key, one pocket, calipers) and set
`SPEC.key.fitClearanceMm` from it; the constant and the model are both one line
to re-tune. Failing that the joint wants a compliant feature rather than a
better dimension.

**The track's hex socket is loose while riser-to-riser is snug — with identical
CAD.** Both sockets measure 9.00 AF at every height; the difference is that a
lone boss hanging under the deck of a 150 mm part does not hold size the way a
compact hex prism standing on the bed does. There is no number to derive from
that, only one to compensate with, so the TRACK socket alone is cut 0.2 AF
undersize (`SPEC.socket.trackShrinkAF`) and every riser-to-riser joint is left
exactly as it prints today — that one already works and must not be "fixed".

**A level top under a sloping deck (found in CAD, 2026-08-08).** The end rib
was a prism whose top was taken at its own face. The deck falls 0.198 mm/mm, so
over 12 mm of rib it drops 2.4 mm while the rib stayed level — and through a
2 mm floor that surfaced 0.28 mm proud on a straight, 0.48 on a curve (where
the flat slab also diverges from the arc, so it breaks through further on one
side than the other), and 0.32 on a LIFT at the far end, because a climbing
piece flips which rib is guilty. It printed as a fin crossing the washboard.

The socket boss had exactly this fault once and was fixed by sloping its top;
the rib was simply never revisited. Both now take the deck as a function of
position. The test added for it checks the SURFACE — nothing in the channel may
rise above the washboard crest — rather than checking the rib, so the next
feature to get it wrong is caught without anyone remembering to look.

## Still open

**The curve's arcade still bridges the full channel.** Measured on the failed
print: the deck spans 50.3 mm wall to wall with nothing beneath it, at every
layer, because the arcade is open by design and the deck slopes — so each
0.2 mm layer exposes a ~1 mm strip of new ceiling and lays it as an unsupported
strand. Removing the curve widening took that to 47.4 mm, which is inside the
envelope the straight on the same plate (46.5 mm) printed cleanly, and the
thicker wall stiffens the ribs; whether that is enough is a print away. The
curve's arches are NOT the problem — it gets 4 openings of 42 mm and a 0.6 mm
flat crown against the straight's 2 openings of 53 mm and a 24 mm flat crown.
If it still fails, the fix is structural: the floor cannot bridge the full
channel unsupported, and the options are restoring some support under the deck,
raising the arch crowns, or accepting supports on curves.

**A calibration coupon.** One key and one pocket, printed and measured, would
turn the process bias from a swept unknown into a number — and that is the only
thing standing between the Monte Carlo and an actual guarantee. It would also
settle whether the track socket's 0.2 AF compensation is right, too much, or
too little. Cheapest outstanding item by far.

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
