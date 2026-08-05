#!/usr/bin/env node
/**
 * make_test_parts.mjs
 * Builds a PARAMETER SWEEP of one track piece and writes it as a single 3MF
 * holding every variant as a separately named object, laid out in a row.
 *
 * The point is to stop bisecting a slicer complaint one file at a time: load
 * the whole set at once and whatever the slicer says about "Object_3" names
 * the variant directly. Each object is also measured here, so the printed
 * legend can be read against whatever the slicer reports.
 *
 * The measurement is the one that matters for support generation — downward
 * skirt-wall area in the 10-30 deg band. Below 10 deg a ceiling is flat enough
 * that a slicer bridges it (anchored at both ends, so it prints unsupported);
 * above 30 deg it holds itself up. In between it is neither, and a curved arch
 * necessarily sweeps through it.
 *
 * Usage:
 *   node scripts/make_test_parts.mjs --key crownFlat       # arch -> flat-top sweep
 *   node scripts/make_test_parts.mjs --out /tmp/parts      # somewhere else
 *   node scripts/make_test_parts.mjs --key band --values 3,4,5,6
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fflate from 'fflate';
import { layoutTrack, planPillarPositions, SPEC } from '../js/track.js';
import { initCSG, buildPieceExportGeometry } from '../js/pieces.js';
import { ARCH } from '../js/geometry.js';
import { generateMultiObject3MFXML, generateBinarySTL } from '../js/export_3mf.js';
import { analyzeMesh } from '../js/mesh_utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = path.resolve(arg('out', path.join(ROOT, 'test-parts')));
const KEY = arg('key', 'haunch');
const VALUES = arg('values', '').split(',').filter(Boolean).map(Number);
const PIECE = arg('piece', 'straight');
const SPACING = Number(arg('spacing', 60));
const PLATE = Number(arg('plate', 256));      // Bambu X1C bed

/** Downward skirt-wall area, split by angle from horizontal. */
function wallAngles(g) {
    const p = g.positions, ix = g.indices;
    const bins = { flat: 0, band: 0, steep: 0 };
    for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        if (Math.abs((p[a + 2] + p[b + 2] + p[c + 2]) / 3) < 22) continue;   // skirt wall only
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) continue;
        const down = -ny / len;
        if (down <= 0.02) continue;
        const deg = Math.acos(Math.min(1, down)) * 180 / Math.PI;
        const area = len / 2;
        if (deg < 10) bins.flat += area;
        else if (deg < 30) bins.band += area;
        else bins.steep += area;
    }
    return bins;
}

function buildOne() {
    const { pieces } = layoutTrack(['straight', PIECE, 'straight'], { slopeDeg: 11.2167 });
    const pc = pieces.find(p => p.type === PIECE) ?? pieces[1];
    const sup = planPillarPositions(pieces).find(s => s.pieceIndex === pc.index);
    const g = buildPieceExportGeometry(pc, { support: sup });
    // drop to Z=0 and centre in X/Y so the layout row is predictable
    const p = g.positions;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity, mny = Infinity;
    for (let i = 0; i < p.length; i += 3) {
        mnx = Math.min(mnx, p[i]); mxx = Math.max(mxx, p[i]);
        mnz = Math.min(mnz, p[i + 2]); mxz = Math.max(mxz, p[i + 2]);
        mny = Math.min(mny, p[i + 1]);
    }
    const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
    for (let i = 0; i < p.length; i += 3) {
        p[i] -= cx; p[i + 1] -= mny; p[i + 2] -= cz;
    }
    return g;
}

await initCSG();
fs.mkdirSync(OUT, { recursive: true });

const sweep = VALUES.length ? VALUES : {
    crownFlat: [0, 0.35, 0.7, 0.95],
    haunch: [0.20, 0.38, 0.60, 0.80],
    band: [3.6, 5, 6, 8],
    maxBridge: [45, 70, 110],
    pier: [6, 8, 12]
}[KEY];
if (!sweep) throw new Error(`no default sweep for --key ${KEY}; pass --values`);

const original = ARCH[KEY];
if (original === undefined) throw new Error(`ARCH has no key "${KEY}"`);
const span = (sweep.length - 1) * SPACING + 55;
if (span > PLATE) {
    console.warn(`! ${sweep.length} variants at ${SPACING} mm pitch span ${span.toFixed(0)} mm, over the ${PLATE} mm plate.`);
    console.warn(`  Bambu will flag them as outside the bed — drop some values or lower --spacing.\n`);
}

const parts = [], legend = [];
sweep.forEach((v, i) => {
    ARCH[KEY] = v;
    const g = buildOne();
    const r = analyzeMesh(g.positions, g.indices);
    const w = wallAngles(g);
    const name = `${KEY}_${String(v).replace('.', 'p')}`;
    // stacked along Y — the piece is 150 long in X and only ~51 wide, so rows
    // are what fit on a plate
    parts.push({ name, positions: g.positions, indices: g.indices, at: [0, (i - (sweep.length - 1) / 2) * SPACING, 0] });
    legend.push({ obj: i + 1, name, value: v, band: w.band, flat: w.flat, steep: w.steep, ok: r.isManifold && r.isConsistent && r.windsOutward });
    fs.writeFileSync(path.join(OUT, `${name}.stl`), Buffer.from(generateBinarySTL(g.positions, g.indices)));
});
ARCH[KEY] = original;

const xml = generateMultiObject3MFXML(parts);
const zip = fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
});
const setFile = path.join(OUT, `sweep_${KEY}.3mf`);
fs.writeFileSync(setFile, Buffer.from(zip));

const rows = legend.map(l =>
    `  Object_${l.obj}  ${l.name.padEnd(18)} ${KEY}=${String(l.value).padEnd(6)} ` +
    `10-30deg band ${l.band.toFixed(0).padStart(4)} mm2   flat ${l.flat.toFixed(0).padStart(4)}   steep ${l.steep.toFixed(0).padStart(4)}   ${l.ok ? 'watertight' : 'BROKEN'}`
).join('\n');
fs.writeFileSync(path.join(OUT, `sweep_${KEY}.txt`),
    `ARCH.${KEY} sweep — ${PIECE}\n\nObjects are laid out front to back in the order below.\n` +
    `The 10-30 deg band is downward skirt-wall area that is neither flat enough\n` +
    `to bridge nor steep enough to self-support.\n\n${rows}\n`);

console.log(`ARCH.${KEY} sweep -> ${setFile}`);
console.log(rows);
console.log(`\nAlso wrote individual .stl files and sweep_${KEY}.txt to ${OUT}`);
