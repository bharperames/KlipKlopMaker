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
export const GEOMETRY_VERSION = '1.1.0';

export const STANDARD = {
    gridMm: 15,
    tileDropMm: 30,
    curveDropMm: 45,
    slopeDeg: Math.atan(29.75 / 150) * 180 / Math.PI,        // 11.2167°
    liftSlopeDeg: Math.atan(30.25 / 150) * 180 / Math.PI,    // 11.4045° (powered)
    curveRadius: (44.75 / (29.75 / 150)) / (Math.PI / 2),    // 143.637 mm
    innerWidth: 48,
    riserSizes: [120, 60, 30, 15],
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
         * The track's socket is cut slightly smaller than everything else's,
         * and this is PROVISIONAL — the measurement that would justify it
         * properly has not been taken.
         *
         * Two hypotheses have already died here. The first was that the track
         * socket prints oversize, since riser-into-riser is snug at the same
         * nominal and the same tenon is loose in the track: measured, it comes
         * out 8.95 against 9.00 drawn, slightly UNDER. The second was that it
         * prints oval, so a tenon would bear on the tight flat pair and rock
         * on the rest: measured across all three pairs, it reads 8.95 on every
         * one. The socket is round, true, and very slightly small.
         *
         * Which leaves the achieved clearance at 0.125-0.175 mm/side — not
         * obviously loose on paper — while the hand says it is. So either the
         * RISER socket is smaller than this one, or the difference is not a
         * size at all, and nobody has measured the riser socket yet.
         *
         * 0.1 AF is a hedge, not an answer: it takes the track joint to
         * 0.075-0.125 mm/side, tighter than measured and still assembling at
         * the tight end, without touching the riser-to-riser joint that
         * already works. One number settles it.
         */
        trackShrinkAF: 0.1
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
    // Bowtie connector key (print-flat butterfly key, Hot-Wheels-style separate
    // connector): pockets recess into full-height end ribs — zero overhangs.
    key: {
        neckHalf: 8, tipHalf: 12, depth: 9, height: 6, ribThk: 12,
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
        printComp: { neckMm: 0, tipMm: 0 },
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
         * THE GRIP IS FRONT TO BACK, UP A TAPER — not side to side.
         *
         * The flanks were being asked to do two jobs at once: wedge the seam
         * shut AND hold the key in. They cannot. The clearance that lets a key
         * slide 33 mm up a throat is the same clearance that lets it rattle,
         * and every measurement so far says the process moves more than the
         * window between those two.
         *
         * So the jobs are split. The flanks keep the wedging at an easy slide
         * fit, where clearance is harmless — they only bear when something
         * tries to pull the seam open. Retention comes from the pocket getting
         * `gripTaperMm` SHALLOWER over the last `gripRiseMm` of travel, so the
         * key wedges front-to-back as it rises.
         *
         * The point of a taper is that it does not have to hit a dimension. A
         * key that prints 0.1 mm over just stops 3 mm lower; one that prints
         * under goes 3 mm higher. At 0.3 mm over 10 mm it is 8x steeper than
         * the 0.15 mm of drift the slot shows over its whole 39 mm height, so
         * the grip is the thing doing the gripping and not a print artefact.
         *
         * It also moves the fit onto the axis this printer is actually good
         * at. Measured per side: Z +0.022 (the key is 5.645 tall against 5.60
         * drawn, 28 exact layers), XY flat faces +0.035, and the XY features
         * that were being asked to hold the joint — the concave waist and the
         * slot — +0.20 to +0.30. Z is an order of magnitude better controlled,
         * and a taper spends XY error as Z position, which is free. Variation becomes seat height instead of
         * rattle or jam, and there is 30 mm of throat to absorb it. That is
         * the compliance both the key's Monte Carlo and the hex socket's
         * 0.2 mm of ovality have been asking for.
         */
        gripTaperMm: 0.3,
        gripRiseMm: 10,
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
    return { pieces, issues, totalDropMm, params: p, openEnds, switches, isCircuit };
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
        const s = pc.planLen / 2;
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

/** Where a jogged support's boss sits: always mid-piece, never moved. */
export function supportBossPos(piece, support) {
    const s = support?.s ?? piece.planLen / 2;
    const p = planPosAt(piece, s);
    return { x: p.x, z: p.z, h: p.h, s };
}

/** Height the riser stack has to make up under a support record. */
export function stackHeightMm(piece, support) {
    return piece.rimY - (support?.mode === 'jog' ? SPEC.jog.heightMm : 0);
}

/** True for records that carry a real socket boss (i.e. not a blocked column). */
export const supportsPillar = (s) => !!s && (s.mode === 'center' || s.mode === 'jog');

/**
 * True when a piece actually needs a pier printed under its boss. A piece
 * sitting at ground level rests on its own skirt: it keeps the boss (so the
 * part stays interchangeable with airborne ones) but nothing goes under it.
 */
export const needsPier = (piece) => !!piece && piece.rimY > 1;

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
