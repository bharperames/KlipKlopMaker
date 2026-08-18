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

import { layoutTrack, planPillarPositions, planPosAt, pieceInFrame, pieceFrame, SPEC }
    from '../js/track.js';
import { initCSG, buildSwitchExportGeometry } from '../js/pieces.js';

const CELL = 6;                        // triangle bucket size, mm

/** Highest downward hit at (x,z). Mesh is Y-up, in the piece frame. */
function topSurface(P, I) {
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
