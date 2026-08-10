# Open questions

Things worth doing that are not started. Each one records what is *measured*
and what is *judgement*, because the measured parts are the ones that survive.

---

## 1. The ragged underside, and the 30% of plastic below the useful part

**Observed** (Brett, on a printed and on-screen spiral): the bottom edge of a
run reads as ragged rather than as an arcade. Two things make it so.

- Every running piece has its rim anchored at its LOW end, so the skirt is as
  deep as the piece's drop plus `skirtDepth`: **42 mm at the high end of a
  straight, 57 mm on a curve**, tapering to 12 at the low end. The arch profile
  cuts into that taper, so at the downhill end there is very little material
  left and what remains is thin and spiky.
- Each piece lays out its own bays independently and both ends carry a 14 mm
  `ARCH.pad`, so **every seam has ~28 mm of solid wall** between the last arch
  of one piece and the first of the next, and the arch pitch changes across it
  (a straight runs 47/37/37 mm bays, a curve 74/62/62). The rhythm breaks at
  every joint.

**Measured** — how much plastic is below a constant-depth beam whose underside
follows the deck, by Monte-Carlo sampling the export mesh:

| piece | volume | discarded by a 12 mm beam | 20 mm | 30 mm |
|---|---|---|---|---|
| straight | 58.9 cm³ | **26%** | 15% | 6% |
| curveL | 85.0 cm³ | **31%** | 23% | 13% |

On a two-tier tower (1117 g of track parts out of a 1672 g job) that is
**roughly 330 g** — a third of a spool, in material that exists only so the
part can meet a flat bed.

### Option B′ — the one to build: a deck-parallel underside (Brett's sketch)

Not a horizontal plane pushed up into the part — a surface **parallel to the
deck**, held a constant `D` below it, with the material below it deleted. That
distinction matters: a horizontal cut takes everything at the high end and
nothing at the low end, which is the ragged taper again. A deck-parallel cut
takes the same amount everywhere.

**It fixes the seams for free.** The deck is continuous across a joint (to
within the 0.25 mm waterfall), so a constant-depth underside is continuous
across a joint too. Today's rim is the discontinuous thing — it steps 30 or
45 mm at every seam, which is why the bottom edge reads as separate pieces.

**How deep it has to be**, from the features that must survive:

| feature | reaches to |
|---|---|
| bowtie pocket ceiling | deck − 3.0 |
| key band (5.6 tall) | deck − 8.6 |
| ...plus throat to insert the key | deck − 14.2 |
| hex socket (10 deep) + 2 mm floor | deck − 12.0 |

So **D ≈ 15 mm**, and the binding constraint is the key's throat, not the
socket.

**The socket still needs a pad.** `decomposeSupport` only works because every
socket mouth is a whole number of 15 mm units off the ground. On a
constant-depth underside the mouth would land wherever the deck happens to be,
so one local pad under the boss makes up the remaining 0–15 mm. That pad is
today's skirt — kept only where it does a job.

*Superseded.* The pad is gone: the remainder is carried by a separate spacer
part instead, which is what lets the piece lie on its own underside. §4 step 2.

**Built, and two of the claims above were wrong.** `SPEC.skirt.style` now
takes `viaduct` or `minimal`; measured on the built meshes:

| | straight | curveL |
|---|---|---|
| viaduct | 60.2 cm³ | 86.2 cm³ |
| minimal (D = 12), boss column to the rim | 49.5 (−18%) | 69.0 (−20%) |
| minimal, boss as a recess, D = 12 | 46.3 (−23%) | 64.4 (−25%) |
| **shipped: recess + collar, D = 15.5** | **50.3 (−16%)** | **69.6 (−19%)** |

D = 15.5 rather than 12 is what lets a straight lie on its own underside (§4
steps 4 and 6). The points it gives back buy a part that lands on the plate.

On the demo tower the first of those was 1672 g → **1492 g**, an 11% job (only
the track parts change; keys, risers and feet are untouched).

- **The saving is 18–20%, not 26–31%** — for as long as the boss is still a
  column down to the rim. Turning it into a recess (§4 step 2) takes another
  5 points, so the shipped number is **23–25%**. The Monte-Carlo estimate that
  said 26–31% compared against a bare beam and was wrong for a different
  reason: the real part also keeps its skirt over the last stretch, where the
  deck is already within D of the rim.
- **The print does not get shorter.** A piece still spans from the rim at its
  low end to deck-plus-rails at its high end: 56 mm on a straight, 71 on a
  curve, unchanged. Height only drops if the part is also tilted, and see
  below for why a curve cannot be.

**D is not free to choose, and 12 is the answer.** The underside meets the
rim exactly when D = `skirtDepth`, so the depths that keep every socket mouth
on the 15 mm grid are 12, 27, 42 — and 12 is the shallowest. Nothing down
there argues for more: the socket does not constrain it at all (the boss keeps
its own full-depth pad to the rim, which is what puts the mouth on the grid),
and the only other feature is the bowtie pocket, whose ceiling is 3 mm under
the deck and whose key is 5.6 tall. At 12 the key still has 3.4 mm of travel
with the pocket fully engaged, after rising its own height to get there.

*Overtaken, and by its own premise.* That whole argument rests on the boss
keeping a pad down to the grid. The spacer carries the grid now, so D is free
of the 15 mm family entirely — and the socket, which "does not constrain it at
all" while it has a pad, constrains it completely once it is a recess: the seat
is level and the underside slopes, so **D ≥ 15.21** or the collar that takes
the boss to the plane has nowhere to go. 15.5, and see §4 steps 4 and 6. The
key's throat wanted 14.2 anyway.

**What it costs:** the arcade, and unsupported printing on curves. A
straight's constant-depth underside is planar, so it can be laid flat and
printed tilted — it now is, `forPrint`, 629 mm² on the bed and half the
height. **A curve's is a helicoid, measured 5.15 mm from the best-fit
plane**, so no orientation puts it on the bed and a minimal curve still needs
print supports under it. That is why `viaduct` stays the default.

### Option A — treat the skirt as a breakaway print support

Print as now; snap the skirt off afterwards.

**For:** no geometry change, no change to how it prints, and it is opt-in per
part. Nothing else in the system has to move.

**Against:** the filament is still printed and then binned — this saves
nothing but appearance. PLA does not break cleanly without a designed
weakening line, and the rim carries the first-layer chamfer, so what is left
after snapping is a rough edge on a face you can see. Option B′ gets the same
appearance AND the material AND a shorter print, so this is only worth
revisiting if B′ turns out to be unprintable.

Stiffness was the objection I expected to be decisive and it is not: Brett's
printed parts are rigid and the load is a 45 g toy. Recorded so it is not
re-raised.

### Option C — leave the part alone and fix the rhythm

Cheapest of the three and aimed only at the "ragged" complaint rather than the
plastic. Phase-lock the bay layout to the global grid instead of solving each
piece independently, and shrink or share `ARCH.pad` at seams so two adjacent
pieces read as one arcade rather than two. Does nothing for the 30%.

### What is still unproven about B′

- **The print orientation is a claim, not a result** — still true, and the one
  that matters. Laying the underside on the bed puts the socket bore, the key
  pocket and both end faces 11.2° off vertical. It measures 629 mm² of bed
  contact and no overhang over 85% of the length; **nothing has printed it.**
  That is the next thing to do with a printer rather than a keyboard.
- ~~The pad under the boss has to be sized per piece type~~ — there is no pad.
  It is a spacer, and there are two of them, chosen by piece type.
- **The grounded case** — checked, and it was not fine. A grounded minimal
  piece touches `rimY` only at its exit boundary, a knife edge rather than a
  skirt, so `needsPier` reading `rimY > 1` left it standing on nothing. It
  reads the socket mouth now.
- **The arcade goes away.** If that turns out to matter, Option C recovers the
  look on whatever depth remains.


---

## 2. Why the flat plane cannot be raised, and what the arcade is actually for

Brett: "slice a plane parallel to the build plate just below the lowest
functional part; the helicoid moves to the contour of the top."

Both halves are right, and together they describe **the part that already
exists**. Today's rim IS a flat plane parallel to the bed, and the helicoid IS
already on top, in the deck. So the question is only how far the plane can be
raised, and the answer is **zero**:

| piece | entry deck | exit deck | rim now | highest legal flat plane |
|---|---|---|---|---|
| straight | 87 | 57 | 45 | **45** |
| curveL | 57 | 12 | 0 | **0** |

The **downhill** rib sets it. That rib needs ~12 mm under its own deck for the
pocket ceiling, the key band and the throat, and the downhill deck is the
lowest deck on the piece — so `rimY = lowDeck − 12` is already exactly "just
below the lowest functional feature". Shortening the front, the back and the
socket independently does not help: they are all referenced to the deck above
them, and the one at the low end is what the plane has to clear.

Everything above that plane at the **high** end is not there for a feature. It
is there because a flat plane under a sloping deck has to be as deep as the
drop — 30 mm on a straight, 45 on a curve. That is geometry, not design.

### And this is what the arcade is for

Any scheme that removes that material creates a downward-facing surface, and
that surface has to print. Measured on the ramp slope:

- A wall whose **bottom edge ramps** at 11.22° advances **1.01 mm per 0.2 mm
  layer** — a **78.8° overhang**, against the 45–60° FDM tolerates. That
  applies to the `minimal` variant as built, on straights as well as curves.
- The arcade avoids it by making every downward surface either a **vertical
  pier** or a **circular arch**, which springs vertically and only becomes a
  bridge near the crown, between two piers.

So the arcade is not decoration and it is not the reason for the deep skirt —
it is the *maximal* removal of material that stays self-supporting.

### Which leaves one honest question

Is `minimal` (and any "legs only" version beyond it) worth printing **with
supports**? The underside is not a show surface, so support scars there cost
nothing but time and a little filament. That is a preference, not a
constraint, and it is the only thing standing between the current part and
another ~30% on top of the 18–20% already saved.


---

## 3. The tilt: built, measured, reverted — and now built again

*It shipped in the end (§4 step 4): 443 → 524 mm² on the bed for a straight,
56 → 28 mm tall. Everything below is the version that failed and why, which is
still the reason the shipped one is shaped the way it is.*

Rotating a `minimal` piece by its own slope so the underside lies on the bed
was the obvious answer to the 78.8° overhang. It was implemented and it made
things worse, for a reason that is worth keeping:

| minimal piece | rim-down | tilted |
|---|---|---|
| straight | 618 mm² on the bed | **2 mm²** |
| lift | 620 mm² | **2 mm²** |

**The socket pad is what stops it.** The pad has to reach a 15 mm grid line —
that is the only reason it exists — so it hangs below the constant-depth
underside by however far the boss's deck is above the piece's low end:

| piece | underside at the boss | rim | pad protrudes |
|---|---|---|---|
| straight | 62.6 | 45.0 | **17.6 mm** |
| curveL | 27.2 | 0.0 | **27.2 mm** |

Lay the piece on its underside and it balances on that pad instead. The tilt
and the grid-aligned pad are mutually exclusive: you can have a face on the
bed or a socket mouth on the grid, not both.

### Correction: an off-axis tilt DOES work for a curve

I said no rotation flattens a helicoid and treated the 5.15 mm deviation as
disqualifying. Wrong — the question is not whether the underside can be made
planar, it is whether the DEPTH BUDGET can absorb the deviation. It can.

Cut the underside as the best-fit PLANE rather than at constant depth under
the deck. For a standard curve that plane is tilted **11.77°** and the deck
wanders **±4.74 mm** about it, so the depth under the deck varies over a
9.5 mm band:

| D | shallowest | deepest | key band needs 8.6 |
|---|---|---|---|
| 12 | 7.3 | 16.7 | fails by 1.3 |
| 13 | 8.3 | 17.7 | fails by 0.3 |
| **14** | **9.3** | 18.7 | **clears by 0.7** |
| 15 | 10.3 | 19.7 | clears by 1.7 |

So **a curve with a plane-cut underside at D = 14 lies flat on the bed**, and
the whole "curves are impossible" line above is wrong. Two notes: the ribs sit
at the extremes of the deck relative to the plane, so the shallow one is the
binding case and a fit that maximised the minimum depth at the two ribs and
the boss would do better than least squares; and a plane cut means the two
walls have different bottom heights at the same station, which `channelProfile`
cannot currently express — it takes one `rimY` per station.

### The design to build: an insertable spacer instead of a long boss

BUILT AND INTEGRATED. The numbers below are what shipped.

The piece keeps only a socket RECESS in its underside, so the boss stops being
a column and becomes a hole. A separate spacer plugs into it and carries the
mouth down to a 15 mm grid line, exactly the move the jog made: take the
support's problem out of the track piece.

**"Exactly the 10 mm the socket needs" was true at one point only, and cost
1.03 mm.** The underside is 12 below the deck and the floor is 2, which does
leave 10 — at the boss centre. But the socket is a hex 10.39 across corners
and the deck falls 0.198 mm/mm, so its downhill corner is 1.03 lower, and a
level socket ceiling at deck − 2 eats into a 2 mm floor: measured on the built
mesh the walking surface over the socket came out **1.27–1.38 mm**. The mouth
drops by that much (`socketMouthY`) and the floor reads 2.32–2.41 instead. A
platform pays nothing, grad being 0 — which is why the same 12 has always
worked for the viaduct boss.

Spacer heights, shoulder to shoulder (measured, after that correction):

| piece | boss at | mouth sits at | remainder | spacer |
|---|---|---|---|---|
| straight | s = 61 | rim + 16.5888 | 16.5888 | **16.59** |
| lift | s = 89 | rim + 16.6645 | 16.6645 | 16.59 (shares) |
| curveL | s = 88 | rim + 26.1991 | 26.1991 − 15 | **11.20** |

So it is **two new parts**, and both are small. They share the riser's tenon
and socket, so nothing new enters the interlock.

The curve's 11.20 is under the ~12 mm that "a 10 mm socket plus a floor"
suggests — it leaves a 1.2 mm plate between the socket ceiling and the tenon
shoulder. That plate is not in the load path (the column bears through the
annular wall), and the alternative is a 26.20 spacer with no grid unit under
it, which stands a grounded curve on an 18 mm disc instead of on a foot.

**They must not look like risers.** A 16.59 spacer next to a 15 riser is 1.6 mm
different: nobody picks that out of a bag, and the wrong one under a pier
tilts the deck it carries. The two spacers are also only 5.4 mm apart from
each other. "Slightly unique" is not enough — the difference has to survive
being in a heap with sixty risers.

What makes it unmistakable, in order of how well it works:

1. **A round body with ONE FLAT — a D section.** Risers, feet, towers and
   jogs are all 15 AF hex; nothing else in the library is round. You cannot
   mistake a D for a hex prism by eye or by touch, in any light, at any angle.
   Only the BODY changes — the tenon and socket stay hex, so the interlock is
   untouched. Ø18 reads as a collar rather than a post.

   The flat earns its place three times over. It carries the engraved code,
   which a plain cylinder has nowhere to put (the foot has to use its base).
   It gives fingers something to bear on, which is the one thing a hex body
   was doing that a cylinder gives up. And it is a rotational reference, so
   the code always faces the same way when the part is seated.
2. **Grooves that can be counted**, one for the short spacer and two for the
   tall, so the two are told apart in isolation rather than side by side.
   A count survives what a 5 mm dimension does not.

Colour is not on the list: a part that is only distinguishable when you happen
to have printed it in a second filament is not distinguishable.

**Why this is worth doing rather than leaning on the slicer.** Bambu's
automatic supports on one printed piece: **44.66 g of support against 72.04 g
of model** — 62% overhead, and the tree supports run the full depth under the
part. Designed geometry that lands on the bed beats that by a wide margin,
which is the whole argument for getting the pad out of the way so the piece
can lie on its underside.

### And on putting the tilt in the exporter at all

Brett: "I wouldn't want the tilt to exist just in the exporter, I'd worry about
geometry drift."

Right, and the worry is not really numerical — a rotation is lossless to well
under a printer's resolution. It is that an export-only transform makes the
thing you INSPECT a different object from the thing that SHIPS, and this
codebase has been bitten by exactly that twice: the joint guide silently lost
its track pieces when export geometry moved into a per-piece frame, and the
gate paddle shipped balanced on the tip of its pin because nothing checked the
orientation it went out in.

So if orientation is ever reintroduced it should follow the pattern the gate
now uses: a named, documented function on the pure module (`forPrint`), with a
test that reads the bed contact off the built mesh — not a step hidden in the
export path.


---

## 4. THE ORDER THIS HAS TO HAPPEN IN

"Flat on the plate" is the payoff and it is STILL not in the app. What ships
today is a minimal piece printed rim-down: the arcade is gone and it is 23-25%
lighter, and nothing under it reaches the rim any more — but it still stands
the way a viaduct piece does, and its ramped wall bottom is a 78.8° overhang
that needs supports.

The changes are strictly ordered, because each one unblocks the next:

1. **The spacer part.** DONE — `buildSpacerGeometry`, two variants, watertight.
2. **The boss becomes a recess.** DONE. `bossOps` in minimal mode starts at the
   underside and cuts the socket 10 mm up from there, instead of running a Ø19
   column down to the rim. `socketMouthY` is the one place that says where the
   mouth is; it cost 1.03 mm to the slope (see §3).
3. **The support chain carries the spacer.** DONE. `stackHeightMm` reads the
   mouth and takes the spacer's bite; `needsPier` reads the mouth too, because
   a grounded minimal piece has no skirt under its boss to rest on. The scene
   and the print shop both draw and count the part.
4. **The tilt.** DONE, for straights and lifts. `tiltOntoUnderside`, applied
   on the export path the way the gate's `forPrint` is, with a test that reads
   bed contact off the built mesh.

   | | rim-down | forPrint |
   |---|---|---|
   | straight | 452 mm² contact, 56 mm tall | **629 mm², 29 mm** |
   | lift | 455 mm², 56 mm tall | **626 mm², 29 mm** |
   | curveL | 453 mm², 71 mm tall | refused |

   **It cost D = 15.5.** The seat is a LEVEL face inside a SLOPING underside,
   so the collar that carries the boss to the plane only fits when D ≥ 15.21
   (step 6). Below that it protrudes and the piece balances on it, which is
   exactly the 2 mm² failure that got the first version reverted. So the part
   is 4 cm³ heavier on a straight and the saving against viaduct goes from 23%
   back to 16%. Worth it: a straight that lies down needs almost no print
   support, against 44.66 g of support for 72.04 g of model.

   *The residual is gone.* It was the END RIB AT THE EXIT FACE: "No supports at all" was
   overstated. Probed along the wall, the underside is on the bed from 5% to
   90% of the length; the last 15 mm rises to 2.6 mm, because `skirtBottom`
   clamps at the rim and D exceeds `skirtDepth` by 3.5, so the piece steps up
   off the plane just before its exit face. The end rib there — the 12 mm slab
   across the joint that carries the bowtie pocket — therefore keeps the 78.8°
   overhang the rest of the part no longer has.

   Removing the clamp alone is not enough — tried, and the rib's own LEVEL
   bottom then protrudes below the plane and bed contact goes to **zero**. Both
   halves had to move: `archedRimY` stops clamping and `ribSolid` takes a
   bottom that follows the plane the way its top already followed the deck.
   Brett: "the bottom doesn't have to end up level after printing." It does
   not, and nothing stands on it — the spacer does that.

   **Bed contact, straight: 443 → 524 → 629 → 1480 mm².** The whole underside,
   ends included.

   The clamp is now tied to `laysOnUnderside`, and that is the rule: the
   underside is held at the rim exactly when the rim is what the piece stands
   on. A piece printed rim-down keeps it; a piece laid on its underside does
   not. The same predicate decides whether the boss is a recess with a collar
   or a plain column to the rim — they were allowed to disagree once, and a
   flat platform built a collar BELOW its rim and balanced the whole part on a
   114 mm² ring.

6. **The collar.** DONE, and it is why the boss is not a floating island.

   A minimal boss stands over the OPEN channel underside — there is no
   material between the walls below the floor — so it is a free-standing tube
   whatever else is true. Ending it at the seat left it starting in mid-air:
   sliced, the boss's **first layer was 1.3 mm²**, which will not stick to a
   plate. Its collar now takes it down to the underside plane, cut BY that
   plane so it is coplanar with the wall bottoms:

   | | before | after |
   |---|---|---|
   | boss, first layer | 1.3 mm² | **116.7 mm²** |
   | whole part, bed contact | 524 mm² | **629 mm²** |

   This is NOT a pier and the two should not be confused. A pier runs to a
   flat rim on the 15 mm grid and carries the tower. The collar is ~2.5 mm of
   ring that carries nothing; it exists so the tube starts on the bed.

   **The bore is what keeps the seat level.** The spacer has to bear on a
   horizontal face or the tower leans, and a horizontal face cut into a
   sloping underside is the problem this whole section keeps circling. So the
   collar is bored to clear the spacer's Ø18 body, the spacer tucks up inside
   it, and the level face it seats on is the ledge at the top of that bore —
   `socketMouthY`, unmoved, so no spacer height changed.

   **It set the depth.** The ledge has to be above the plane everywhere under
   the collar, so D ≥ `floorThk + socketDepth + grad·(rCorner + collarR)` =
   15.21, and `minimalDepthMm` is 15.5. `bossOps` and `tiltOntoUnderside`
   share one test for it (`collarFits`), so a shallower depth gets the old
   plain boss and no tilt rather than a broken part.
7. **Curves.** DONE. `undersidePlane` cuts the underside as one PLANE rather
   than at constant depth, so there is no helicoid left to flatten and a curve
   lies down like a straight: **453 → 875 mm² on the bed, 71 → 39 mm tall**, at
   a cost of ~7 cm³. It is fitted to the two wall bottom lines and offset so
   the SHALLOWEST point is `minimalDepthMm` — §6 has why the mean was the wrong
   end to hold. A straight is untouched by it: its constant-depth underside
   already IS that plane, so the fit reproduces it with zero residual and one
   code path serves both. `channelProfile` takes a bottom per wall — the thing
   a constant-depth cut cannot express — and `tiltOntoUnderside` is now one
   Rodrigues rotation of the plane's normal onto +Y.

## 5. Spacer build: the two decisions it needed

The integration was attempted once and backed out, because two things in it
were Brett's call and not the arithmetic's. Both are now decided and built.

**Decision 1 — a lift shares the straight's spacer.** A straight's remainder
is 16.5888 and a lift's is 16.6645: the lift climbs at `liftSlopeDeg`
(11.4045°) against the ramp's 11.2167°, so its boss sits fractionally higher.
Two parts 0.08 mm apart is worse than no distinguishing feature at all — it is
the exact failure the D section exists to prevent, reintroduced by arithmetic.
**The lift takes the straight's spacer and its deck sits 0.08 low**, beside a
waterfall step of 0.25.

**Decision 2 — platforms keep the viaduct boss.** A start or end platform has
no drop, so its deck is only `skirtDepth` above its rim and `deck − 12` lands
just below the rim. They are flat: no skirt taper to save, nothing to gain.
`socketMouthY` clamps to the rim, so they fall out of the spacer path on their
own. Elevators are excluded for their own reason — the housing is a solid
block from rim to deck, so there is no sloping underside to recess into.

Where that leaves the arithmetic, on the demo tower:

| piece | mouth (above rim) | spacer | stack below | decomposes |
|---|---|---|---|---|
| start | 0 | — | 450.0 | foot + 120·3 + 60 + 15 |
| straight | 16.5888 | 16.59 | 405.0 | foot + 120·3 + 30 |
| curveL | 26.1991 | 11.20 | 375.0 | foot + 120·3 |
| lift | 16.6645 | 16.59 (+0.08) | on the grid | — |
| grounded straight | 16.5888 | 16.59 | 0.0 | spacer on the bed |

**The regression that was flagged did not happen:** `stackHeightMm` shortens
the column the scene draws by the spacer height, so the spacer had to be
modelled and added to the same change — it was, and the browser check on the
demo tower shows columns meeting their sockets in both styles.


---

## 6. The plane-cut curve: what to build, and why D = 14 was the wrong number

The remaining step (§4 step 5) is a curve whose underside is cut as one PLANE
so it can be laid on the bed like a straight now is. Nothing of it is built.
What follows is the design worked out against the real curve geometry, and it
differs from the earlier §3 note in one decision that changes everything else.

### The measurement, on a standard curve in its own frame

Fitting a plane by least squares to the two wall bottom lines (u = ±26.4, the
whole arc, 800 samples):

| | |
|---|---|
| plane tilt | **11.53°** |
| deck above the plane | **−5.46 … +5.46 mm** |

§3 recorded 11.77° and ±4.74 from a different sample set. Use ±5.46: the
walls are what has to touch the bed, so they are what the fit should minimise
against.

Depth under the deck, relative to the plane's mean, at the places features
live — and note the SPREAD ACROSS A SINGLE END FACE, which is the part the
old note missed entirely:

| where | depth |
|---|---|
| entry rib, outer wall (u = −26) | mean + 4.99 |
| entry rib, centre | mean + 1.34 |
| entry rib, inner wall (u = +26) | mean − 2.31 |
| exit rib, outer wall | mean − 4.99 |
| exit rib, centre | mean − 1.34 |
| exit rib, inner wall | mean + 2.31 |
| boss centre | mean − 0.12 |

### The decision: the plane is set by its SHALLOWEST point, not its mean

§3 put the plane at a mean depth of 14 and checked that the shallowest point
still cleared the key band (8.6). That is the wrong end to hold, for two
reasons that only showed up once the boss became a recess:

- **The socket mouth needs 14.91 of local depth** (§4 step 4), and the boss
  sits at mean − 0.12. At a mean of 14 the mouth protrudes and the curve
  balances on it — the same failure the straight's tilt was reverted for. Even
  at a mean of 15 it is 0.03 short.
- **The key's THROAT wants 14.2, not the band's 8.6.** At a mean of 14 the
  shallowest point is 8.5, which does not even clear the band.

Hold the shallowest point instead — put the plane so that
`min(deck − plane) = SPEC.skirt.minimalDepthMm` — and every one of those falls
out for free: min depth is D = 15 by construction (clears the throat), and the
boss is then at D + 5.34 = 20.3 (clears 14.91 with 5.4 to spare). It also
keeps today's straight EXACTLY as it is, because a straight's constant-depth
underside already is that plane with zero residual, so one code path serves
both.

**It costs about 5.9 cm³ on a curve** — mean depth 20.5 instead of 15, so
68.6 → ~74.5 cm³, and the saving against viaduct drops from 20% to ~14%. That
is the price of a curve that needs no print supports, against Bambu's measured
44.66 g of support for 72.04 g of model. Worth it.

### The shape of the change

- `undersidePlane(piece, spec)` in `geometry.js`: fit by least squares over the
  two wall lines, then offset to the shallowest point. Memoise on a signature
  that includes the piece's FRAME — the coefficients are frame-dependent, and
  `archedRimY` is called with world pieces (display) and framed ones (export).
- `archedRimY` gains a trailing `u`, and the minimal branch returns the plane
  at (s, u) instead of `deck(s) − D`. Straights are unchanged by construction.
- `channelProfile` takes `rimL`/`rimR` (the values at u = ∓Wo) and lerps for
  the two inner bottom corners at ±Wi — exact, because it is a plane. Defaults
  to today's single `rimY`.
- `pieceProfiles` evaluates both ends.
- **The ribs are the awkward part, and the reason this is not a small change.**
  `jointOps` takes ONE `rimY` and `ribSolid` builds the rib bottom flat at it.
  Across one end face the plane moves 7.3 mm, so a flat rib bottom is either
  7.3 mm proud of the plane (and the part lands on the rib, contact → 0, which
  is exactly what happened when the clamp was removed from a straight) or
  7.3 mm recessed (a notch at each end with a 78.8° roof). `ribSolid` already
  lofts five stations with a varying top, so it can take a varying bottom the
  same way — but `rimY` is also used by the detent guard and the lightening
  windows in the same function, and all of them have to agree.
- `tiltOntoUnderside` generalises: rotate the plane's normal onto −Y. That one
  rotation then serves straights too, and the current special case goes away.

### The residual that comes with it

The straight's exit end already lifts 2.6 mm off the bed because `skirtBottom`
clamps at the rim (§4 step 4). Under min-depth semantics a curve will do the
same thing, at the same place, for the same reason. The fix is the same fix as
the rib bottoms: the clamp has to follow the plane rather than the rim.
