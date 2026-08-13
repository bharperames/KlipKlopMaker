/**
 * SLICE LOOP — build a part from this source tree, slice it with the REAL
 * Bambu slicer, and report what the slicer said about it.
 *
 *   node scripts/slice_loop.mjs                       every track piece, both styles
 *   node scripts/slice_loop.mjs curveR minimal        one part
 *   node scripts/slice_loop.mjs curveR minimal --process "0.10mm Standard @BBL P2S"
 *   node scripts/slice_loop.mjs --save                rewrite the stored baseline
 *
 * WHY THIS EXISTS. `slice_audit.mjs` reads a slice somebody made by hand in the
 * GUI. That settles an argument once, but it cannot be iterated: every geometry
 * change means another manual export, drag, slice and export. So the previous
 * session's conclusion — "iterate against the slicer, not against intuition" —
 * had no way to actually happen, and the next idea would have been judged the
 * same way the last six were, by eye.
 *
 * BambuStudio ships a CLI inside the .app, and the P2S system presets are
 * already on disk, so the whole loop runs headless in about twenty seconds:
 *
 *     build  ->  3MF  ->  bambu-studio --slice  ->  gcode  ->  feature totals
 *
 * WHAT TO WATCH, and what NOT to read into it. `Floating vertical shell` is
 * the metric, but it does NOT mean "broken" — it has a benign floor. A
 * perfectly flat ceiling produces one loop of it at the single layer where the
 * ceiling starts in mid-air, and then gets bridged normally: a `minimal`
 * straight, whose ceiling is measurably 0.00 deg, still prints 253 mm of it,
 * 119 mm of that in one layer. What distinguishes a curve is that its ceiling
 * arrives over ~50 layers instead of one, so it pays that perimeter cost fifty
 * times. Compare parts against each other and against the stored baseline;
 * never against zero.
 *
 * `Support` is the number that would mean real trouble, and it is 0.0 mm on
 * every part in the library today — nothing here needs support material. See
 * HANDOFF.md for the diagnosis these numbers come from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fflate from 'fflate';
import { layoutTrack, planPillarPositions } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildSwitchExportGeometry } from '../js/pieces.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { analyzeMesh } from '../js/mesh_utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAMBU = '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const PRESETS = `${process.env.HOME}/Library/Application Support/BambuStudio/system/BBL`;
const BASELINE = path.join(ROOT, 'reports', 'slice-baseline.json');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAVE = argv.includes('--save');
// Where to leave the 3MF and the gcode. Without this the loop is a
// measurement and throws its output away; with it, the same run produces
// something you can actually put on a printer.
const KEEP = flag('keep', null);
const PROCESS = flag('process', '0.20mm Standard @BBL P2S');
const MACHINE = flag('machine', 'Bambu Lab P2S 0.4 nozzle');
const FILAMENT = flag('filament', 'Bambu PLA Matte @BBL P2S');
const positional = argv.filter(a => !a.startsWith('--') &&
    argv[argv.indexOf(a) - 1] !== '--process' && argv[argv.indexOf(a) - 1] !== '--machine' &&
    argv[argv.indexOf(a) - 1] !== '--filament');

// The slicer is the whole point, so say plainly when it is not there rather
// than failing somewhere inside a zip writer.
for (const [what, p] of [['BambuStudio', BAMBU], ['its P2S presets', `${PRESETS}/process/${PROCESS}.json`]]) {
    if (!fs.existsSync(p)) {
        console.error(`slice_loop needs ${what}, not found at:\n  ${p}\n`);
        console.error('Install BambuStudio (and open it once so the system presets unpack),');
        console.error('or pass --process/--machine/--filament naming presets that do exist.');
        process.exit(1);
    }
}

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kk-slice-'));

/**
 * FLATTEN A PRESET BEFORE HANDING IT OVER, because the CLI does not follow
 * `inherits` and does not say so. A Bambu system preset is a leaf holding only
 * its own overrides — "0.16mm Standard @BBL P2S" does not contain a layer
 * height at all; that lives in `fdm_process_single_0.16`. Passed as-is, the
 * slicer takes the leaf's few fields, silently keeps 0.2 mm layers, and
 * reports a clean run. Two "different" layer heights then produce byte-identical
 * feature totals, which is how this was caught.
 *
 * The chain is resolved here and the merged preset written to a temp file, with
 * the child overriding the parent. `verifyLayerHeight` below is the belt to
 * this braces: it reads back what the gcode says actually happened.
 */
function flatten(kind, name) {
    const chain = [];
    let cur = name;
    while (cur) {
        const f = path.join(PRESETS, kind, `${cur}.json`);
        if (!fs.existsSync(f)) break;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        chain.unshift(j);
        cur = j.inherits;
    }
    if (!chain.length) throw new Error(`preset not found: ${kind}/${name}`);
    const merged = Object.assign({}, ...chain);
    delete merged.inherits;
    merged.name = name;
    const out = path.join(TMP, `${kind}_${name.replace(/[^\w.]+/g, '_')}.json`);
    fs.writeFileSync(out, JSON.stringify(merged));
    return out;
}

const MACHINE_JSON = flatten('machine', MACHINE);
const PROCESS_JSON = flatten('process', PROCESS);
const FILAMENT_JSON = flatten('filament', FILAMENT);

const zip = (xml) => Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
}));

/** One part, alone and centred on the bed — never packed. */
function write3MF(name, g) {
    const p = g.positions;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
        y0 = Math.min(y0, p[i + 1]);
        z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    // printer space is X=x, Y=-z, Z=y (the exporter's proper rotation), so the
    // build-item translation that centres the part on a 256 mm bed is this:
    const at = [128 - (x0 + x1) / 2, 128 + (z0 + z1) / 2, -y0];
    const f = path.join(TMP, `${name}.3mf`);
    fs.writeFileSync(f, zip(generateMultiObject3MFXML([{ name, positions: g.positions, indices: g.indices, at }])));
    return f;
}

let achievedLayer = 0;
const kept = [];

/** Filament laid down per extrusion FEATURE. Retractions are not extrusion. */
function features(gcode) {
    const tot = new Map();
    let feature = '(none)';
    for (const line of gcode.split('\n')) {
        if (line.startsWith('; FEATURE:')) { feature = line.slice(11).trim(); continue; }
        if (!line.startsWith('G1 ')) continue;
        const m = /\sE(-?[0-9.]+)/.exec(line);
        if (!m) continue;
        const e = parseFloat(m[1]);
        if (e > 0) tot.set(feature, (tot.get(feature) ?? 0) + e);
    }
    return tot;
}

function slice(name, g) {
    const f3mf = write3MF(name, g);
    const out = path.join(TMP, `out_${name}`);
    fs.mkdirSync(out, { recursive: true });
    try {
        execFileSync(BAMBU, [
            '--load-settings', `${MACHINE_JSON};${PROCESS_JSON}`,
            '--load-filaments', FILAMENT_JSON,
            '--slice', '0', '--outputdir', out, f3mf
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        const r = path.join(out, 'result.json');
        const why = fs.existsSync(r) ? JSON.parse(fs.readFileSync(r, 'utf8')).error_string : e.message;
        return { name, failed: why };
    }
    const gcode = fs.readFileSync(path.join(out, 'plate_1.gcode'), 'utf8');
    if (KEEP) {
        const dir = path.resolve(ROOT, KEEP);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(f3mf, path.join(dir, `${name}.3mf`));
        fs.copyFileSync(path.join(out, 'plate_1.gcode'), path.join(dir, `${name}.gcode`));
        kept.push(path.join(path.relative(ROOT, dir), `${name}.gcode`));
    }
    // What the slicer says it DID, not what we asked for. See flatten() above.
    achievedLayer = parseFloat(/^; layer_height = ([0-9.]+)/m.exec(gcode)?.[1] ?? '0');
    const tot = features(gcode);
    const sum = [...tot.values()].reduce((a, b) => a + b, 0);
    const get = (re) => [...tot].filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
    const r = analyzeMesh(g.positions, g.indices);
    return {
        name,
        watertight: r.isManifold && r.isConsistent && r.windsOutward,
        massG: +(r.volumeMm3 / 1000 * 1.24).toFixed(1),
        filament: Math.round(sum),
        floating: +get(/Floating/).toFixed(1),
        overhang: +get(/Overhang/).toFixed(1),
        bridge: +get(/Bridge/).toFixed(1),
        support: +get(/Support/).toFixed(1),
        troublePct: +(100 * get(/Floating|Overhang/) / sum).toFixed(2)
    };
}

// ---------------------------------------------------------------------------
await initCSG();

const SEQ = ['start', 'straight', 'curveR', 'curveL', 'lift', 'powered', 'straight', 'end'];
const TYPES = positional.length ? [positional[0]]
    : ['start', 'straight', 'curveR', 'lift', 'powered', 'end'];
const STYLES = positional.length > 1 ? [positional[1]] : ['viaduct', 'minimal'];

const rows = [];
for (const style of STYLES) {
    const { pieces } = layoutTrack(SEQ, { skirtStyle: style });
    const sups = planPillarPositions(pieces);
    for (const type of TYPES) {
        const pc = pieces.filter(p => p.type === type).at(-1);
        if (!pc) continue;
        const support = sups.find(s => s.pieceIndex === pc.index);
        process.stderr.write(`slicing ${type} (${style})...\r`);
        rows.push(slice(`${type}_${style}`, buildPieceExportGeometry(pc, { support, forPrint: true })));
    }
    if (!positional.length) {
        const sw = layoutTrack([{ type: 'switchL', gate: 'main', main: ['straight'], branch: ['straight'] }],
            { skirtStyle: style });
        const ss = planPillarPositions(sw.pieces);
        const main = sw.pieces.find(p => p.role === 'main');
        process.stderr.write(`slicing switchL (${style})...\r`);
        rows.push(slice(`switchL_${style}`, buildSwitchExportGeometry(main,
            sw.pieces.find(p => p.role === 'branch'),
            { support: ss.find(s => s.pieceIndex === main.index), forPrint: true })));
    }
}

const prev = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
const was = new Map((prev?.rows ?? []).map(r => [r.name, r]));

const wanted = parseFloat(/^([0-9.]+)mm/.exec(PROCESS)?.[1] ?? '0');
console.log(`\n# Slice loop — ${PROCESS} (sliced at ${achievedLayer} mm layers)\n`);
if (wanted && achievedLayer && Math.abs(wanted - achievedLayer) > 1e-6) {
    console.log(`! the preset name says ${wanted} mm but the gcode says ${achievedLayer} mm — `
        + `the inheritance chain did not resolve. Numbers below are NOT what you asked for.\n`);
}
console.log('| part | g | filament | floating | overhang | bridge | support | trouble | vs baseline |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
    if (r.failed) { console.log(`| ${r.name} | — | SLICER ERROR: ${r.failed} |`); continue; }
    const b = was.get(r.name);
    const d = b ? (r.floating + r.overhang) - (b.floating + b.overhang) : null;
    const delta = d === null ? '—' : (d > 0.5 ? `+${d.toFixed(0)} worse` : d < -0.5 ? `${d.toFixed(0)} better` : 'same');
    console.log(`| ${r.name} | ${r.massG} | ${r.filament} | ${r.floating} | ${r.overhang} | `
        + `${r.bridge} | ${r.support}${r.support > 0 ? ' ⚠' : ''} | ${r.troublePct}% | ${delta} |`);
}
console.log('\nfloating/overhang/bridge/support are mm of filament in that feature class.');
console.log('Floating vertical shell has a benign floor — read the header of this file.');

if (kept.length) {
    console.log(`\nready to print (sliced at ${achievedLayer} mm, ${FILAMENT}):`);
    for (const f of kept) console.log(`  ${f}`);
}
if (SAVE) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ process: PROCESS, rows }, null, 2) + '\n');
    console.log(`\nbaseline written to ${path.relative(ROOT, BASELINE)}`);
}
fs.rmSync(TMP, { recursive: true, force: true });
