#!/usr/bin/env node
/**
 * ONE PLATE THAT CHECKS EVERY FIT CHANGED THIS ROUND.
 *
 *   node scripts/fit_test_plate.mjs
 *
 * WHY IT CARRIES A FULL-SIZE STRAIGHT. The bore failure that started all of
 * this was not a modelling error: the 15 mm riser in the plate that assembles
 * and the one in the plate that does not have the SAME GEOMETRY HASH. What
 * differed was the plate — 5 small support parts in one case, 15 parts
 * including three big track pieces in the other. A plate of small parts alone
 * would therefore reproduce the condition that already WORKED and prove
 * nothing. The straight is here as a thermal load, and it doubles as the test
 * for the filled underside and the key pocket.
 *
 * WHAT IS BEING CHECKED, and how to read each one:
 *
 *  1. BORE LADDER — three risers, bores 9.60 / 9.70 / 9.80, one/two/three
 *     notches. 9.70 is what ships. Push a tenon into each: the shipping one
 *     should start easily on the taper and arrive snug. If 9.60 binds here it
 *     confirms the plate effect; if 9.80 is the only one that works, say so
 *     and the number moves.
 *  2. TENON TAPER — riser T carries the 0.30 AF lead-in that ships, riser P is
 *     the old parallel tenon. Both into the same 9.70 bore. T should find the
 *     hole without being aimed; P should be fussier. This is the only
 *     comparison on the plate that isolates the taper.
 *  3. THE FOOT IS NOT SPECIAL — a foot to put into the same bores as the
 *     risers. It used to measure 0.08 wider across corners; if that is really
 *     gone, it should feel like the risers do.
 *  4. KEY DRIVE TAPER — two keys and a straight with real pockets at both
 *     ends. The key is directional now: small end leads. Wrong way round it
 *     should stop early and obviously. Right way round it should tighten as it
 *     is driven and hold the seam closed.
 *  5. FILLED UNDERSIDE — the straight's own sole. Look for the pie slice that
 *     was there before (an open wedge near the ends), and for stranding under
 *     the deck.
 *  6. NO GRID MARKS — the risers are plain shafts now. Nothing to measure,
 *     just confirm they no longer read as parts that pull apart.
 *
 * Every object is gated with `analyzeMesh` before it is written, and the
 * overhang audit runs on the straight, because a test plate that is not itself
 * sound tests nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as fflate from 'fflate';
import { SPEC, layoutTrack, planPillarPositions } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildRiserGeometry,
    buildSupportFootGeometry, buildKeyGeometry, csgChain, toBufferGeometry,
    SUBTRACTION } from '../js/pieces.js';
import { extrudePolygonY } from '../js/geometry.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { audit } from './overhang_audit.mjs';

const OUT = 'test-parts/fit_test';

/**
 * COUNTABLE NOTCHES, cut into the 15 AF shaft — the same scheme the six-piece
 * sweep used, and it exists because POSITION IS NOT A LABEL: BambuStudio
 * re-arranges the plate, so "second from the left" tells you nothing once the
 * parts are in your hand. The engraved code is the primary mark and these are
 * the backup, readable at arm's length and by feel.
 *
 * Same geometry as scripts/tenon_sweep.mjs so a notch means the same thing on
 * both plates: 0.8 mm deep flats up one side, first at y 10.8, then every
 * 1.3 mm, topping out at 14.2 and clear of the 15 mm shoulder.
 */
function notchOps(n) {
    const ops = [];
    for (let k = 0; k < n; k++) {
        const y = 10.8 + k * 1.3;
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(
            [[6.3, -12], [20, -12], [20, 12], [6.3, 12]], y, y + 0.8)) });
    }
    return ops;
}

await initCSG();
fs.mkdirSync(OUT, { recursive: true });

const parts = [];
const add = (name, g, note) => {
    const P = g.positions ?? g.attributes.position.array;
    const I = g.indices ?? (g.index ? g.index.array
        : Uint32Array.from({ length: P.length / 3 }, (_, i) => i));
    const r = analyzeMesh(P, I);
    const ok = r.isManifold && r.isConsistent && r.windsOutward;
    parts.push({ name, positions: P, indices: I, cm3: r.volumeMm3 / 1000, ok, note });
    if (!ok) { console.error(`*** ${name} IS NOT WATERTIGHT — not writing the plate`); process.exit(1); }
};

// 1 + 2 + 3 --------------------------------------------------------------
// BORE LADDER — notches 1/2/3 in ascending bore order, so counting them tells
// you the size even after the codes have been thumbed over.
const BORES = [[9.60, 'BORE 960', 1], [9.70, 'BORE 970', 2], [9.80, 'BORE 980', 3]];
for (const [dia, code, n] of BORES) {
    add(`riser15_bore_${String(dia.toFixed(2)).replace('.', 'p')}_${n}notch`,
        csgChain(buildRiserGeometry(15,
            { ...SPEC, socket: { ...SPEC.socket, boreDia: dia } }, { code }), notchOps(n)),
        `bore ${dia.toFixed(2)}  ·  ${n} notch${n > 1 ? 'es' : ''}`);
}
// TENON COMPARISON — 4 and 5 notches, continuing the same count so no two
// parts on the plate share one. Both bores are the shipping 9.70, so the only
// difference between them is the tenon.
add('riser15_tenon_TAPER_4notch',
    csgChain(buildRiserGeometry(15, SPEC, { code: 'TENON TAPER' }), notchOps(4)),
    'tapered tenon (ships)  ·  4 notches');
add('riser15_tenon_PLAIN_5notch',
    csgChain(buildRiserGeometry(15,
        { ...SPEC, socket: { ...SPEC.socket, tenonTaperAF: 0 } }, { code: 'TENON PLAIN' }),
        notchOps(5)),
    'parallel tenon (the old one)  ·  5 notches');
// THE FOOT JOINT IS THE ONE THAT STICKS. Brett: "the support tenon when pushed
// all the way into the original smallest bore ... becomes completely stuck". A
// riser stuck on a riser can be worked apart; a riser stuck on the FOOT has
// nothing to brace against. Both options go on the plate so a hand decides.
add('foot_tenon_FULL', buildSupportFootGeometry(SPEC, { code: 'FOOT FULL' }),
    'foot, standard tenon');
add('foot_tenon_TRIM', buildSupportFootGeometry(SPEC, { code: 'FOOT TRIM', tenonTrimAF: 0.15 }),
    'foot, tenon 0.15 AF smaller (0.17 a/c)');

// 3b — THE ONE THAT CANNOT LOCK ------------------------------------------
//
// Brett: "if the taper idea is to work, it has to not end up like this
// scenario where once it is fully pushed in, it is locked."
//
// A 0.3 AF taper over 8 mm is a 2.1 degree half-angle, which is inside
// self-locking territory. It is harmless only while the WHOLE tenon is
// narrower than the bore, and that is not guaranteed: across corners the
// tenon is 9.65 when its corners round off and 9.93 as DRAWN, against a
// 9.70 bore. Round -> 0.025 clear. Sharp -> 0.115 interference, driven up a
// shallow taper, which is a press fit you cannot get back off.
//
// TRUNCATING THE CORNERS removes the hope from the calculation. Clipped to a
// 9.60 across-corners FLAT, the tenon's widest dimension is drawn rather than
// emergent, so the 9.70 bore has 0.05/side no matter how sharply the nozzle
// turns, and there is nothing left that can wedge. Flats print accurately;
// points do not. It costs nothing in a hex socket either, because hex-in-hex
// bears on the FLATS — every socket already printed keeps its fit.
/**
 * Clip the six corners off a tenon so its ACROSS-CORNERS is a drawn flat.
 * Six half-spaces, each a box pushed out beyond `maxAC/2` in one corner
 * direction and spanning only the tenon's height, subtracted from a real
 * riser — cheaper and safer than redrawing the part, and it keeps every other
 * feature (shaft, bore, engraving) exactly as it ships.
 */
function truncateCorners(g, maxAC, y0, y1) {
    const ops = [];
    const r = maxAC / 2;
    for (let i = 0; i < 6; i++) {
        // hexPlan puts VERTICES at 0/60/120..., so the corner cuts go THERE.
        // Offset by 30 they landed on the flats, which sit at radius 4.30
        // against the 4.80 cut — the boxes removed nothing and the "truncated"
        // tenon measured 9.76 across corners, i.e. exactly untruncated.
        const a = (i / 6) * 2 * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rect = [[r, -14], [22, -14], [22, 14], [r, 14]]
            .map(([u, v]) => [u * ca - v * sa, u * sa + v * ca]);
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(rect, y0, y1)) });
    }
    return csgChain(g, ops);
}
add('riser15_tenon_TRUNC_6notch',
    csgChain(truncateCorners(
        buildRiserGeometry(15, SPEC, { code: 'TENON TRUNC' }),
        9.60, 14.9, 15 + SPEC.socket.depth), notchOps(6)),
    'corners clipped to 9.60 a/c — cannot lock  ·  6 notches');

// 4 ----------------------------------------------------------------------
// The key's code is engraved on its TOP face, which is also its LEAD end —
// so the mark doubles as the which-way-up indicator: code up, drive it down.
add('bowtie_key_a', buildKeyGeometry(SPEC, { code: 'KEY 1' }), 'drive taper, code face = lead end');
add('bowtie_key_b', buildKeyGeometry(SPEC, { code: 'KEY 2' }), 'spare');

// 5 — the thermal load, and the underside/pocket test ---------------------
const t = layoutTrack(['start', 'straight', 'curveR', 'end'],
    { skirtStyle: 'minimal', slopeDeg: 11.2167 });
const straight = t.pieces.find((p) => p.type === 'straight');
const sup = planPillarPositions(t.pieces).find((s) => s.pieceIndex === straight.index);
const sg = buildPieceExportGeometry(straight, { support: sup, forPrint: true });
add('straight_ramp', sg, 'thermal load + filled sole + key pockets');

const rows = audit({ name: 's',
    V: (() => { const V = []; for (let i = 0; i < sg.positions.length; i += 3)
        V.push([sg.positions[i], -sg.positions[i + 2], sg.positions[i + 1]]); return V; })(),
    T: (() => { const T = []; for (let i = 0; i < sg.indices.length; i += 3)
        T.push([sg.indices[i], sg.indices[i + 1], sg.indices[i + 2]]); return T; })() }, 5);

// lay them out: the straight along the back, the small parts in a row ------
const bbox = (p) => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < p.length; i += 3) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
        y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
        z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    return { x0, x1, y0, y1, z0, z1 };
};
const objs = [];
let cx = 20, row = 70, rowDepth = 0;
for (const p of parts) {
    const b = bbox(p.positions);
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    let at;
    if (p.name === 'straight_ramp') {                 // along the back
        at = [128 - (b.x0 + b.x1) / 2, 190 + (b.z0 + b.z1) / 2, -b.y0];
    } else {
        if (cx + w > 236) { cx = 20; row += rowDepth + 10; rowDepth = 0; }
        at = [cx - b.x0, row - b.z0, -b.y0];
        cx += w + 10;
        rowDepth = Math.max(rowDepth, d);
    }
    objs.push({ name: p.name, positions: p.positions, indices: p.indices, at });
}

const xml = generateMultiObject3MFXML(objs);
const zip = Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
}));
const file = path.join(OUT, 'fit_test.3mf');
fs.writeFileSync(file, zip);

const ac = (af) => af / Math.cos(Math.PI / 6);
const AF = SPEC.socket.hexAF - 2 * SPEC.jointClearanceMm;
console.log(`\n${file}`);
console.log(`${parts.length} objects, ${parts.reduce((s, p) => s + p.cm3, 0).toFixed(1)} cm3, all watertight\n`);
for (const p of parts) console.log(`   ${p.name.padEnd(26)} ${p.cm3.toFixed(2).padStart(7)} cm3   ${p.note}`);
console.log(`\nstraight: worst unsupported span ${(rows[0]?.span ?? 0).toFixed(1)} mm, `
    + `${rows.filter((r) => r.span > 20).length} over 20 mm`);
console.log('\nWHAT SHIPS, so you know what "right" feels like:');
console.log(`   bore          ${SPEC.socket.boreDia.toFixed(2)}`);
console.log(`   tenon tip     ${ac(AF - SPEC.socket.tenonTaperAF).toFixed(3)} a/c  -> `
    + `${((SPEC.socket.boreDia - ac(AF - SPEC.socket.tenonTaperAF)) / 2).toFixed(3)} mm/side entering`);
console.log(`   tenon seated  9.650 a/c as printed -> `
    + `${((SPEC.socket.boreDia - 9.65) / 2).toFixed(3)} mm/side`);
console.log(`   key           lead ${SPEC.key.taperLeadMm} under / grip ${SPEC.key.taperGripMm} over nominal`);
