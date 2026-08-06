/**
 * clearance.js
 * Lateral fit: does the figure actually pass through the channel? Pure — no
 * DOM, no Three.js, so Jest tests it directly.
 *
 * WHY THIS EXISTS. `simulate.js` models motion *along* the track — speed,
 * slope, friction, walk/slide regimes, stall, tumble — and never reads channel
 * width. Nothing in this project could tell a 48 mm channel from a 51 mm one,
 * so the +3 mm curve widening and the seam taper rested on judgement and on a
 * test ("a helix is not pinched at its interior seams") that encoded that
 * judgement rather than measuring anything. This module is the missing half:
 * a rigid-body sweep that says how wide the channel HAS to be at a given place.
 *
 * WHAT IS MEASURED AND WHAT IS JUDGED — read this before trusting an output.
 *
 *  MEASURED (read off the figure outlines in geometry.js; change the outlines
 *  and these follow):
 *    - footprint length: the figure's along-travel extent BELOW rail height,
 *      taken at full pendulum swing. Above the rails the channel is open, so
 *      the nose and the head do not constrain anything.
 *    - footprint width: the printed body width, `channelWidth − 4`.
 *
 *  DERIVED (rigid-body kinematics, no free parameters):
 *    - the swept band of a rectangle riding a circular centreline. This is the
 *      off-tracking term the "+3 mm curve widening" was always standing in for.
 *
 *  JUDGED (defensible, not yet measured against a print — Phase 3 of PLAN.md):
 *    - the yaw model. A passive walker does not steer; it translates along a
 *      chord for one stride and is squared up by the walls at hoof strike, so
 *      heading error against the local tangent is taken as ±stride/2R. Straight
 *      pieces are modelled with zero yaw, which makes the 44 mm figure in the
 *      48 mm standard channel come out exactly at its stated 4 mm of play —
 *      i.e. the model is anchored to the one configuration known to work.
 *    - the 3 mm lateral clearance floor, from PHYSICS.md §4 ("figure width +
 *      3–4 mm total clearance"). It is the bottom of a published range, not a
 *      measurement of when a hoof starts to bind.
 */

import { STANDARD, SPEC, degToRad, innerWidthAt, samplePath, resolveRidePath } from './track.js';
import { bodySideOutline, pendulumSideOutline, FIGURE } from './geometry.js';

export const CLEARANCE = {
    /** Design target for total side-to-side play, bottom of the PHYSICS.md §4 range. */
    lateralMm: 3,
    /**
     * Below this much play a real print binds even though the model fits: a
     * 0.2 mm joint clearance plus the warp a 150 mm PLA part comes off the bed
     * with is most of a millimetre a side. Under the target is a design note;
     * under this is a defect.
     */
    warnPlayMm: 2,
    /** Perimeter samples per footprint when measuring a swept band. */
    bandSamples: 96,
    /** Station spacing (mm of arc) for a path fit scan. */
    stationStepMm: 10
};

// ---------------------------------------------------------------------------
// The footprint
// ---------------------------------------------------------------------------

/** Rotates outline points [z, y] about the axle by `rad`. */
function swingAbout(pts, rad, pz, py) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return pts.map(([z, y]) => {
        const dz = z - pz, dy = y - py;
        return [pz + dz * c - dy * s, py + dz * s + dy * c];
    });
}

/**
 * Along-travel extent of a closed [z, y] outline below `railY`. Edges are
 * clipped at the rail plane rather than only their vertices tested: a body
 * silhouette can cross the rail line mid-edge, and dropping that crossing
 * would shorten the footprint by whatever the edge was leaning.
 */
function extentBelow(outline, railY, acc) {
    const n = outline.length;
    const take = (z) => { acc.min = Math.min(acc.min, z); acc.max = Math.max(acc.max, z); };
    for (let i = 0; i < n; i++) {
        const [z1, y1] = outline[i];
        const [z2, y2] = outline[(i + 1) % n];
        if (y1 <= railY) take(z1);
        if ((y1 - railY) * (y2 - railY) < 0) {
            const t = (railY - y1) / (y2 - y1);
            take(z1 + (z2 - z1) * t);
        }
    }
    return acc;
}

/**
 * The rigid footprint that has to fit between the rails.
 *
 * @param {object} opts - { style, railHeightMm, channelWidthMm, figureWidthMm,
 *                          walker: { alphaDeg } }
 * @returns {{ lengthMm, widthMm, zMin, zMax, style, railHeightMm }}
 */
export function walkerFootprint(opts = {}) {
    const style = opts.style ?? 'classic';
    const railY = opts.railHeightMm ?? SPEC.railHeight;
    const alpha = degToRad(opts.walker?.alphaDeg ?? FIGURE.alphaDeg);
    // The figure is printed for the channel it was designed against, not for
    // the widest channel it will ever cross — a curve at 51 does not get a
    // fatter figure. Default to the STANDARD 48 unless told otherwise.
    const widthMm = opts.figureWidthMm ?? ((opts.channelWidthMm ?? STANDARD.innerWidth) - 4);

    const acc = { min: Infinity, max: -Infinity };
    extentBelow(bodySideOutline(style), railY, acc);
    const pend = pendulumSideOutline();
    for (const swing of [-alpha, 0, alpha]) {
        extentBelow(swingAbout(pend, swing, FIGURE.axle.z, FIGURE.axle.y), railY, acc);
    }
    return {
        lengthMm: acc.max - acc.min, widthMm,
        zMin: acc.min, zMax: acc.max, style, railHeightMm: railY
    };
}

// ---------------------------------------------------------------------------
// Yaw
// ---------------------------------------------------------------------------

/** Stride between hoof contacts — same expression physics.js walks on. */
export function strideMm(walker = {}) {
    const l = walker.legLenMm ?? FIGURE.legLenMm;
    const a = degToRad(walker.alphaDeg ?? FIGURE.alphaDeg);
    return 2 * l * Math.sin(a);
}

/**
 * Heading error against the local tangent, in radians. JUDGED — see the header.
 * A step is a straight chord; over one stride the tangent turns by stride/R and
 * the walls take that back out at hoof strike, so the excursion either side of
 * the tangent is half of it.
 *
 * The closed form, for the interior of a piece of constant radius.
 */
export function yawAmplitudeRad(radiusMm, opts = {}) {
    const floor = opts.straightYawRad ?? 0;
    if (!radiusMm || !Number.isFinite(radiusMm)) return floor;
    return Math.max(floor, strideMm(opts.walker ?? {}) / (2 * Math.abs(radiusMm)));
}

/**
 * The same statement evaluated on the real path: half the heading change over
 * one stride, centred on the query point. Identical to the closed form inside a
 * curve, zero on a straight, and — the reason it exists — it ramps across a
 * transition instead of switching on at full amplitude the instant the piece
 * type changes. A figure arriving at a curve is still walking straight; it has
 * not begun to tack until it has taken a step round the turn.
 */
function pathYawRad(headingAt, d, stride, floor = 0) {
    if (stride <= 0) return floor;
    const dh = headingAt(d + stride / 2) - headingAt(d - stride / 2);
    return Math.max(floor, Math.abs(dh) / 2);
}

// ---------------------------------------------------------------------------
// The swept band
// ---------------------------------------------------------------------------

/** Footprint perimeter in figure-local plan coords, yawed by `yawRad`. */
function footprintOutline(footprint, yawRad, samples) {
    const hl = footprint.lengthMm / 2, hw = footprint.widthMm / 2;
    const corners = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]];
    const perim = 4 * (hl + hw);
    const c = Math.cos(yawRad), s = Math.sin(yawRad);
    const pts = [];
    for (let i = 0; i < 4; i++) {
        const [au, av] = corners[i];
        const [bu, bv] = corners[(i + 1) % 4];
        const edgeLen = Math.hypot(bu - au, bv - av);
        const n = Math.max(1, Math.round((edgeLen / perim) * samples));
        for (let k = 0; k < n; k++) {
            const t = k / n;
            const u = au + (bu - au) * t, v = av + (bv - av) * t;
            pts.push([u * c - v * s, u * s + v * c]);
        }
    }
    return pts;
}

/**
 * Width of the narrowest band concentric with the centreline that contains the
 * footprint, for a centreline of signed radius `signedRadiusMm` (positive =
 * turning left, centre on the +lateral side; null/Infinity = straight).
 *
 * Exact rigid-body sweep — no small-angle approximation — so it carries both
 * the off-tracking term and the yaw term at once instead of adding two
 * linearised ones.
 */
export function sweptBandMm(footprint, signedRadiusMm, yawRad = 0, samples = CLEARANCE.bandSamples) {
    const pts = footprintOutline(footprint, yawRad, samples);
    let lo = Infinity, hi = -Infinity;
    const R = signedRadiusMm;
    const straight = !R || !Number.isFinite(R);
    for (const [u, v] of pts) {
        const off = straight ? v : R - Math.sign(R) * Math.hypot(u, v - R);
        if (off < lo) lo = off;
        if (off > hi) hi = off;
    }
    return hi - lo;
}

/** Signed radius of a piece's centreline: + turning left, − right, null flat. */
export function signedRadiusOf(piece) {
    if (!piece || !piece.radius) return null;
    return piece.turn > 0 ? piece.radius : -piece.radius;
}

/**
 * Channel width the figure needs on `piece`, including lateral clearance.
 *
 * `s` is accepted so this reads as a station query alongside `innerWidthAt`,
 * but a piece has ONE curvature end to end, so the answer does not vary with
 * it. That also makes this the piece-local answer: within half a footprint of
 * a seam the figure is partly on its neighbour and this over-reports. Use
 * `channelFitProfile` for a verdict on a real track; use this one to reason
 * about the interior of a piece, and about a seam between two pieces of the
 * SAME curvature — a helix interior seam — where the two agree exactly.
 */
export function requiredWidthAt(piece, s = 0, opts = {}) {
    const footprint = opts.footprint ?? walkerFootprint(opts);
    const R = signedRadiusOf(piece);
    const psi = yawAmplitudeRad(piece?.radius, opts);
    const band = Math.max(
        sweptBandMm(footprint, R, psi),
        sweptBandMm(footprint, R, -psi)
    );
    return band + (opts.lateralClearanceMm ?? CLEARANCE.lateralMm);
}

// ---------------------------------------------------------------------------
// Fit against a real track
// ---------------------------------------------------------------------------

/** Nearest point on the polyline window [i0, i1) → { dist, lateral }. */
function projectToPath(samples, i0, i1, px, pz) {
    let bestD2 = Infinity, bestDist = 0, bestLat = 0;
    for (let i = i0; i < i1; i++) {
        const a = samples[i], b = samples[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-12) continue;
        let t = ((px - a.x) * dx + (pz - a.z) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (a.x + dx * t), ez = pz - (a.z + dz * t);
        const d2 = ex * ex + ez * ez;
        if (d2 < bestD2) {
            const inv = 1 / Math.sqrt(len2);
            const tx = dx * inv, tz = dz * inv;
            bestD2 = d2;
            bestDist = a.dist + t * Math.sqrt(len2);
            // `right` in the sense stationsForPiece uses: (sin h, −cos h)
            bestLat = ex * tz - ez * tx;
        }
    }
    return { dist: bestDist, lateral: bestLat };
}

/**
 * Walks the ride path and reports, at every station, how much side-to-side
 * PLAY the figure has once its footprint is placed as favourably as it can be.
 * Play is the quantity the spec is written in: the standard 48 mm channel and
 * its 44 mm figure come out of here at 4.00 mm, as they should.
 *
 * The footprint is projected onto the ACTUAL centreline, so a piece boundary is
 * handled by geometry rather than by a rule: a figure entering a curve is still
 * mostly on the straight, and the half of it that is already round the corner
 * is measured against the curve's own width at the arc length it reaches.
 *
 * Fit is a 1-D feasibility problem. Each footprint sample i lands at lateral
 * offset `oᵢ` where the channel allows `±hᵢ` (its half width there). A rigid
 * figure can only shift as a whole, by some δ, so it fits iff
 * `max(−hᵢ − oᵢ) ≤ min(hᵢ − oᵢ)`, and the gap between those two is the play.
 * Doing it this way is what lets a piece whose width VARIES along the footprint
 * — anything inside `SEAM_TAPER_MM` of a seam — be judged honestly.
 *
 * @returns {{ worstPlayMm, worst, stations }}
 */
export function channelFitProfile(pieces, opts = {}) {
    const path = opts.path ?? resolveRidePath(pieces);
    const running = path.filter(pc => pc.planLen > 0);
    if (running.length < 1) return { worstPlayMm: Infinity, worst: null, stations: [] };

    const footprint = opts.footprint ?? walkerFootprint(opts);
    const samples = samplePath(running, opts.pathStepMm ?? 4);
    const total = samples[samples.length - 1].dist;

    // arc-length start of each piece, so a projected point can be turned back
    // into (piece, s) and asked for its width
    const starts = [];
    let acc = 0;
    for (const pc of running) { starts.push(acc); acc += pc.planLen; }
    const widthAtDist = (d) => {
        let k = starts.length - 1;
        while (k > 0 && d < starts[k]) k--;
        const pc = running[k];
        return innerWidthAt(pc, Math.max(0, Math.min(pc.planLen, d - starts[k])));
    };

    const stations = [];
    const step = opts.stationStepMm ?? CLEARANCE.stationStepMm;
    const reach = footprint.lengthMm + 8;
    const stride = opts.strideMm ?? strideMm(opts.walker ?? {});
    const headingAt = (d) => sampleAt(samples, Math.max(0, Math.min(total, d))).h;
    let worst = null;

    for (let d = 0; d <= total + 1e-6; d += step) {
        const dq = Math.min(d, total);
        const here = sampleAt(samples, dq);
        const pc = running[here.pieceIndex];
        const psi = pathYawRad(headingAt, dq, stride, opts.straightYawRad ?? 0);
        let stationPlay = Infinity, stationOffset = 0;

        for (const yaw of psi > 0 ? [psi, -psi] : [0]) {
            const outline = footprintOutline(footprint, yaw, opts.bandSamples ?? CLEARANCE.bandSamples);
            const c = Math.cos(here.h), s = Math.sin(here.h);
            // window the projection by arc length: a helix passes over its own
            // plan position, so nearest-point over the whole polyline would
            // happily snap a footprint corner onto the tier below
            const i0 = indexBefore(samples, dq - reach);
            const i1 = Math.min(samples.length - 1, indexBefore(samples, dq + reach) + 1);
            let lo = -Infinity, hi = Infinity;
            for (const [u, v] of outline) {
                // local (u along, v to the LEFT) → world; right = (sin h, −cos h)
                const px = here.x + c * u + s * -v;
                const pz = here.z + s * u - c * -v;
                const pr = projectToPath(samples, i0, i1, px, pz);
                const half = widthAtDist(pr.dist) / 2;
                lo = Math.max(lo, -half - pr.lateral);
                hi = Math.min(hi, half - pr.lateral);
            }
            if (hi - lo < stationPlay) { stationPlay = hi - lo; stationOffset = (lo + hi) / 2; }
        }
        const st = {
            dist: dq, pieceIndex: here.pieceIndex, pieceName: pc.name,
            s: dq - starts[here.pieceIndex], playMm: stationPlay,
            yawDeg: psi * 180 / Math.PI,
            centreOffsetMm: stationOffset, availableMm: widthAtDist(dq)
        };
        stations.push(st);
        if (!worst || st.playMm < worst.playMm) worst = st;
        if (dq >= total) break;
    }
    return { worstPlayMm: worst ? worst.playMm : Infinity, worst, stations };
}

function indexBefore(samples, d) {
    if (d <= samples[0].dist) return 0;
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].dist <= d) lo = mid; else hi = mid;
    }
    return lo;
}

function sampleAt(samples, d) {
    const i = indexBefore(samples, d);
    const a = samples[i], b = samples[Math.min(samples.length - 1, i + 1)];
    const f = b.dist === a.dist ? 0 : (d - a.dist) / (b.dist - a.dist);
    let dh = b.h - a.h;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    return {
        x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
        h: a.h + dh * f, pieceIndex: a.pieceIndex
    };
}

/**
 * Track-level verdict, shaped like the other `issues` producers in track.js so
 * the app can surface it next to slope and clearance warnings.
 */
export function checkChannelFit(pieces, opts = {}) {
    const fit = channelFitProfile(pieces, opts);
    const warnAt = opts.warnPlayMm ?? CLEARANCE.warnPlayMm;
    const issues = [];
    if (fit.worst && fit.worst.playMm <= 0) {
        issues.push({
            level: 'error', code: 'channel-too-narrow',
            msg: `The figure does not fit at ${fit.worst.pieceName}: its swept footprint needs ${(-fit.worst.playMm).toFixed(2)} mm more channel than there is.`
        });
    } else if (fit.worst && fit.worst.playMm < warnAt) {
        issues.push({
            level: 'warn', code: 'channel-tight',
            msg: `Only ${fit.worst.playMm.toFixed(2)} mm of side-to-side play at ${fit.worst.pieceName} — a warped print will bind there.`
        });
    }
    return { issues, ...fit };
}
