/**
 * THE metric: how far does a bridge move travel with NOTHING under it?
 *
 * Segment length was the wrong instrument, and a lattice proved it — anchors
 * every 8 mm in both directions and the longest bridge "segment" was still
 * 65 mm. A single G1 move can pass straight over intervening solid material,
 * so its length says nothing about how far the nozzle is actually unsupported.
 *
 * This rasterises each layer's extrusions into an occupancy grid and then, for
 * every bridge move in the NEXT layer, walks it in small steps and measures the
 * runs that fall over empty cells. That is the span the plastic actually has to
 * cross on its own, which is what droops.
 */
import fs from 'node:fs';

const file = process.argv[2];
const CELL = 0.5;                       // mm per grid cell
const STEP = 0.4;                       // mm per sample along a move
const R = 0.25;                         // half an extrusion width of tolerance

const lines = fs.readFileSync(file, 'utf8').split('\n');
// pass 1: bounds
let x = 0, y = 0, X0 = 1e9, X1 = -1e9, Y0 = 1e9, Y1 = -1e9;
for (const l of lines) {
    if (!l.startsWith('G1 ')) continue;
    const mx = /\sX(-?[0-9.]+)/.exec(l), my = /\sY(-?[0-9.]+)/.exec(l);
    const nx = mx ? parseFloat(mx[1]) : x, ny = my ? parseFloat(my[1]) : y;
    const me = /\sE(-?[0-9.]+)/.exec(l);
    if (me && parseFloat(me[1]) > 0) {
        X0 = Math.min(X0, x, nx); X1 = Math.max(X1, x, nx);
        Y0 = Math.min(Y0, y, ny); Y1 = Math.max(Y1, y, ny);
    }
    x = nx; y = ny;
}
const NX = Math.ceil((X1 - X0) / CELL) + 4, NY = Math.ceil((Y1 - Y0) / CELL) + 4;
const idx = (px, py) => {
    const i = Math.round((px - X0) / CELL) + 2, j = Math.round((py - Y0) / CELL) + 2;
    return (i < 0 || j < 0 || i >= NX || j >= NY) ? -1 : j * NX + i;
};
const mark = (g, ax, ay, bx, by) => {
    const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / (CELL / 2)));
    for (let k = 0; k <= n; k++) {
        const t = k / n, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        for (let oi = -1; oi <= 1; oi++) for (let oj = -1; oj <= 1; oj++) {
            const p = idx(px + oi * R, py + oj * R);
            if (p >= 0) g[p] = 1;
        }
    }
};

// pass 2: layer by layer.
//
// THE LAYER BOUNDARY IS NOT "Z CHANGED". Bambu z-hops on travel moves, and the
// hop is a bare `G1 Z...` indistinguishable from a layer change by pattern —
// so keying on it wiped the occupancy grid several times per layer and left
// `prev` holding a fraction of the layer below. Every run then read as
// unsupported, which is how the VIADUCT (whose deck printed fine) scored worse
// than the minimal curve that failed.
//
// A hop extrudes nothing, so the honest boundary is a change in the Z of the
// last EXTRUSION. That is immune to hops by construction.
let prev = new Uint8Array(NX * NY), cur = new Uint8Array(NX * NY);
let feature = '(none)', z = 0, printZ = null;
const runs = [];
x = 0; y = 0;

for (const l of lines) {
    if (l.startsWith('; FEATURE:')) { feature = l.slice(11).trim(); continue; }
    const zm = /^G1\s[^;]*?Z([0-9.]+)/.exec(l);
    if (zm) { z = parseFloat(zm[1]); continue; }
    if (!l.startsWith('G1 ')) continue;
    const mx = /\sX(-?[0-9.]+)/.exec(l), my = /\sY(-?[0-9.]+)/.exec(l);
    const nx = mx ? parseFloat(mx[1]) : x, ny = my ? parseFloat(my[1]) : y;
    const me = /\sE(-?[0-9.]+)/.exec(l);
    if (me && parseFloat(me[1]) > 0) {
        if (printZ === null) printZ = z;
        else if (z > printZ + 0.05) { prev = cur; cur = new Uint8Array(NX * NY); printZ = z; }
        if (/Bridge|Overhang|Floating/i.test(feature)) {
            const d = Math.hypot(nx - x, ny - y);
            const n = Math.max(1, Math.ceil(d / STEP));
            // ANCHORED AT BOTH ENDS or not — that is the whole distinction.
            // The middle of a proper bridge is unsupported and prints fine; a
            // run that simply stops in mid-air is a cantilever and droops.
            const sup = [];
            for (let k = 0; k <= n; k++) {
                const t = k / n, px = x + (nx - x) * t, py = y + (ny - y) * t;
                const p = idx(px, py);
                sup.push(p >= 0 && prev[p] === 1);
            }
            const dl = d / n;
            let k = 0;
            while (k <= n) {
                if (sup[k]) { k++; continue; }
                let e = k;
                while (e <= n && !sup[e]) e++;
                const len = (e - k) * dl;
                // anchored at both ends only if supported samples bracket it
                // INSIDE this move; a run touching either end of the move is
                // open as far as this move can tell
                if (len > 0.6) runs.push({ len, both: k > 0 && e <= n });
                k = e;
            }
        }
        mark(cur, x, y, nx, ny);
    }
    x = nx; y = ny;
}

const bridged = runs.filter(r => r.both).map(r => r.len).sort((a, b) => a - b);
const open = runs.filter(r => !r.both).map(r => r.len).sort((a, b) => a - b);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const over = (a, m) => sum(a.filter(r => r >= m));
console.log(`${file.split('/').pop()}`);
console.log(`  BRIDGED (anchored both ends): ${sum(bridged).toFixed(0)} mm, max ${(bridged.at(-1) ?? 0).toFixed(1)}`);
console.log(`  OPEN-ENDED (stops in mid-air): ${sum(open).toFixed(0)} mm, max ${(open.at(-1) ?? 0).toFixed(1)}`);
console.log(`     open-ended over 5 mm:  ${over(open, 5).toFixed(0)} mm`);
console.log(`     open-ended over 10 mm: ${over(open, 10).toFixed(0)} mm`);
console.log(`     open-ended over 20 mm: ${over(open, 20).toFixed(0)} mm`);
