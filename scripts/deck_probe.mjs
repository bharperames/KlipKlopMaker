#!/usr/bin/env node
/**
 * LOOK AT THE WALKING SURFACE ITSELF, not at a render of it.
 *
 *   node scripts/deck_probe.mjs [switchL|switchR]
 *
 * The frog has been judged from a screenshot more than once, and a render
 * shades a CREASE and a GROOVE identically — so the eye cannot separate "the
 * surface changes height here" from "the surface stops being corrugated here",
 * and those two need opposite fixes. This measures both, off the built mesh.
 *
 *   DECK     surface height, as deviation from the smooth ramp the route
 *            should be falling along. A step shows up here and nowhere else.
 *   RELIEF   peak-to-trough of the washboard within a short window along the
 *            route. An amplitude hole shows up here — a flat patch reads 0
 *            however level it is, and a full washboard reads ~ridge.height.
 *
 * Sampled in each ROUTE's own frame — down the centreline and across the
 * channel — because that is the frame a walker experiences. A defect that is
 * diagonal in the part is usually square in one of the two routes, and which
 * route it squares up in says which route's field produced it.
 *
 * Rays are cast downward and the HIGHEST hit is taken, so the fill, the skirt
 * and the far route's underside are invisible to it.
 */

import { layoutTrack, planPillarPositions, planPosAt, pieceInFrame, pieceFrame, bankAt, SPEC }
    from '../js/track.js';
import { initCSG, buildSwitchExportGeometry } from '../js/pieces.js';

const CELL = 6;                        // triangle bucket size, mm

/** Highest downward hit at (x,z). Mesh is Y-up, in the piece frame. */
export function topSurface(P, I) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
        x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]);
        z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]);
    }
    const NX = Math.ceil((x1 - x0) / CELL) + 2, NZ = Math.ceil((z1 - z0) / CELL) + 2;
    const grid = new Map();
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const i0 = Math.max(0, Math.floor((Math.min(P[a], P[b], P[c]) - x0) / CELL));
        const i1 = Math.min(NX - 1, Math.floor((Math.max(P[a], P[b], P[c]) - x0) / CELL));
        const j0 = Math.max(0, Math.floor((Math.min(P[a+2], P[b+2], P[c+2]) - z0) / CELL));
        const j1 = Math.min(NZ - 1, Math.floor((Math.max(P[a+2], P[b+2], P[c+2]) - z0) / CELL));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const k = j * NX + i;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(t);
        }
    }
    return (px, pz) => {
        const bucket = grid.get(Math.floor((pz - z0) / CELL) * NX + Math.floor((px - x0) / CELL));
        if (!bucket) return null;
        let best = null;
        for (const t of bucket) {
            const a = I[t] * 3, b = I[t+1] * 3, c = I[t+2] * 3;
            const ax = P[a], az = P[a+2], bx = P[b], bz = P[b+2], cx = P[c], cz = P[c+2];
            const d = (bx-ax)*(cz-az) - (bz-az)*(cx-ax);
            if (d === 0) continue;
            const w0 = ((px-ax)*(cz-az) - (pz-az)*(cx-ax)) / d;
            const w1 = ((bx-ax)*(pz-az) - (bz-az)*(px-ax)) / d;
            if (w0 < -1e-9 || w1 < -1e-9 || w0 + w1 > 1 + 1e-9) continue;
            const y = P[a+1] + w0*(P[b+1]-P[a+1]) + w1*(P[c+1]-P[a+1]);
            if (best === null || y > best) best = y;
        }
        return best;
    };
}

/**
 * WORST DIP BELOW THE RAMP LINE, along the direction of travel.
 *
 * The lateral-step gate walks ACROSS the channel, so a trough that runs ALONG
 * it slips straight through — which is how Brett came to find one with his
 * fingers instead: "a 'trough' effect that requires a bit of a climb to get
 * back onto the curve route ... this low point is in the 'knee' where the two
 * routes intersect."
 *
 * Valley floors, not crests: the minimum over one ridge pitch, so the washboard
 * itself reads as zero and only real depressions count. Measured against the
 * straight line from the route's own entry deck to its own exit deck, plus its
 * bank, which is the surface a walker is entitled to expect.
 */
export function worstDip(top, piece, us = [-18, -9, 0, 9, 18], dS = 2) {
    let worst = 0, at = 'nowhere';
    for (let s = 0; s <= piece.planLen; s += dS) {
        const ideal = piece.entryDeck - piece.drop * (s / piece.planLen);
        const tb = Math.tan(bankAt(piece, s));
        for (const u of us) {
            let lo = Infinity;
            for (let t = -1.25; t <= 1.25; t += 0.25) {
                const q = planPosAt(piece, Math.max(0, Math.min(s + t, piece.planLen)));
                const y = top(q.x + Math.sin(q.h) * u, q.z - Math.cos(q.h) * u);
                if (y != null) lo = Math.min(lo, y);
            }
            if (lo === Infinity) continue;
            const d = lo - (ideal + u * tb);
            if (d < worst) { worst = d; at = `s=${s} u=${u}`; }
        }
    }
    return { dip: -worst, at };
}

/**
 * THE LARGEST PATCH OF WALKING SURFACE WITH NO RACK IN IT, in mm2.
 *
 * The washboard is not a friction coating, it is a RACK that the pony's front
 * pads mesh with (PHYSICS.md §3.1) — Brett: "the function of the pony requires
 * contact and grip from these front feet to the surface". So a smooth patch is
 * a disengaged drive, not a slightly slippier floor, and "no broad flat areas"
 * is a functional requirement he stated in exactly those words.
 *
 * Relief is peak-to-trough within one ridge pitch ALONG the route, so a deck
 * that is merely steep or banked reads full and only a genuine loss of
 * amplitude reads flat. Cells below `frac` of the nominal ridge height are
 * flat; the answer is the biggest CONNECTED patch of them, not the total,
 * because scattered singles are sampling noise at a rail fillet while one
 * contiguous region is a stride with nothing to push against.
 */
export function worstFlatPatch(top, piece, { frac = 0.5, dS = 2, dU = 3, endMm = 6 } = {}) {
    const half = piece.innerWidth / 2 - 2;         // clear of the fillets
    const lim = SPEC.ridge.height * frac;
    const rows = [];
    // SKIP THE END BANDS. A seam face is not walking surface — the pitch is
    // snapped so the seam lands in a valley, so the last row before a face is
    // a valley floor by construction and reads flat however healthy the field
    // is. The start platform's bumper end is the same story. 6 mm is two ridge
    // pitches, enough to clear both and far short of anything a stride cares
    // about.
    for (let s = endMm; s <= piece.planLen - endMm + 1e-9; s += dS) {
        const p = planPosAt(piece, Math.min(s, piece.planLen));
        const rx = Math.sin(p.h), rz = -Math.cos(p.h);
        const row = [];
        for (let u = -half; u <= half + 1e-9; u += dU) {
            let lo = Infinity, hi = -Infinity;
            for (let t = -1.25; t <= 1.25; t += 0.25) {
                const q = planPosAt(piece, Math.max(0, Math.min(s + t, piece.planLen)));
                const y = top(q.x + Math.sin(q.h) * u, q.z - Math.cos(q.h) * u);
                if (y != null) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
            }
            row.push(lo === Infinity ? null : hi - lo);
        }
        rows.push({ s, u0: -half, row });
    }
    const seen = rows.map((r) => r.row.map(() => false));
    let best = 0, at = 'nowhere';
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < rows[i].row.length; j++) {
        const v = rows[i].row[j];
        if (seen[i][j] || v == null || v >= lim) continue;
        let n = 0;
        const stack = [[i, j]];
        seen[i][j] = true;
        while (stack.length) {
            const [a, b] = stack.pop();
            n++;
            for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const p = a + da, q = b + db;
                if (p < 0 || q < 0 || p >= rows.length || q >= rows[p].row.length) continue;
                const w = rows[p].row[q];
                if (seen[p][q] || w == null || w >= lim) continue;
                seen[p][q] = true; stack.push([p, q]);
            }
        }
        if (n * dS * dU > best) { best = n * dS * dU; at = `s=${rows[i].s.toFixed(0)} u=${(rows[i].u0 + j * dU).toFixed(0)}`; }
    }
    return { areaMm2: best, at };
}

/** Sample one route: [s][u] grid of deck height, null off the deck. */
function sampleRoute(top, piece, halfW, dS, dU) {
    const rows = [];
    for (let s = 0; s <= piece.planLen + 1e-9; s += dS) {
        const p = planPosAt(piece, Math.min(s, piece.planLen));
        const rx = Math.sin(p.h), rz = -Math.cos(p.h);
        const row = { s, cells: [] };
        for (let u = -halfW; u <= halfW + 1e-9; u += dU) {
            row.cells.push(top(p.x + rx * u, p.z + rz * u));
        }
        rows.push(row);
    }
    return rows;
}

export async function probe(hand = 'switchL') {
    await initCSG();
    const sw = layoutTrack([{ type: hand, gate: 'main', main: ['straight'], branch: ['straight'] }],
        { skirtStyle: 'minimal' });
    const sups = planPillarPositions(sw.pieces);
    const main0 = sw.pieces.find((p) => p.role === 'main');
    const branch0 = sw.pieces.find((p) => p.role === 'branch');
    const g = buildSwitchExportGeometry(main0, branch0,
        { support: sups.find((x) => x.pieceIndex === main0.index) });
    const frame = pieceFrame(main0);
    const main = pieceInFrame(main0, frame), branch = pieceInFrame(branch0, frame);
    const top = topSurface(g.positions, g.indices);
    return { hand, g, main, branch, top };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const hand = process.argv[2] ?? 'switchL';
    const { main, branch, top } = await probe(hand);
    const halfW = main.innerWidth / 2 - 1;      // stay a mm clear of the rails
    const dS = 2, dU = 3;

    for (const [label, piece] of [['MAIN', main], ['BRANCH', branch]]) {
        const rows = sampleRoute(top, piece, halfW, dS, dU);
        console.log(`\n${hand}  ${label} route — ${rows.length} stations, `
            + `${rows[0].cells.length} across (u = ${-halfW} .. ${halfW} mm)\n`);
        // RELIEF: peak-to-trough over a +-3 mm window along the route
        console.log('   s     relief across the channel (0.1 mm units; . = flat, X = full washboard)   worst step');
        const W = Math.round(3 / dS);
        for (let i = 0; i < rows.length; i++) {
            const line = [];
            let holes = 0;
            for (let c = 0; c < rows[i].cells.length; c++) {
                let lo = Infinity, hi = -Infinity, n = 0;
                for (let k = Math.max(0, i - W); k <= Math.min(rows.length - 1, i + W); k++) {
                    const v = rows[k].cells[c];
                    if (v == null) continue;
                    lo = Math.min(lo, v); hi = Math.max(hi, v); n++;
                }
                if (!n || rows[i].cells[c] == null) { line.push(' '); continue; }
                const rel = hi - lo;
                if (rel < 0.05) { line.push('.'); holes++; }
                else if (rel < SPEC.ridge.height * 0.5) line.push('-');
                else if (rel < SPEC.ridge.height * 0.85) line.push('+');
                else line.push('X');
            }
            // biggest lateral jump in the raw surface at this station
            let jump = 0;
            for (let c = 1; c < rows[i].cells.length; c++) {
                const a = rows[i].cells[c - 1], b = rows[i].cells[c];
                if (a != null && b != null) jump = Math.max(jump, Math.abs(a - b));
            }
            console.log(`${rows[i].s.toFixed(0).padStart(5)}   ${line.join('')}   `
                + `${jump.toFixed(2)}${holes ? `   ${holes} flat` : ''}`);
        }
    }
}
