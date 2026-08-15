#!/usr/bin/env node
/**
 * ROUND-TENON DIAMETER SWEEP — find the fit by hand, in the real part.
 *
 * Why a sweep rather than a calculation. The riser joint's whole usable window
 * is 0.035 mm per side: that is the measured gap between a foot's tenon (9.73
 * across corners) and a riser's (9.65), and it is the difference between "very
 * tight" and "loose" on the same socket. Three nominally identical feet off one
 * plate spanned "ok" to "too tight", so the PROCESS SPREAD IS AS WIDE AS THE
 * WHOLE WINDOW. No single drawn number survives that, and the one dimension
 * that would let us compute it — the socket's printed across-flats — is a blind
 * hex bore 10 mm deep in a 3 mm wall, which cannot be measured with anything in
 * a normal toolbox.
 *
 * So the sweep measures the socket BY PROXY. Push each coupon into a socket you
 * already own; the one that grips is the answer, and it answers for that
 * socket's real printed size rather than its drawing.
 *
 * These are REAL 15 mm RISERS, not redrawn coupons — `buildRiserGeometry` with
 * `roundTenonDia`, so the shaft, shoulder, socket, grid grooves and print
 * orientation are the shipping part's. Only the tenon changes. That matters
 * here more than usual: the defect being chased IS a print-size effect, so a
 * coupon in a different section would measure its own section.
 *
 *   node scripts/tenon_sweep.mjs
 *   node scripts/tenon_sweep.mjs --from 8.30 --to 8.75 --step 0.05
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fflate from 'fflate';
import { SPEC } from '../js/track.js';
import { initCSG, buildRiserGeometry, buildSupportFootGeometry, toBufferGeometry, csgChain, ADDITION, SUBTRACTION } from '../js/pieces.js';
import { circlePlan, sweepSolid, extrudePolygonY } from '../js/geometry.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { analyzeMesh } from '../js/mesh_utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? +argv[i + 1] : d; };

// RANGE 8.80-9.30, AND THE FIRST SWEEP'S RANGE WAS WRONG. It ran 8.30-8.75,
// reasoned from "the foot's hex tenon measures 8.43 across flats and is very
// tight in a riser socket, so the socket must print near 8.43". Every coupon
// came back loose, including 8.75, which bounds the socket's flats ABOVE 8.75.
//
// The error is worth keeping because it is the same error twice over: A HEX
// TENON BINDS AT THE CORNERS, A CYLINDER BINDS AT THE FLATS. FDM cannot cut a
// sharp internal corner — the nozzle leaves roughly its own radius in each of
// the socket's six — so a hex tenon's corners foul that rounding long before
// its flats touch anything. That is why 0.08 mm across corners flips this joint
// from tight to loose, and it is why the corner-derived number said nothing
// about where the flats are. Sizing a flat-engaging feature from a
// corner-derived measurement is what put the whole first sweep below the hole.
//
// It also strengthens the case for going round: the hex fit was being set by
// corner rounding, which is the least controlled feature on the part.
const FROM = flag('from', 8.80);
const TO = flag('to', 9.30);
const STEP = flag('step', 0.05);
const SIZE = flag('size', 15);
// `--feet 8.45,8.55` adds real support feet at those diameters. The foot is the
// other half of this joint — its tenon is the one measuring 9.73 and the one
// Brett found "too tight" on one of three — and a foot is a much broader part
// than a riser, so it is exactly where a print-size effect would differ. Off by
// default because a foot is ~4x the plastic of a 15 mm riser.
const list = (n) => (argv[argv.indexOf(`--${n}`) + 1] || '').split(',').filter(Boolean).map(Number);
const FEET = list('feet');
// `--tall 8.45,8.60` adds 60 mm risers at those diameters. THIS IS THE ONE
// CONTROL THE SWEEP OTHERWISE LACKS. Every coupon above is a 15 mm riser, so a
// number read off them is calibrated for a 15 — and the leading explanation for
// the whole fault is that a tenon's printed size depends on the part carrying
// it (a foot's measures 9.73 across corners, a riser's 9.65). If that is height,
// a 60's tenon differs from a 15's and the sweep answers for the wrong part.
// Same drawn diameter at two heights settles it directly.
const TALL = list('tall');
const OUT = path.join(ROOT, 'test-parts', 'tenon_sweep');

/**
 * A STEP GAUGE — one part that measures the socket, instead of eleven that
 * guess at it.
 *
 * Brett, on the first sweep: "Why are there so many 15mm pieces they all seem
 * the same". They were, to the eye: eleven coupons differing only by 0.05 mm of
 * diameter, identified by an engraved code that is 0.5 mm wide — 1.19 extrusion
 * widths — which is exactly the legibility problem measured earlier the same
 * day. A sweep whose members can only be told apart by an illegible mark is a
 * failed article regardless of what it measures.
 *
 * So: a single riser carrying a stepped tenon, smallest at the tip. Push it in
 * and count the steps that DISAPPEARED — the first one that will not enter is
 * the socket's effective across-flats. No reading, no calipers, no sorting a
 * row of identical parts, and it reads the real printed hole rather than its
 * drawing. Built on a real 15 mm riser so the steps print in the same section
 * and orientation a real tenon does.
 *
 * Steps run LARGEST AT THE SHOULDER so the small end leads. `stepMm` tall each,
 * so "3 steps went in" is countable against the shoulder.
 */
function stepGauge(from, to, step, stepMm, spec) {
    const dias = [];
    for (let d = from; d <= to + 1e-9; d += step) dias.push(+d.toFixed(3));
    // smallest at the tip: the largest sits against the shoulder
    const n = dias.length;
    const y0 = 15;                       // the riser's shoulder
    const g = buildRiserGeometry(15, spec, { roundTenonDia: dias[0] });
    const ops = [];
    for (let k = 1; k < n; k++) {
        // step k spans from the shoulder up to where the smaller steps begin
        const top = y0 + (n - k) * stepMm;
        const cyl = sweepSolid(
            [circlePlan(dias[k] / 2, 96), circlePlan(dias[k] / 2, 96)]
                .map(pl => pl.map(([x, z]) => [x, -z])),
            [y0 - 0.4, top].map(y => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
        );
        ops.push({ op: ADDITION, geometry: toBufferGeometry(cyl) });
    }
    return { g: csgChain(g, ops), dias, stepMm };
}

await initCSG();
fs.mkdirSync(OUT, { recursive: true });

const zip = (xml) => Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
}));

// `buildSupportFootGeometry` hands back a THREE.BufferGeometry while
// `buildRiserGeometry` hands back plain arrays. Normalise rather than "fix" one
// of them: both are shipped builders with other callers.
const arrays = (g) => {
    if (g.positions) return g;
    const pos = g.attributes.position.array;
    const idx = g.index ? g.index.array
        : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
};

/**
 * HEAD-TO-HEAD: cylinder-in-hex against hex-in-round, four of each.
 *
 * Not a step gauge. A gauge needs a hard stop, and this joint is deliberately
 * COMPLIANT — 0.1 mm ledges in a line-contact fit swage through with gradually
 * rising force rather than stopping, so the gauge cannot read anything. Brett:
 * ".05mm is not enough to make a difference". So: few parts, spaced 0.3-0.4 mm,
 * which is four times the step he has already said he cannot feel.
 *
 * You supply the mating half for both from parts already printed — existing hex
 * SOCKETS take the cylinder tenons, existing hex TENONS go into the new round
 * sockets. Nothing here needs a partner from the same plate.
 *
 * Ranges are grounded differently, and unequally:
 *  - HEX IN ROUND is the better grounded of the two, because the male part was
 *    measured: Brett's tenons are 9.73 (foot) and 9.65 (riser) across corners.
 *    Corner interference per side is (9.65 - D)/2, so 9.0-9.9 runs from a heavy
 *    bite to just free.
 *  - CYLINDER IN HEX only has a bound. Every coupon up to 8.75 drawn (~8.64
 *    printed) was loose, so the socket's flats are above that; the cylinder
 *    bears on the flats at 8.75 and is not fully constrained until the corners
 *    at 10.10, so 8.9-10.1 spans that whole window.
 */
/**
 * COUNTABLE NOTCHES, because neither of the other two labels survives contact.
 *
 * The engraved code is 0.5 mm of stroke — 1.19 extrusion widths — which is the
 * width at which a slicer renders a hairline or drops it; Brett could not read
 * the last set. And plate POSITION is not a label either: the transforms in
 * this file put the parts on a 26 mm grid at two rows, and BambuStudio
 * re-arranged them, so what comes off the plate is in an order nobody chose.
 *
 * So: N grooves cut into the shaft between the socket (which ends at 10) and
 * the tenon shoulder (at 15), where they touch neither. Count them with a
 * fingernail. The two ROWS need no label — one has a round tenon on top and the
 * other a hex one, which is unmistakable.
 *
 * Height is deliberately NOT the label. It would work, but the tenon is the
 * feature under test and moving it up or down changes what it prints like,
 * which is the exact variable being measured.
 */
function notchOps(n) {
    const ops = [];
    for (let k = 0; k < n; k++) {
        const y = 10.8 + k * 1.3;   // top notch ends 14.2, clear of the 15 shoulder
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(
            [[6.3, -12], [20, -12], [20, 12], [6.3, 12]], y, y + 0.8)) });
    }
    return ops;
}

if (argv.includes('--compare')) {
    // CENTRED ON BRETT'S TWO ANCHORS, not on a blind bracket.
    //
    // Cylinder in hex: "make that diameter of the cylinder the Flat to Flat
    // width". Right — a cylinder is tangent to all six flats at exactly the
    // across-flats, 8.75. But a coupon DRAWN 8.75 already printed loose, so the
    // principle has to be applied to printed sizes: cylinders come out about
    // 0.1 under, which puts the flat-to-flat candidate at 8.90 drawn. 8.75 is
    // the known-loose floor, so the row starts above it and steps 0.2.
    const CYL = [8.90, 9.10, 9.30];
    // Hex in round bore: "it is the width of vertex to vertex of the hex that
    // is what the cylinder diameter should be". Also right, and better founded,
    // because the male part is MEASURED rather than inferred — his tenons are
    // 9.65 (riser) and 9.73 (foot) across corners, so 9.65 is the zero-
    // interference bore and anything under it bites. Bores print under by more
    // than shafts do, so the row runs from 9.60 (a firm bite once shrunk) up to
    // 10.10 (near zero even after shrink).
    const SOC = [9.60, 9.85, 10.10];
    const parts = [], rows = [];
    let bad = 0;
    const add = (g, name, at, kind, dia) => {
        const a = arrays(g);
        const r = analyzeMesh(a.positions, a.indices);
        if (!(r.isManifold && r.isConsistent && r.windsOutward)) {
            console.log(` FAIL ${name}: nonmanifold=${r.nonManifoldEdges} winding=${r.isConsistent}`);
            bad++; return;
        }
        parts.push({ name, positions: a.positions, indices: a.indices, at });
        rows.push({ name, kind, dia, notches: rows.filter(x=>x.kind===kind).length + 1, cm3: +(r.volumeMm3 / 1000).toFixed(2) });
    };
    CYL.forEach((d, i) => add(
        csgChain(buildRiserGeometry(15, SPEC, { roundTenonDia: d, code: `C${Math.round(d * 10)}` }), notchOps(i + 1)),
        `cyl_tenon_${Math.round(d * 100)}`,
        [128 + (i - 1) * 26, 128 - 22, 0], 'cylinder tenon -> your hex socket', d));
    SOC.forEach((d, i) => add(
        csgChain(buildRiserGeometry(15, SPEC, { roundSocketDia: d, code: `S${Math.round(d * 10)}` }), notchOps(i + 1)),
        `round_socket_${Math.round(d * 100)}`,
        [128 + (i - 1) * 26, 128 + 22, 0], 'round socket <- your hex tenon', d));
    if (bad) { console.error(`\n${bad} failed the mesh gate — NOTHING WRITTEN.`); process.exit(1); }
    const f = path.join(OUT, 'compare_cyl_vs_hex.3mf');
    fs.writeFileSync(f, zip(generateMultiObject3MFXML(parts)));
    const tot = rows.reduce((a, b) => a + b.cm3, 0);
    console.log('\nHEAD-TO-HEAD — 3 + 3 real 15 mm risers\n');
    console.log('  FRONT ROW  cylinder tenon on top -> push into a hex socket you own');
    for (const r of rows.filter(r => r.kind[0] === 'c'))
        console.log(`   ${r.notches} notch${r.notches>1?'es':'  '}  drawn ${r.dia.toFixed(2)}  ~printed ${(r.dia-0.11).toFixed(2)}  vs socket flats 8.75 -> ${(((r.dia-0.11)-8.75)/2>=0?'+':'')}${(((r.dia-0.11)-8.75)/2).toFixed(2)} /side`);
    console.log('\n  BACK ROW   round socket below -> push YOUR hex tenon (9.65-9.73 a/c) into it');
    for (const r of rows.filter(r => r.kind[0] === 'r'))
        console.log(`   ${r.notches} notch${r.notches>1?'es':'  '}  bore ${r.dia.toFixed(2)}  vs your tenon 9.65 a/c -> ${((9.65-r.dia)/2>=0?'+':'')}${((9.65-r.dia)/2).toFixed(2)} /side before bore shrink`);
    console.log(`\n  ${tot.toFixed(1)} cm3 solid   ${path.relative(ROOT, f)}`);
    console.log('\n  IDENTIFY BY COUNTING THE NOTCHES on the shaft. Not by position — the');
    console.log('  slicer re-arranges the plate — and not by the engraving, which is');
    console.log('  1.19 extrusion widths wide. Round tenon on top = cylinder-in-hex row;');
    console.log('  hex tenon on top = round-bore row.');
    process.exit(0);
}

const dias = [];
for (let d = FROM; d <= TO + 1e-9; d += STEP) dias.push(+d.toFixed(3));

// A BUILD ITEM'S TRANSFORM IS [X, Y, Z] IN PRINTER SPACE, AND Z IS HEIGHT.
// The feet were first given `at: [x, 0, 45]` meaning "45 mm back on the bed",
// which actually lifted them 45 mm into the air; BambuStudio met the file with
// "Multi-part object detected ... objects positioned at multiple heights" and
// offered to merge them into one object. The second slot is the one that moves
// a part across the plate. Parts also have to be placed about the BED CENTRE —
// the mesh sits at the origin, so without this the row straddles the corner.
const BED = 256;
// One row, 22 mm apart: a 15 AF hex is 17.3 across corners, so this clears.
// A foot flares to 36, so feet get their own row 50 mm away.
const PITCH = 22;
const parts = [];
const rows = [];
let bad = 0;

for (let i = 0; i < dias.length; i++) {
    const dia = dias[i];
    // The code is the DIAMETER, in hundredths — "845" is 8.45. It goes on a hex
    // flat of the shaft the same way a riser's code always does, so you can
    // read which is which after they come off the plate and get mixed up.
    const tag = String(Math.round(dia * 100));
    const g = buildRiserGeometry(SIZE, SPEC, { roundTenonDia: dia, code: tag });
    const r = analyzeMesh(g.positions, g.indices);
    const ok = r.isManifold && r.isConsistent && r.windsOutward;
    if (!ok) {
        // SAME RULE AS THE CURVE HARNESS: a mesh that is not watertight is not
        // written, because a slicer's reading of one is undefined.
        console.log(` FAIL  dia ${dia}  nonmanifold=${r.nonManifoldEdges} open=${r.openEdges} winding=${r.isConsistent}`);
        bad++;
        continue;
    }
    parts.push({
        name: `tenon_${tag}`, positions: g.positions, indices: g.indices,
        at: [BED / 2 + (i - (dias.length - 1) / 2) * PITCH, BED / 2 - 25, 0]
    });
    rows.push({ dia, tag, cm3: +(r.volumeMm3 / 1000).toFixed(2) });
}

for (let i = 0; i < TALL.length; i++) {
    const dia = TALL[i];
    const tag = String(Math.round(dia * 100));
    const g = buildRiserGeometry(60, SPEC, { roundTenonDia: dia, code: `T ${tag}` });
    const r = analyzeMesh(g.positions, g.indices);
    if (!(r.isManifold && r.isConsistent && r.windsOutward)) {
        console.log(` FAIL  tall dia ${dia}  nonmanifold=${r.nonManifoldEdges} winding=${r.isConsistent}`);
        bad++;
        continue;
    }
    parts.push({
        name: `tall60_${tag}`, positions: g.positions, indices: g.indices,
        at: [BED / 2 + (i - (TALL.length - 1) / 2) * 30, BED / 2 - 70, 0]
    });
    rows.push({ dia, tag, cm3: +(r.volumeMm3 / 1000).toFixed(2), tall: true });
}

for (let i = 0; i < FEET.length; i++) {
    const dia = FEET[i];
    const tag = String(Math.round(dia * 100));
    const g = arrays(buildSupportFootGeometry(SPEC, { roundTenonDia: dia, code: `F ${tag}` }));
    const r = analyzeMesh(g.positions, g.indices);
    if (!(r.isManifold && r.isConsistent && r.windsOutward)) {
        console.log(` FAIL  foot dia ${dia}  nonmanifold=${r.nonManifoldEdges} winding=${r.isConsistent}`);
        bad++;
        continue;
    }
    parts.push({
        name: `foot_${tag}`, positions: g.positions, indices: g.indices,
        at: [BED / 2 + (i - (FEET.length - 1) / 2) * 45, BED / 2 + 25, 0]
    });
    rows.push({ dia, tag, cm3: +(r.volumeMm3 / 1000).toFixed(2), foot: true });
}

if (bad) {
    console.error(`\n${bad} coupon(s) failed the mesh gate — NOTHING WRITTEN.`);
    process.exit(1);
}

const file = path.join(OUT, `tenon_sweep_${dias.length}x${TALL.length ? `_${TALL.length}tall` : ''}${FEET.length ? `_${FEET.length}feet` : ''}.3mf`);
fs.writeFileSync(file, zip(generateMultiObject3MFXML(parts)));

const total = rows.reduce((a, b) => a + b.cm3, 0);
console.log(`\nROUND-TENON SWEEP — ${dias.length} real ${SIZE} mm risers${FEET.length ? ` + ${FEET.length} feet` : ''}, hex sockets unchanged\n`);
console.log('  engraved   tenon dia    (hex socket is drawn 8.750 AF; it prints smaller)');
for (const r of rows) {
    const note = r.foot ? '   <- FOOT (broad part)'
        : r.tall ? '   <- 60 mm RISER (height control)'
        : Math.abs(r.dia - 8.75) < 1e-9 ? '   <- socket AS DRAWN; the last sweep proved this is still loose' : '';
    console.log(`     ${r.tag}       ${r.dia.toFixed(2)} mm${note}`);
}
console.log(`\n  ${path.relative(ROOT, file)}`);
// Solid volume x density OVERSTATES it by nearly 2x — these are infilled, not
// solid. Sliced, the 10+2 plate is 29.3 g / 1h11 against the 53 g that
// arithmetic predicted. Quote the slicer, not the density.
console.log(`  ${total.toFixed(1)} cm3 of solid — sliced, 10 risers is 29.3 g / 1h11 and the`);
console.log('  full 10 + 2 tall + 2 feet plate is 41.4 g / 2h00\n');
console.log('  HOW TO READ IT: push each one into a socket you already own — a riser you');
console.log('  printed, not a new part. The first that grips without needing force is the');
console.log('  number. Try the loose 60 and the too-tight foot both, and note if they');
console.log('  disagree: that spread is the thing being designed around, not an error.');
