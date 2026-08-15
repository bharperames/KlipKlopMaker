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
import { initCSG, buildRiserGeometry, buildSupportFootGeometry } from '../js/pieces.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { analyzeMesh } from '../js/mesh_utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? +argv[i + 1] : d; };

// The socket is DRAWN 8.750 and, from the fits Brett reports, must be PRINTING
// near 8.43-8.47. The sweep therefore straddles that, not the drawing: a
// cylinder wants to be at or just over the socket's real across-flats.
const FROM = flag('from', 8.30);
const TO = flag('to', 8.75);
const STEP = flag('step', 0.05);
const SIZE = flag('size', 15);
// `--feet 8.45,8.55` adds real support feet at those diameters. The foot is the
// other half of this joint — its tenon is the one measuring 9.73 and the one
// Brett found "too tight" on one of three — and a foot is a much broader part
// than a riser, so it is exactly where a print-size effect would differ. Off by
// default because a foot is ~4x the plastic of a 15 mm riser.
const FEET = (process.argv[process.argv.indexOf('--feet') + 1] || '')
    .split(',').filter(Boolean).map(Number);
const OUT = path.join(ROOT, 'test-parts', 'tenon_sweep');

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

const dias = [];
for (let d = FROM; d <= TO + 1e-9; d += STEP) dias.push(+d.toFixed(3));

// One row, 22 mm apart: a 15 AF hex is 17.3 across corners, so this clears.
// A foot flares to 36, so feet get their own row further back.
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
        at: [(i - (dias.length - 1) / 2) * PITCH, 0, 0]
    });
    rows.push({ dia, tag, cm3: +(r.volumeMm3 / 1000).toFixed(2) });
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
        at: [(i - (FEET.length - 1) / 2) * 40, 0, 45]
    });
    rows.push({ dia, tag, cm3: +(r.volumeMm3 / 1000).toFixed(2), foot: true });
}

if (bad) {
    console.error(`\n${bad} coupon(s) failed the mesh gate — NOTHING WRITTEN.`);
    process.exit(1);
}

const file = path.join(OUT, `tenon_sweep_${dias.length}x${FEET.length ? `_${FEET.length}feet` : ''}.3mf`);
fs.writeFileSync(file, zip(generateMultiObject3MFXML(parts)));

const total = rows.reduce((a, b) => a + b.cm3, 0);
console.log(`\nROUND-TENON SWEEP — ${dias.length} real ${SIZE} mm risers${FEET.length ? ` + ${FEET.length} feet` : ''}, hex sockets unchanged\n`);
console.log('  engraved   tenon dia    (hex socket is drawn 8.750 AF; it prints smaller)');
for (const r of rows) {
    const note = r.foot ? '   <- FOOT' : Math.abs(r.dia - 8.60) < 1e-9 ? '   <- todays hex tenon, across flats' : '';
    console.log(`     ${r.tag}       ${r.dia.toFixed(2)} mm${note}`);
}
console.log(`\n  ${path.relative(ROOT, file)}`);
// Solid volume x density OVERSTATES it by nearly 2x — these are infilled, not
// solid. Sliced, the 10+2 plate is 29.3 g / 1h11 against the 53 g that
// arithmetic predicted. Quote the slicer, not the density.
console.log(`  ${total.toFixed(1)} cm3 of solid, but sliced the 10+2 plate is 29.3 g / 1h11\n`);
console.log('  HOW TO READ IT: push each one into a socket you already own — a riser you');
console.log('  printed, not a new part. The first that grips without needing force is the');
console.log('  number. Try the loose 60 and the too-tight foot both, and note if they');
console.log('  disagree: that spread is the thing being designed around, not an error.');
