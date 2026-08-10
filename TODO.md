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

**Built, and two of the claims above were wrong.** `SPEC.skirt.style` now
takes `viaduct` or `minimal`; measured on the built meshes:

| | straight | curveL |
|---|---|---|
| viaduct | 60.2 cm³ | 86.2 cm³ |
| **minimal (D = 12)** | **49.5 (−18%)** | **69.0 (−20%)** |
| minimal, D = 15 | 52.7 (−12%) | 73.3 (−15%) |

On the demo tower that is 1672 g → **1492 g**, an 11% job (only the track
parts change; keys, risers and feet are untouched).

- **The saving is 18–20%, not 26–31%.** The Monte-Carlo estimate compared
  against a bare beam. The real part keeps a full-depth pad under the socket
  (which is what puts the mouth on the grid) and keeps its skirt over the last
  stretch, where the deck is already within D of the rim.
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

**What it costs:** the arcade, and unsupported printing on curves. A
straight's constant-depth underside is planar, so it could be laid flat and
printed tilted; **a curve's is a helicoid, measured 5.15 mm from the best-fit
plane**, so no orientation puts it on the bed and a minimal curve needs print
supports under it. That is why `viaduct` stays the default.

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

- **The print orientation is a claim, not a result.** Laying the underside on
  the bed puts the socket bore, the key pocket and both end faces 11.2° off
  vertical. Nothing says that fails, but nothing has printed it either.
- **The pad under the boss has to be sized per piece type** and its own
  underside is horizontal in use, so it is 11.2° off the bed in print — a
  small sloped pad, but it is where the column seats.
- **The grounded case.** A piece with `rimY = 0` currently rests on its whole
  skirt. With B′ it rests on the pad and the rib ends, like every other piece.
  Probably fine, worth checking against `needsPier`.
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

## 3. The tilt: built, measured, reverted

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

NOT BUILT YET. Recorded with the numbers so it can be picked up.

The piece keeps only a socket RECESS in its underside — the underside is 12 mm
below the deck and the floor is 2, which leaves exactly the 10 mm the socket
needs, so the boss stops being a column and becomes a hole. A separate spacer
plugs into it and carries the mouth down to a 15 mm grid line, exactly the
move the jog made: take the support's problem out of the track piece.

Spacer heights, shoulder to shoulder (measured):

| piece | boss at | mouth would sit at | spacer |
|---|---|---|---|
| straight | s = 61 | deck − 12 | **17.6 mm** |
| lift | s = 89 | deck − 12 | **17.7 mm** |
| curveL | s = 88 | deck − 12 | **27.2 or 12.2 mm** |

A spacer cannot be shorter than ~12 mm whatever the arithmetic says: its body
has to hold a 10 mm socket plus a floor. That rules out the tempting
`17.6 − 15 = 2.6` for a straight, and makes 12.2 the useful curve variant
(the column below simply grows one grid unit).

So it is **two new parts** — call them 17.5 and 12.5 — and both are small.
They share the riser's tenon and socket, so nothing new enters the interlock.

**They must not look like risers.** A 17.5 spacer next to a 15 riser is 2.6 mm
different: nobody picks that out of a bag, and the wrong one under a pier
tilts the deck it carries. The two spacers are also only 5 mm apart from each
other. "Slightly unique" is not enough — the difference has to survive being
in a heap with sixty risers.

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
