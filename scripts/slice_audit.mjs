/**
 * SLICE AUDIT — read what the slicer actually did, not what we hoped it would.
 *
 *   node scripts/slice_audit.mjs <file.3mf>     mesh: downward area by angle
 *   node scripts/slice_audit.mjs <file.gcode>   print: filament by FEATURE
 *
 * This exists because the argument about whether a surface needs support is
 * not settleable from the model alone. A downward face is supported, bridged,
 * or drooped depending on how it ARRIVES layer by layer, and the only thing
 * that knows is the slicer. Bambu tags every extrusion with `; FEATURE: ...`,
 * so a sliced file is a direct readout of that judgement — 17% of a curve
 * being `Bridge` says the ceiling is being spanned, and 3% being
 * `Floating vertical shell` says where it is not.
 *
 * The angle bands on the mesh side are chosen to match: under 5 deg a ceiling
 * arrives inside a layer or two and is a genuine span; 5-25 deg it arrives as
 * a series of slivers each cantilevered off the last, which is the band that
 * costs support. See HANDOFF.md.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const path = process.argv[2];
if (!path) {
    console.error('usage: node scripts/slice_audit.mjs <file.3mf|file.gcode>');
    process.exit(1);
}

if (/\.gcode$/i.test(path)) auditGcode(path);
else audit3mf(path);

/** Filament laid down per extrusion FEATURE, whole file and per layer band. */
function auditGcode(file) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const tot = new Map(), byZ = new Map();
    let feature = '(none)', z = 0;
    for (const line of lines) {
        if (line.startsWith('; FEATURE:')) { feature = line.slice(11).trim(); continue; }
        // Bambu does not emit ;Z: — track the Z of the layer-change move
        // itself, and note it writes `Z.4` rather than `Z0.4`.
        //
        // AND THE LAYER CHANGE IS OFTEN Z-ONLY: `G1 Z.2`, with no X or Y. The
        // obvious pattern wants whitespace before the Z, which that line does
        // not have once `G1 ` is consumed — so every bare layer change was
        // missed and its extrusions were filed under the PREVIOUS layer. It
        // read as a part floating 0.4 mm above the bed that was in fact sitting
        // on it. Totals per feature never depended on Z, but every per-layer
        // table did.
        const zm = /^G1\s[^;]*?Z([0-9.]+)/.exec(line);
        if (zm) z = parseFloat(zm[1]);
        if (!line.startsWith('G1 ')) continue;
        const m = /\sE(-?[0-9.]+)/.exec(line);
        if (!m) continue;
        const e = parseFloat(m[1]);
        if (!(e > 0)) continue;                       // retractions are not extrusion
        tot.set(feature, (tot.get(feature) ?? 0) + e);
        const key = `${feature}@${z.toFixed(2)}`;
        byZ.set(key, (byZ.get(key) ?? 0) + e);
    }
    const sum = [...tot.values()].reduce((a, b) => a + b, 0);
    console.log(`# ${file.split('/').pop()}\n`);
    console.log('| feature | filament mm | share |');
    console.log('|---|---|---|');
    for (const [f, v] of [...tot].sort((a, b) => b[1] - a[1])) {
        console.log(`| ${f} | ${v.toFixed(1)} | ${(100 * v / sum).toFixed(1)}% |`);
    }
    // the layers where the slicer had the most trouble
    const trouble = /Bridge|Floating|Overhang|Support/i;
    const worst = new Map();
    for (const [key, v] of byZ) {
        const [f, zz] = key.split('@');
        if (!trouble.test(f)) continue;
        worst.set(zz, (worst.get(zz) ?? 0) + v);
    }
    console.log('\nWorst layers (bridge + floating + overhang + support, mm of filament):');
    for (const [zz, v] of [...worst].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`  z=${zz}  ${v.toFixed(1)} mm`);
    }
}

/** Downward-facing area by how far it leans off the bed. 3MF is Z-up. */
function audit3mf(file) {
    const xml = execSync(`unzip -p ${JSON.stringify(file)} '3D/3dmodel.model'`,
        { maxBuffer: 1 << 28 }).toString();
    const objs = [...xml.matchAll(/<object[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)];
    console.log(`# ${file.split('/').pop()}\n`);
    console.log('| object | verts | height | first layer | flat <5° | 5–25° | 25–45° | >45° |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const [, id, body] of objs) {
        const vs = [...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)]
            .map(m => [+m[1], +m[2], +m[3]]);
        const ts = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
            .map(m => [+m[1], +m[2], +m[3]]);
        if (!vs.length) continue;
        let lo = Infinity, hi = -Infinity;
        for (const v of vs) { lo = Math.min(lo, v[2]); hi = Math.max(hi, v[2]); }
        const band = { flat: 0, shallow: 0, mid: 0, steep: 0 };
        let first = 0;
        for (const [a, b, c] of ts) {
            const A = vs[a], B = vs[b], C = vs[c];
            const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
            const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
            const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            const L = Math.hypot(...n);
            if (L < 1e-12) continue;
            const area = L / 2, nz = n[2] / L;
            if (Math.min(A[2], B[2], C[2]) <= lo + 0.25) { if (nz < -0.5) first += area; continue; }
            if (nz >= -1e-6) continue;
            const alpha = Math.acos(Math.min(1, -nz)) * 180 / Math.PI;   // 0 = flat ceiling
            if (alpha < 5) band.flat += area;
            else if (alpha < 25) band.shallow += area;
            else if (alpha < 45) band.mid += area;
            else band.steep += area;
        }
        console.log(`| ${id} | ${vs.length} | ${(hi - lo).toFixed(1)} mm | ${first.toFixed(0)} | `
            + `${band.flat.toFixed(0)} | ${band.shallow.toFixed(0)} | ${band.mid.toFixed(0)} | `
            + `${band.steep.toFixed(0)} |`);
    }
    console.log('\nAreas in mm². The 5–25° column is the one that costs support:');
    console.log('under 5° a ceiling arrives inside a layer and is bridged.');
}
