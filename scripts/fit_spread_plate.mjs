#!/usr/bin/env node
/**
 * DOES TRUNCATING THE TENON'S CORNERS REDUCE THE SPREAD? — a plate built to
 * answer that and nothing else.
 *
 *   node scripts/fit_spread_plate.mjs
 *
 * WHY REPEATS. Every fit plate so far carried ONE of each variant, and one of
 * each cannot answer this question. The complaint is not that the fit is wrong,
 * it is that it is INCONSISTENT: the same drawing measured 9.65 to 9.93 across
 * corners, and Brett found two nominally identical feet where "one seems to be
 * a .01mm wider across vertex measurement and that is just enough to make the
 * tenon stick". A single sample of a variable process tells you where one
 * sample landed. So this plate carries FOUR of each tenon, and the reading that
 * matters is how much they differ from each other, not how any one feels.
 *
 * WHAT IS BEING COMPARED. A post is both halves of the joint — a tenon on top,
 * a bore in the base — so any post's tenon can be pushed into any post's bore
 * and the set cross-tests itself.
 *
 *   HEX A-D    plain hex tenon, bore 9.65     · 1 notch
 *   TRN A-D    corners clipped to 9.60, 9.65  · 2 notches
 *   HX60 A-B   plain hex tenon, bore 9.60     · 3 notches
 *   TR60 A-B   truncated tenon,  bore 9.60    · 4 notches
 *   FOOT A-B   two feet, full tenon           (the joint that stuck)
 *
 * HOW TO READ IT, in order:
 *
 *  1. Push HEX A, B, C, D each into the SAME bore. Do they feel the same? The
 *     spread you feel here is today's problem, quantified by hand.
 *  2. Do the same with TRN A-D. If they feel more alike than the HEX four did,
 *     truncation works and the argument is settled. If they are just as varied,
 *     it does not and I should stop proposing it.
 *  3. Only then compare 9.60 against 9.65 within a tenon type, to pick a bore.
 *  4. The feet last: a full-size foot tenon into a 9.65 and a 9.60 bore.
 *
 * THE PREDICTION, written down first so it can be wrong: truncated tenons
 * should mate near 9.617 across corners with roughly a third of the spread,
 * because the contact moves from a 120 degree point (nozzle turns 60) to the
 * ends of a drawn 0.57 mm facet (nozzle turns 30). Against a 9.65 bore that is
 * +0.016 mm/side. If the TRN posts feel LOOSE rather than consistent, the
 * contact model is wrong — they contact at radius 4.809, not at the 4.800 flat.
 *
 * A cal_ramp rides along as thermal load, because the bore fit has already been
 * shown to move with what else is on the plate.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as fflate from 'fflate';
import { SPEC, layoutTrack, planPillarPositions } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildRiserGeometry,
    buildSupportFootGeometry, csgChain, toBufferGeometry, SUBTRACTION,
    CALIBRATION } from '../js/pieces.js';
import { extrudePolygonY } from '../js/geometry.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { audit } from './overhang_audit.mjs';

const OUT = 'test-parts/fit_spread';
const CLIP_AC = 9.60;          // where the corners get cut back to

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
 * Cut the six corners off a tenon so its across-corners is drawn, not emergent.
 * Six half-spaces at the CORNER angles — hexPlan puts vertices at 0/60/120, and
 * offsetting by 30 lands them on the flats, where a 4.80 cut removes nothing.
 */
function truncateCorners(g, maxAC, y0, y1) {
    const r = maxAC / 2;
    const ops = [];
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 2 * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rect = [[r, -14], [22, -14], [22, 14], [r, 14]]
            .map(([u, v]) => [u * ca - v * sa, u * sa + v * ca]);
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(rect, y0, y1)) });
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
    parts.push({ name, positions: P, indices: I, cm3: r.volumeMm3 / 1000, note });
};

const post = (bore, code) => buildRiserGeometry(15,
    { ...SPEC, socket: { ...SPEC.socket, boreDia: bore } }, { code });
const trunc = (g) => truncateCorners(g, CLIP_AC, 14.9, 15 + SPEC.socket.depth);

for (const L of ['A', 'B', 'C', 'D']) {
    add(`HEX_${L}`, csgChain(post(9.65, `HEX ${L}`), notchOps(1)), 'plain tenon · bore 9.65');
}
for (const L of ['A', 'B', 'C', 'D']) {
    add(`TRN_${L}`, csgChain(trunc(post(9.65, `TRN ${L}`)), notchOps(2)),
        `corners clipped to ${CLIP_AC} · bore 9.65`);
}
for (const L of ['A', 'B']) {
    add(`HX60_${L}`, csgChain(post(9.60, `HX60 ${L}`), notchOps(3)), 'plain tenon · bore 9.60');
}
for (const L of ['A', 'B']) {
    add(`TR60_${L}`, csgChain(trunc(post(9.60, `TR60 ${L}`)), notchOps(4)),
        `corners clipped to ${CLIP_AC} · bore 9.60`);
}
for (const L of ['A', 'B']) {
    add(`FOOT_${L}`, buildSupportFootGeometry(SPEC, { code: `FOOT ${L}` }), 'full tenon · the joint that stuck');
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
for (const p of parts) console.log(`   ${p.name.padEnd(11)} ${p.cm3.toFixed(2).padStart(7)} cm3   ${p.note}`);
console.log(`\ncal_ramp worst unsupported span ${(rows[0]?.span ?? 0).toFixed(1)} mm, `
    + `${rows.filter((r) => r.span > 20).length} over 20`);
