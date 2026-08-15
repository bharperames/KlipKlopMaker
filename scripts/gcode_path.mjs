/**
 * GCODE → MOVES, WITH ARCS. Shared by `unsupported_runs.mjs` and
 * `curve_variants.mjs` so the two cannot drift apart again.
 *
 * WHY THIS EXISTS: both scripts used to parse `G1` only. Bambu ships with
 * `enable_arc_fitting = 1`, and a sliced CURVE is 13% arc moves — 58 903 `G2`/
 * `G3` against 389 026 `G1` on the baseline. Parsing G1 alone did two things,
 * and the second is worse than the first:
 *
 *   1. arc moves never marked the occupancy grid, so the layer below was
 *      under-recorded and material that WAS supported read as unsupported;
 *   2. the nozzle position was never advanced by an arc, so the next `G1` was
 *      measured from a stale point — a straight line drawn from wherever the
 *      last G1 ended to wherever the arc happened to finish. On a 90° curve
 *      that chord cuts clean across the empty concave side of the part, which
 *      is where the phantom 110–148 mm "bridges" came from. They appeared at
 *      identical coordinates in every variant INCLUDING the baseline, which is
 *      what gave them away: real geometry differences do not do that.
 *
 * A move is yielded as a POLYLINE, not a segment. That matters for the run
 * analysis: it walks one move looking for stretches over empty space and calls
 * a stretch "open-ended" if it reaches either end of the move. Flattening an
 * arc into 100 separate moves would make every stretch touch an end and score
 * as open. One arc is one move, with a bent path.
 */

/** Chord tolerance when flattening an arc, mm. Well under one extrusion width. */
const ARC_TOL_MM = 0.02;

const num = (re, l) => { const m = re.exec(l); return m ? parseFloat(m[1]) : null; };

/**
 * @param lines gcode split into lines
 * @yields { pts: [[x,y],...], z, extruding, feature }
 */
export function* moves(lines) {
    let x = 0, y = 0, z = 0, feature = '(none)';
    for (const l of lines) {
        if (l.startsWith('; FEATURE:')) { feature = l.slice(11).trim(); continue; }
        const isArc = l.startsWith('G2 ') || l.startsWith('G3 ');
        if (!isArc && !l.startsWith('G1 ')) continue;

        const nz = num(/\sZ(-?[0-9.]+)/, l);
        if (nz !== null) z = nz;
        const nx = num(/\sX(-?[0-9.]+)/, l) ?? x;
        const ny = num(/\sY(-?[0-9.]+)/, l) ?? y;
        const e = num(/\sE(-?[0-9.]+)/, l);
        const extruding = e !== null && e > 0;

        if (!isArc) {
            // A bare `G1 Z...` is a layer change or a z-hop and moves nothing
            // in the plane; yielding it as a zero-length move is harmless but
            // pointless, and it would pollute the run list with 0 mm entries.
            if (nx !== x || ny !== y) yield { pts: [[x, y], [nx, ny]], z, extruding, feature };
            x = nx; y = ny;
            continue;
        }

        // I/J are the offset from the CURRENT point to the arc centre.
        const i = num(/\sI(-?[0-9.]+)/, l) ?? 0;
        const j = num(/\sJ(-?[0-9.]+)/, l) ?? 0;
        const cx = x + i, cy = y + j;
        const r = Math.hypot(i, j);
        if (!(r > 1e-9)) { x = nx; y = ny; continue; }

        const a0 = Math.atan2(y - cy, x - cx);
        const a1 = Math.atan2(ny - cy, nx - cx);
        const cw = l.startsWith('G2 ');
        let sweep = a1 - a0;
        // Normalise into the direction of travel. A start and end at the same
        // angle is a FULL circle, not a zero-length move.
        if (cw) { while (sweep >= 0) sweep -= 2 * Math.PI; while (sweep < -2 * Math.PI) sweep += 2 * Math.PI; }
        else { while (sweep <= 0) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI; }

        // Segments needed to hold the chord sagitta under ARC_TOL_MM.
        const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOL_MM / r)));
        const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(1e-6, maxStep)));
        const pts = [];
        for (let k = 0; k <= n; k++) {
            const a = a0 + (sweep * k) / n;
            pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        // End exactly where the gcode says, not where the trig lands.
        pts[pts.length - 1] = [nx, ny];
        yield { pts, z, extruding, feature };
        x = nx; y = ny;
    }
}

/** Total planar length of a polyline. */
export function pathLength(pts) {
    let d = 0;
    for (let k = 0; k + 1 < pts.length; k++) d += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    return d;
}

/** Point at arc-length `t` along a polyline (clamped). */
export function pointAt(pts, t) {
    let acc = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
        const seg = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
        if (acc + seg >= t || k + 2 === pts.length) {
            const f = seg < 1e-12 ? 0 : Math.max(0, Math.min(1, (t - acc) / seg));
            return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f,
                pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f];
        }
        acc += seg;
    }
    return pts[pts.length - 1];
}
