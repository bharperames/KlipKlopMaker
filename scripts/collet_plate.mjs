#!/usr/bin/env node
/**
 * TUNE THE COLLET. The mechanism is settled; only its resting size is not.
 *
 *   node scripts/collet_plate.mjs
 *
 * WHAT THE LAST PLATE SETTLED. Against four foot tenons spanning the real
 * printed range, Brett found:
 *
 *   COL  slit spring    3 of 4 — good on the largest, acceptable on the next
 *                       two, loose only on the smallest. "The spring sides
 *                       flex nicely, so the design is good."
 *   HEX  plain 9.70     1 of 4 — jams the largest, tight on the second, loose
 *                       below. This is the fit that has been moving all week.
 *   RIB  ribs at 9.60   1 of 4 — only the largest, despite gripping NOMINALLY
 *                       tighter than the plain bore. Three small pads do not
 *                       survive contact; they print short, or crush flat on
 *                       first insertion. The rib approach is dropped, not
 *                       retuned.
 *
 * So the round bore becomes a COLLET, for the reason the gate pin already
 * demonstrated: it absorbs its own variation instead of being sized around it.
 *
 * WHAT IS LEFT. The collet's one gap is the SMALLEST tenon, and that is sizing,
 * not design — at a 9.70 resting bore the fingers never load against a small
 * tenon, so there is nothing to spring. Bring the resting diameter down and the
 * bottom of the range comes into contact. This plate is that ladder:
 *
 *   C945   resting bore 9.45     · notches 1,2,3 = copy A,B,C
 *   C955   resting bore 9.55
 *   C965   resting bore 9.65
 *   C95L   9.55 with LONGER slots — more compliant fingers, in case range
 *          rather than size is the limit
 *
 * READ IT AGAINST YOUR SIX BASES, smallest tenon to largest. The winner is the
 * bore that grips ALL of them, not the one that grips the middle best. A collet
 * that only spans four is the same failure as a fixed diameter, just wider.
 *
 * MARKING, because the last set was unreadable. The code is the resting bore at
 * cap 4.0 mm — 67% larger than the 2.4 used before, and still inside the 12 mm
 * a 15 mm flat allows. NOTCHES ARE THE COPY NUMBER now, not the variant: the
 * variant is written on the part in letters you can actually read. Two lines
 * would force the cap back down, so the code is one line and the copy is
 * counted instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as fflate from 'fflate';
import { SPEC, layoutTrack, planPillarPositions } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildRiserGeometry, csgChain,
    toBufferGeometry, SUBTRACTION, CALIBRATION, HEX_FLAT_CAP } from '../js/pieces.js';
import { extrudePolygonY } from '../js/geometry.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { audit } from './overhang_audit.mjs';

const OUT = 'test-parts/collet';
const CAP = 4.0;                 // engraved cap height — the last set was 2.4

/** Copy number, countable by feel. */
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
 * Slot the bore wall so it can open — three fingers that spring apart.
 *
 * `reach` is how far up the slots run. Longer slots make longer, more compliant
 * fingers, which widens the range of tenon the collet can take before the force
 * becomes silly. The gate pin does the same thing with one axial slot on the
 * male side and mates at 0.00 clearance.
 */
function colletBore(g, socketDepth, reach = socketDepth + 0.5) {
    const ops = [];
    for (let i = 0; i < 3; i++) {
        const a = ((i + 0.5) / 3) * 2 * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rect = [[3.0, -0.5], [9.0, -0.5], [9.0, 0.5], [3.0, 0.5]]
            .map(([u, v]) => [u * ca - v * sa, u * sa + v * ca]);
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(
            extrudePolygonY(rect, -1, reach)) });
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
    // and it must stand up: a watertight part balanced on three rib tips is
    // what the last plate nearly shipped
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
        console.error(`*** ${name}: only ${bed.toFixed(0)} mm2 on the bed`); process.exit(1);
    }
    parts.push({ name, positions: P, indices: I, cm3: r.volumeMm3 / 1000, bed, note });
};

const DEPTH = SPEC.socket.depth;
const post = (bore, code) => buildRiserGeometry(15,
    { ...SPEC, socket: { ...SPEC.socket, boreDia: bore } },
    { code, capHeight: CAP });

for (const [bore, code] of [[9.45, 'C945'], [9.55, 'C955'], [9.65, 'C965']]) {
    for (let n = 1; n <= 3; n++) {
        add(`${code}_${n}`, csgChain(colletBore(post(bore, code), DEPTH), notchOps(n)),
            `resting bore ${bore.toFixed(2)} · copy ${n}`);
    }
}
// longer fingers at the middle size, in case RANGE is the limit rather than size
for (let n = 1; n <= 2; n++) {
    add(`C95L_${n}`, csgChain(colletBore(post(9.55, 'C95L'), DEPTH, DEPTH + 4), notchOps(n)),
        'resting bore 9.55, slots 4 mm longer · copy ' + n);
}

// thermal load, so this plate prints under the same conditions as the last one
const t = layoutTrack(['start', 'straight', 'straight', 'curveR', 'straight', 'end'],
    { skirtStyle: 'minimal', slopeDeg: 11.2167, tileLen: CALIBRATION.rampTileLenMm });
const sups = planPillarPositions(t.pieces);
let tile = null, tileSup = null;
for (const p of t.pieces.filter((q) => q.type === 'straight')) {
    const su = sups.find((x) => x.pieceIndex === p.index);
    if (su && su.mode !== 'none') { tile = p; tileSup = su; break; }
}
const sg = buildPieceExportGeometry(tile, { support: tileSup, forPrint: true });
add('cal_ramp', sg, 'thermal load, matching the last plate');

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
const file = path.join(OUT, 'collet.3mf');
fs.writeFileSync(file, Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(generateMultiObject3MFXML(objs)), { level: 6 }]
})));

console.log(`\n${file}`);
console.log(`${parts.length} objects, ${parts.reduce((s, p) => s + p.cm3, 0).toFixed(1)} cm3, all watertight\n`);
for (const p of parts) console.log(`   ${p.name.padEnd(10)} ${p.cm3.toFixed(2).padStart(7)} cm3  `
    + `${p.bed.toFixed(0).padStart(6)} mm2 bed   ${p.note}`);
