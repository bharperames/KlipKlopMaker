#!/usr/bin/env node
/**
 * STRUCTURAL AUDIT FROM THE GEOMETRY, not from the slicer.
 *
 * Every previous answer to "is this part printable" came from slicing it and
 * reading a warning or counting bridge moves. Both are downstream of a profile
 * and one of them turned out to be a knife edge (0.044 mm of socket position
 * flips it). This reads the MESH: it finds every downward-facing face, casts a
 * ray straight down from it, and reports how far the material falls before it
 * lands on something. That distance is the thing that actually decides whether
 * a ceiling sags — a 2 mm drop is a detail, a 20 mm drop is a cantilever — and
 * it is a property of the part alone.
 *
 * Reported per cluster, worst first:
 *   area    how much ceiling is unsupported there
 *   drop    how far it is to the next material below (Infinity = open to the bed)
 *   span    the widest gap it has to cross, measured on its own layer
 *
 *   node scripts/overhang_audit.mjs <file.3mf> [minArea mm2]
 *
 * A face is "downward" at more than 45 degrees from vertical, which is the same
 * threshold slicers use to decide a wall needs support. Faces within `BED_EPS`
 * of the lowest point are the part sitting on the plate and are not overhangs.
 */

import fs from 'node:fs';
import * as fflate from 'fflate';

const BED_EPS = 0.6;
const DOWN_COS = -0.7071;        // 45 degrees
const CELL = 4;                  // XZ bucket size for the ray cast

export function loadObjects(file) {
    const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(file)));
    const xml = Buffer.from(zip['3D/3dmodel.model']).toString('utf8');
    const out = [];
    for (const m of xml.matchAll(/<object id="(\d+)" type="model" name="([^"]*)">([\s\S]*?)<\/object>/g)) {
        const V = [...m[3].matchAll(/<vertex x="(-?[\d.eE+-]+)" y="(-?[\d.eE+-]+)" z="(-?[\d.eE+-]+)"/g)]
            .map(v => [+v[1], +v[2], +v[3]]);
        const T = [...m[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
            .map(t => [+t[1], +t[2], +t[3]]);
        out.push({ name: m[2], V, T });
    }
    return out;
}

/**
 * In a 3MF the part is Z-up. Returns clusters of unsupported ceiling.
 */
export function audit(obj, minArea = 5) {
    const { V, T } = obj;
    let zMin = Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const v of V) {
        zMin = Math.min(zMin, v[2]);
        x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]);
        y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]);
    }
    // bucket every triangle by the XZ cells its bounding box covers, so a
    // downward ray only tests the few hundred triangles beneath it
    const NX = Math.ceil((x1 - x0) / CELL) + 2, NY = Math.ceil((y1 - y0) / CELL) + 2;
    const grid = new Map();
    const push = (i, j, t) => {
        const k = j * NX + i;
        let a = grid.get(k); if (!a) grid.set(k, a = []);
        a.push(t);
    };
    for (let t = 0; t < T.length; t++) {
        const P = [V[T[t][0]], V[T[t][1]], V[T[t][2]]];
        const bx0 = Math.min(P[0][0], P[1][0], P[2][0]), bx1 = Math.max(P[0][0], P[1][0], P[2][0]);
        const by0 = Math.min(P[0][1], P[1][1], P[2][1]), by1 = Math.max(P[0][1], P[1][1], P[2][1]);
        for (let i = Math.floor((bx0 - x0) / CELL); i <= Math.ceil((bx1 - x0) / CELL); i++)
            for (let j = Math.floor((by0 - y0) / CELL); j <= Math.ceil((by1 - y0) / CELL); j++)
                if (i >= 0 && j >= 0 && i < NX && j < NY) push(i, j, t);
    }
    /** highest surface strictly below z at (x, y), or null for open air */
    const below = (x, y, z) => {
        const i = Math.floor((x - x0) / CELL), j = Math.floor((y - y0) / CELL);
        const a = grid.get(j * NX + i); if (!a) return null;
        let best = null;
        for (const t of a) {
            const A = V[T[t][0]], B = V[T[t][1]], C = V[T[t][2]];
            const d1x = B[0] - A[0], d1y = B[1] - A[1], d2x = C[0] - A[0], d2y = C[1] - A[1];
            const den = d1x * d2y - d1y * d2x;
            if (Math.abs(den) < 1e-12) continue;
            const px = x - A[0], py = y - A[1];
            const w1 = (px * d2y - py * d2x) / den, w2 = (d1x * py - d1y * px) / den;
            if (w1 < -1e-9 || w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
            const zz = A[2] + w1 * (B[2] - A[2]) + w2 * (C[2] - A[2]);
            if (zz < z - 0.05 && (best === null || zz > best)) best = zz;
        }
        return best;
    };

    const faces = [];
    for (let t = 0; t < T.length; t++) {
        const A = V[T[t][0]], B = V[T[t][1]], C = V[T[t][2]];
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
        const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const L = Math.hypot(nx, ny, nz); if (!L) continue;
        if (nz / L > DOWN_COS) continue;
        const cz = (A[2] + B[2] + C[2]) / 3;
        if (cz - zMin < BED_EPS) continue;                 // sitting on the plate
        const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3;
        const land = below(cx, cy, cz);
        faces.push({ tri: t, x: cx, y: cy, z: cz - zMin, area: L / 2, drop: land === null ? Infinity : cz - land });
    }
    // cluster adjacent faces at a similar height
    const key = (f) => `${Math.round(f.x / 8)}|${Math.round(f.y / 8)}|${Math.round(f.z / 5)}`;
    const cl = new Map();
    for (const f of faces) {
        const k = key(f);
        let e = cl.get(k);
        if (!e) cl.set(k, e = { area: 0, x: 0, y: 0, z: 0, drop: 0, maxDrop: 0, n: 0 });
        e.area += f.area; e.x += f.x; e.y += f.y; e.z += f.z; e.n++;
        const d = f.drop === Infinity ? f.z : f.drop;
        e.drop += d; e.maxDrop = Math.max(e.maxDrop, d);
    }
    // SPAN, which is the measure that actually predicts sag. Area and drop
    // together still rank a ribbed curve as worse than a hollow one: ribs at an
    // 18 mm pitch leave just as much ceiling hanging just as far, and it prints
    // fine because no single stretch of it is wide. What matters is how far a
    // bridge has to reach before it lands on something. Rasterise the
    // unsupported ceiling, mark every cell that HAS support close beneath it,
    // and flood outward — the deepest cell is half the span.
    const G = 1;
    const gx = Math.ceil((x1 - x0) / G) + 2, gy = Math.ceil((y1 - y0) / G) + 2;
    const ceilCell = new Int32Array(gx * gy).fill(-1);   // index into `faces`
    const cellDrop = new Float64Array(gx * gy);
    // RASTERISE THE WHOLE TRIANGLE, not its centroid. Marking one cell per face
    // left every interior cell of a large ceiling looking unsupported-adjacent,
    // so the flood terminated immediately and every part measured a 2 mm span.
    for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi], t = f.tri;
        const A = V[T[t][0]], B = V[T[t][1]], C = V[T[t][2]];
        const bx0 = Math.min(A[0], B[0], C[0]), bx1 = Math.max(A[0], B[0], C[0]);
        const by0 = Math.min(A[1], B[1], C[1]), by1 = Math.max(A[1], B[1], C[1]);
        const d1x = B[0] - A[0], d1y = B[1] - A[1], d2x = C[0] - A[0], d2y = C[1] - A[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;
        for (let i = Math.floor((bx0 - x0) / G); i <= Math.ceil((bx1 - x0) / G); i++) {
            for (let j = Math.floor((by0 - y0) / G); j <= Math.ceil((by1 - y0) / G); j++) {
                if (i < 0 || j < 0 || i >= gx || j >= gy) continue;
                const px = x0 + i * G - A[0], py = y0 + j * G - A[1];
                const w1 = (px * d2y - py * d2x) / den, w2 = (d1x * py - d1y * px) / den;
                if (w1 < -0.02 || w2 < -0.02 || w1 + w2 > 1.02) continue;
                const p = j * gx + i;
                const d = f.drop === Infinity ? f.z : f.drop;
                if (d > cellDrop[p]) { cellDrop[p] = d; ceilCell[p] = fi; }
            }
        }
    }
    // Anchored: no ceiling here at all (solid, or outside the part), or one that
    // lands almost at once. A bridge reaching such a cell has something to sit on.
    const supported = new Uint8Array(gx * gy);
    for (let p = 0; p < supported.length; p++) if (cellDrop[p] <= 3) supported[p] = 1;
    const dist = new Float64Array(gx * gy).fill(Infinity);
    const q = [];
    for (let p = 0; p < supported.length; p++) if (supported[p]) { dist[p] = 0; q.push(p); }
    for (let h = 0; h < q.length; h++) {
        const c = q[h], ci = c % gx, cj = (c - ci) / gx;
        for (const [oi, oj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ai = ci + oi, aj = cj + oj;
            if (ai < 0 || aj < 0 || ai >= gx || aj >= gy) continue;
            const n = aj * gx + ai;
            if (dist[n] !== Infinity) continue;
            dist[n] = dist[c] + G; q.push(n);
        }
    }

    const out = [];
    for (const e of cl.values()) {
        if (e.area < minArea) continue;
        out.push({ area: e.area, x: e.x / e.n, y: e.y / e.n, z: e.z / e.n,
            drop: e.drop / e.n, maxDrop: e.maxDrop, span: 0 });
    }
    // attribute each cell's reach to the cluster it belongs to
    for (let p = 0; p < ceilCell.length; p++) {
        const fi = ceilCell[p]; if (fi < 0 || !isFinite(dist[p]) || dist[p] === 0) continue;
        const f = faces[fi];
        let best = null, bd = Infinity;
        for (const r of out) {
            const d = Math.hypot(r.x - f.x, r.y - f.y) + Math.abs(r.z - f.z);
            if (d < bd) { bd = d; best = r; }
        }
        if (best && bd < 14) best.span = Math.max(best.span, 2 * dist[p]);
    }
    // A CEILING IS AS BAD AS ITS SPAN, then its drop. Ranking on area alone puts
    // the socket collar (broad, 2.4 mm above its own recess, known and accepted)
    // above a narrow shelf hanging 20 mm over nothing.
    out.sort((a, b) => (b.span - a.span) || (b.maxDrop - a.maxDrop));
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const file = process.argv[2];
    const minArea = Number(process.argv[3] ?? 5);
    if (!file) { console.error('usage: node scripts/overhang_audit.mjs <file.3mf> [minArea]'); process.exit(1); }
    for (const o of loadObjects(file)) {
        const rows = audit(o, minArea);
        const tot = rows.reduce((s, r) => s + r.area, 0);
        const bad = rows.filter(r => r.maxDrop > 3);
        console.log(`\n${o.name}   ${rows.length} ceilings over ${minArea} mm2, ${tot.toFixed(0)} mm2 total`);
        console.log(`   ${bad.length} of them fall more than 3 mm  (${bad.reduce((s, r) => s + r.area, 0).toFixed(0)} mm2)`);
        const wide = rows.filter(r => r.span > 20);
        console.log(`   worst span ${(rows[0]?.span ?? 0).toFixed(1)} mm;  ${wide.length} cluster(s) span over 20 mm`);
        console.log('      span      area      drop    height   at (x, y)');
        for (const r of rows.slice(0, 10)) {
            console.log(`   ${r.span.toFixed(1).padStart(7)}  ${r.area.toFixed(1).padStart(8)}  ${r.maxDrop.toFixed(1).padStart(7)}  ${r.z.toFixed(1).padStart(7)}   (${r.x.toFixed(0)}, ${r.y.toFixed(0)})`);
        }
    }
}
