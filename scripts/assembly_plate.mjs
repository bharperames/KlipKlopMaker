#!/usr/bin/env node
/**
 * ONE ASSEMBLABLE SUPPORTED CURVE — the 2.4 acceptance plate.
 *
 * Every part comes from the SHIPPING builder with no experiment hooks, so what
 * prints is what the app exports. It is chosen to exercise everything 2.4
 * changed, and to leave you with something you can stand up and run a figure
 * over rather than a bag of coupons:
 *
 *   curve      ribs across the arc      the part that has never printed well
 *   straight   spines along it          the strand complaint
 *   foot       hex tenon                unchanged, the reference fit
 *   riser x2   ROUND 9.60 bore          confirmed on coupons, unconfirmed as a part
 *   spacer     ROUND 9.60 bore          NEW and unverified — different part mass
 *   jog        ROUND 9.60 bore          NEW and unverified — different part mass
 *   key x2     unchanged                the seam that now closes
 *
 * The spacer and the jog are the only genuinely untested joints in 2.4. Both
 * carry the same 9.60 bore proven on a riser, but in a different mass — and
 * mass is exactly the variable that has caught this project out repeatedly, so
 * they are on the plate rather than assumed.
 *
 *   node scripts/assembly_plate.mjs            # build + gate + lay out
 *   node scripts/assembly_plate.mjs --slice    # ... and slice it
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fflate from 'fflate';
import { layoutTrack, planPillarPositions, spacerHeightMm, spacerVariant,
         SPEC, GEOMETRY_VERSION } from '../js/track.js';
import { partCode, pieceCode } from '../js/engrave.js';
import { initCSG, buildPieceExportGeometry, buildSupportFootGeometry,
         buildRiserGeometry, buildSpacerGeometry, buildJogGeometry,
         buildKeyGeometry } from '../js/pieces.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { analyzeMesh } from '../js/mesh_utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-parts', 'assembly_2_4_0');
const BED = 256, MARGIN = 6;
const DO_SLICE = process.argv.includes('--slice');

const arrays = (g) => {
    if (g.positions) return g;
    const pos = g.attributes.position.array;
    const idx = g.index ? g.index.array
        : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
};

await initCSG();
fs.mkdirSync(OUT, { recursive: true });

// The track pieces come from a real layout so they carry a real support
// station — the boss is at the piece's centre of mass, not mid-length.
const { pieces } = layoutTrack(['start', 'straight', 'curveR', 'straight', 'end'],
    { skirtStyle: 'minimal', slopeDeg: 11.2167 });
const sup = planPillarPositions(pieces);
const track = (type) => {
    const pc = pieces.find(p => p.type === type);
    return buildPieceExportGeometry(pc, {
        support: sup.find(s => s.pieceIndex === pc.index), forPrint: true });
};
const curvePiece = pieces.find(p => p.type === 'curveR');
const spcH = spacerHeightMm(curvePiece, SPEC);
const spcV = spacerVariant(spcH);

// SUPPORTS ARE OPT-IN. The plate Brett asked for is the two TRACK pieces — they
// are what changed and what is being judged. The foot, risers, spacer, jog and
// keys are untouched by the underside work, so a set already printed still
// mates; adding them here only costs bed space the curve needs. `--supports`
// puts them back for a from-scratch set.
const WITH_SUPPORTS = process.argv.includes('--supports');
const items = [
    { name: 'curve_R', n: 1, code: pieceCode(pieces.find(p => p.type === 'curveR'), GEOMETRY_VERSION), g: () => track('curveR') },
    { name: 'straight', n: 1, code: pieceCode(pieces.find(p => p.type === 'straight'), GEOMETRY_VERSION), g: () => track('straight') },
    { name: 'support_foot', code: partCode('FOOT', GEOMETRY_VERSION), n: 1, g: () => buildSupportFootGeometry(SPEC, { code: partCode('FOOT', GEOMETRY_VERSION) }) },
    { name: 'riser_15', code: partCode('R15', GEOMETRY_VERSION), n: 2, g: () => buildRiserGeometry(15, SPEC, { code: partCode('R15', GEOMETRY_VERSION) }) },
    { name: `spacer_${spcV?.code ?? 'SPC'}`, code: partCode(spcV?.code ?? 'SPC', GEOMETRY_VERSION), n: 1, g: () => buildSpacerGeometry(spcH, SPEC, { rings: spcV?.rings ?? 1, code: partCode(spcV?.code ?? 'SPC', GEOMETRY_VERSION) }) },
    { name: 'support_jog', code: partCode('JOG', GEOMETRY_VERSION), n: 1, g: () => buildJogGeometry(SPEC, { code: partCode('JOG', GEOMETRY_VERSION) }) },
    { name: 'bowtie_key', code: partCode('KEY', GEOMETRY_VERSION), n: 2, g: () => buildKeyGeometry(SPEC, { code: partCode('KEY', GEOMETRY_VERSION) }) }
].filter(it => WITH_SUPPORTS || it.name === 'curve_R' || it.name === 'straight');

// Build once per NAME, gate it, then place n copies. A part that fails the mesh
// gate stops the whole plate — the rule the curve experiments did not have.
const built = [];
let bad = 0;
for (const it of items) {
    const g = arrays(it.g());
    const r = analyzeMesh(g.positions, g.indices);
    const ok = r.isManifold && r.isConsistent && r.windsOutward;
    if (!ok) { console.log(` FAIL ${it.name}: nonmanifold=${r.nonManifoldEdges} winding=${r.isConsistent}`); bad++; continue; }
    const p = g.positions;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
        y0 = Math.min(y0, p[i + 1]);
        z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    built.push({ ...it, g, r, w: x1 - x0, d: z1 - z0,
        cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, y0 });
}
if (bad) { console.error(`\n${bad} part(s) failed the mesh gate — NOTHING WRITTEN.`); process.exit(1); }

// TWO PLATES, AND THE CURVE IS ALONE ON ONE — to contain a failure, not to
// keep a warning straight.
//
// Brett: "The warning is not misattributed, it is always the curve, the reason
// to print alone is being conservative about failures." The curve is the part
// with no successful print behind it and the longest run on the plate at 3h43;
// putting the straight and every support part beside it means one bad curve
// costs all of them. Separated, a failure costs only itself.
//
// (The cantilever warning does fire on this curve, and it will fire on any
// curve whatever its geometry — it tests area and cannot tell a bridge from a
// cantilever. Ignore it and judge the print.)
//
// It packs better too: the curve is 179x178 on a 244 mm usable bed and leaves
// only awkward strips — a shelf packer overflowed on a 24 mm key.
//
// Printer space is X=x, Y=-z, Z=y, so a part's bed footprint is (w, d) and the
// build item translation centres it there. Z is HEIGHT: -y0 puts it on the bed.
// ONE PLATE, curve and straight together, because that is what Brett asked
// for and both are now the same question: does the capped under-deck structure
// stop the deck's first layer sagging? Printing them side by side means one
// answer covers both, and the supports ride along so the result is assemblable.
const plates = [
    { file: 'plate_curve_and_straight', keep: () => true }
];

// SKYLINE, not shelves. The curve is 179x178 on a 244 mm usable bed, which
// leaves a 59 mm column beside it that a shelf packer cannot reach — it puts
// the straight on the next shelf and then has nowhere for a 24 mm key. A
// skyline drops each part at the lowest point it fits, so the column gets used.
const layOut = (list) => {
    const queue = [];
    for (const b of list) for (let i = 0; i < b.n; i++) queue.push(b);
    queue.sort((a, b) => (b.w * b.d) - (a.w * a.d));      // largest first

    const usable = BED - 2 * MARGIN;
    const STEP = 1;
    const cols = Math.floor(usable / STEP);
    const sky = new Array(cols).fill(0);
    const out = [];
    for (const b of queue) {
        const w = b.w + MARGIN, d = b.d + MARGIN;
        const nw = Math.ceil(w / STEP);
        let best = null;
        for (let i = 0; i + nw <= cols; i++) {
            let y = 0;
            for (let k = i; k < i + nw; k++) y = Math.max(y, sky[k]);
            if (y + d > usable + MARGIN) continue;
            if (!best || y < best.y) best = { i, y };
        }
        if (!best) { console.error(`   packer stuck on ${b.name} (${b.w.toFixed(0)}x${b.d.toFixed(0)}); skyline max ${Math.max(...sky).toFixed(0)} min ${Math.min(...sky).toFixed(0)}`); return null; }
        for (let k = best.i; k < best.i + nw; k++) sky[k] = best.y + d;
        const x = MARGIN + best.i * STEP, y = MARGIN + best.y;
        out.push({ name: b.name, positions: b.g.positions, indices: b.g.indices,
            meshKey: b.name,
            at: [x + b.w / 2 - b.cx, BED - (y + b.d / 2) + b.cz, -b.y0] });
    }
    return out;
};

const zip = (xml) => Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
}));

console.log(`\nASSEMBLY PLATES — geometry ${GEOMETRY_VERSION}\n`);
console.log('  part              n   footprint      cm3   engraved');
for (const b of built) {
    console.log(`  ${b.name.padEnd(16)} ${String(b.n).padStart(2)}   ${`${b.w.toFixed(0)}x${b.d.toFixed(0)}`.padEnd(10)} ${(b.r.volumeMm3 / 1000).toFixed(2).padStart(6)}   ${b.code}`);
}

const written = [];
for (const pl of plates) {
    const list = built.filter(pl.keep);
    const laid = layOut(list);
    if (!laid) { console.error(`\n${pl.file}: does not fit the bed`); process.exit(1); }
    const f = path.join(OUT, `${pl.file}_${GEOMETRY_VERSION.replace(/\./g, '_')}.3mf`);
    fs.writeFileSync(f, zip(generateMultiObject3MFXML(laid)));
    const vol = list.reduce((a, b) => a + b.n * b.r.volumeMm3 / 1000, 0);
    console.log(`\n  ${pl.file}: ${laid.length} objects, ${vol.toFixed(1)} cm3 solid`);
    console.log(`     ${path.relative(ROOT, f)}`);
    written.push(f);
}

if (DO_SLICE) {
    const SP = process.env.TMPDIR ?? '/tmp';
    const B = '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
    const PRESETS = `${process.env.HOME}/Library/Application Support/BambuStudio/system/BBL`;
    const flat = (kind, name, patch = {}) => {
        const chain = []; let cur = name;
        while (cur) {
            const f = path.join(PRESETS, kind, `${cur}.json`);
            if (!fs.existsSync(f)) break;
            const j = JSON.parse(fs.readFileSync(f, 'utf8')); chain.unshift(j); cur = j.inherits;
        }
        const m = Object.assign({}, ...chain, patch); delete m.inherits; m.name = name;
        const o = path.join(SP, `kk_${kind}.json`); fs.writeFileSync(o, JSON.stringify(m)); return o;
    };
    console.log('');
    for (const f of written) {
        const out = path.join(SP, 'kk_assembly_out');
        fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
        execFileSync(B, ['--load-settings',
            `${flat('machine', 'Bambu Lab P2S 0.4 nozzle')};${flat('process', '0.20mm Standard @BBL P2S', { curr_bed_type: 'Textured PEI Plate' })}`,
            '--load-filaments', flat('filament', 'Bambu PETG HF @BBL P2S 0.4 nozzle'),
            '--slice', '0', '--outputdir', out, f], { stdio: ['ignore', 'pipe', 'pipe'] });
        const gc = fs.readFileSync(path.join(out, 'plate_1.gcode'), 'utf8');
        console.log(`  sliced ${path.basename(f).padEnd(46)} ` +
            `${/^; total filament weight \[g\] : ([0-9.]+)/m.exec(gc)?.[1]} g   ` +
            `${(/^; model printing time: ([^;\n]+)/m.exec(gc)?.[1] ?? '?').trim()}`);
        fs.copyFileSync(path.join(out, 'plate_1.gcode'),
            path.join(OUT, path.basename(f).replace('.3mf', '.gcode')));
    }
}
