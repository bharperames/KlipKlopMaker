/**
 * track.js
 * Pure track layout engine — no DOM or Three.js dependencies.
 *
 * A track is an ordered sequence of segment types. This module converts that
 * sequence into fully placed pieces (plan position, heading, deck elevations)
 * while enforcing the Klip-Klop physics rule set:
 *
 *  - Slope lock: every running segment descends at exactly the configured pitch
 *    (green zone 10-12 deg). Elevations are solved automatically ("Auto-Z").
 *  - Waterfall rule: each downhill piece's floor starts 0.25 mm LOWER than the
 *    uphill piece's exit, so a printed seam can never present an uphill lip.
 *  - Washboard phase: piece lengths snap the ridge pitch so seams always land
 *    in a ridge valley, never through a peak.
 *  - Zero bank: layout is pure plan-position + vertical elevation; the sweep
 *    basis vector stays horizontal so curves and spirals never roll inward.
 */

export const SPEC = {
    slope: { hardMin: 8, greenMin: 10, greenMax: 12, hardMax: 14, default: 11 },
    innerWidth: { min: 46, max: 50, default: 48 },
    curveWidenMm: 3,            // dynamic curve widening for rigid-body pivot room
    minCurveRadius: 120,
    defaultCurveRadius: 150,
    railHeight: 14,
    wall: 2.4,
    floorThk: 2.0,              // acoustic drumhead thickness under the ridges
    filletR: 2.0,               // floor-to-wall fillet that re-centers wandering hooves
    skirtDepth: 12,             // hollow chamber depth below the exit-end deck line
    ridge: { height: 0.6, pitch: 2.5 },
    waterfallStepMm: 0.25,      // downhill floor drop at every seam
    jointClearanceMm: 0.2,      // horizontal + vertical dovetail clearance
    tileLen: 150,
    platformLen: 150,
    clearanceHeight: 100,       // min vertical gap where track overlaps itself (spiral tiers)
    socket: { hexAF: 9, depth: 10, bossR: 9.5, pillarR: 7 }
};

const rot2 = (x, z, a) => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];

export function degToRad(d) { return d * Math.PI / 180; }
export function radToDeg(r) { return r * 180 / Math.PI; }

/**
 * Snaps the washboard ridge pitch so an integer number of ridge periods fits
 * exactly in `length`, guaranteeing both ends of the piece terminate in a valley.
 */
export function effectiveRidgePitch(length, nominalPitch) {
    const n = Math.max(1, Math.round(length / nominalPitch));
    return { pitch: length / n, count: n };
}

/**
 * Raised-cosine washboard profile: 0 at s=0, peaks at half-pitch, 0 at pitch.
 * Gentle sine ridges — hard square ridges would absorb the gait's kinetic energy.
 */
export function ridgeOffset(s, pitch, height) {
    return (height / 2) * (1 - Math.cos((2 * Math.PI * s) / pitch));
}

/** Per-type geometric footprint before elevation solving. */
function segmentPlan(type, entry, params) {
    const R = params.curveRadius;
    const { x, z, h } = entry;
    const dir = [Math.cos(h), Math.sin(h)];

    if (type === 'straight' || type === 'start' || type === 'end') {
        const len = type === 'straight' ? params.tileLen : params.platformLen;
        return {
            planLen: len,
            exit: { x: x + dir[0] * len, z: z + dir[1] * len, h },
            radius: null, center: null, turn: 0
        };
    }
    if (type === 'curveL' || type === 'curveR') {
        const turn = type === 'curveL' ? Math.PI / 2 : -Math.PI / 2;
        const side = Math.sign(turn);
        const [nx, nz] = rot2(dir[0], dir[1], side * Math.PI / 2); // toward curve center
        const center = [x + nx * R, z + nz * R];
        const exitH = h + turn;
        // rotate the entry point around the center by the turn angle
        const [rx, rz] = rot2(x - center[0], z - center[1], turn);
        return {
            planLen: (Math.PI / 2) * R,
            exit: { x: center[0] + rx, z: center[1] + rz, h: exitH },
            radius: R, center, turn
        };
    }
    throw new Error(`Unknown segment type: ${type}`);
}

/**
 * Lays out the full track: implicit start platform + user sequence + implicit
 * end platform. Solves elevations so the lowest skirt rim sits on the ground.
 *
 * @param {string[]} sequence - user segments: 'straight' | 'curveL' | 'curveR'
 * @param {object} params - { slopeDeg, innerWidth, curveRadius, tileLen, ... }
 * @returns {{ pieces: object[], issues: object[], totalDropMm: number }}
 */
export function layoutTrack(sequence, params = {}) {
    const p = {
        slopeDeg: SPEC.slope.default,
        innerWidth: SPEC.innerWidth.default,
        curveRadius: SPEC.defaultCurveRadius,
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

    const types = ['start', ...sequence, 'end'];
    const tanSlope = Math.tan(degToRad(p.slopeDeg));
    const pieces = [];
    let cursor = { x: 0, z: 0, h: 0 };
    let deck = 0; // provisional; shifted after the loop

    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        const plan = segmentPlan(type, cursor, p);
        const isRunning = type !== 'start' && type !== 'end';
        const drop = isRunning ? plan.planLen * tanSlope : 0;
        // Waterfall rule: every seam steps the downhill floor DOWN by a hair.
        const entryDeck = i === 0 ? deck : deck - p.waterfall;
        const exitDeck = entryDeck - drop;
        const innerWidth = plan.radius ? p.innerWidth + SPEC.curveWidenMm : p.innerWidth;
        const ridge = effectiveRidgePitch(plan.planLen, p.ridgePitch);

        pieces.push({
            type, index: i,
            name: `${String(i).padStart(2, '0')}_${type}`,
            entry: { ...cursor },
            exit: { ...plan.exit },
            planLen: plan.planLen,
            radius: plan.radius, center: plan.center, turn: plan.turn,
            slopeDeg: isRunning ? p.slopeDeg : 0,
            drop, entryDeck, exitDeck,
            rimY: exitDeck - p.skirtDepth,
            innerWidth,
            ridgePitch: ridge.pitch, ridgeCount: ridge.count
        });

        cursor = plan.exit;
        deck = exitDeck;
    }

    // Shift the whole layout up so the lowest skirt rim rests exactly on the ground.
    const minRim = Math.min(...pieces.map(pc => pc.rimY));
    for (const pc of pieces) {
        pc.entryDeck -= minRim;
        pc.exitDeck -= minRim;
        pc.rimY -= minRim;
    }

    const totalDropMm = pieces[0].entryDeck - pieces[pieces.length - 1].exitDeck;
    issues.push(...checkClearances(pieces, p));
    return { pieces, issues, totalDropMm, params: p };
}

/** Deck-centerline elevation at arc-length s within a piece (excludes ridges). */
export function deckYAt(piece, s) {
    const f = piece.planLen === 0 ? 0 : s / piece.planLen;
    return piece.entryDeck - piece.drop * f;
}

/** Plan position + heading at arc-length s within a piece. */
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
 * Sweep stations for mesh generation. Each station provides the deck-centerline
 * origin and a HORIZONTAL right vector (zero-bank rule: `right` never tilts,
 * so the channel floor stays level side-to-side even on helical curves).
 */
export function stationsForPiece(piece, maxStep = 8) {
    const n = Math.max(2, Math.ceil(piece.planLen / maxStep) + 1);
    const stations = [];
    for (let i = 0; i < n; i++) {
        const s = (piece.planLen * i) / (n - 1);
        const { x, z, h } = planPosAt(piece, s);
        stations.push({
            s,
            origin: [x, deckYAt(piece, s), z],
            right: [Math.sin(h), 0, -Math.cos(h)] // horizontal, perpendicular to travel
        });
    }
    return stations;
}

/** Dense centerline samples for the gait simulation. */
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
 * Self-intersection / spiral-tier clearance check. Non-adjacent pieces whose
 * centerlines pass within a channel-width of each other must be separated
 * vertically by at least SPEC.clearanceHeight (figure + rails + structure).
 */
export function checkClearances(pieces, params) {
    const issues = [];
    const outerW = (params.innerWidth ?? SPEC.innerWidth.default) + 2 * SPEC.wall + SPEC.curveWidenMm;
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

    const flagged = new Set();
    for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 2; j < pieces.length; j++) {
            let clash = false;
            for (const a of sampled[i]) {
                for (const b of sampled[j]) {
                    const dx = a[0] - b[0], dz = a[2] - b[2];
                    if (dx * dx + dz * dz < outerW * outerW) {
                        const dy = Math.abs(a[1] - b[1]);
                        if (dy < SPEC.clearanceHeight) { clash = true; break; }
                    }
                }
                if (clash) break;
            }
            if (clash && !flagged.has(`${i}-${j}`)) {
                flagged.add(`${i}-${j}`);
                issues.push({
                    level: 'error', code: 'clearance', i, j,
                    msg: `Pieces ${pieces[i].name} and ${pieces[j].name} overlap with less than ${SPEC.clearanceHeight} mm of vertical clearance — the figure will strike the tier above.`
                });
            }
        }
    }
    return issues;
}

/** Convenience: appends a full 360° spiral tier (4 quarter-turns) to a sequence. */
export function appendSpiralTier(sequence, direction = 'L') {
    const t = direction === 'L' ? 'curveL' : 'curveR';
    return [...sequence, t, t, t, t];
}
