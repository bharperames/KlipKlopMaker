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

### Option A — treat the skirt as a breakaway print support

Print as now; snap the skirt off afterwards.

**For:** no geometry change, no change to how it prints, and it is opt-in per
part. Nothing else in the system has to move.

**Against, and this is probably fatal:** the skirt is not decoration, it is the
**web of the beam**. The deck is a 2 mm floor and the only other depth is the
14 mm rails. Bending stiffness goes with depth cubed, so dropping 57 mm of
section to ~16 mm leaves about **2%** of the stiffness — on a piece that spans
150–225 mm between piers. Also: the filament is still printed and then binned,
PLA does not break cleanly without a designed weakening line (which would be a
stress riser exactly where the moment is highest), and the rim carries the
first-layer chamfer, so what is left after snapping is a rough edge on a face
you can see.

### Option B — a "short" piece: deck, rails, end ribs, socket, and nothing else

**For:** removes the 26–31% outright, in print time as well as filament, and
the underside becomes a clean constant-depth line instead of an arcade remnant.

**Against:** the flat rim is what buys the two properties the whole system
rests on.

1. *It prints with no supports.* A constant-depth beam has a sloped underside
   and cannot sit on the bed. The alternatives are printing on the slope (needs
   supports — against the print contract in CLAUDE.md), deck-down (the washboard
   and the show surface go against the plate), or on its side (every surface
   becomes a layer-line surface, and the bowtie pockets become horizontal
   slots).
2. *It puts the support interface on the 15 mm grid.* `decomposeSupport` works
   because every rim is a whole number of grid units. A sloped underside has no
   single rim height, so either the boss keeps a local flat pad at a grid
   height — which is most of the skirt back again, locally — or the riser
   ladder stops composing.

Worth exploring anyway, because "a local flat pad at the boss plus a shallow
beam elsewhere" may be a real shape: it is the current part with the skirt
removed *between* the piers rather than everywhere.

### Option C — leave the part alone and fix the rhythm

Cheapest of the three and aimed only at the "ragged" complaint rather than the
plastic. Phase-lock the bay layout to the global grid instead of solving each
piece independently, and shrink or share `ARCH.pad` at seams so two adjacent
pieces read as one arcade rather than two. Does nothing for the 30%.

### What to measure before choosing

- Deflection of a real piece spanning two piers, skirt on and skirt cut away.
  Option A lives or dies on this and the stiffness estimate above is a
  calculation, not a measurement.
- Whether a shallow-beam piece can be printed at all in an orientation that
  keeps the washboard and the channel walls off the bed.
