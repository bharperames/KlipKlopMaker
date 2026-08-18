#!/usr/bin/env node
/**
 * SLICE A 3MF THAT ALREADY EXISTS, and report what the slicer says about it.
 *
 *   node scripts/slice_file.mjs test-parts/collet/collet.3mf [--brim]
 *
 * `slice_loop.mjs` builds parts and slices them in one pass, which is right
 * when the geometry is the thing under test. It is the wrong tool for checking
 * a plate that has already been written, because it would rebuild rather than
 * read — and the standing rule is that a plate is verified from the FILE that
 * goes to the printer, not from the code that made it.
 *
 * Reports time, mass, and `sliced_plates[0].warning_message` from result.json,
 * which is the only place the floating-regions warning is machine-readable.
 *
 * QUOTE YOUR OWN PROFILE, NOT THIS ONE. Defaults here are 0.20mm Standard @BBL
 * P2S with PETG HF; Brett's GUI profile is not that and disagrees by ~25% on
 * mass. These numbers rank plates and confirm a plate slices clean. Anything
 * absolute comes off his slicer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAMBU = '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const PRESETS = `${process.env.HOME}/Library/Application Support/BambuStudio/system/BBL`;

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: slice_file.mjs <file.3mf> [--brim]'); process.exit(2); }
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const PROCESS = flag('process', '0.20mm Standard @BBL P2S');
const MACHINE = flag('machine', 'Bambu Lab P2S 0.4 nozzle');
const FILAMENT = flag('filament', 'Bambu PETG HF @BBL P2S 0.4 nozzle');
// THE PLATE HAS TO BE NAMED OR PETG WILL NOT SLICE — no preset carries
// `curr_bed_type`, the CLI falls back to the Cool Plate, and PETG's own
// temperature table is zero there. See curve_variants.mjs for the full note.
const BED = flag('bed', 'Textured PEI Plate');
const BRIM = argv.includes('--brim');

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kk-slicefile-'));

/** Resolve `inherits` by hand — the CLI does not, and does not say so. */
function flatten(kind, name, extra = {}) {
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
    const merged = Object.assign({}, ...chain, extra);
    delete merged.inherits;
    merged.name = name;
    const out = path.join(TMP, `${kind}.json`);
    fs.writeFileSync(out, JSON.stringify(merged));
    return out;
}

// The collet's first layer is three separate islands by design; a brim is how
// that plate is meant to be printed, so the check has to be run that way too.
const MACHINE_JSON = flatten('machine', MACHINE, { curr_bed_type: BED });
const PROCESS_JSON = flatten('process', PROCESS,
    BRIM ? { brim_type: 'outer_only', brim_width: '5', brim_object_gap: '0.1' } : {});
const FILAMENT_JSON = flatten('filament', FILAMENT);

const out = path.join(TMP, 'out');
fs.mkdirSync(out, { recursive: true });
let failed = null;
try {
    execFileSync(BAMBU, ['--load-settings', `${MACHINE_JSON};${PROCESS_JSON}`,
        '--load-filaments', FILAMENT_JSON, '--slice', '0', '--outputdir', out,
        path.resolve(ROOT, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { failed = e.message; }

const rj = path.join(out, 'result.json');
const res = fs.existsSync(rj) ? JSON.parse(fs.readFileSync(rj, 'utf8')) : null;
// `error_string` is "Success." on a good run — it is a status, not a fault.
const err = res?.error_string && !/^success\.?$/i.test(res.error_string) ? res.error_string : null;
if (err) { console.error(`SLICE FAILED: ${err}`); process.exit(1); }
if (failed && !res) { console.error(`SLICE FAILED: ${failed}`); process.exit(1); }

const gpath = path.join(out, 'plate_1.gcode');
const g = fs.existsSync(gpath) ? fs.readFileSync(gpath, 'utf8') : '';
const grab = (re) => re.exec(g)?.[1] ?? '?';
console.log(`\n${file}`);
console.log(`  profile      ${PROCESS} · ${FILAMENT}${BRIM ? ' · BRIM 5 mm' : ''}`);
console.log(`  layer        ${grab(/^; layer_height = ([0-9.]+)/m)} mm`);
console.log(`  time         ${grab(/^; model printing time: (.+?);/m)}`);
console.log(`  filament     ${grab(/^; total filament weight \[g\] : ([0-9.]+)/m)} g`);
const warn = res?.sliced_plates?.[0]?.warning_message ?? '';
console.log(`  warning      ${warn ? `*** ${warn}` : '(none)'}`);
fs.rmSync(TMP, { recursive: true, force: true });
