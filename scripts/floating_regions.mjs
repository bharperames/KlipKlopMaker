#!/usr/bin/env node
/**
 * WHERE IS THE FLOATING REGION? — locate what Bambu is warning about.
 *
 * `result.json` tells you THAT a part "has floating regions"; it never says
 * where. That gap is why the warning went unexplained for months: it could be
 * read (eventually) but not acted on. This finds the patches it is reading.
 *
 * For each layer it rasterises the extrusions, subtracts the layer below
 * (dilated by one extrusion width, since a wall sitting on a wall is supported
 * even if the paths do not coincide exactly), and reports the connected
 * components of what is left — material with nothing under it. Sorted by area,
 * because the warning is plainly area-based rather than length-based: a solid
 * curve carries 18.7 m of "Floating vertical shell" in TOTAL and stays silent
 * while a solid switch with 30.2 m warns, so total length is not the trigger.
 *
 *   node scripts/floating_regions.mjs <file.gcode> [minArea mm2]
 */

import fs from 'node:fs';
import { moves } from './gcode_path.mjs';

const file = process.argv[2];
const MIN_AREA = Number(process.argv[3] ?? 8);
if (!file) { console.error('usage: node scripts/floating_regions.mjs <file.gcode> [minArea]'); process.exit(1); }

const CELL = 0.5;
const lines = fs.readFileSync(file, 'utf8').split('\n');

let X0 = 1e9, X1 = -1e9, Y0 = 1e9, Y1 = -1e9;
for (const mv of moves(lines)) {
    if (!mv.extruding) continue;
    for (const [x, y] of mv.pts) {
        X0 = Math.min(X0, x); X1 = Math.max(X1, x);
        Y0 = Math.min(Y0, y); Y1 = Math.max(Y1, y);
    }
}
const NX = Math.ceil((X1 - X0) / CELL) + 6, NY = Math.ceil((Y1 - Y0) / CELL) + 6;
const idx = (x, y) => {
    const i = Math.round((x - X0) / CELL) + 3, j = Math.round((y - Y0) / CELL) + 3;
    return (i < 0 || j < 0 || i >= NX || j >= NY) ? -1 : j * NX + i;
};
const stamp = (g, ax, ay, bx, by, r) => {
    const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / (CELL / 2)));
    const k = Math.ceil(r / CELL);
    for (let s = 0; s <= n; s++) {
        const t = s / n, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        for (let oi = -k; oi <= k; oi++) for (let oj = -k; oj <= k; oj++) {
            const p = idx(px + oi * CELL, py + oj * CELL);
            if (p >= 0) g[p] = 1;
        }
    }
};

// group moves into layers by the Z of the last EXTRUSION — a z-hop extrudes
// nothing, so this is immune to it (see gcode_path.mjs)
const layers = [];
let cur = null, printZ = null;
for (const mv of moves(lines)) {
    if (!mv.extruding) continue;
    if (printZ === null || mv.z > printZ + 0.05) { cur = { z: mv.z, mv: [] }; layers.push(cur); printZ = mv.z; }
    cur.mv.push(mv);
}

const found = [];
let prev = null;
for (const L of layers) {
    const solid = new Uint8Array(NX * NY);
    const support = new Uint8Array(NX * NY);
    for (const mv of L.mv) {
        for (let k = 0; k + 1 < mv.pts.length; k++) {
            stamp(solid, mv.pts[k][0], mv.pts[k][1], mv.pts[k + 1][0], mv.pts[k + 1][1], 0.21);
        }
    }
    if (prev) {
        // one extrusion width of tolerance: a wall on a wall is supported even
        // if the two toolpaths do not land on the same cell
        for (let i = 0; i < prev.length; i++) if (prev[i]) support[i] = 1;
        const dil = new Uint8Array(NX * NY);
        for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
            const p = j * NX + i;
            if (!support[p]) continue;
            for (let oj = -1; oj <= 1; oj++) for (let oi = -1; oi <= 1; oi++) dil[p + oj * NX + oi] = 1;
        }
        // ISLANDS, NOT UNSUPPORTED AREA. Components of THIS layer's solid that
        // have NO support beneath them anywhere. A bridge is unsupported in its
        // middle but its component is anchored at the rails, so it does not
        // count — which is why the straight carries 4840 mm2 of unsupported
        // area and no warning while the switch warns with 10.5. Bambu is
        // looking for material that starts in mid-air, not material that spans.
        const seen = new Uint8Array(NX * NY);
        for (let p0 = 0; p0 < solid.length; p0++) {
            if (!solid[p0] || seen[p0]) continue;
            const q = [p0]; seen[p0] = 1; const cells = [];
            let supported = 0;
            while (q.length) {
                const c = q.pop(); cells.push(c);
                if (dil[c]) supported++;
                const ci = c % NX, cj = (c - ci) / NX;
                for (let oj = -1; oj <= 1; oj++) for (let oi = -1; oi <= 1; oi++) {
                    const ai = ci + oi, aj = cj + oj;
                    if (ai < 0 || aj < 0 || ai >= NX || aj >= NY) continue;
                    const n = aj * NX + ai;
                    if (solid[n] && !seen[n]) { seen[n] = 1; q.push(n); }
                }
            }
            const area = cells.length * CELL * CELL;
            if (supported > 0 || area < MIN_AREA) continue;
            let sx = 0, sy = 0;
            for (const c of cells) { const ci = c % NX; sx += X0 + (ci - 3) * CELL; sy += Y0 + ((c - ci) / NX - 3) * CELL; }
            found.push({ z: L.z, area, x: sx / cells.length, y: sy / cells.length });
        }
    }
    prev = solid;
}

found.sort((a, b) => b.area - a.area);
const total = found.reduce((s, f) => s + f.area, 0);
console.log(`\n${file.split('/').pop()}`);
console.log(`  ${found.length} floating ISLANDS over ${MIN_AREA} mm2, ${total.toFixed(0)} mm2 total`);
console.log('   area mm2      z        at (x, y)');
for (const f of found.slice(0, 12)) {
    console.log(`   ${f.area.toFixed(1).padStart(8)}  ${f.z.toFixed(1).padStart(6)}   (${f.x.toFixed(0)}, ${f.y.toFixed(0)})`);
}
