/**
 * track.js
 * Pure track layout engine — no DOM or Three.js dependencies.
 *
 * v2: the track is a TREE, not a list. A node is either a simple segment type
 * ('straight' | 'curveL' | 'curveR' | 'lift') or a switch object:
 *
 *   { type: 'switchL'|'switchR', gate: 'main'|'branch', main: Node[], branch: Node[] }
 *
 * A switch is always the last node of its container array; its two exits each
 * carry their own continuation. Every leaf container is auto-capped with an
 * end platform, and the root is prefixed with a start platform.
 *
 * Physics rule set enforced here (see PHYSICS.md):
 *  - Slope lock (green 10-12°) with Auto-Z elevation solving down every branch
 *  - Waterfall rule: every seam steps the downhill floor 0.25 mm lower
 *  - Washboard pitch snapped per piece so seams land in ridge valleys
 *  - Zero bank: sweep `right` vectors stay horizontal on curves and spirals
 *  - Lifts ascend at the same locked angle (externally powered — the one
 *    exception to gravity-only, flagged with `isLift`)
 */

/**
 * THE KLIP KLOP STANDARD — locked track parameters, derived so that every
 * printed part interoperates forever:
 *  - Each running tile drops a whole number of 15 mm grid units INCLUDING its
 *    0.25 mm waterfall seam: straights/lifts = 30 mm, curves = 45 mm.
 *  - Therefore ramp slope = atan(29.75/150) = 11.217° (dead center of the
 *    10–12° passive-walker green zone) and curve radius = 143.64 mm (above
 *    the 120 mm rigid-body minimum).
 *  - Every deck boundary — and every support rim — lands on the 15 mm grid,
 *    so supports are STACKS OF STANDARD RISERS (15/30/60/120 mm on a common
 *    foot), not one-off cut-to-height pillars.
 *  - Loops close exactly: 6 lift tiles buy what 4 curves spend (180 mm).
 * Deviating from these values forks your part library — the UI treats custom
 * parameters as an explicit, warned, non-interoperable mode.
 */
/**
 * Geometry semver: stamped into scene files and export jobs. Bump MAJOR when
 * printed parts stop mating (joint/socket/grid changes), MINOR for additive
 * compatible geometry, PATCH for cosmetic-only changes.
 */
export const GEOMETRY_VERSION = '2.4.0';

export const STANDARD = {
    gridMm: 15,
    tileDropMm: 30,
    curveDropMm: 45,
    slopeDeg: Math.atan(29.75 / 150) * 180 / Math.PI,        // 11.2167°
    liftSlopeDeg: Math.atan(30.25 / 150) * 180 / Math.PI,    // 11.4045° (powered)
    curveRadius: (44.75 / (29.75 / 150)) / (Math.PI / 2),    // 143.637 mm
    innerWidth: 48,
    /**
     * The riser ladder. Every size is exactly TWICE the next, which is the
     * property doing the work: over a 15 mm grid that makes it a binary
     * system, so every height a track can ask for is buildable AND the greedy
     * decomposition in decomposeSupport is provably the fewest parts. Break
     * the doubling and both guarantees go — [90, 45, 15] and [120, 45, 30, 15]
     * look tidier and cost MORE risers (114 against 111 over a measured
     * sample of 38 columns from one-, two- and three-tier towers).
     *
     * There is nothing to optimise toward on the demand side. A tier drops
     * four curves at 45 mm, supports land three grid units apart inside a
     * tier, and across towers the heights come out as 2, 5, 8, 11, 13, 14, 16,
     * 19 ... 40 units — i.e. essentially every grid unit. So the ladder has to
     * cover all of them, not hit favoured multiples.
     *
     * Adding 240 would keep the doubling and cut the sample from 111 risers to
     * 96 (2.92 to 2.53 per column). It is deliberately NOT here: a riser is a
     * hex tube that can only print standing up, and 240 mm on a 19 mm section
     * is 12.6:1 — past the point where a knock from the nozzle takes the print
     * out. 120 mm at 6.3:1 is the practical ceiling, and paying one extra
     * riser per tall column is the cheaper side of that trade.
     */
    riserSizes: [60, 30, 15],
    footHeight: 15
};

/** Does a parameter set match the interoperable standard? */
export function isStandardParams(p = {}) {
    const slope = p.slopeDeg ?? STANDARD.slopeDeg;
    const radius = p.curveRadius ?? STANDARD.curveRadius;
    const width = p.innerWidth ?? STANDARD.innerWidth;
    return Math.abs(slope - STANDARD.slopeDeg) < 0.02
        && Math.abs(radius - STANDARD.curveRadius) < 0.5
        && Math.abs(width - STANDARD.innerWidth) < 0.01;
}

/**
 * Decomposes a support height (a 15 mm-grid rim) into standard parts:
 * one foot + risers. Returns null when the height is off-grid (custom mode).
 */
export function decomposeSupport(heightMm) {
    const units = Math.round(heightMm / STANDARD.gridMm);
    if (Math.abs(heightMm - units * STANDARD.gridMm) > 0.1 || units < 1) return null;
    let rest = heightMm - STANDARD.footHeight;
    const risers = [];
    for (const size of STANDARD.riserSizes) {
        while (rest >= size - 0.1) { risers.push(size); rest -= size; }
    }
    if (rest > 0.1) return null;
    return { foot: 1, risers };
}

export const SPEC = {
    slope: { hardMin: 8, greenMin: 10, greenMax: 12, hardMax: 14, default: 11 },
    // The channel, everywhere. One width: straights, curves, switches, the lot.
    innerWidth: { min: 46, max: 50, default: 48 },
    // ZERO, and this is the measurement that got it there.
    //
    // A real Klip Klop figure is 38 mm across (measured off the toy). Swept
    // through the tightest legal curve — R 120 — a 38 mm footprint needs
    // 44.60 mm of channel including its clearance, and 48 covers that with
    // 3.40 mm to spare. It covers every legal radius for any figure up to
    // 41 mm. So a turn needs nothing added to it, and the widening that used
    // to be here was never about the toy: it was propping up OUR printed
    // figure, which was 44 mm because it was derived as `channel − 4` rather
    // than from anything physical.
    //
    // Setting this to 0 is what deletes the whole `_into_curve` /
    // `_out_of_curve` / `_between_curves` family: with one width there are no
    // seam mismatches to taper, so `resolveSeamWidths` becomes a no-op and
    // every curve and every straight is one shape. The taper machinery below
    // is kept and still tested, because a custom-parameter build can still ask
    // for a widened turn — it just is not what the Standard does.
    curveWidenMm: 0,
    minCurveRadius: 120,
    defaultCurveRadius: 150,
    railHeight: 14,
    // 2.4 mm = 6 perimeters at a 0.4 nozzle. This was cut to 1.6 to save
    // plastic — the shell is ~75% of all track plastic, so it looked like 15%
    // off the whole job — and the saving was not real. PRINTED at 1.6 the
    // skirt walls are too slender to stand up while they are being built: a
    // pier is only `ARCH.pier` long, so at 1.6 it meets the bed on 12.8 mm²
    // (less the 0.5 mm edge chamfer) and carries a 40 mm wall above it. A
    // centre pier on a test straight shifted on the plate and welded back on
    // crooked. 2.4 puts 19.2 mm² under the same pier and stiffens the wall
    // against the nozzle knocking it.
    wall: 2.4,
    floorThk: 2.0,
    filletR: 2.0,
    skirtDepth: 12,
    /**
     * The two underside shapes. `viaduct` is the default and the printable
     * one; `minimal` keeps only what the joints need. See archedRimY.
     *
     * 15.5, AND 15.21 IS WHY. The number that has to clear is not a feature
     * under the deck — it is the SEAT the spacer bears on. That seat has to be
     * level (or the tower leans) and the underside slopes, so the seat can only
     * live at the top of a collar bored down to the plane, and the collar only
     * works if the seat is above the plane everywhere under it:
     *
     *     seat, set by the floor        deck - 2 - 1.03 - 10   = deck - 13.03
     *     underside at the collar's
     *       uphill edge (r = 11)        deck + 2.18 - D
     *
     * so D >= 15.21, and 15.5 takes it with 0.29 to spare. Below that the
     * collar has nowhere to go: it either protrudes past the underside plane —
     * and the piece laid on its own underside balances on THAT, which is the
     * failure the first tilt was reverted for — or it inverts. `bossOps` and
     * `tiltOntoUnderside` share one test for it, so a shallower depth simply
     * gets the old plain boss and no tilt rather than a broken part.
     *
     * This used to say "12, and it is not a choice", because the depths that
     * kept a socket mouth on the 15 mm grid were 12, 27 and 42. That was true
     * while the boss carried its OWN pad down to the grid. The spacer carries
     * the grid now, so D is free of that family entirely, and what asks for a
     * number instead is the seat. 12 remains the right answer for a part that
     * will be printed rim-down with supports: 3.7 cm3 lighter on a straight,
     * and none of the above matters when the piece is not standing on it.
     */
    /*
     * MINIMAL IS THE DEFAULT UNDERSIDE, on slicer evidence.
     *
     * Sliced through `scripts/slice_loop.mjs`, the arcade is the single biggest
     * generator of unsupported perimeter in the library: a viaduct straight
     * spends 12.20% of its filament on floating shell and overhang wall against
     * a minimal straight's 1.38%, and a viaduct curve 17.02% against 4.56%. It
     * is also what actually failed in plastic — the one part printed off this
     * repo was a viaduct curve, and its failures were exclusively on the arched
     * skirts, while the deck underside it shares with the minimal part came out
     * clean despite drawing the same warnings.
     *
     * A minimal piece is also shorter (41 mm against 71 on a curve), sits on
     * more bed (1777 mm2 against 1031) and costs no extra plastic — 106 g
     * either way. What it costs is a spacer under a curve, and having never
     * been printed: see HANDOFF.md. `viaduct` remains fully supported and is
     * one selection away in the Underside control.
     */
    skirt: { style: 'minimal', minimalDepthMm: 17 },
    ridge: { height: 0.6, pitch: 2.5 },
    waterfallStepMm: 0.25,
    // Assembly clearance where nothing better is known. The two joints that
    // have now been printed carry their own MEASURED numbers instead —
    // `key.fitClearanceMm` and `socket.tenonClearanceMm` — because 0.2 turned
    // out to be too generous for both of them.
    jointClearanceMm: 0.2,
    tileLen: 150,
    platformLen: 150,
    clearanceHeight: 100,
    socket: {
        hexAF: 9, depth: 10, bossR: 9.5, pillarR: 7,
        /**
         * THE PILLAR SOCKET IS A ROUND BORE, AND THE TENON STAYS HEX.
         *
         * Brett's inversion, and it is measured, not reasoned: a plate of three
         * round bores took his existing hex tenons and read 9.60 "a pleasing
         * snug fit, easy to push in, doesn't fall out", 9.85 "kinda loose",
         * 10.10 "really loose". Cylinder-in-hex, tested on the same plate, has
         * almost no window at all — 8.89 enters and 9.10 already will not.
         *
         * WHY THE HEX GOES OUTSIDE. FDM cannot cut a sharp INTERNAL corner: the
         * nozzle leaves roughly its own radius in each of a hex socket's six,
         * and how much varies with the part. That rounding, not any drawn
         * clearance, is what set the old fit — which is why one drawing gave
         * "very tight" in a foot and "loose" in a riser off the same plate. An
         * external corner is only a direction change and comes out crisp, and a
         * round hole has no internal corners to lose. Each feature is now where
         * the process is good at it.
         *
         * A hex in a round bore lands on its six CORNERS, so it is SNUG when
         * the bore equals the tenon's ACROSS-CORNERS and jams when the bore
         * falls to its ACROSS-FLATS. Sharp corners displace little material, so
         * they yield gracefully over that whole band — the opposite of a
         * cylinder on six flats, which is a broad contact that jams almost at
         * once. (I had that backwards and the print corrected it.)
         *
         * 9.60 against a tenon printing 9.65-9.73 across corners. It does not
         * remove the 0.08 mm spread between a broad foot and a slender riser —
         * nothing will, they are the same drawing — but it accommodates all of
         * it, snug to firm, where the hex socket ran loose to jammed.
         *
         * THE TENON IS UNCHANGED, so this is backward compatible in the
         * direction that matters: a new riser still plugs into every hex socket
         * already printed, and an old riser plugs into the new bore better than
         * it did into a hex one.
         *
         * The TRACK BOSS keeps its hex socket: the jog is indexed there, and a
         * round bore would let a 45 mm offset arm swing anywhere.
         */
        boreDia: 9.6,
        /**
         * The track socket is drawn 0.25 AF SMALL, and the number is the gap
         * between two printed copies of the same drawing.
         *
         * One hex socket, one AF 9 drawing, two places it gets used:
         *
         *     riser / foot   drawn 9.00 -> printed 8.62, 8.65   ("snug, good")
         *     track piece    drawn 9.00 -> printed 8.85 - 8.95  ("falls out")
         *
         * with the tenon dead on 8.60 in both cases. So the joint that works
         * runs 0.010-0.025 mm/side and the joint that fails runs 0.125-0.175 —
         * and NEITHER is a design decision, because both came off the same
         * number. The difference is thermal: a socket in a slender hex tube is
         * two perimeters and a few seconds of layer time and closes in on
         * itself; a socket buried in a track piece's boss has a cool body
         * around it and barely moves. PRINT_DEVIATION carries both populations.
         *
         * 0.25 is what makes the track socket print like the riser socket:
         * 8.75 drawn, ~8.65 printed, 0.025 mm/side. hexFitTrials scores that at
         * 84% good against the reference joint's own 82% — the target is not
         * perfection, it is the joint you already said feels right.
         *
         * Earlier attempts to explain the track socket as oversize, oval, or
         * "the hole is the problem" all died against measurement. The tenon
         * printing exactly to size was the standing clue: an external feature
         * gets +nozzle and −shrink and they cancel, an internal one gets both
         * inward, and how much depends on what is around it.
         */
        // NOW APPLIED TO EVERY SOCKET, not just the track's. Brett, after
        // stacking two PETG pillars: "the hex pillars are also not tight with
        // each other", and "make the pillar socket the same as the ramp
        // socket". The ramp socket is the one he has repeatedly called right.
        //
        // WHAT THIS OVERTURNS, deliberately: the note below and PLAN.md said
        // riser-to-riser "already works and must not be fixed", on PLA prints
        // where riser sockets measured 8.62-8.65 from this 9.0 drawing. Brett
        // prints PETG and only PETG, so that measurement is history rather than
        // a constraint — and the PLA interference risk it implied is moot.
        // THIS NUMBER IS A PETG NUMBER, like every other fit in the system.
        socketShrinkAF: 0.25,
        /**
         * NO grip taper here, unlike the key — and the reason is worth keeping,
         * because the key's answer looks like it should transfer and does not.
         *
         * A taper works on the key because its SEAT HEIGHT IS FREE: it stops
         * wherever it wedges, three millimetres either way changes nothing, and
         * there is 30 mm of throat to give. A riser meets the part above
         * SHOULDER TO SHOULDER, with the tenon a locator carrying 1 mm of air
         * under it, and every stack height sits on the 15 mm grid. A wedging
         * taper there holds the shoulder off and makes the tower tall.
         *
         * The measured clearance spread (0.10 AF) is also comparable to the
         * whole interference budget, so no single taper grips the loose end
         * without pressing the tight one. If this joint still needs help after
         * the 0.1 AF, the right feature is a crushable rib — compliance that
         * is local, so the shoulder still seats.
         */
        gripTaperAF: 0,
        /**
         * THE COLLAR — what takes a `minimal` boss down to the print plane.
         *
         * A minimal boss stands over the OPEN channel underside: there is no
         * material between the walls below the floor, so the boss is a
         * free-standing tube. Ending it at the socket mouth left that tube
         * starting in mid-air — sliced, its first layer was **1.3 mm²**, a
         * sliver that will not stick to a plate. The fix is not a pier and
         * should not be confused with one: a pier runs to a flat rim on the
         * 15 mm grid and carries the tower. This is ~2.5 mm of ring that
         * carries nothing and exists only so the tube starts on the bed.
         *
         * Its bottom is CUT BY THE UNDERSIDE PLANE, so it is coplanar with the
         * wall bottoms and lands with the rest of the part — 114 mm² from the
         * first layer instead of 1.3.
         *
         * The bore is what keeps the SEAT LEVEL. The spacer has to bear on a
         * horizontal face or the tower leans, and a horizontal face cut into a
         * sloping underside is the whole problem this file keeps running into.
         * So the collar is bored out to clear the spacer's Ø18 body, the
         * spacer tucks up inside it, and the level face it seats on is the
         * ledge at the top of that bore — `socketMouthY`, unmoved.
         */
        collarR: 11,
        collarBoreR: 9.2
    },
    /**
     * The JOG: an offset riser that moves a support column sideways when the
     * column straight under a piece would spear the tier below.
     *
     * It replaces the integral outrigger arm, which made the TRACK PIECE a
     * different solid — six of them across the stock scenes — for a reason that
     * has nothing to do with the track. Now every piece has one socket at
     * mid-piece and the offset lives in a part.
     *
     * 45 mm because the socket is hex: an adapter can only point in six
     * directions, so the worst orientation is 60° off the one you want and its
     * useful reach is 45·sin 60° = 39 mm — a shade more than the 37.5 mm the
     * integral arm used to give. Measured over the stock scenes: 42 mm places
     * every support, 40 mm leaves three helix curves unsupportable, and the old
     * arm's 37.5 leaves thirteen. 45 is the first round number with margin.
     *
     * One grid unit tall, so it SUBSTITUTES for a 15 mm riser rather than
     * adding an off-grid step: `decomposeSupport` still lands on the grid.
     */
    jog: { armMm: 45, heightMm: 15 },
    /**
     * SPACER — the adapter that puts a `minimal` piece's socket mouth back on
     * the 15 mm grid. Same move as the jog: the track piece keeps one shape and
     * the support absorbs the remainder.
     *
     * TWO SIZES, and they are not round numbers because they are not free. A
     * minimal piece's mouth sits at `socketMouthY`, which is fixed by the deck
     * height at the boss — 16.5888 above the rim on a straight, 26.1991 on a
     * curve. The spacer is exactly that remainder (less a whole grid unit,
     * where one fits), so the stack UNDER it is a multiple of 15 and
     * `decomposeSupport` still works:
     *
     *     straight   16.5888 -> 16.59 spacer, stack = rim          (-0.001)
     *     lift       16.6645 -> 16.59 spacer, stack = rim          (+0.075)
     *     curve      26.1991 -> 11.20 spacer, stack = rim + 15     (-0.001)
     *
     * A LIFT SHARES THE STRAIGHT'S. It climbs at `liftSlopeDeg` against the
     * ramp's slope, so its own remainder is 0.0757 mm more — and two parts a
     * tenth of a millimetre apart is the exact failure the D section exists to
     * prevent, reintroduced by arithmetic. The lift's deck sits 0.08 low
     * instead; the waterfall step it lands beside is 0.25.
     *
     * The curve's 11.20 is under the ~12 mm that "a 10 mm socket plus a floor"
     * suggests: it leaves a 1.2 mm plate between the socket ceiling and the
     * tenon shoulder. That plate is not in the load path — the column bears
     * through the annular wall — and taking the alternative (a 26.20 spacer,
     * no grid unit under it) would stand a grounded curve on an 18 mm disc
     * instead of on a foot.
     */
    spacer: { curveMm: 11.20 },
    // Bowtie connector key (print-flat butterfly key, Hot-Wheels-style separate
    // connector): pockets recess into full-height end ribs — zero overhangs.
    key: {
        neckHalf: 8, tipHalf: 12, depth: 9, height: 12, ribThk: 12,
        /**
         * 12, DOUBLED FROM 6, and the reason is a failure Brett saw on the
         * bench: with a key in two pieces the pieces could still ROTATE away
         * from each other about the seam. Part of that was a loose fit from an
         * older key, but not all of it — a 6 mm band is a short lever arm, and
         * once the seam opens a hair at the deck the key has almost nothing
         * below to resist it. The flanks only ever bear when something tries to
         * pull the seam apart (see fitClearanceMm), so what they need is DEPTH:
         * twice the band is twice the moment before the pieces hinge.
         *
         * A tall key is the one feature here that the viaduct skirt pays for
         * and the minimal skirt does not have room for. The pocket ceiling is
         * 3 mm under the deck and the key rises into it from below, so the rib
         * needs the band plus a throat to offer it — see SPEC.skirt.
         */
        // Per side, key flank to pocket wall, drawn. Printing adds ~0.025 to
        // it — the slot's neck came out 16.85 against 16.40 drawn while the
        // key's came out 16.40 against 16.00, so the two oversizes very nearly
        // cancel — and this lands at ~0.145/side at the seat where 0.225
        // rattled. It does not need to be tight: the flanks only bear when
        // something tries to pull the seam open, and retention is the grip
        // taper's job now.
        //
        // Measured up the throat, the slot runs 17.00 at the bed, 16.94 low
        // down and 16.85 at the top: essentially prismatic, 0.15 mm of drift
        // over 39 mm, and running the helpful way — widest where the key goes
        // in. So the throat is its own lead-in, and nothing unintended is
        // gripping anywhere along it.
        fitClearanceMm: 0.12,
        /**
         * The FAR WALL gets its own, much bigger clearance, and it is the one
         * that was jamming the key.
         *
         * Front-to-back the key is a 9.00 mm external feature going into a
         * 9.12 mm hole. Externals print -0.10 to +0.10 across, so a key half
         * is 8.95-9.05; the pocket is a hole in a track piece and the holes
         * measured in track pieces run -0.05 to -0.15, so it is 9.045-9.095.
         * Worst against worst that is -0.005 mm/side — the key does not go in.
         * Against the worst hole reading on record it is -0.12. Whichever way
         * you take it, 0.12 was never enough front-to-back, and that is
         * before the 0.3 mm far-wall taper that used to be in there on top.
         *
         * Spending clearance here costs NOTHING, which is the whole point.
         * The far wall must not touch in service anyway: the key reaches into
         * two pockets at once, so anything pressing on its tips has nowhere to
         * send that force except into driving the two pieces apart. The
         * flanks do the wedging and the flanks alone. So the far wall is
         * pulled back until it clears under every hole reading in the set,
         * with the rib still 2.6 mm thick behind the pocket.
         *
         * This is why the key does not need a compliant feature the way the
         * gate pin does. Compliance is what you reach for when the binding
         * dimension is load-bearing and you cannot spend clearance on it.
         * Here the binding dimension carries no load at all.
         */
        depthClearanceMm: 0.40,
        /**
         * NO drawn-vs-printed compensation, and the reason is worth keeping.
         *
         * Measured off the printed key, a bowtie does not print as a scaled
         * bowtie: the nozzle fills the concave waist (+0.20/side) and rounds
         * the convex tips (−0.275), so it prints with a shallower rake than it
         * is drawn with. That looked like the explanation for a joint that was
         * tight at one end and loose at the other, and the key was briefly
         * drawn pre-distorted to correct it.
         *
         * Then the SLOT was measured, and it does exactly the same thing:
         * +0.225/side at the face, −0.339 at the wide end. Printed flares come
         * out 0.392 for the key and 0.383 for the slot — within 0.01 of each
         * other. The two errors cancel, the printed pair is still parallel,
         * and the gap is a uniform 0.225/side end to end.
         *
         * So there was nothing to compensate. The joint was loose for the
         * simple reason that 0.2 drawn prints as 0.225, and the "tight" half
         * of the complaint was the detent, not the flanks. Comparing a printed
         * part against a drawn one is what made it look like a rake problem.
         */
        /**
         * THE KEY IS DRAWN OVERSIZE, and only the key.
         *
         * A printed key/pocket seam came out loose in PLA and looser in PETG.
         * Measured off the calibration card, the key prints 0.33 mm under what
         * an island of its size should, while the POCKET prints normally for a
         * hole (-0.06 against its family) — so the joint opens by roughly the
         * key's own deficit. Across five photographs the tip-to-tip clearance
         * read 0.887 mm mean against 0.596 modelled: +0.29 mm of slack that was
         * never drawn. The cause is the bowtie's acute tips, the sharpest
         * convex corners in the library and the only shape that loses this
         * much — the disks, squares and hexes all mate at zero clearance by
         * hand.
         *
         * `tipMm` widens the key across the tips by 2x this, closing that gap.
         * It compensates the KEY ONLY: `bowtiePocketPlan` never sees it, so
         * every track piece already printed keeps its pocket and stays valid,
         * and the fix costs a reprint of the one part that is cheap to reprint.
         * Brett: "ideally we would fix this by enlarging the key slightly to
         * not invalidate the parts printed."
         *
         * This reverses a previous conclusion, deliberately. The old note said
         * the key must NOT be pre-distorted because the slot distorts with it —
         * true of the RAKE (printed flares 0.392 key against 0.383 slot) and
         * NOT true of absolute size, which is what a fit is made of. Rake
         * cancelling was read as the fit taking care of itself; it does not.
         *
         * `neckMm` stays 0: the neck was never measured short, and moving both
         * would change the flare that the rake evidence says is already right.
         * The number to trust over this one is the clearance ladder read by
         * hand in the material being printed.
         */
        /**
         * NOT pre-distorted, and the clearance ladder printed in PETG is why.
         *
         * Read by hand: the nominal key will not enter a 0.00 cavity, enters
         * 0.05 EXTREMELY snug, is a good tight fit at 0.10 AND at 0.12, and is
         * loose from 0.15 up. The as-printed key wants 0.10-0.12 mm per side,
         * and 0.12 is what is drawn — so the drawn clearance is inside the
         * proven band and the key is not the half that is wrong.
         *
         * This briefly shipped as tipMm 0.15 on the strength of a calibration
         * CARD measurement, and the ladder took it back out. A key widened
         * 0.128 mm per side would need a 0.23 cavity and would have jammed in
         * every pocket already in the field. The card compared a printed key
         * against a printed hole in a 3 mm card; the rib pocket is a
         * through-slot in a 12 mm rib and does not print like that. The ladder
         * compares the two things that actually mate, which is why it wins.
         *
         * The seam still feels loose in the field, so something remains
         * unexplained — most likely the rib pocket printing larger than the
         * card cavity. That wants evidence, not another guess: the next
         * measurement is a real rib pocket against the ladder, not a change.
         */
        /**
         * THE KEY IS DRAWN 0.07 mm PER SIDE BIGGER. Brett, holding the parts:
         * "the current key/slot is loose, I want the key bigger so it is
         * tighter", and "ideally it would be tight at extremely snug at 0.05".
         *
         * The pocket is drawn at `fitClearanceMm` 0.12 per side. Growing the
         * key by 0.07 lands the throat on 0.05 — the rung of the printed PETG
         * clearance ladder that takes the key EXTREMELY SNUG by hand, which is
         * the fit asked for. The seat, one `seatGripMm` tighter still, lands at
         * 0.02.
         *
         * BOTH numbers move, so the flare does not. `neckHalf` is
         * `K.neckHalf - comp.neckMm` and `tipHalf` is `K.tipHalf + comp.tipMm`,
         * so -0.07 and +0.07 grow neck and tips alike: the key gets uniformly
         * wider without changing its rake, and the rake is the one thing the
         * printed evidence says is already right (key flare 0.392 against the
         * slot's 0.383).
         *
         * ONLY THE KEY MOVES. `bowtiePocketPlan` never sees printComp, so every
         * piece already printed keeps its slot and stays valid — the correction
         * costs a reprint of the cheapest part in the system, which is why it
         * was chosen over touching the pocket.
         *
         * `depthMm` IS THE ONE THAT WAS ACTUALLY LOOSE, and it is worth being
         * blunt about how long it took to see. Brett: "the back of the key to
         * the back of the slot has a lot of slop, almost a full 1mm". He was
         * right to the tenth. One rib's pocket runs to 9.4 from the seam, two
         * mated ribs give an 18.80 cavity, and the key spanned 18.00 — 0.80 mm
         * of play, all of it in THE DIRECTION THE TWO RAMPS SEPARATE. The key
         * located the pieces and then let them open a 0.8 mm seam, which is
         * exactly the failure he has described from the start: "any exposed
         * seam stops the klipklop".
         *
         * It comes straight from `depthClearanceMm` 0.4 per side, and it is
         * SIX TIMES the 0.07 flank change that felt like nothing in the hand.
         * The flanks were never the problem; I spent two versions there because
         * I was reading the ladder as a statement about the flanks when it is a
         * uniform inset and was reporting on every direction at once.
         *
         * 0.3 leaves 0.1 per side, which is the rung Brett called a good tight
         * fit. Taking the pocket's clearance out instead would have been the
         * same joint, but it would strand every pocket already printed.
         *
         * The clearance ladder is the way to check this before committing a
         * batch: a 2.1 key should first enter around the 0.12 rung rather than
         * 0.05. If it will not go home by hand, this is the number to reduce.
         */
        printComp: { neckMm: -0.07, tipMm: 0.07, depthMm: 0.3 },
        // The pocket's far corners are INTERNAL, and a 0.4 nozzle cannot cut
        // one sharper than ~0.3 mm radius. A sharp key corner cannot enter
        // that, so it rides on its corners and never touches the flanks that
        // are supposed to do the wedging — at the old clearance the corner
        // interference was 0.20 mm while the flank gap was 0.18. Chamfering
        // the key's four tips takes the corners out of the fit entirely.
        // 1.8 mm, sized by `bowtieFitTrials` against a MEASURED corner radius
        // rather than a guessed one. The corner is the binding constraint, not
        // the clearance — and the key's own diagonals put the radius at
        // 0.43-0.50 mm, not the 0.30 first assumed. At 0.8 the joint tolerates
        // 0.46 mm and at 1.4 only 0.60, against the 0.63 needed at three
        // sigma; 1.8 tolerates 0.74 and is where P(good) stops improving.
        tipChamfer: 1.8,
        // Retention. The pocket is a through-slot open to the rim, so a seated
        // key had nothing under it and simply fell back out — the joint has
        // never actually held itself together. These bumps narrow the pocket in
        // a short band just below the seated key: it is pushed up past them and
        // then rests on them. Kept short so it is a snap, not a press fit down
        // the whole throat, and shallow enough to print as a 0.35 mm step.
        /**
         * THE KEY'S SEAT HEIGHT IS NOT FREE, AND THE GRIP MUST NOT SPEND IT.
         *
         * This replaces a front-to-back taper on the pocket's FAR WALL, and
         * both halves of that idea were wrong.
         *
         * Wrong about the seat: the key's top face against the pocket ceiling
         * is the joint's VERTICAL REGISTER. Both pockets are cut 3 mm below
         * their own deck, so a key held hard against both ceilings is what
         * makes the two walking surfaces coplanar at the seam — and a piece
         * whose uphill end has no pier under it hangs on that face. A grip
         * that stops the key "wherever it wedges" therefore does not absorb
         * variation, it AMPLIFIES it into the one dimension that has to be
         * exact: at 0.3 mm over 10 mm of rise, 0.1 mm of process moves the
         * seat 3.3 mm. Thirty-three times, into a step across the walking
         * surface. The old test asserted that amplification as a feature.
         *
         * Wrong about the direction: a far-wall taper pushes the key's tips
         * inward from both pockets at once. The key cannot move — so the
         * reaction drives the two PIECES APART, opening the seam it exists to
         * close, by up to the taper itself. The bowtie's flanks are the only
         * surfaces whose tightening pulls the seam SHUT: squeeze them and the
         * key rides shallower, and both pieces come toward it, 2.25 mm of
         * closure per mm of flank interference at this flare.
         *
         * So: the flanks close by `seatGripMm` per side over `gripRiseMm`, and
         * then HOLD THAT CLEARANCE, unchanged, for the last `seatLandMm` of
         * travel. The key wedges progressively as it rises, arrives at a
         * defined light interference, and covers the final stretch at constant
         * section — sliding friction, no wedge — so it can be pushed until the
         * ceiling stops it. Grip and register end up on different axes, which
         * is the only way to have both.
         *
         * 0.03/side is the same order as the hex joint's proven 0.02-0.04, on
         * 4.6 mm of land per flank per pocket. The far wall does not move at
         * all — see bowtiePocketPlan's separate depthClearance.
         */
        seatGripMm: 0.03,
        gripRiseMm: 4,
        seatLandMm: 1.5,
        // The detent is off: the taper does its job and does it better. It was
        // a step, and a step is what stopped the first printed keys dead.
        // The pocket is drawn 0.2 mm/side clear of the key, but a printed slot
        // comes out ~0.16 mm/side narrow, so the plain throat is ALREADY at
        // zero clearance — the detent then added 0.35 on top, 0.82 mm of
        // interference across a 16 mm neck, against a rib far too stiff to
        // flex. 0.15 leaves a catch you can feel without one you cannot pass.
        detentProud: 0,
        detentTall: 1.5,
        // ...and it is a RAMP now, not a step. A square ledge presents the key
        // with a wall to shear through; over 0.8 mm of rise the same ledge is
        // a wedge the key rides up, and it prints as four 0.04 mm steps
        // instead of one 0.35 mm overhang.
        detentRamp: 0.8
    },
    // Engraved part codes, cut into the CHANNEL face of a rail — inside,
    // vertical, and not a surface anything depends on (see engraveOps).
    // minFeature IS the pen width of the stroke font in engrave.js, so no part
    // of a letter can come out thinner: 0.5 mm is a groove a 0.4 nozzle cuts
    // cleanly, and depth 0.5 is under a third of the 1.6 mm wall, leaving
    // three perimeters and never reaching the outside face.
    //
    // marginMm is 14 and not 6 because the start platform's bumper fills the
    // channel from 2 to 10 mm in: at 6 the first glyph landed INSIDE it and
    // came out as a sealed void — invisible, and a second shell in a part that
    // must be one solid.
    engrave: { depth: 0.5, capHeight: 3.5, minFeature: 0.5, marginMm: 14 },
    liftSpeedMmS: 110
};

const rot2 = (x, z, a) => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];

export function degToRad(d) { return d * Math.PI / 180; }
export function radToDeg(r) { return r * 180 / Math.PI; }

export function effectiveRidgePitch(length, nominalPitch) {
    const n = Math.max(1, Math.round(length / nominalPitch));
    return { pitch: length / n, count: n };
}

export function ridgeOffset(s, pitch, height) {
    return (height / 2) * (1 - Math.cos((2 * Math.PI * s) / pitch));
}

// ---------------------------------------------------------------------------
// Tree helpers (pure editing API used by the app)
// ---------------------------------------------------------------------------

export const SIMPLE_TYPES = ['straight', 'curveL', 'curveR', 'lift', 'elevator', 'powered'];
export const isSwitchNode = (n) => typeof n === 'object' && n !== null && (n.type === 'switchL' || n.type === 'switchR');

/**
 * EVERY SEGMENT TOKEN A SEQUENCE MAY CONTAIN. `switchL`/`switchR` are not here
 * because they are switch NODES, not segments — see isSwitchNode.
 *
 * This exists because `makePiece` dispatches on the token with a final `else`
 * that means "curve", so ANY unrecognised string became a curve, silently and
 * with no issue raised: a scene asking for `platform` got a 225.6 mm curve
 * carrying the previous piece's drop, and looked plausible on screen. A typo in
 * a scene file should say so, not quietly build something else.
 *
 * `switchMain`/`switchBranch` are internal — `walk` synthesises them for a
 * switch's two role pieces and they never appear in a sequence.
 */
export const SEGMENT_TYPES = Object.freeze([
    'start', 'end', 'straight', 'curveL', 'curveR', 'lift', 'powered', 'elevator'
]);

/** Is this node something `layoutTrack` can actually build? */
export const isKnownNode = (n) => isSwitchNode(n) ||
    SEGMENT_TYPES.includes(typeof n === 'string' ? n : (n && n.type));

/** Array a `containerPath` refers to: [] = root; [i,'main',...] descends switches. */
export function getContainer(sequence, containerPath) {
    let arr = sequence;
    for (let k = 0; k < containerPath.length; k += 2) {
        const node = arr[containerPath[k]];
        if (!isSwitchNode(node)) throw new Error(`bad container path at ${containerPath[k]}`);
        arr = node[containerPath[k + 1]];
    }
    return arr;
}

/** Node addressed by [...containerPath, index]. */
export function nodeAt(sequence, address) {
    const arr = getContainer(sequence, address.slice(0, -1));
    return arr[address[address.length - 1]];
}

export const pathKey = (p) => JSON.stringify(p);

/**
 * All open build ends: containers that do not terminate in a switch.
 * (A container ending in a switch builds through the switch's branches.)
 */
export function openContainers(sequence) {
    const out = [];
    const visit = (arr, path) => {
        const last = arr[arr.length - 1];
        if (isSwitchNode(last)) {
            visit(last.main, [...path, arr.length - 1, 'main']);
            visit(last.branch, [...path, arr.length - 1, 'branch']);
        } else {
            out.push(path);
        }
        arr.forEach((n, i) => {
            if (isSwitchNode(n) && i < arr.length - 1) {
                // defensive: mid-array switches shouldn't exist, but don't lose them
                visit(n.main, [...path, i, 'main']);
                visit(n.branch, [...path, i, 'branch']);
            }
        });
    };
    visit(sequence, []);
    return out;
}

/** Appends a full 360° spiral tier (4 quarter-turns) to a node array. */
export function appendSpiralTier(sequence, direction = 'L') {
    const t = direction === 'L' ? 'curveL' : 'curveR';
    return [...sequence, t, t, t, t];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function segmentPlan(kind, entry, params) {
    const { x, z, h } = entry;
    const dir = [Math.cos(h), Math.sin(h)];
    if (kind === 'straightish') {
        const len = params.len;
        return { planLen: len, exit: { x: x + dir[0] * len, z: z + dir[1] * len, h }, radius: null, center: null, turn: 0 };
    }
    // curve: params.turnSign ±1, radius R
    const R = params.radius;
    const turn = params.turnSign * Math.PI / 2;
    const [nx, nz] = rot2(dir[0], dir[1], Math.sign(turn) * Math.PI / 2);
    const center = [x + nx * R, z + nz * R];
    const [rx, rz] = rot2(x - center[0], z - center[1], turn);
    return {
        planLen: (Math.PI / 2) * R,
        exit: { x: center[0] + rx, z: center[1] + rz, h: h + turn },
        radius: R, center, turn
    };
}

/**
 * Lays out the full track tree. Returns flat `pieces` in depth-first order
 * (main before branch) with tree metadata:
 *   piece.address     — [...containerPath, index] of the source node
 *   piece.role        — 'main' | 'branch' for the two exits of a switch node
 *   piece.switchKey   — shared by a switch's two role pieces
 *   piece.active      — lies on the ride path given current gate settings
 *   piece.isLift      — powered ascending section
 * Plus `openEnds` (arrow targets), `switches` (gate toggles), `issues`.
 */
export function layoutTrack(sequence, params = {}) {
    const p = {
        slopeDeg: STANDARD.slopeDeg,
        innerWidth: STANDARD.innerWidth,
        curveWidenMm: SPEC.curveWidenMm,
        curveRadius: STANDARD.curveRadius,
        tileLen: SPEC.tileLen,
        platformLen: SPEC.platformLen,
        waterfall: SPEC.waterfallStepMm,
        skirtDepth: SPEC.skirtDepth,
        ridgeHeight: SPEC.ridge.height,
        ridgePitch: SPEC.ridge.pitch,
        skirtStyle: SPEC.skirt.style,
        ...params
    };

    const issues = [];
    if (p.slopeDeg < SPEC.slope.hardMin || p.slopeDeg > SPEC.slope.hardMax) {
        issues.push({ level: 'error', code: 'slope-out-of-range', msg: `Slope ${p.slopeDeg}° is outside the ${SPEC.slope.hardMin}–${SPEC.slope.hardMax}° operating window.` });
    } else if (p.slopeDeg < SPEC.slope.greenMin || p.slopeDeg > SPEC.slope.greenMax) {
        issues.push({ level: 'warn', code: 'slope-marginal', msg: `Slope ${p.slopeDeg}° works but the sweet spot is ${SPEC.slope.greenMin}–${SPEC.slope.greenMax}°.` });
    }
    if (p.curveRadius < SPEC.minCurveRadius) {
        issues.push({ level: 'error', code: 'radius-too-tight', msg: `Curve radius ${p.curveRadius} mm is below the ${SPEC.minCurveRadius} mm minimum — a rigid figure will wedge across the channel.` });
    }

    const tanSlope = Math.tan(degToRad(p.slopeDeg));
    // powered lifts climb a hair steeper so a lift tile NETS exactly one
    // 30 mm grid step after its waterfall seam (standard mode only)
    const liftSlopeDeg = p.liftSlopeDeg ?? (isStandardParams(p) ? STANDARD.liftSlopeDeg : p.slopeDeg);
    const tanLift = Math.tan(degToRad(liftSlopeDeg));
    const pieces = [];
    const openEnds = [];
    const switches = [];
    let pieceCounter = 0;

    const makePiece = (kind, node, cursor, entryDeck, meta, hasEntrySeam = true) => {
        let plan, drop, slopeDeg, isLift = false, innerWidth = p.innerWidth;
        if (kind === 'start' || kind === 'end') {
            plan = segmentPlan('straightish', cursor, { len: p.platformLen });
            drop = 0; slopeDeg = 0;
        } else if (kind === 'straight' || kind === 'switchMain') {
            plan = segmentPlan('straightish', cursor, { len: p.tileLen });
            drop = plan.planLen * tanSlope; slopeDeg = p.slopeDeg;
        } else if (kind === 'lift') {
            plan = segmentPlan('straightish', cursor, { len: p.tileLen });
            drop = -plan.planLen * tanLift; slopeDeg = -liftSlopeDeg; isLift = true;
        } else if (kind === 'elevator') {
            const height = node && typeof node === 'object' ? (node.height ?? 90) : 90;
            plan = segmentPlan('straightish', cursor, { len: p.tileLen });
            drop = -(height + p.waterfall);
            slopeDeg = -radToDeg(Math.asin(Math.min(0.99, height / p.tileLen)));
            isLift = true;
        } else if (kind === 'powered') {
            plan = segmentPlan('straightish', cursor, { len: p.tileLen });
            drop = 0; slopeDeg = 0; isLift = true;
        } else { // curveL / curveR / switchBranch
            const sign = (kind === 'curveL' || meta.switchType === 'switchL') ? 1 : -1;
            plan = segmentPlan('curve', cursor, { radius: p.curveRadius, turnSign: sign });
            drop = plan.planLen * tanSlope; slopeDeg = p.slopeDeg;
            innerWidth = p.innerWidth + p.curveWidenMm;
        }
        const exitDeck = entryDeck - drop;
        // Rim anchors to the GRID BOUNDARY at the piece's low end (exit
        // boundary when descending; the uphill seam boundary for lifts and
        // platforms). Keeps every support height on one grid family — the
        // skirt is 11.75 mm instead of 12 on climbing/flat pieces.
        const lowBoundary = drop > 0 ? exitDeck : entryDeck + (hasEntrySeam ? p.waterfall : 0);
        const ridge = effectiveRidgePitch(plan.planLen, p.ridgePitch);
        const piece = {
            type: kind, index: pieceCounter++,
            name: `${String(pieceCounter - 1).padStart(2, '0')}_${kind}`,
            entry: { ...cursor }, exit: { ...plan.exit },
            planLen: plan.planLen, radius: plan.radius, center: plan.center, turn: plan.turn,
            slopeDeg, drop, entryDeck, exitDeck,
            rimY: lowBoundary - p.skirtDepth,
            innerWidth, isLift,
            isElevator: kind === 'elevator',
            ridgePitch: ridge.pitch, ridgeCount: ridge.count,
            skirtStyle: p.skirtStyle ?? SPEC.skirt.style,
            ...meta
        };
        pieces.push(piece);
        return piece;
    };

    /** Walks a node array; returns the final {cursor, deck} for linear chains (null after a switch). */
    const walk = (nodes, prevExit, containerPath, active, capEnd = true) => {
        let cursor = prevExit.cursor;
        let deck = prevExit.deck;
        // uphill neighbour, threaded through so seam widths can be resolved
        // later. Matching seams by coincident endpoints does not work: a full
        // spiral tier lands back over its own start, so every tier's first
        // curve looks like a neighbour of every other tier's last one.
        let prev = prevExit.piece ?? null;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const address = [...containerPath, i];
            const entryDeck = deck - p.waterfall;
            if (isSwitchNode(node)) {
                const gate = node.gate === 'branch' ? 'branch' : 'main';
                const switchKey = pathKey(address);
                const main = makePiece('switchMain', node, cursor, entryDeck,
                    { address, role: 'main', switchKey, switchType: node.type, active: active && gate === 'main', gateOpen: gate === 'main' });
                const branch = makePiece('switchBranch', node, cursor, entryDeck,
                    { address, role: 'branch', switchKey, switchType: node.type, active: active && gate === 'branch', gateOpen: gate === 'branch' });
                // the two route shells are printed as ONE part — share the lower
                // rim plane so the merged solid sits flat on the build plate
                const sharedRim = Math.min(main.rimY, branch.rimY);
                main.rimY = sharedRim;
                branch.rimY = sharedRim;
                switches.push({ address, key: switchKey, gate, entry: { ...cursor }, deck: entryDeck, type: node.type });
                if (i < nodes.length - 1) {
                    issues.push({ level: 'error', code: 'switch-not-last', msg: 'A switch must be the last piece of its branch — pieces after it are unreachable.' });
                }
                main.prevIndex = prev ? prev.index : null;
                branch.prevIndex = prev ? prev.index : null;
                walk(node.main ?? [], { cursor: main.exit, deck: main.exitDeck, piece: main }, [...address, 'main'], active && gate === 'main');
                walk(node.branch ?? [], { cursor: branch.exit, deck: branch.exitDeck, piece: branch }, [...address, 'branch'], active && gate === 'branch');
                return null;
            }
            const kind = typeof node === 'string' ? node : node.type;
            // UNKNOWN TOKEN: report it and build NOTHING. Falling through would
            // hand `makePiece` a kind its final `else` reads as a curve.
            if (!SEGMENT_TYPES.includes(kind)) {
                issues.push({ level: 'error', code: 'unknown-piece',
                    msg: `"${kind}" is not a piece type. Use one of: ${SEGMENT_TYPES.join(', ')}, or a switch node.` });
                continue;
            }
            const piece = makePiece(kind, node, cursor, entryDeck, { address, active });
            piece.prevIndex = prev ? prev.index : null;
            prev = piece;
            cursor = piece.exit;
            deck = piece.exitDeck;
        }
        if (capEnd) {
            // leaf: implicit end platform + an open build end just before it
            openEnds.push({ containerPath, cursor: { ...cursor }, deck });
            const cap = makePiece('end', 'end', cursor, deck - p.waterfall, { address: [...containerPath, nodes.length], active, isImplicitEnd: true });
            cap.prevIndex = prev ? prev.index : null;
            prev = cap;
        }
        return { cursor, deck, piece: prev };
    };

    // IMPLICIT TOPOLOGY: a design is a circuit because its geometry closes,
    // not because a mode said so. Trial-walk the root chain from the origin;
    // if the tail lands back on the head (pose + a legal waterfall step-down)
    // the design IS a circuit: no platforms, ride wraps. Otherwise it's an
    // open run and every leaf gets its corral.
    let isCircuit = false;
    const rootHasSwitch = sequence.some(isSwitchNode);
    if (sequence.length && !rootHasSwitch) {
        const probePieces = [];
        const probeCounter = { n: 0 };
        // cheap pose-only probe using the same segment math
        let cur = { x: 0, z: 0, h: 0 };
        let deck = 0;
        const tanL = tanLift;
        for (const node of sequence) {
            const kind = typeof node === 'string' ? node : node.type;
            if (!SEGMENT_TYPES.includes(kind)) continue;   // reported in walk()
            let plan, drop;
            if (kind === 'straight' || kind === 'lift' || kind === 'elevator' || kind === 'powered') {
                plan = segmentPlan('straightish', cur, { len: p.tileLen });
                if (kind === 'elevator') {
                    const height = typeof node === 'object' ? (node.height ?? 90) : 90;
                    drop = -(height + p.waterfall);
                } else if (kind === 'lift') {
                    drop = -plan.planLen * tanL;
                } else if (kind === 'powered') {
                    drop = 0;
                } else {
                    drop = plan.planLen * tanSlope;
                }
            } else {
                plan = segmentPlan('curve', cur, { radius: p.curveRadius, turnSign: kind === 'curveL' ? 1 : -1 });
                drop = plan.planLen * tanSlope;
            }
            deck = (deck - p.waterfall) - drop;
            cur = plan.exit;
        }
        const dh = Math.abs(((cur.h % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
        const stepDown = deck - (-p.waterfall); // tail exit vs head entry (0 − wf)
        isCircuit = Math.hypot(cur.x, cur.z) <= 5 && dh <= 0.04
            && stepDown >= p.waterfall - 0.05 && stepDown <= 3;

        if (!isCircuit && Math.hypot(cur.x, cur.z) <= 160) {
            let msg = 'Loop is close but cannot close: ';
            const details = [];
            const dhDeg = dh * 180 / Math.PI;
            if (dh > 0.04) {
                details.push(`heading mismatch of ${Math.round(dhDeg)}°`);
            }
            if (stepDown < p.waterfall - 0.05 || stepDown > 3) {
                const diff = stepDown - p.waterfall;
                if (diff < 0) {
                    details.push(`height is too low by ${Math.abs(diff).toFixed(1)} mm`);
                } else {
                    details.push(`height is too high by ${diff.toFixed(1)} mm`);
                }
            }
            if (details.length > 0) {
                msg += details.join(' and ') + '.';
                issues.push({ level: 'warn', code: 'circuit-mismatch', msg });
            }
        }
    }

    if (isCircuit) {
        const tail = walk(sequence, { cursor: { x: 0, z: 0, h: 0 }, deck: 0 }, [], true, false);
        // the ring closes onto its own head, so that is a seam like any other
        if (tail && tail.piece && pieces.length) pieces[0].prevIndex = tail.piece.index;
    } else {
        const start = makePiece('start', 'start', { x: 0, z: 0, h: 0 }, 0, { address: [-1], active: true, isImplicitStart: true }, false);
        walk(sequence, { cursor: start.exit, deck: start.exitDeck, piece: start }, [], true);
        if (sequence.length && !rootHasSwitch) {
            // the ring's head is buildable: activating this end PREPENDS
            openEnds.push({ containerPath: 'head', cursor: { x: 0, z: 0, h: Math.PI }, deck: 0 });
        }
    }

    // ground shift: lowest skirt rim rests on the ground
    const minRim = Math.min(...pieces.map(pc => pc.rimY));
    for (const pc of pieces) {
        pc.entryDeck -= minRim;
        pc.exitDeck -= minRim;
        pc.rimY -= minRim;
    }
    for (const sw of switches) sw.deck -= minRim;
    for (const oe of openEnds) oe.deck -= minRim;

    resolveSeamWidths(pieces);

    const active = pieces.filter(pc => pc.active);
    const totalDropMm = active.length ? active[0].entryDeck - active[active.length - 1].exitDeck : 0;
    issues.push(...checkClearances(pieces, p));
    issues.push(...checkStrandedEnds(pieces, p));
    return { pieces, issues, totalDropMm, params: p, openEnds, switches, isCircuit };
}

/**
 * A leg that can never reach the ground.
 *
 * Running tiles drop in whole grid units and only two sizes exist: 2 units
 * for a straight or a lift, 3 for a curve. Any remaining height is therefore
 * reachable as 2a + 3b — EXCEPT one. From exactly one grid unit up, there is
 * no combination at all: the smallest drop available is two units, which puts
 * the next seam below the ground.
 *
 * So a run that lands on 15 mm is stranded. It is legal, it sits on a foot,
 * and it can never be brought down — the fix is always upstream, swapping a
 * straight (2) for a curve (3) somewhere earlier so the parity changes. This
 * is what a Y with straights down one leg and a curve down the other runs
 * into: one side reaches the ground and the other stops one unit short.
 */
function checkStrandedEnds(pieces, p) {
    const out = [];
    const G = STANDARD.gridMm;
    for (const pc of pieces) {
        if (pc.type !== 'end') continue;
        const units = Math.round(pc.rimY / G);
        if (Math.abs(pc.rimY - units * G) > 0.1 || units !== 1) continue;
        out.push({
            level: 'warn',
            code: 'stranded-end',
            msg: `${pc.name} finishes ${G} mm up and cannot come down: tiles drop 2 grid ` +
                 `units (straight, lift) or 3 (curve), so from one unit the smallest step ` +
                 `available goes underground. Swap a straight for a curve earlier in this ` +
                 `leg — that changes the parity and lands it flat.`
        });
    }
    return out;
}

/**
 * Distance over which a piece blends between its seam width and its body
 * width. 30 mm puts the wall at ~3° off the centreline for the 1.5 mm/side
 * curve widening — nothing to a printer, and nothing a hoof can catch.
 */
export const SEAM_TAPER_MM = 30;

/**
 * Gives every piece an `entryWidth` and `exitWidth`: the channel width at each
 * mating face, which is the WIDER of the two pieces meeting there.
 *
 * AT THE STANDARD THIS IS A NO-OP. `curveWidenMm` is 0, so every piece is the
 * same width and every face already agrees — which is exactly what makes each
 * piece type a single shape. It earns its place only when a custom build asks
 * for a widened turn, and then the direction matters:
 *
 * A widened curve butted against a straight leaves a ledge per side, and
 * downhill of a curve that ledge faces the figure square-on where it is still
 * riding wide off the turn — a hoof-catcher, not a cosmetic step. Matching the
 * faces removes it. Matching them on the WIDER width rather than the narrower
 * is what keeps the curve one shape: the widened value is the maximum any seam
 * can reach, so every curve face takes it whatever it neighbours, and the
 * flare lands on the straights instead. Measured, when the widening was still
 * 3 mm: taking the narrower width left 1.87 mm of side-to-side play at the
 * tightest station of a helix against 2.79 for the wider one, because a
 * footprint is 47.5 mm long and half of it is already round the corner at a
 * curve mouth.
 *
 * Faces are resolved once for everything that meets on them, not pairwise: a
 * switch puts THREE pieces on one mouth (the feeder and both roles), and
 * deciding it pairwise would hand the straight role one width while the feeder
 * and the curve role took another — a step in the middle of what prints as one
 * solid.
 */
function resolveSeamWidths(pieces) {
    const byIndex = new Map(pieces.map(pc => [pc.index, pc]));
    for (const pc of pieces) {
        pc.entryWidth = pc.innerWidth;
        pc.exitWidth = pc.innerWidth;
    }
    const faceWidth = new Map();
    for (const pc of pieces) {
        const prev = pc.prevIndex == null ? null : byIndex.get(pc.prevIndex);
        if (!prev) continue;
        faceWidth.set(prev.index, Math.max(faceWidth.get(prev.index) ?? prev.innerWidth, pc.innerWidth));
    }
    for (const pc of pieces) {
        const prev = pc.prevIndex == null ? null : byIndex.get(pc.prevIndex);
        if (!prev) continue;
        const w = faceWidth.get(prev.index);
        pc.entryWidth = Math.max(pc.entryWidth, w);
        prev.exitWidth = Math.max(prev.exitWidth, w);
    }
}

/**
 * Channel width at arc length s. Smoothstep rather than a straight ramp: its
 * slope is zero at both ends, so the wall leaves the mating face exactly
 * parallel to the neighbour's and there is no crease where the taper stops.
 *
 * Written as body-width plus a decaying deviation per face, which is what lets
 * a face be WIDER than the body: a straight that hands off to a curve carries
 * the curve's width at that face and relaxes back to 48 inside itself. The old
 * min-of-two-blends form silently clamped any such face back to the body.
 * For faces narrower than the body and a piece at least two tapers long — every
 * piece this project builds — the two forms agree exactly.
 */
export function innerWidthAt(piece, s) {
    const body = piece.innerWidth;
    const e = piece.entryWidth ?? body, x = piece.exitWidth ?? body;
    if (e === body && x === body) return body;
    const blend = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };
    const w = body
        + (e - body) * (1 - blend(s / SEAM_TAPER_MM))
        + (x - body) * (1 - blend((piece.planLen - s) / SEAM_TAPER_MM));
    // a short piece could otherwise let two overlapping tapers add up past
    // either face; the channel never leaves the envelope its own faces set
    return Math.min(Math.max(w, Math.min(body, e, x)), Math.max(body, e, x));
}

/**
 * The linear piece list the figure actually rides, following current gate
 * settings. Depth-first emission order + active flags make this a filter.
 */
export function resolveRidePath(pieces) {
    return pieces.filter(pc => pc.active);
}

export function deckYAt(piece, s) {
    if (piece.type === 'elevator' || piece.isElevator) {
        const L = piece.planLen;
        const h = -piece.drop;
        if (s < 40) return piece.entryDeck;
        if (s > L - 40) return piece.exitDeck;
        const t = (s - 40) / (L - 80);
        return piece.entryDeck + t * h;
    }
    const f = piece.planLen === 0 ? 0 : s / piece.planLen;
    return piece.entryDeck - piece.drop * f;
}

export function planPosAt(piece, s) {
    if (!piece.radius) {
        const dir = [Math.cos(piece.entry.h), Math.sin(piece.entry.h)];
        return { x: piece.entry.x + dir[0] * s, z: piece.entry.z + dir[1] * s, h: piece.entry.h };
    }
    const a = (s / piece.planLen) * piece.turn;
    const [rx, rz] = rot2(piece.entry.x - piece.center[0], piece.entry.z - piece.center[1], a);
    return { x: piece.center[0] + rx, z: piece.center[1] + rz, h: piece.entry.h + a };
}

/**
 * The rigid transform that takes a piece into its OWN frame: entry at the
 * origin, entry heading along +X, rim at Y=0.
 *
 * Pieces carry world coordinates because the scene needs them — a piece has to
 * know where it sits in the tower to be drawn there. The export builders were
 * written against the same objects and inherited that, so a curve high in a
 * spiral ran its CSG at x≈400, y≈135 and then recentred the finished mesh.
 *
 * Doing the booleans out there costs float precision, and the cost is visible:
 * the SAME curve exported from rimY 30, 60 and 135 came out with 14072, 13986
 * and 14094 triangles and volumes a millimetre cubed apart. That makes an
 * exported part depend on its address in the tower, which is wrong on its own
 * terms — two identical pieces should be one file — and it made a slicer
 * warning appear on some copies and not others.
 */
export function pieceFrame(piece) {
    return { x: piece.entry.x, z: piece.entry.z, h: piece.entry.h, y: piece.rimY };
}

const inPlane = (x, z, f) => {
    const c = Math.cos(f.h), s = Math.sin(f.h);
    return { x: (x - f.x) * c + (z - f.z) * s, z: -(x - f.x) * s + (z - f.z) * c };
};

/**
 * A copy of `piece` expressed in `frame`. Rotation about the vertical only, so
 * it is a PROPER rigid motion — chiral parts (left vs right curves, the bowtie
 * flare) are never mirrored.
 *
 * Pass a frame explicitly when several pieces must land together: the two
 * halves of a switch are merged into one solid and have to share one frame.
 */
export function pieceInFrame(piece, frame = pieceFrame(piece)) {
    const out = { ...piece };
    out.entry = { ...inPlane(piece.entry.x, piece.entry.z, frame), h: piece.entry.h - frame.h };
    out.exit = { ...inPlane(piece.exit.x, piece.exit.z, frame), h: piece.exit.h - frame.h };
    if (piece.center) {
        const c = inPlane(piece.center[0], piece.center[1], frame);
        out.center = [c.x, c.z];
    }
    out.entryDeck = piece.entryDeck - frame.y;
    out.exitDeck = piece.exitDeck - frame.y;
    out.rimY = piece.rimY - frame.y;
    return out;
}

/** The matching move for a support station, whose x/z/h place the boss. */
export function supportInFrame(support, frame) {
    if (!support) return support;
    return { ...support, ...inPlane(support.x, support.z, frame), h: support.h - frame.h };
}

export function stationsForPiece(piece, maxStep = 8, extra = []) {
    const n = Math.max(2, Math.ceil(piece.planLen / maxStep) + 1);
    const cuts = [];
    for (let i = 0; i < n; i++) cuts.push((piece.planLen * i) / (n - 1));
    // `extra` lets the arcade ask for stations where IT needs them. The sweep
    // samples the rim uniformly along the track, which is the wrong variable
    // for an arch: near the springing the curve is vertical, so one 6 mm step
    // can jump 17 mm in height and the opening comes out visibly faceted.
    for (const s of extra) if (s > 0.01 && s < piece.planLen - 0.01) cuts.push(s);
    cuts.sort((a, b) => a - b);

    const stations = [];
    for (const s of cuts) {
        if (stations.length && s - stations[stations.length - 1].s < 1e-6) continue;
        const { x, z, h } = planPosAt(piece, s);
        stations.push({
            s,
            origin: [x, deckYAt(piece, s), z],
            right: [Math.sin(h), 0, -Math.cos(h)] // zero-bank rule
        });
    }
    return stations;
}

/** Dense centerline samples for simulation — expects a LINEAR piece list. */
export function samplePath(pieces, step = 5) {
    const samples = [];
    let total = 0;
    for (let i = 0; i < pieces.length; i++) {
        const pc = pieces[i];
        const n = Math.max(2, Math.ceil(pc.planLen / step) + 1);
        for (let k = 0; k < n - (i < pieces.length - 1 ? 1 : 0); k++) {
            const s = (pc.planLen * k) / (n - 1);
            const { x, z, h } = planPosAt(pc, s);
            samples.push({
                x, z, h,
                y: deckYAt(pc, s),
                slopeDeg: pc.slopeDeg,
                pieceIndex: i,
                dist: total + s
            });
        }
        total += pc.planLen;
    }
    return samples;
}

/**
 * Collision-aware support planning. A pillar under each piece's midpoint spears
 * straight through the tier below on stacked spirals, so every support column
 * is checked against all pieces beneath it:
 *  - 'center': the boss at mid-piece and the column straight down from it
 *  - 'jog': the column moved sideways by a JOG (SPEC.jog) plugged into that
 *    same mid socket. The socket is hex, so the jog can point in six
 *    directions and the planner tries each.
 *  - 'none': no clear column exists — reported so the UI can warn
 *
 * The boss NEVER moves: every piece has one socket at mid-piece and is the same
 * solid as every other piece of its type. That is the whole point — the
 * previous version nudged the boss along the track and grew an outrigger arm
 * when that failed, which made six extra track parts out of a problem that
 * belongs to the support, not the track.
 *
 * @returns Array<{ pieceIndex, mode, x, z, h, s, rot? }>
 */
export function planPillarPositions(pieces, params = {}) {
    const outerHalfOf = (pc) => pc.innerWidth / 2 + SPEC.wall;
    const clearR = SPEC.socket.pillarR + 2;
    const armOffsetOf = (pc) => outerHalfOf(pc) + SPEC.socket.bossR + 4;

    const samples = pieces.map(pc => {
        const n = Math.max(2, Math.ceil(pc.planLen / 20) + 1);
        const pts = [];
        for (let k = 0; k < n; k++) {
            const s = (pc.planLen * k) / (n - 1);
            const pos = planPosAt(pc, s);
            pts.push([pos.x, deckYAt(pc, s), pos.z]);
        }
        return pts;
    });

    const columnBlocked = (x, z, topY, ignore) => {
        for (let j = 0; j < pieces.length; j++) {
            if (ignore.has(j)) continue;
            const q = pieces[j];
            const reach = outerHalfOf(q) + clearR;
            for (const pt of samples[j]) {
                if (pt[1] >= topY - 1) continue; // only geometry beneath obstructs
                const dx = x - pt[0], dz = z - pt[2];
                if (dx * dx + dz * dz < reach * reach) return true;
            }
        }
        return false;
    };

    const supports = [];
    for (const pc of pieces) {
        if (pc.role === 'branch') continue;   // merged with its main sibling
        // NB: grounded pieces (rimY ~ 0) are planned too. They used to be
        // skipped, which left them with no support record at all — and bossOps
        // reads a missing record as "build the default centre boss", so they
        // got a boss anyway while the part signature and the dimension labels
        // both reported them as unsupported. Every piece keeps its socket boss,
        // and decomposeSupport() returns null at zero height so no foot or
        // risers are emitted for them.
        const ignore = new Set(
            pc.switchKey
                ? pieces.filter(q => q.switchKey === pc.switchKey).map(q => q.index)
                : [pc.index]
        );
        const s = massCentreS(pc);          // under the weight, not the middle
        const pos = planPosAt(pc, s);
        let placed = null;
        if (!columnBlocked(pos.x, pos.z, pc.rimY, ignore)) {
            placed = { pieceIndex: pc.index, mode: 'center', x: pos.x, z: pos.z, h: pos.h, s };
        } else {
            // six hex orientations of the jog, nearest-to-outboard first so a
            // curve still tends to throw its column to the outside of the turn
            const outboard = pc.turn < 0 ? 1 : -1;
            const order = [1, -1, 2, -2, 3, 0].map(k => k * outboard);
            for (const k of order) {
                const a = pos.h + k * Math.PI / 3;
                const jx = pos.x + Math.cos(a) * SPEC.jog.armMm;
                const jz = pos.z + Math.sin(a) * SPEC.jog.armMm;
                if (!columnBlocked(jx, jz, pc.rimY, ignore)) {
                    placed = { pieceIndex: pc.index, mode: 'jog', x: jx, z: jz, h: pos.h, s, rot: k };
                    break;
                }
            }
        }
        supports.push(placed ?? { pieceIndex: pc.index, mode: 'none', x: pos.x, z: pos.z, h: pos.h, s });
    }
    return supports;
}

/**
 * Where along a piece its MASS actually is.
 *
 * The boss used to sit at mid arc-length, which is the middle of the piece
 * and not the middle of its weight. The rim is anchored at the piece's LOW
 * end, so the skirt is as deep as the drop at the top and only `skirtDepth`
 * at the bottom — 56.75 mm against 12 on a standard curve. The walls are
 * ~75% of the plastic, so mass per unit length falls off linearly and the
 * centroid sits at 39% of a curve and 41% of a straight, not 50%.
 *
 * A single pier under mid-length is therefore 25 mm downhill of the weight it
 * is carrying, and the piece tips UPHILL — toward the start, which is exactly
 * where they were falling. Moving the boss to the centroid costs nothing: it
 * is a constant per piece type, so a curve is still one shape.
 *
 * Centroid of a linear taper from h1 at s=0 to h2 at s=L:
 *     s_c = L (h1 + 2 h2) / (3 (h1 + h2))
 * which returns L/2 whenever h1 = h2, so platforms and powered tiles do not
 * move at all.
 *
 * What this does NOT fix is the LATERAL offset on a curve: the deck band's
 * centroid is ~10 mm inboard of the arc (the outer wall is longer, which
 * pulls some of it back), and the boss stays on the centreline. That is the
 * smaller of the two and moving it sideways would put the socket within
 * 2 mm of the inner skirt wall.
 */
export function massCentreS(piece) {
    const L = piece.planLen;
    const h1 = Math.max(0.1, piece.entryDeck - piece.rimY);
    const h2 = Math.max(0.1, piece.exitDeck - piece.rimY);
    return L * (h1 + 2 * h2) / (3 * (h1 + h2));
}

/** Where a jogged support's boss sits: at the piece's centre of mass. */
export function supportBossPos(piece, support) {
    const s = support?.s ?? massCentreS(piece);
    const p = planPosAt(piece, s);
    return { x: p.x, z: p.z, h: p.h, s };
}

/**
 * Is there room to take a minimal boss down to the underside plane?
 *
 * The collar's bottom IS that plane, so the level ledge the spacer seats on has
 * to sit above the plane everywhere under it. The plane is highest at the
 * collar's uphill edge, so D >= floorThk + socketDepth + grad·(rCorner +
 * collarR) — 15.21 at the standard slope. Below that the collar would protrude
 * past the plane and the piece laid down would balance on it.
 */
export function collarFits(piece, spec) {
    if (piece.skirtStyle !== 'minimal' || !(spec.socket?.collarR > 0)) return false;
    if (!(piece.planLen > 0)) return false;
    const s = massCentreS(piece);
    const seat = rawSeatY(piece, s, spec);
    // measured against the REAL plane, not `deck - D`. Those are the same
    // surface under a straight and 5.3 mm apart under a curve, where the plane
    // is fitted rather than held at constant depth — and a collar built to the
    // wrong one stops short and leaves the boss floating, which is exactly what
    // it did the first time a curve was laid down.
    return seat >= planeUnderCollar(piece, s, spec);
}

/**
 * THE UNDERSIDE OF A MINIMAL PIECE, AS ONE PLANE.
 *
 * A constant-depth underside — the deck held down by D — is a plane under a
 * straight and a HELICOID under a curve, measured 5.15 mm from its own
 * best-fit plane. That is why a straight can be laid on the bed and a curve
 * cannot. Cutting the underside as an actual plane makes them the same part
 * again, and a straight is unchanged by it: its constant-depth surface already
 * IS a plane, so the fit reproduces it with zero residual and one code path
 * serves both.
 *
 * FITTED TO THE TWO WALL BOTTOM LINES, because they are what has to touch the
 * bed, so they are what the fit should minimise against. (§3 of TODO recorded
 * 11.77° and ±4.74 from a different sample set; over the walls it is 11.53°
 * and ±5.46.)
 *
 * THE OFFSET IS SET BY THE SHALLOWEST POINT, NOT THE MEAN, and that is the
 * decision the whole thing turns on. Held at the mean, D = 14 leaves 8.5 mm at
 * the shallow corner — less than the key band it was chosen to clear — and
 * puts the boss at mean − 0.12, missing the depth its collar needs. Held at the
 * shallowest point, `minimalDepthMm` means what it says everywhere: min depth
 * is D by construction, the key's throat clears, and the boss sits 5.3 mm
 * deeper than it needs. It costs a curve about 6 cm³ of extra material, which
 * is what a part that lands on the plate is worth.
 *
 * Frame-dependent, so the cache key carries the frame: `archedRimY` is called
 * with world pieces (display) and framed ones (export).
 */
const planeCache = new Map();

export function undersidePlane(piece, spec = SPEC) {
    const D = spec.skirt?.minimalDepthMm ?? 15;
    // A SWITCH IS ONE SOLID AND SO NEEDS ONE PLANE. Its two halves are a
    // straight and a curve, which fit different planes; cut to their own, the
    // merged part has two undersides and cannot lie on either. `planeGroup`
    // hands both halves the same sample set, so one plane is fitted to the
    // whole footprint and both shells, both boss and every rib share it.
    const group = piece.planeGroup ?? [piece];
    const sig = (q) => [q.type, q.planLen, q.radius ?? 0, q.turn ?? 0, q.drop,
        q.entryDeck, q.innerWidth, q.entry.x, q.entry.z, q.entry.h].join(',');
    const key = group.map(sig).join(';') + `|${D}`;
    const hit = planeCache.get(key);
    if (hit) return hit;

    const pts = [];
    const N = 96;
    for (const q of group) {
        const Wo = q.innerWidth / 2 + spec.wall;
        for (let k = 0; k <= N; k++) {
            const s = (q.planLen * k) / N;
            const p = planPosAt(q, s), y = deckYAt(q, s);
            const r = [Math.sin(p.h), -Math.cos(p.h)];
            for (const u of [-Wo, Wo]) pts.push([p.x + r[0] * u, p.z + r[1] * u, y]);
        }
    }
    // least squares y = a x + b z + c
    let Sxx = 0, Sxz = 0, Szz = 0, Sx = 0, Sz = 0, S1 = 0, Sxy = 0, Szy = 0, Sy = 0;
    for (const [x, z, y] of pts) {
        Sxx += x * x; Sxz += x * z; Szz += z * z; Sx += x; Sz += z; S1++;
        Sxy += x * y; Szy += z * y; Sy += y;
    }
    const M = [[Sxx, Sxz, Sx], [Sxz, Szz, Sz], [Sx, Sz, S1]];
    const V = [Sxy, Szy, Sy];
    const A = M.map((row, i) => [...row, V[i]]);
    for (let i = 0; i < 3; i++) {
        let piv = i;
        for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
        [A[i], A[piv]] = [A[piv], A[i]];
        if (Math.abs(A[i][i]) < 1e-12) { A[i][i] = 1; A[i][3] = 0; continue; }
        for (let j = 0; j < 3; j++) {
            if (j === i) continue;
            const f = A[j][i] / A[i][i];
            for (let k2 = i; k2 < 4; k2++) A[j][k2] -= f * A[i][k2];
        }
    }
    let a = A[0][3] / A[0][0], b = A[1][3] / A[1][1], c = A[2][3] / A[2][2];
    // drop the plane until the SHALLOWEST point is exactly D under the deck
    let shallowest = Infinity;
    for (const [x, z, y] of pts) shallowest = Math.min(shallowest, y - (a * x + b * z + c));
    c += shallowest - D;

    const out = { a, b, c, at: (x, z) => a * x + b * z + c };
    if (planeCache.size > 512) planeCache.clear();
    planeCache.set(key, out);
    return out;
}

/**
 * Is this piece EXPORTED LYING ON ITS UNDERSIDE? One predicate, because three
 * things have to agree about it: the shell (whether to clamp the underside at
 * the rim), the boss (whether to build a collar), and the exporter (whether to
 * rotate). They disagreed once and the part balanced on its boss.
 *
 * A CURVE IS INCLUDED NOW. It used to be excluded because a constant-depth
 * underside under a curve is a HELICOID, 5.15 mm from its own best-fit plane,
 * and no rotation flattens it. `undersidePlane` cuts the underside AS a plane
 * instead, so there is nothing left to flatten and a curve lies down like a
 * straight. Platforms and powered tiles stay out: they are level already.
 */
/**
 * The one place that says what an unrecognised underside means.
 *
 * Nine sites used to spell this `x === 'minimal' ? 'minimal' : 'viaduct'`,
 * which silently hard-codes the default into every load path: the day the
 * default moved, a saved state with no `skirtStyle` would still have come back
 * viaduct. A style that IS named is always honoured — a scene saved as
 * `viaduct` is a different printed part and must reload as one — and only an
 * absent or unknown one falls through to the default.
 */
export function normaliseSkirtStyle(v, spec = SPEC) {
    return v === 'viaduct' || v === 'minimal' ? v : spec.skirt.style;
}

export function laysOnUnderside(piece, spec) {
    // An ELEVATOR never does. Its housing is a solid block from the rim up to
    // the deck, so its underside is that rim and not the plane — tilted, it
    // rested on a corner at 0 mm2 of contact. It keeps the rim, the rim boss
    // and a rim-down print, which is what the block wants anyway.
    if (piece.isElevator || piece.type === 'elevator') return false;
    return piece.skirtStyle === 'minimal'
        && piece.planLen > 0 && Math.abs(piece.drop ?? 0) > 1e-6
        && collarFits(piece, spec);
}

/**
 * Where the socket MOUTH is — the level face the support column bears on.
 *
 * On a `viaduct` piece it is the rim, because the boss is a column that runs
 * all the way down to it. On a `minimal` piece there is no rim under the boss:
 * the underside follows the deck, so the boss stops being a column and becomes
 * a recess, and the mouth lands wherever the deck happens to be. That is what
 * the spacer is for (see buildSpacerGeometry) — everything below the mouth is
 * the support's problem, not the track's.
 *
 * THE FLOOR SETS IT, NOT THE UNDERSIDE. The socket is a hex 10.39 mm across
 * corners and the deck falls 0.198 mm/mm, so its DOWNHILL CORNER is 1.03 mm
 * lower than its centre. Put the ceiling one floor thickness under the deck
 * at that corner and the mouth is 10 mm below that — full socket, full floor,
 * everywhere. Measured on the built mesh, a mouth placed at the underside
 * instead left 1.27-1.38 mm of walking surface over a flat blind hole.
 *
 * `minimalDepthMm` deliberately does not appear here. It used to, as an upper
 * bound, from the days when the boss carried its own pad down to the grid and
 * the mouth had to be ON the underside. The spacer carries the grid now, so
 * the two are independent — and they have to be, because the relationship
 * between them is what decides whether the piece can be laid on its underside
 * and printed. See `SPEC.skirt.minimalDepthMm`: at 12 the mouth sits 1.03
 * BELOW the underside and hangs 2.91 below the plane at the boss's uphill
 * edge; at 15 it sits 1.97 ABOVE it and the recess is a pocket, clear of the
 * bed. A platform pays nothing either way, grad being 0 — which is why the
 * same arithmetic has always worked for the viaduct boss.
 */
export function socketMouthY(piece, s = null, spec = SPEC) {
    // An elevator keeps the rim boss whatever the skirt style: its housing is
    // a solid block from the rim to the deck, so there is no sloping underside
    // for a recess to sit in and nothing to save by cutting one.
    // ONLY A PIECE THAT IS LAID ON ITS UNDERSIDE gets a recessed seat. A piece
    // printed rim-down needs its boss to reach the rim and stand on the bed
    // there, exactly as a viaduct boss does — recessing it on a rim-down piece
    // left the boss floating 26 mm up, and on a flat platform it built a collar
    // BELOW the rim, so the whole part balanced on a 114 mm² ring.
    if (!laysOnUnderside(piece, spec) || piece.isElevator || piece.type === 'elevator') {
        return piece.rimY;
    }
    const at = s ?? massCentreS(piece);
    const raw = Math.max(piece.rimY, rawSeatY(piece, at, spec));
    // AND THEN IT SNAPS DOWN ONTO THE GRID, if there is still room under it.
    // The seat cannot go UP — the floor over the socket is what sets it — but
    // it can be dropped to the grid line below by carrying more material under
    // the piece, which is what `minimalDepthMm` = 17 buys. A straight, a lift
    // and a switch all land exactly on a grid line that way and need no spacer
    // at all; a curve's nearest line is 11.2 mm down, which would cost it
    // another 11 mm of depth everywhere, so it keeps the one spacer left in
    // the library. Brett: "raise the bottom slightly to snap to whole units...
    // slightly more material under it, but it keeps it uniform with the others".
    const snapped = piece.rimY
        + Math.floor((raw - piece.rimY) / STANDARD.gridMm + 1e-9) * STANDARD.gridMm;
    return snapped >= planeUnderCollar(piece, at, spec) ? snapped : raw;
}

/** Where the floor lets the seat sit at the highest — before any snapping. */
function rawSeatY(piece, s, spec) {
    const f = piece.planLen ? s / piece.planLen : 0;
    const deck = piece.entryDeck - (piece.drop ?? 0) * f;
    const grad = piece.planLen ? Math.abs(piece.drop ?? 0) / piece.planLen : 0;
    const rCorner = spec.socket.hexAF / 2 / Math.cos(Math.PI / 6);
    return deck - spec.floorThk - grad * rCorner - spec.socket.depth;
}

/** The highest the underside plane reaches anywhere under the collar. */
function planeUnderCollar(piece, s, spec) {
    const pos = planPosAt(piece, s);
    const pl = undersidePlane(piece, spec);
    let hi = -Infinity;
    for (let k = 0; k < 16; k++) {
        const a = (2 * Math.PI * k) / 16;
        hi = Math.max(hi, pl.at(pos.x + Math.cos(a) * spec.socket.collarR,
            pos.z + Math.sin(a) * spec.socket.collarR));
    }
    return hi;
}

/**
 * Which spacer goes under a piece, or 0 for the pieces that take none.
 *
 * Platforms and powered tiles are FLAT, so their deck is exactly `skirtDepth`
 * above the rim and the mouth lands on the rim itself — they keep the viaduct
 * boss and need nothing. Everything that slopes takes one of the two.
 */

/**
 * The two spacers as PARTS: what to engrave on one and how many rings to turn
 * into it. The rings are the thing that survives a heap — 16.59 and 11.20 are
 * 5.4 mm apart, which nobody picks out by eye, and the taller one takes the
 * larger count so the two agree with each other.
 */
export const SPACER_VARIANTS = [
    { heightMm: SPEC.spacer.curveMm, rings: 1, code: 'SPC', fits: 'curves' }
];

/** The variant record for a height from spacerHeightMm, or null for none. */
export const spacerVariant = (heightMm) =>
    SPACER_VARIANTS.find(v => Math.abs(v.heightMm - heightMm) < 0.005) ?? null;

export function spacerHeightMm(piece) {
    if (!piece) return 0;
    // whatever the seat is off the grid by, and nothing else. Snapping put
    // straights, lifts and switches ON the grid, so they ask for none.
    const rise = socketMouthY(piece) - piece.rimY;
    const rest = rise - Math.floor(rise / STANDARD.gridMm + 1e-9) * STANDARD.gridMm;
    if (rest < 0.5) return 0;
    // and it is a PRINTED PART, so it is the variant's height and not the
    // remainder to six places. Anything that does not land on a variant is a
    // piece the library cannot support, and saying 0 would hide that.
    const v = SPACER_VARIANTS.find(x => Math.abs(x.heightMm - rest) < 0.05);
    return v ? v.heightMm : rest;
}

/**
 * Height the riser stack has to make up under a support record — from the
 * ground to the bottom of whatever plugs into the socket.
 *
 * Three things can stand between the ground and the mouth and each takes its
 * own bite: the riser stack, a jog where the column had to step aside, and a
 * spacer where the mouth is not on the grid. On a viaduct piece the last is
 * zero and the mouth IS the rim, so this is the expression it always was.
 */
export function stackHeightMm(piece, support) {
    return socketMouthY(piece, support?.s) - spacerHeightMm(piece)
        - (support?.mode === 'jog' ? SPEC.jog.heightMm : 0);
}

/** True for records that carry a real socket boss (i.e. not a blocked column). */
export const supportsPillar = (s) => !!s && (s.mode === 'center' || s.mode === 'jog');

/**
 * True when a piece actually needs something printed under its boss. A viaduct
 * piece sitting at ground level rests on its own skirt: it keeps the boss (so
 * the part stays interchangeable with airborne ones) but nothing goes under it.
 *
 * A GROUNDED MINIMAL PIECE IS NOT THAT CASE, and that is why this reads the
 * MOUTH rather than the rim. Its underside follows the deck, so `rimY` is
 * touched only at the exit boundary — a knife edge, not a skirt — and the
 * mouth is 16.6 mm (straight) or 26.2 mm (curve) up in the air. It stands on
 * its spacer like every other minimal piece; there is simply no riser stack
 * under it. See TODO §1, "the grounded case".
 */
export const needsPier = (piece) => !!piece && socketMouthY(piece) > 1;

/**
 * Spiral-tier / branch clearance check. Pieces that share an endpoint
 * (parent-child seams, switch siblings) are exempt; everything else that
 * overlaps in plan needs SPEC.clearanceHeight of vertical separation.
 */
export function checkClearances(pieces, params) {
    const issues = [];
    const outerW = (params.innerWidth ?? SPEC.innerWidth.default) + 2 * SPEC.wall
        + (params.curveWidenMm ?? SPEC.curveWidenMm);
    const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 2;
    const related = (a, b) =>
        near(a.exit, b.entry) || near(b.exit, a.entry) || near(a.entry, b.entry) || near(a.exit, b.exit);

    const sampled = pieces.map(pc => {
        const n = Math.max(2, Math.ceil(pc.planLen / 25) + 1);
        const pts = [];
        for (let k = 0; k < n; k++) {
            const s = (pc.planLen * k) / (n - 1);
            const pos = planPosAt(pc, s);
            pts.push([pos.x, deckYAt(pc, s), pos.z]);
        }
        return pts;
    });

    for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) {
            if (related(pieces[i], pieces[j])) continue;
            let clash = false;
            for (const a of sampled[i]) {
                for (const b of sampled[j]) {
                    const dx = a[0] - b[0], dz = a[2] - b[2];
                    if (dx * dx + dz * dz < outerW * outerW && Math.abs(a[1] - b[1]) < SPEC.clearanceHeight) {
                        clash = true; break;
                    }
                }
                if (clash) break;
            }
            if (clash) {
                issues.push({
                    level: 'error', code: 'clearance', i, j,
                    msg: `Pieces ${pieces[i].name} and ${pieces[j].name} overlap with less than ${SPEC.clearanceHeight} mm of vertical clearance — the figure will strike the tier above.`
                });
            }
        }
    }
    return issues;
}
