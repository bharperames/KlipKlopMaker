/**
 * A COMPLIANT BORE, BECAUSE THE TENON IS NOT ALLOWED TO MOVE.
 *
 *   node scripts/fit_spread_plate.mjs
 *
 * Brett: "We have kept the tenon dimension invariant because of these ramp
 * sockets and I want to keep it that way." The hex tenon mates with the HEX
 * SOCKET in every ramp and curve already printed, and that pairing works.
 * Changing it to suit the round bore would break the half that is proven to
 * satisfy the half that is not. An earlier version of this plate carried a
 * truncated tenon; it is gone.
 *
 * SO THE ARITHMETIC FALLS ON THE BORE, and it is decisive. The same tenon
 * drawing prints 9.65 to 9.93 across corners. A bore that always ACCEPTS the
 * largest needs D >= 9.93; one that GRIPS the smallest needs D <= 9.65. No
 * plain cylinder is both, which is why boreDia has moved five times in a day
 * and why a 0.01 mm difference between two feet decided whether one stuck.
 * Something has to be compliant, and this project has already proved that
 * works: the gate pin is a split C at 0.00 clearance and reads "a great fit,
 * perfect".
 *
 * TWO WAYS TO MAKE A ROUND HOLE COMPLIANT, both tested here, tenon untouched:
 *
 *   RIB   a generous 10.00 bore with three ribs standing 0.20 proud at 120
 *         degrees, so the grip diameter is 9.60 while the hole itself clears
 *         the biggest tenon. Contact is three small pads that crush and bed in.
 *   COL   a collet: the 9.70 bore slotted through the wall three times over the
 *         socket depth, leaving three fingers that spring apart. This is the
 *         gate pin's trick applied to the female half. 2.65 mm of wall is
 *         available at the flats.
 *
 * WHY REPEATS. The complaint is not that the fit is wrong, it is that it is
 * INCONSISTENT. Every fit plate so far carried ONE of each variant, and one
 * sample of a variable process tells you where one sample landed. Four plain
 * bores establish today's spread by hand; three of each compliant bore say
 * whether it collapses that spread.
 *
 *   HEX A-D   plain bore 9.70, the control      · 1 notch
 *   RIB A-C   10.00 bore, 3 ribs to 9.60        · 2 notches
 *   COL A-C   9.70 bore, 3 slots, collet        · 3 notches
 *   FOOT A-B  two feet, full tenon              (the joint that stuck)
 *
 * HOW TO READ IT: push the four HEX tenons into the same HEX bore and feel how
 * much they differ — that is the problem, measured by hand. Then push the same
 * four tenons into a RIB bore, and into a COL bore. The winner is whichever
 * makes four different tenons feel the SAME, not whichever feels best once.
 *
 * A cal_ramp rides along as thermal load, because the bore fit has already been
 * shown to move with what else is on the plate.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as fflate from 'fflate';
import { SPEC, layoutTrack, planPillarPositions } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildRiserGeometry,
    buildSupportFootGeometry, csgChain, toBufferGeometry, SUBTRACTION, ADDITION,
    CALIBRATION } from '../js/pieces.js';
import { extrudePolygonY } from '../js/geometry.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { audit } from './overhang_audit.mjs';

const OUT = 'test-parts/fit_spread';

/** Countable notches, same geometry as tenon_sweep and the first fit plate. */
function notchOps(n) {
    const ops = [];
    for (let k = 0; k < n; k++) {
        const y = 10.8 + k * 1.3;
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(
            [[6.3, -12], [20, -12], [20, 12], [6.3, 12]], y, y + 0.8)) });
    }
    return ops;
}

/**
 * Three ribs standing proud inside an oversize bore.
 *
 * The hole clears the largest tenon on record, and the ribs — not the hole —
 * set the grip. A small tenon meets them lightly, a large one crushes them a
 * little; either way it enters, which a plain cylinder cannot promise.
 */
function ribbedBore(g, gripAC, socketDepth) {
    const rGrip = gripAC / 2;
    const ops = [];
    for (let i = 0; i < 3; i++) {
        const a = (i / 3) * 2 * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        // a 1.2 mm wide pad spanning from the grip radius outward into the wall
        const rect = [[rGrip, -0.6], [rGrip + 1.2, -0.6], [rGrip + 1.2, 0.6], [rGrip, 0.6]]
            .map(([u, v]) => [u * ca - v * sa, u * sa + v * ca]);
        // FROM 1.0, NOT BELOW ZERO. Started at -0.4 these stood 0.4 mm PROUD
        // of the base and the whole post balanced on three rib tips: 4 mm2 of
        // bed contact against 114 for a plain one, and Bambu called it a
        // floating cantilever, correctly. Starting above the socket's mouth
        // flare also gives the tenon a lead-in before it meets them.
        ops.push({ op: ADDITION, geometry: toBufferGeometry(
            extrudePolygonY(rect, 1.0, socketDepth - 1.5)) });
    }
    return csgChain(g, ops);
}

/**
 * A COLLET: slot the bore wall so it can open.
 *
 * Three radial slots over the socket depth leave three fingers. The gate pin
 * does this on the male side — a hollow pin with one axial slot, a C-spring,
 * mating at 0.00 clearance — and it is the only joint in this library that
 * absorbs its own variation instead of being sized around it.
 */
function colletBore(g, socketDepth) {
    const ops = [];
    for (let i = 0; i < 3; i++) {
        const a = ((i + 0.5) / 3) * 2 * Math.PI;      // between the ribs' angles
        const ca = Math.cos(a), sa = Math.sin(a);
        const rect = [[3.0, -0.5], [9.0, -0.5], [9.0, 0.5], [3.0, 0.5]]
            .map(([u, v]) => [u * ca - v * sa, u * sa + v * ca]);
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(
            extrudePolygonY(rect, -1, socketDepth + 0.5)) });
    }
    return csgChain(g, ops);
}

await initCSG();
fs.mkdirSync(OUT, { recursive: true });

const parts = [];
const add = (name, g, note) => {
    const P = g.positions ?? g.attributes.position.array;
    const I = g.indices ?? (g.index ? g.index.array
        : Uint32Array.from({ length: P.length / 3 }, (_, i) => i));
    const r = analyzeMesh(P, I);
    if (!(r.isManifold && r.isConsistent && r.windsOutward)) {
        console.error(`*** ${name} IS NOT WATERTIGHT — nothing written`); process.exit(1);
    }
    // IT MUST ALSO BE ABLE TO STAND UP. analyzeMesh says a mesh is closed, not
    // that it will print: the first ribbed bore was watertight AND balanced on
    // three 0.4 mm rib tips, 4 mm2 of bed contact against 114. A gate that only
    // checks topology passes that happily.
    let z0 = Infinity;
    for (let i = 2; i < P.length; i += 3) z0 = Math.min(z0, P[i]);
    let bed = 0;
    for (let k = 0; k < I.length; k += 3) {
        const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
        if (Math.max(P[a + 2], P[b + 2], P[c + 2]) > z0 + 0.15) continue;
        bed += Math.abs((P[b] - P[a]) * (P[c + 1] - P[a + 1])
                      - (P[b + 1] - P[a + 1]) * (P[c] - P[a])) / 2;
    }
    if (bed < 40) {
        console.error(`*** ${name} has only ${bed.toFixed(0)} mm2 on the bed — it would `
            + `print balanced on a few points. Nothing written.`); process.exit(1);
    }
    parts.push({ name, positions: P, indices: I, cm3: r.volumeMm3 / 1000, bed, note });
};

const post = (bore, code) => buildRiserGeometry(15,
    { ...SPEC, socket: { ...SPEC.socket, boreDia: bore } }, { code });
const DEPTH = SPEC.socket.depth;

for (const L of ['A', 'B', 'C', 'D']) {
    add(`HEX_${L}`, csgChain(post(9.70, `HEX ${L}`), notchOps(1)),
        'plain bore 9.70 — the control');
}
for (const L of ['A', 'B', 'C']) {
    add(`RIB_${L}`, csgChain(ribbedBore(post(10.00, `RIB ${L}`), 9.60, DEPTH), notchOps(2)),
        '10.00 bore, 3 ribs to 9.60');
}
for (const L of ['A', 'B', 'C']) {
    add(`COL_${L}`, csgChain(colletBore(post(9.70, `COL ${L}`), DEPTH), notchOps(3)),
        '9.70 bore, slotted — collet');
}
for (const L of ['A', 'B']) {
    add(`FOOT_${L}`, buildSupportFootGeometry(SPEC, { code: `FOOT ${L}` }),
        'full tenon · the joint that stuck');
}

// thermal load, and a real pocket/sole while we are here
const t = layoutTrack(['start', 'straight', 'straight', 'curveR', 'straight', 'end'],
    { skirtStyle: 'minimal', slopeDeg: 11.2167, tileLen: CALIBRATION.rampTileLenMm });
const sups = planPillarPositions(t.pieces);
let tile = null, tileSup = null;
for (const p of t.pieces.filter((q) => q.type === 'straight')) {
    const su = sups.find((x) => x.pieceIndex === p.index);
    if (su && su.mode !== 'none') { tile = p; tileSup = su; break; }
}
const sg = buildPieceExportGeometry(tile, { support: tileSup, forPrint: true });
add('cal_ramp', sg, 'thermal load · plate composition moves the bore fit');

const bbox = (p) => { let x0=1e9,x1=-1e9,y0=1e9,z0=1e9,z1=-1e9;
    for (let i = 0; i < p.length; i += 3) {
        x0=Math.min(x0,p[i]); x1=Math.max(x1,p[i]); y0=Math.min(y0,p[i+1]);
        z0=Math.min(z0,p[i+2]); z1=Math.max(z1,p[i+2]); }
    return { x0, x1, y0, z0, z1 }; };
const objs = [];
let cx = 20, row = 60, rowDepth = 0;
for (const p of parts) {
    const b = bbox(p.positions);
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    let at;
    if (p.name === 'cal_ramp') at = [128 - (b.x0 + b.x1) / 2, 195 + (b.z0 + b.z1) / 2, -b.y0];
    else {
        if (cx + w > 236) { cx = 20; row += rowDepth + 8; rowDepth = 0; }
        at = [cx - b.x0, row - b.z0, -b.y0];
        cx += w + 8; rowDepth = Math.max(rowDepth, d);
    }
    objs.push({ name: p.name, positions: p.positions, indices: p.indices, at });
}
const file = path.join(OUT, 'fit_spread.3mf');
fs.writeFileSync(file, Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(generateMultiObject3MFXML(objs)), { level: 6 }]
})));

const rows = audit({ name: 'r',
    V: (() => { const V = []; for (let i = 0; i < sg.positions.length; i += 3)
        V.push([sg.positions[i], -sg.positions[i + 2], sg.positions[i + 1]]); return V; })(),
    T: (() => { const T = []; for (let i = 0; i < sg.indices.length; i += 3)
        T.push([sg.indices[i], sg.indices[i + 1], sg.indices[i + 2]]); return T; })() }, 5);

console.log(`\n${file}`);
console.log(`${parts.length} objects, ${parts.reduce((s, p) => s + p.cm3, 0).toFixed(1)} cm3, all watertight\n`);
for (const p of parts) console.log(`   ${p.name.padEnd(11)} ${p.cm3.toFixed(2).padStart(7)} cm3  `
    + `${p.bed.toFixed(0).padStart(6)} mm2 on the bed   ${p.note}`);
console.log(`\ncal_ramp worst unsupported span ${(rows[0]?.span ?? 0).toFixed(1)} mm, `
    + `${rows.filter((r) => r.span > 20).length} over 20`);
