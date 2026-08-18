#!/usr/bin/env node
/**
 * SIZE THE COLLET, AND TRY IT WITH A HEX HOLE.
 *
 *   node scripts/collet_plate.mjs
 *
 * MEASURED, and it overturns the arithmetic every earlier plate was sized by.
 * Brett put calipers across the real base tenons:
 *
 *   smallest 9.53 mm across vertices · largest 9.60 · SPREAD 0.07
 *
 * Every previous ladder here assumed 9.65-9.93, a 0.28 spread, and sized the
 * fingers to swallow it. They do not have to swallow anything like that. The
 * collet's job is four times smaller than it was designed for.
 *
 * DRAWN IS NOT PRINTED, and mixing the two frames is what hid this:
 *
 *   tenon  drawn 9.93 across corners  ->  prints 9.53-9.60
 *   bore   drawn 9.70                 ->  prints about 9.60
 *
 * The bore figure is read back from behaviour, not calipers: the printed 9.70
 * collet is "just barely tight enough for the largest with virtually no spring
 * needed ... wobbly loose on the smallest." A bore that only just touches a
 * 9.60 tenon IS 9.60. So 9.70 did not fail because the spread beat it — it is
 * sized 0.10-0.17 too big and the fingers never load at all.
 *
 *   drawn   prints   vs 9.53 smallest   vs 9.60 largest
 *   9.40     9.30    grips 0.23         grips 0.30
 *   9.55     9.45    grips 0.08         grips 0.15
 *   9.70     9.60    loose 0.07         grips 0.00      <- THE CONTROL
 *
 * SLOT LENGTH IS NOT A VARIABLE HERE. An earlier draft lengthened the fingers
 * to 14 mm to buy reach over a 0.28 spread; against 0.07 there is nothing to
 * reach for, and Brett: "I don't think the slit should be longer, it doesn't
 * need it to flex correctly." 10.5 mm, as printed and approved.
 *
 * THE HEX HOLE IS THE OTHER HALF OF THE PLATE, and it is Brett's proposal:
 * "the alignment of the hex, and the flexibility/adaptability of the collet."
 * It has the better prior. Hex-on-hex is the one pillar joint that has never
 * been in doubt — the shipped socket is 8.75 AF against an 8.6 AF tenon and it
 * is "very nice and tight" — and the reason a round bore has been so hard to
 * size is that THE TENON IS TAPERED: 8.6 AF at the root falling to 8.3 at the
 * tip. A cylinder can only touch a tapered hex at ONE height, so its grip is a
 * ring of six points that slides with insertion depth. A hex hole beds on six
 * FLATS over the whole engagement, and slotting it adds the give.
 *
 *   H875   8.75 AF — the shipped socket, slotted. Grip from the slots alone.
 *   H860   8.60 AF — meets the tenon root exactly: zero clearance at the seat.
 *   H845   8.45 AF — 0.15 interference; the fingers must open to admit it.
 *
 * ---------------------------------------------------------------------------
 * PRINT THIS PLATE WITH BRIM ON. Not a preference — the collet's first layer is
 * THREE SEPARATE ISLANDS, and that is what spaghettified a post on the last
 * plate. The slots are cut at the hex corners and run out to r 9.0, past the
 * 8.66 corner radius, so they sever the shell: a plain post lands 116 mm2 in
 * one piece, the collet lands 3 x 35 mm2 that stay separate for the full 10.5
 * mm of slot. Three tall thin unbraced crescents, and the one that failed was
 * first in the grid where the nozzle arrives coldest.
 *
 * This is inherent, not a bug to design out. A collet's fingers must be FREE at
 * the mouth, the mouth is at the bed, and free-at-the-bed means islands. The
 * alternatives were worked through and all fail: stopping the slot short of the
 * shell leaves the fingers tied by a ligament in hoop tension (0.55 mm of
 * stretch shared by three 1 mm webs is 18% strain — it cracks, it does not
 * spring); rooting the fingers at the bed instead puts the compliance at the
 * blind end where the tenon never reaches; a shared base pad is the same hoop
 * problem 0.6 mm tall. A brim costs a checkbox and removes in seconds.
 *
 * If a slotted bore wins, production needs its own answer to this. That is a
 * decision to take once we know which bore wins, not before.
 * ---------------------------------------------------------------------------
 *
 * MARKING. The engraved code is the variant, at cap 4.0 mm so it reads across a
 * bench. NOTCHES ARE THE RANK WITHIN THE FAMILY, tightest first — R940 and H845
 * get 1, R955 and H860 get 2, R970 and H875 get 3. Copies of one variant are
 * interchangeable and carry no extra mark; counting copies is what made the
 * first set unreadable.
 *
 * READ IT AGAINST ALL NINE BASES. The winner grips the 9.53 one AND accepts the
 * 9.60 one. A bore that only spans the top of the range is a fixed diameter
 * with extra steps — which is precisely what the control turned out to be.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as fflate from 'fflate';
import { SPEC, layoutTrack, planPillarPositions } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildRiserGeometry, csgChain,
    toBufferGeometry, SUBTRACTION, CALIBRATION } from '../js/pieces.js';
import { extrudePolygonY } from '../js/geometry.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { slabIslands } from './first_layer.mjs';

const OUT = 'test-parts/collet';
const CAP = 4.0;                  // engraved cap height — the first set was 2.4
const REACH = SPEC.socket.depth + 0.5;   // 10.5, the finger length that was approved

/** Rank within the family, countable by feel: 1 = tightest. */
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
 * The slots sit at 60/180/300 deg, which is where BOTH hexes put a corner: the
 * shaft's, so the cut leaves the engraved flat alone, and the hex bore's, so
 * each finger keeps two whole flats to bed on and the cut lands on the stress
 * concentration instead of beside it.
 *
 * The gate pin does the same thing from the male side — a hollow pin with one
 * axial slot, a C-spring, mating at 0.00 clearance — and it is the only joint
 * in this library that absorbs its own variation instead of being sized around
 * it.
 */
function colletBore(g) {
    const ops = [];
    for (let i = 0; i < 3; i++) {
        const a = ((i + 0.5) / 3) * 2 * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rect = [[3.0, -0.5], [9.0, -0.5], [9.0, 0.5], [3.0, 0.5]]
            .map(([u, v]) => [u * ca - v * sa, u * sa + v * ca]);
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(
            extrudePolygonY(rect, -1, REACH)) });
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
    // AND IT MUST STAND UP. Total bed area is not the question — a part can
    // have plenty of it in pieces that each have to hold their own tower down.
    // The gate is on the SMALLEST island.
    let y0 = Infinity;
    for (let i = 1; i < P.length; i += 3) y0 = Math.min(y0, P[i]);
    const fl = slabIslands(P, I, y0 + 0.10);
    const smallest = fl.areas[fl.areas.length - 1] ?? 0;
    if (smallest < 25) {
        console.error(`*** ${name}: an island of only ${smallest.toFixed(0)} mm2`);
        process.exit(1);
    }
    parts.push({ name, positions: P, indices: I, cm3: r.volumeMm3 / 1000, fl, note });
};

const post = (opts, code) => buildRiserGeometry(15, SPEC, { ...opts, code, capHeight: CAP });

// tightest first, so the notch count IS the rank within the family
const LADDER = [
    ['R940', { roundSocketDia: 9.40 }, 'round 9.40 · prints ~9.30 · grips 0.23/0.30 — stiff bracket'],
    ['R955', { roundSocketDia: 9.55 }, 'round 9.55 · prints ~9.45 · grips 0.08/0.15 — THE PREDICTION'],
    ['R970', { roundSocketDia: 9.70 }, 'round 9.70 · THE CONTROL — the exact geometry you printed'],
    ['H845', { hexSocketAF: 8.45 },    'hex 8.45 AF · 0.15 interference at the root — fingers must open'],
    ['H860', { hexSocketAF: 8.60 },    'hex 8.60 AF · meets the tenon root — zero clearance at the seat'],
    ['H875', { hexSocketAF: 8.75 },    'hex 8.75 AF · THE SHIPPED SOCKET, slotted — grip from slots alone'],
];
LADDER.forEach(([code, opts, note], i) => {
    for (let n = 1; n <= 2; n++) {
        add(`${code}_${n}`, csgChain(colletBore(post(opts, code)), notchOps((i % 3) + 1)),
            `${note}   [${(i % 3) + 1} notch]`);
    }
});

// thermal load, so this plate prints under the same conditions as the last one
const t = layoutTrack(['start', 'straight', 'straight', 'curveR', 'straight', 'end'],
    { skirtStyle: 'minimal', slopeDeg: 11.2167, tileLen: CALIBRATION.rampTileLenMm });
const sups = planPillarPositions(t.pieces);
let tile = null, tileSup = null;
for (const p of t.pieces.filter((q) => q.type === 'straight')) {
    const su = sups.find((x) => x.pieceIndex === p.index);
    if (su && su.mode !== 'none') { tile = p; tileSup = su; break; }
}
add('cal_ramp', buildPieceExportGeometry(tile, { support: tileSup, forPrint: true }),
    'thermal load, matching the last plate');

const bbox = (p) => { let x0=1e9,x1=-1e9,y0=1e9,z0=1e9,z1=-1e9;
    for (let i = 0; i < p.length; i += 3) {
        x0=Math.min(x0,p[i]); x1=Math.max(x1,p[i]); y0=Math.min(y0,p[i+1]);
        z0=Math.min(z0,p[i+2]); z1=Math.max(z1,p[i+2]); }
    return { x0, x1, y0, z0, z1 }; };
const objs = [];
// 10 mm of clear air between posts, because a brim needs somewhere to go
let cx = 20, row = 60, rowDepth = 0;
for (const p of parts) {
    const b = bbox(p.positions);
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    let at;
    if (p.name === 'cal_ramp') at = [128 - (b.x0 + b.x1) / 2, 195 + (b.z0 + b.z1) / 2, -b.y0];
    else {
        if (cx + w > 236) { cx = 20; row += rowDepth + 12; rowDepth = 0; }
        at = [cx - b.x0, row - b.z0, -b.y0];
        cx += w + 12; rowDepth = Math.max(rowDepth, d);
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
console.log(`${parts.length} objects, ${parts.reduce((s, p) => s + p.cm3, 0).toFixed(1)} cm3, all watertight`);
console.log('PRINT WITH BRIM ON — see the header.\n');
for (const p of parts) console.log(`   ${p.name.padEnd(10)} ${p.cm3.toFixed(2).padStart(6)} cm3  `
    + `${String(p.fl.islands).padStart(2)} island(s) `
    + `${p.fl.areas.map(a => a.toFixed(0)).join('+').padEnd(12)} mm2   ${p.note}`);
