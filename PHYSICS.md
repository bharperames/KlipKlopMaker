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

## 4. Geometry constraints enforced by the app

| Constraint | Value | Reason |
|---|---|---|
| Slope | hard 8–14°, green 10–12° | stall / slide-tumble envelope above |
| Bank (roll) | exactly 0° | 1° of inward lean jams the top-heavy figure against the wall |
| Curve radius | ≥ 120 mm centerline | rigid figure wedges front-inner/rear-outer hoof otherwise |
| Curve widening | +3 mm | swept-path widening of a rigid rectangle in a turn |
| Channel width | 46–50 mm | figure width + 3–4 mm total clearance |
| Rail height | 14 mm | guides the base, clears the swinging torso |
| Floor fillets | r = 2 mm | re-centers a wandering hoof without snagging |
| Floor thickness | 2.0–2.6 mm over a hollow skirt | acoustic drumhead ("klip-klop" amplifier) |
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
