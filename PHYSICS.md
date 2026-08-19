# Klip-Klop Physics — research notes & model derivation

The Fisher-Price Klip Klop figures are **passive dynamic walkers**: no motor, no
spring — the ramp *is* the engine. This document records the research behind the
numbers baked into `js/physics.js` and `js/track.js`.

## 1. The mechanism

The figure is two rigid bodies on one low-friction metal axle:

- **Outer body + front hooves** — a rocker whose hoof bottoms are convex
  tangent-arc cams (radius ≈ 30 mm here, ~1.15× the 26 mm axle height).
- **Inner pendulum + rear hooves** — swings freely between internal stops
  (the *swing limiter*, ±α ≈ 18°).

Cycle: gravity tips the body forward onto the front cams (**klip**) → the rear
pendulum swings forward → momentum pitches the figure onto the advanced rear
hooves (**klop**) → the front swings forward. Each hoof strike dissipates
kinetic energy; the ramp's descent replenishes it. Steady gait = losses exactly
balanced by slope.

## 2. Model: McGeer's rimless wheel

The canonical reduced model of passive walking treats the gait as a wheel with
spokes 2α apart rolling down slope γ:

- Stance phase (inverted pendulum): `ω̇ = (g/l)·sin φ`
- Hoof strike: angular momentum about the *new* pivot scales ω by `cos(2α)`
- Steady-state post-strike velocity:
  `ω_s² = 4(g/l)·sinα·sinγ · K/(1−K)`, where `K = η·cos²(2α)`

`η` is an efficiency factor (default 0.26) covering what the ideal model
ignores: toy-grade axle friction, hoof scuffing, non-instant double support.
It was chosen so the predicted minimum slope lands at the empirically known
~7–8° for this class of toy (ideal rimless wheels walk on slopes as shallow as
~1°; literature solutions exist up to ~15.4° where the stance-leg ground
reaction force reaches zero).

Failure modes, in order of increasing slope:

| Condition | Status | Test |
|---|---|---|
| Post-strike energy can't vault top dead center | **stall** | `½ω_s² < (g/l)(1−cos(α−γ))` |
| Hoof-ramp interface loses grip | **slide** | `tan γ > 0.85·μs` |
| Next hoof lands beyond the limiter's reach | **tumble** | `γ > α` |

With defaults (α=18°, l=26 mm, η=0.26, washboard μs≈0.6) the model walks from
**≈7.6° to ≈18°**, bracketing the design green zone of **10–12°** with margin —
consistent with the original playset's ramp geometry (8–15° operating window).

## 3. Friction: why the washboard floor exists

Printed PLA-on-PLA is slick. Published tribology for FDM PLA reports COF
roughly **0.38–0.67**, with the *transverse* direction (sliding across layer
lines) measurably higher than longitudinal. The rocking gait needs
`μs > tan γ` with margin: at 12°, `tan γ = 0.213` — smooth PLA (μs≈0.32)
leaves little headroom once dust and wear set in.

The generator therefore models a **transverse washboard** directly into the
floor mesh: raised-cosine ridges **0.6 mm tall on a 2.5 mm pitch**, always
perpendicular to travel (radial on curves). These interlock mechanically with
the hoof cams — effective grip above plain friction (modeled as μs≈0.6) — and
double as the acoustic texture for a sharper clack. Sine profiles, not square:
square ridges act like stairs and eat the gait's kinetic energy.

Ridge pitch is snapped per piece so seams always land in a **valley**, and
every seam applies the **waterfall rule**: the downhill floor starts 0.25 mm
lower. A toy can step *down* a microscopic ledge but stubs its toe on even a
0.2 mm uphill lip (printer warp/over-extrusion tolerance).

### 3.1 The ridges are a RACK, and the pony's front feet are the pinion

The paragraphs above treat the washboard as a friction aid, which understates
it. Brett, off the toy itself: the front hooves carry **little grooved rubber
pads**, and "the function of the pony requires contact and grip from these
front feet to the surface". The pad grooves and the floor ridges are the same
pitch family — they *mesh*. That is why grip here is modelled at μs≈0.6 rather
than PLA's 0.32: the mechanism is interlock, not adhesion.

Two consequences, and both are design rules rather than nice-to-haves:

- **A smooth patch is not "slightly less grippy", it is a DISENGAGED rack.**
  The pads have nothing to bite and the walker free-wheels or stalls. So a flat
  area anywhere on the walking surface is a functional failure, not a cosmetic
  one — which is why `deck_probe.mjs` reports relief as a first-class number
  alongside height, and why any flat cell in the frog is a defect.
- **Ridge DIRECTION steers.** A rack meshing at an angle to travel resolves a
  sideways component at every hoof strike, so, in Brett's words, the ridge
  direction "determines the perpendicular path of the horse". This is what
  makes ridges perpendicular to travel a *requirement* and not a convention,
  and it is the real difficulty at a **frog**, where the two routes' fields
  cross at up to 45°. A branch walker inside the frog meets some of the main's
  ridges obliquely and is nudged toward the main. Feathering the two fields
  into one another spreads that nudge over many strikes instead of handing the
  walker one long oblique rack; suppressing one field entirely — which this
  project did for a while — removes the nudge by removing the drive, and that
  is worse.

## 4. Geometry constraints enforced by the app

| Constraint | Value | Reason |
|---|---|---|
| Slope | hard 8–14°, green 10–12° | stall / slide-tumble envelope above |
| Bank (roll) | exactly 0° | 1° of inward lean jams the top-heavy figure against the wall |
| Curve radius | ≥ 120 mm centerline | rigid figure wedges front-inner/rear-outer hoof otherwise; §8 shows 48 mm still covers a 38 mm figure at 120 |
| Curve widening | **none** | a 38 mm figure's swept path fits 48 mm at every legal radius (§8). The +3 mm this table used to require was carrying an oversized *printed* figure, not the toy |
| Channel width | **48 mm, uniform** | swept width in the tightest legal turn + 3 mm. One width everywhere — straights, curves, switches |
| Figure width | 38 mm, measured off the toy | it used to be `channel − 4`, which let the figure and the channel justify each other |
| Rail height | 14 mm | guides the base, clears the swinging torso |
| Floor fillets | r = 2 mm | re-centers a wandering hoof without snagging |
| Floor thickness | 2.0–2.6 mm over an open skirt | acoustic drumhead ("klip-klop" amplifier) |
| Tier clearance | ≥ 100 mm vertical where the path overlaps itself | figure + rails + structure |

## 5. Mass properties

Injection-molded figures are far denser than FDM prints. The ballast planner
assumes PLA at 1.24 g/cm³ with shell+infill ≈ 30% + 0.7·infill effective solid
fraction, and steel BBs (0.35 g each, ~60% packing in the bores). Weight goes
**low and rear-biased**: low CoM keeps the rocker stable; rear bias powers the
pendulum. The model itself is mass-independent (g/l scaling) — mass buys
robustness against bearing friction, not speed.

## Sources

- McGeer, T. — *Passive Dynamic Walking* (IJRR 1990); rimless-wheel benchmark
  models: [Numerical accuracy of two benchmark models of walking](https://www.researchgate.net/publication/267123687_Numerical_accuracy_of_two_benchmark_models_of_walking_The_rimless_spoked_wheel_and_the_simplest_walker)
- [Small slope implies low speed for McGeer's passive walking machines](https://www.researchgate.net/publication/233643468_Small_slope_implies_low_speed_for_McGeer's_passive_walking_machines)
- [An Experimental Study on Passive Dynamic Walking (USF)](https://digitalcommons.usf.edu/cgi/viewcontent.cgi?article=6690&context=etd) — walking solutions up to ~15.42° slope
- [Design of Passive Dynamic Walking Robots for Additive Manufacture (UT Austin)](https://repositories.lib.utexas.edu/server/api/core/bitstreams/3a5eec83-109b-497e-889a-8f67ef3a252a/content)
- [Optimal foot shape for a passive dynamic biped](https://www.sciencedirect.com/science/article/abs/pii/S0022519307002317)
- PLA tribology: [Effects of 3D-printed PLA infill density on COF (Rapid Prototyping Journal)](https://www.emerald.com/insight/content/doi/10.1108/rpj-03-2022-0081/full/html),
  [Tribological Behaviour of 3D printed PLA (IOP)](https://iopscience.iop.org/article/10.1088/1742-6596/2542/1/012003/pdf),
  [Friction Behavior of 3D-printed Polymeric Materials](https://revmaterialeplastice.ro/pdf/19%20CHISIU%201%2021.pdf)
- Reference toy: Fisher-Price Little People Disney Princess Klip Klop Stable
  ([motion video](https://www.youtube.com/watch?v=wqNYFY2WxSg&t=5s))

## 6. The Klip Klop Standard (interoperability lock)

Free parameters silently fork a printed part library: pieces sliced at 11°
don't mate with pieces at 12°, and cut-to-height pillars are single-use. The
locked standard makes every part reusable:

| Locked value | Why |
|---|---|
| Tile drop = **30 mm** (straights & lifts, incl. the 0.25 mm waterfall seam) | two 15 mm grid units |
| Curve drop = **45 mm** | three grid units |
| Ramp slope = atan(29.75/150) = **11.217°** | dead center of the 10–12° green zone |
| Lift slope = atan(30.25/150) = **11.405°** | powered; nets +30 mm after its seam |
| Curve radius = **143.64 mm** | gives the 45 mm curve drop; above the 120 mm rigid-body minimum |
| Channel width = **48 mm** | center of the 46–50 mm spec |

Consequences: every deck boundary — and therefore every support rim — lands
on a **15 mm height grid**, so supports are stacks of five reusable designs
(foot + 15/30/60/120 mm risers on the common hex interlock) instead of
cut-to-height pillars; and closed loops balance exactly (6 lift tiles buy
what 4 curves spend). Custom parameters remain available behind an explicit
unlock, clearly marked as producing a non-interoperable print batch.

## 7. Ground-truth validation against a proven community set

Measured directly from the mesh of a known-working community print
(`klip-klop-set-v8-new.3mf`, ramp + peg stacker):

| Metric | Community set (measured) | This project | Agreement |
|---|---|---|---|
| Ramp slope | **12.0°** (tan 0.213, least-squares fit of 215 crest samples) | 11.22° locked (green 10–12°) | ✓ both inside the derived green zone |
| Transverse floor ribs | present: ~1.0 mm pitch × ~0.15 mm | 2.5 mm × 0.6 mm (research spec 2–3 × 0.5–0.8) | ✓ concept independently converged; ours is deeper per the spec sheet |
| Guide channel | ≈ 39.5 mm recessed groove | 48 mm walled channel (spec 46–50) | different philosophy: tight groove vs walled channel + clearance |
| Rail/shoulder height | ≈ 7.3 mm | 14 mm | ours guards leaning figures more |
| Tile | 128 mm long, 24.2 mm drop | 150 mm, 30 mm drop | same class |
| Vertical module | 21.4 mm stacker + 12 mm pegs (Ø10.5 friction fit) | 15 mm grid risers, hex 9 AF interlock | both quantize height into reusable modules |

Running the community set's measured 12.0° through this project's rimless-wheel
model predicts a healthy gait (8.9 steps/s, 143 mm/s, slide margin
tan 12° = 0.213 « 0.85·μs) — i.e., **our physics engine predicts that the
known-working design works**, the strongest external check available without
printing. That is all this section is for: it validates the MODEL, not any
claim of cross-compatibility. Interlocks are not cross-compatible (round pegs
vs hex sockets) and are not meant to be — this track does not aim to
interoperate with anyone else's.

Community print-orientation note: the surveyed standalone set recommends
printing ramps vertically with tree supports to get clean rib lines — this
project's flat, rim-down orientation achieves clean transverse ridges with
zero supports instead (the ridges print as stacked perimeter steps).

## 8. The lateral model — does the figure fit sideways?

Everything above §7 is about motion *along* the track. `simulate.js` models
exactly that and never reads channel width, so for a long time the lateral
numbers in §4 had nothing testing them and nothing relating them to each other.
`js/clearance.js` is the missing half.

**The model.** The figure is a rigid rectangle: its along-travel extent *below
rail height* (above the rails the channel is open, so the nose and head
constrain nothing) by its width. That rectangle is swept along the centreline
and the model reports the narrowest concentric band containing it —
off-tracking and yaw at once, no small-angle approximation.

Yaw is where the judgement is. A passive walker does not steer: it translates
along a straight chord for one stride and is squared back up by the walls at
hoof strike, so heading error against the local tangent is taken as **half the
turn the tangent makes in one stride**, `stride/2R` — ±3.2° at the standard
radius, zero on a straight.

**The two measurements it rests on.**

| Measured | Value | Where it came from |
|---|---|---|
| Figure width | **38 mm** | a real Klip Klop toy, on the bench |
| Channel narrowing in print | **0.32 mm** | a printed straight measures 47.68 across a channel drawn at 48 |

The second one matters more than it looks: the fit check subtracts it, so what
it answers is "does the figure pass through the plastic", not "does it pass
through the CAD".

**What it says.** Channel required, including the 3 mm clearance floor:

| Where | Needs | Has |
|---|---|---|
| Straight | 41.0 mm | 48 |
| Curve, R = 143.64 (standard) | 44.08 mm | 48 |
| Curve, R = 120 (tightest legal) | **44.60 mm** | 48 |

The tightest legal turn is the worst case anywhere on any track, and the
standard channel clears it by 3.4 mm. **So a turn needs nothing added to it,
and `SPEC.curveWidenMm` is 0.** There is headroom for a figure up to 41 mm, so
a differently-measured toy does not break the design.

**What that deleted.** The widening existed only to carry the project's own
printed figure, which was 44 mm because it was defined as `channel − 4` — a
number with no physical referent that then justified the channel that defined
it. Removing it means **one width everywhere, and therefore one shape per piece
type**: with nothing to blend at a seam there are no `_into_curve` /
`_out_of_curve` / `_between_curves` straights and no `_entry` / `_through` /
`_exit` curves. Across the whole scene library the track collapses to **8
distinct shapes** — start, end, straight, curveL, curveR, lift, elevator,
switch — down from 16.

Note what is NOT a reason here. Running on other people's ramps is not a goal
of this project, so nothing about the community set in §7 constrains the
design. What does constrain it is the other direction: **a real Klip Klop toy
has to run on THIS track**, and that is what puts the floor under the channel
at 44.60 mm.

Worst side-to-side play over the eleven stock scenes, as printed:

| Configuration | Distinct shapes | Worst play |
|---|---|---|
| 44 mm figure, 48/51 tapered, narrower face wins | 14 | 1.87 mm |
| 44 mm figure, 48/51 tapered, wider face wins | 16 | 2.79 mm |
| **38 mm figure, uniform 48** | **8** | **5.84 mm** |

Fewer parts and more clearance at once, which is the shape of an answer that
was being blocked by a wrong assumption rather than a real trade.

**The cost, stated plainly.** A straight now gives the figure ~9.7 mm of
side-to-side play where the old rule gave 4. The reference toy's own ramp uses
a tight 39.5 mm groove (§7) — a different philosophy — and more play means more
wander and more wall contact, which costs a little gait energy. Narrowing the
channel toward the figure would recover it, but the 48 mm channel is locked by
the Klip Klop Standard (§6) and changing it is a MAJOR bump that forks every
printed part. Not worth it for a second-order gait effect; worth revisiting if
a print ever shows the figure wandering badly on straights.

**Still not validated against plastic.** The yaw law and the 3 mm clearance
floor are reasoned, not measured. A printed helix tier with a figure run
through it is what would settle them.
