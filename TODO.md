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

**And it probably prints BETTER, not worse.** Lay the deck-parallel underside
on the bed and the deck is horizontal in print:

| | print height, curve |
|---|---|
| now (rim-down, deck sloped 11.2°) | 57 + 14 = **71 mm** |
| D = 15, underside-down | 15 + 14 = **29 mm** |

The washboard currently prints on an 11.2° slope, so every ridge is stepped
across the layers; flat on the bed each ridge becomes a constant-Z feature.
What tilts instead is everything vertical-in-use — socket bore, key pocket,
end faces — by 11.2°, which is a mild lean on features that are all holes or
slots rather than show surfaces.

**What it costs:** the arcade. At 15 mm deep there is no room for piers and
three-centred arches, so the viaduct look goes with it. That is the real price
and it is an aesthetic one, not a structural one.

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
