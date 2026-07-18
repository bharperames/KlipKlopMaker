# 🐴 Klip Klop Maker — The Journey

*How a toy-physics question became a full track-design studio, physics lab, and 3D-print pipeline — the complete record of the founding session (July 15–18, 2026).*

**Repo:** [github.com/bharperames/KlipKlopMaker](https://github.com/bharperames/KlipKlopMaker) · **Live:** GitHub Pages (pure static SPA) · **Status at time of writing:** ~43 commits, 190 tests across 9 suites, 11 curated demo scenes, Geometry Standard v1.0.0

## Part I — The Spark

### The founding prompt

*"Build a web application whose goal is to create 3D Printable parts that can be used with the 'Klip Klop' line of toys. Research optimal angle and surface friction characteristics needed to produce the right motion for these parts."*

The target is the Fisher-Price **Little People Disney Princess Klip Klop** toy line: weighted horse figures that trot down sloped ramps under gravity alone, clacking their hooves alternately — the "klip klop." Brett supplied a remarkably complete physical description in the very first message:

- The figure is a **rocker pivoting about alternating hooves**, weight biased toward the back half.
- Gravity tips the center of mass over the front leg → front hoof *clack* → impact lifts the rear → mass shifts back → rear hoof *clack*.
- The ramp's incline keeps each landing hoof slightly lower than the last, so the rhythm is self-sustaining — **potential energy continuously converted into rocking motion**.
- Reference video of the stable playset in action, Etsy listings of the vintage castle, and photos of the toys (including *Mike the Knight* on Galahad, who would later become the app's mascot figure).

Two more inspiration sources were named up front and shaped everything after:

- **`~/Code/3d_prints`** — Brett's prior project with an established pipeline for building *watertight, printable* meshes in the browser and exporting them. Its lessons (and one of its bugs) carried straight into this app.
- A **spiral tree-tower** image — the aspirational build: a helix of ramps winding down a tower, which became the flagship "Demo Tower" and "Grand Helix" scenes.

The working style was set immediately: **"Continue building autonomously with no questions, pick the best direction."** That instruction became a persistent project memory and governed the whole session — decisions were made, then reported, never pre-asked.

### The engineering spec sheet

Shortly after, Brett dropped a full engineering constraints document that read like a real product spec. Its highlights became the app's physics constants:

| Constraint | Value | Why |
|---|---|---|
| Slope "green zone" | **10–12°** | Below ~10° the gait stalls; above ~12° the swing limiter is exceeded and the figure tumbles |
| Bank angle | **0° always** | The rocker cannot tolerate lateral tilt |
| Waterfall seams | **≤ 0.25 mm** | Downstream deck may sit a hair *lower*, never higher — no uphill lips |
| Washboard texture | **0.6 mm × 2.5 mm pitch**, raised cosine | Transverse ribs give the hooves purchase and make the clack |
| Minimum curve radius | **≥ 120 mm** centerline | Tighter curves outrun the gait's turning ability |
| Channel width | **46–50 mm** | Guides the figure without pinching the rocking motion |

## Part II — Physics First

### The rimless wheel

Before any geometry existed, the gait was modeled. The passive-dynamic walking literature (McGeer's *rimless wheel*) gave a closed-form steady-state:

`ω_s² = 4 (g/l) · sin α · sin γ · K / (1 − K),   K = η · cos²(2α)`

where `α` is the half-angle between hoof contacts, `γ` the ramp slope, `l` the effective leg length, and `η` the collision energy-retention efficiency. From this came:

- **`assessSlope`** — classifies any slope into *stall / walk / slide / tumble* with a predicted speed and step frequency,
- **the goldilocks range** — the computed walkable band, which independently landed on ~10–12°, confirming the spec,
- **the slide criterion** — the figure skis instead of walks when `tan γ > 0.85 μs`,
- **friction presets** — dusty 0.22, smooth 0.32, perpendicular-ribs 0.45, washboard 0.60,
- a default walker: α = 18°, leg 26 mm, η = 0.26, mass 45 g.

### Simulation as a first-class citizen

Brett's early directive: *"make sure there is a persistence format and that simulation (simple sliding) is supported… generate several scenes… solid testing harness with dynamics/physics verification… generate visual reports for review later."*

So the sim (`js/simulate.js`) was built **pure and deterministic** — no DOM, no Three.js — and made to drive *both* the interactive "Test ride" animation *and* the offline test harness. What you watch in the browser is literally what the tests verify. It integrates three regimes (WALK relaxing to the rimless-wheel speed, SLIDE with `v̇ = g(sin θ − μk cos θ)`, and powered LIFT), counts hoof clacks, and ends in one of *arrived / stalled / tumbled / circuit / timeout*. An **energy-budget verifier** asserts that no passive span of any trace ever creates kinetic energy from nothing — the integrator is audited on every test run.

### Validation against the real world

Later in the session Brett supplied a community-made, field-proven design — `klip-klop-set-v8-new.3mf` — with the instruction *"double check our physics math against this one."* The measured artifact: **12.0° slope, 1.0 × 0.15 mm transverse ribs, 21.4 mm stacker module**. Our model predicts that design walks — right at the top of our green zone, with rib geometry consistent with our traction presets. That cross-check was written up as **PHYSICS.md §7**, turning the physics doc from theory into validated engineering.

## Part III — Building the App

### Foundations (commit 1: *"RCT-style designer for 3D-printable passive-walker ramp towers"*)

The first commit already contained the skeleton that survives today:

- **`js/track.js`** — a pure layout engine: a piece sequence walks forward through grid transforms, producing world-space poses, deck heights, and support plans. No rendering, fully testable.
- **`js/geometry.js` + `js/pieces.js`** — profile-based solid construction: channel cross-sections swept along straights and arcs, washboard ribs phase-snapped so seams land in texture valleys, arched "gothic arcade" skirt windows to save plastic.
- **CSG done right** — the prior project's `three-bvh-csg` was tried and *rejected* (it left T-junctions and 749+ open edges — non-manifold, unprintable). Replaced with the **manifold-3d WASM kernel**, whose output is manifold by construction. Every exported part passes a watertightness analyzer (manifold check + orientation + signed volume) in the test suite.
- **The STL lesson inherited from `3d_prints`:** the old writer axis-swapped coordinates, silently **mirroring chiral parts**. The new exporter uses a proper rotation `(x, −z, y)` — a left curve prints as a left curve.
- Three.js viewport with orbit controls, localStorage persistence, and the first demo scenes.

### Going static (*"Can this app function entirely as a single page application?"*)

Brett wanted zero infrastructure: all assets static, persistence local, deployable on GitHub Pages. So every runtime dependency was **vendored** — three.js and addons, the manifold-3d WASM, fflate — no CDN, no build step, `.nojekyll`, import maps in plain HTML. Commit and push went to `bharperames/KlipKlopMaker`, and Pages has served every iteration since.

### The RCT era (*"Research the build interaction ux mechanics that Roller Coaster Tycoon uses"*)

The next great expansion turned a viewer into an **editor**, explicitly modeled on Roller Coaster Tycoon's track-building paradigm:

- construction arrows at the active track end, **ghost previews** of the next piece before committing,
- in-place piece editing, head-of-track prepending, and piece deletion anywhere,
- **Y-switches with swing gates** — the sequence became a *tree* (switch nodes carrying `main` and `branch` sub-chains), with a gate paddle that physically hinges to route the figure,
- **powered lift ramps** — conveyor sections that carry the figure *up*, making closed circuits energetically possible,
- **interlocking scenery** — tower, palm island, patio — all sharing one hex-socket standard with the track supports,
- more demo scenes to exercise everything.

Real use immediately found real bugs, reported with screenshots: *"the supports go through the track"* → collision-aware pillar planning (center / outrigger / none per piece). *"I tried 'R' after clicking a track piece and nothing happened"* → the editing actions were rationalized and surfaced. *"Undo/redo should be based on edit stack"* → a proper snapshot history module (`js/history.js`) with gesture coalescing, reviewed to cover **every** mutating operation uniformly.

## Part IV — Making It Printable for Real

### The slicer strikes back

Brett ran real parts through a slicer and came back with a screenshot: the protruding dovetail connector was a **floating cantilever** — unprintable without supports. His suggestion: do what Hot Wheels does. The redesign:

- **Bowtie connector keys** seated in *full-height end ribs* — every face bed-supported, zero overhangs, printable rim-down with no support material,
- a footprint test in the suite that permanently forbids any geometry protruding past the part's buildable footprint.

### "No 90° edges"

*"Are you modelling them with chamfers and fillets that will print nicely?"* prompted a chamfer pass across every part: 0.5 mm elephant-foot chamfers on bed edges, 0.8 mm rail-crest chamfers, lead-in chamfers on every hex tenon tip and socket mouth. One scenery bug fell out of this review: the palm island's tenon was a *circumscribed circle* (Ø 9.93) that could never enter the 9 mm-across-flats socket — replaced with a true hex tenon with lead-in.

### "The supports can't be magic" — the Klip Klop Standard

The pivotal engineering prompt of the session:

*"The support pieces used can't be magic, they need to be made of commonly sized parts… perhaps we can lock in the track parameters with some research and only change for very specific reasons."*

Free-height supports meant every pillar was a bespoke print. The fix was to **derive the track parameters from the support system** instead of the other way around. Research produced **THE KLIP KLOP STANDARD (Geometry v1.0.0)**:

| Parameter | Value | Derivation |
|---|---|---|
| Grid module | **15 mm** | Every deck height lands on this lattice |
| Straight tile | 150 mm plan, **−30 mm** drop | slope = atan(29.75/150) = **11.2167°** — inside the green zone |
| Lift tile | 150 mm plan, **+30 mm** rise | atan(30.25/150) = 11.4045° |
| Curve (90°) | R = **143.637 mm**, −45 mm drop | ≥ 120 mm rule satisfied; drop stays on-grid |
| Channel width | **48 mm** | center of the 46–50 spec |
| Riser kit | **120 / 60 / 30 / 15 mm** + 15 mm foot | *five* reusable part designs build every support height |
| Joints | bowtie keys, hex 8.6 AF tenon ↔ 9 AF socket × 10 deep | one interlock standard across track, pillars, scenery |

The beautiful consequence: heights always decompose into a small stack of standard risers, and **loops close exactly** (6 lift tiles ≡ 4 curve drops). The parts list stopped counting bespoke pillars and started counting *feet and risers*.

### Interoperability, versioned

Once parameters were sacred, they became **constant app-wide**: `GEOMETRY_VERSION = '1.0.0'` (semver) is stamped into every export, every scene file, and every demo. Loading an old or foreign file with non-standard parameters re-lays it canonically and shows a styled warning — the parts you print today will always mate with the parts you print next year. Brett also had existing community models reviewed (Printables ramp+stacker, Thingiverse ramp support) to understand what interlocks others had used; the Printables one was later dropped from References on review.

## Part V — Loops, Circuits, and "Connect Ends"

### Loop as a *property*, not a mode

*"I'd like to move from explicitly labelling the setup as 'a loop' to implicitly figuring it out based on the design — 'closed loop' is a property of the analysis, not an up-front direction."*

The explicit loop toggle (which had already caused one bug — Clear leaked loop mode and made fresh ramps unrideable) was removed. Instead `layoutTrack` **trial-walks the chain**: if the tail lands back on the head (within 5 mm, heading aligned, step-down in the waterfall window), the design *is* a circuit. Open runs get start/end platforms; circuits get lap counting and the "perpetual circuit" sim outcome.

### Brio-style auto-closure

The same prompt named the second inspiration explicitly: **Brio train tracks** — standardized parts mean the computer can finish your loop for you. Because every part is one of four exact grid transforms (straight +150/−30, lift +150/+30, curves ±90° at R143.6/−45), closing a gap is a clean **A\* search** (`js/connect.js`, pure, tested). Build a descending U, press **Connect ends** → *"connected with 9 standard tiles (7× lift, 2× curveL)"* → the horse immediately runs laps. Two hard-won fixes along the way: the solver had to derive its moves from the *layout's* params (a legacy custom-param file once made a one-tile gap unsolvable), and a 10-second main-thread hang became a chunked async stepper with a progress toast.

## Part VI — The Experience Layer

### The toy taught the UI its colors

*"Come up with another visual aesthetic for the UI, I don't like the white and yellow. Maybe use color theming inspired from the toy."* The Mike the Knight castle playset supplied the palette: **chocolate structure brown** (#3c2a19), **roof orange** (#e0641e), **banner blue** (#2f6fd0), **track gold** (#f2b632), cream plastic buttons. Everything got restyled: chunky embossed part buttons with hand-drawn **SVG icons of the actual parts**, a single left panel with **Build | Physics | Print | Parts** tabs, Refs as a header toolbar overlay, styled dialogs replacing every bare `alert()` (an explicit rule after one too many browser popups), undo/redo icons in the Build header, and gold pill toggles in the parts gallery.

### Watching the physics

The believability requests — *"physics needs visual clues"* — produced the full ride experience: figure animation driven by the sim trace, live telemetry HUD, hoof-clack audio, ride **pause** (Space), figure opacity control, and **Film ride** — an in-app MP4/AAC capture of the whole run. Film had its own saga: audio played ~9% fast until the AudioContext was pinned to **48 kHz** (Chrome's muxer assumption vs. the default 44.1 kHz).

### Mike the Knight rides again

The vintage castle's hero got his tribute: a **knight figure style** (Galahad + Mike) alongside the classic horse. Brett then sculpted his own display model — `js/horse_model.js`, 400 lines, user-authored — and wired it in *while the session was running*, a pattern that repeated enough to earn its own project memory: **Brett edits and commits in parallel mid-session; always re-check git state before assuming.** Eventually the figures were scoped correctly: *"let's not consider the figure as printable parts, only the track construction"* — figures are the stock toys you already own; their physics moved to a **Figure Lab** accordion in the Physics tab "for the curious."

### The Parts gallery

A full-page parts inspector grew from *"parts page request — large versions, interlocking mechanisms visible"*: every printable part rendered large with shading styles (injection plastic / PLA / clay / normals), a bright-green tessellation overlay, auto-rotate, and **dimension witness lines that touch the parts** (redrawn after the first attempt floated free). Facet tessellation itself became spec-driven: a sagitta-based `segmentsForCircle` guarantees ≤ 0.1 mm faceting error on every curved surface. And a user report of *"twisted surface normals"* exposed that naive vertex-normal computation was smearing shading across welded sharp edges — fixed with `toCreasedNormals(30°)`.

## Part VII — Trust, Testing, and the Paper Trail

The harness grew alongside every feature and now stands at **190 tests in 9 suites**:

- **track** — layout math, circuit detection, support decomposition, grid anchoring
- **geometry / pieces** — every exported part is verified *watertight and correctly oriented* (manifold analysis + signed volume), footprints bed-safe
- **physics / simulate** — slope classification, goldilocks bounds, energy-budget conservation on every trace
- **scenes** — all demo scenes load, lay out, simulate, and hit their *expected outcomes* (the scene format carries an `expect` block — scenes are test fixtures)
- **history, connect, mesh_utils, scene format round-trips**

Failures during the session were diagnostic gold: the energy verifier once "caught" the integrator creating energy at lift crests — actually trace-cadence sampling, resolved with a justified epsilon (≈ g·0.25 mm) and a comment explaining exactly why. Rim grids mixed two height families off by 0.25 mm until boundary anchoring unified them. A truncated code splice once broke the whole bundle with a single missing brace ("figure switching gone" was the symptom; a syntax error was the disease).

The demo scenes themselves tell the physics story: *First Ramp*, *Demo Tower*, *Grand Helix*, *Slippery Slide* (μ too low → skis), *Too-Shallow Stall*, *Cliffhanger Tumble*, *Switchyard*, *Lift & Return*, *Palm Resort*, *Perpetual Motion*. One scene was **retired with pride**: the tight-radius violation demo became impossible to build once canonical parts were locked — the standard had eliminated the failure mode it demonstrated.

Visual verification reports (rendered scene grids + sim traces) were generated throughout and published as a shareable artifact for async review.

## Part VIII — Beyond the Founding Session

After this session's last push (`f27324f`, the gold-pill toggles), the work continued in parallel sessions — visible in the git log and part of the same journey:

- **Elevator track piece** with a custom height editor and animated conveyor prongs; elevator drop math extended so elevator loops close, with alignment diagnostics and A\* solver support for powered track
- **Inline 3D part inspector** with a full-screen lightbox modal
- Parts grouped by canonical orientation with per-part print weights in grams
- Scene library curation down to a standard set (Elevator Showcase, Perpetual Spiral Track, a redesigned signature *Palm Resort*)
- UX polish: click-background to deselect, "Editing: *piece*" cards, `beforeunload` guard, Clear design with critical styling
- Film capture fixes: 30 FPS pinning for high-refresh screens, silent-oscillator keep-alive to stop audio timeline speedup

## Appendix A — Decisions That Defined the Project

- **Physics before geometry** — the rimless wheel model came first; the track was designed to satisfy it, then validated against a measured working community design.
- **Purity as architecture** — layout, physics, sim, solver, and persistence are all DOM-free pure modules; the UI is a thin shell; the tests exercise the *same* code the user watches.
- **Manifold or nothing** — CSG output must be provably watertight; the printable pipeline is enforced by tests, not hope.
- **The Standard is sacred** — parameters are constants, geometry is semver'd, supports are a five-part kit, and the solver exists *because* the parts are standard (the Brio insight).
- **Real feedback beats speculation** — the slicer screenshot, the community 3MF, the twisted-normals report, and the checkbox screenshot each reshaped the product more than any plan did.
- **Autonomous but accountable** — build without asking, report every decision, keep 190 tests green, and let the demo scenes prove the claims.

## Appendix B — The Prompt Timeline (abridged)

| # | Prompt (paraphrased) | What it produced |
|---|---|---|
| 1 | Build the app; research angle & friction; consult `3d_prints`; toy physics essay + video/images | Physics model, layout engine, first scenes |
| 2 | Spiral tower inspiration image; "build autonomously, no questions" | Demo Tower / Grand Helix; the working contract |
| 3 | Engineering spec sheet (green zone, waterfall, washboard, radius, bank) | Locked physics constants, PHYSICS.md |
| 4 | Persistence + sliding sim + scenes + test harness + visual reports | scene_format, simulate.js, harness, reports artifact |
| 5 | Commit/push to GitHub; fully static SPA; GitHub Pages | Vendored deps, zero-build deployment |
| 6 | Favicon; RCT editing research; switches, lifts, scenery, interlocking bases | The editor era |
| 7 | "Supports go through the track"; editing discoverability | Collision-aware pillars; action surfacing |
| 8 | Edit-stack undo/redo | history.js |
| 9 | Hot-Wheels connector idea + slicer cantilever screenshot | Bowtie keys, zero-overhang joints |
| 10 | Video export with audio; pause; opacity; loop scenes | Film ride, ride controls |
| 11 | Twisted normals; chamfers ("no 90° edges"); tessellation tolerance | Creased normals, chamfer pass, sagitta faceting |
| 12 | "Supports can't be magic — lock the parameters" | **The Klip Klop Standard v1.0.0** |
| 13 | Toy-inspired theme; single tabbed panel; SVG part icons; styled dialogs | The chocolate/orange/gold UI |
| 14 | Community model review; "double-check physics against this 3MF" | PHYSICS.md §7 validation |
| 15 | Loop as analyzed property; Brio-style "Connect ends" | Implicit circuits + A\* closure solver |
| 16 | Constant params, semver geometry stamps, canonical demos, async solver | Interoperability guarantee |
| 17 | Figures aren't printable parts; Figure Lab; parts page to top tabs | Correct product scoping |
| 18 | "Improve the look of these checkboxes" | Gold pill toggles — the founding session's last shipped pixel |

*Compiled July 18, 2026 from the founding session's full transcript, project memories, and git history. The horse walks because the math says it must.* 🐴
