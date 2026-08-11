/**
 * PRINT SUITABILITY AUDIT — every printable part, measured off its own mesh.
 *
 * Run from the repo root:  node scripts/print_audit.mjs
 * Writes reports/print-audit.md and reports/print-audit.html (open the latter
 * in a browser — no server needed, it is self-contained).
 *
 * The parts are exported in the orientation they PRINT in, which for a minimal
 * track piece means already tilted onto its underside. So every number here is
 * about the part as the slicer receives it, not as it sits in a tower.
 *
 * What is measured, and why each one is here:
 *
 *  - watertight     manifold + consistently wound + outward volume. A slicer
 *                   will "repair" anything else silently and print something
 *                   nobody drew.
 *  - first layer    the area actually touching the plate. This is adhesion,
 *                   and it is the number that caught the socket boss starting
 *                   on 1.3 mm2 of air.
 *  - contact frac   first layer over bounding footprint. Low means the part
 *                   perches rather than sits.
 *  - slenderness    height over the smaller footprint dimension. Above ~6 a
 *                   part is at risk from a nozzle strike (see riserSizes).
 *  - overhang       area of downward-facing surface by how far it leans off
 *                   vertical. Under 45 deg from the bed is where FDM starts
 *                   needing help; 0 deg is a flat ceiling.
 *  - islands        downward-facing area with NOTHING under it — the part of
 *                   the overhang a slicer must support rather than bridge.
 */
import { layoutTrack, SPEC, STANDARD, GEOMETRY_VERSION, planPillarPositions,
    decomposeSupport, stackHeightMm, spacerHeightMm, spacerVariant, socketMouthY,
    needsPier, supportsPillar, massCentreS, SPACER_VARIANTS } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, buildSwitchExportGeometry, buildKeyGeometry,
    buildGateGeometry, buildSpacerGeometry, buildSupportFootGeometry, buildRiserGeometry,
    buildJogGeometry, buildTowerGeometry, buildPatioGeometry, toBufferGeometry } from '../js/pieces.js';
import { analyzeMesh, bedStability } from '../js/mesh_utils.js';
import { writeFileSync } from 'node:fs';

// every console.log below is captured so the same run can emit both formats
const md = [];
const out = (line = '') => { md.push(line); console.log(line); };

const PLA_G_PER_CM3 = 1.24;
const LAYER = 0.2;

const arrays = (g) => {
    if (g?.positions && g?.indices) return { positions: g.positions, indices: g.indices };
    const bg = g?.attributes ? g : toBufferGeometry(g);
    const pos = bg.attributes.position.array;
    return {
        positions: pos,
        indices: bg.index ? bg.index.array : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i)
    };
};

/** Downward-facing area, split by how far the surface leans off the bed. */
function overhangProfile(positions, indices, bedY) {
    const bands = { flat: 0, steep: 0, fine: 0 };   // <25 deg, 25-45, >45 from bed
    let unsupported = 0, lowIsland = 0, worstAt = null, worst = 90;
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const A = [positions[a], positions[a + 1], positions[a + 2]];
        const B = [positions[b], positions[b + 1], positions[b + 2]];
        const C = [positions[c], positions[c + 1], positions[c + 2]];
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(...n);
        if (len < 1e-12) continue;
        const area = len / 2;
        const ny = n[1] / len;
        if (ny >= -1e-6) continue;                       // not downward-facing
        const lowest = Math.min(A[1], B[1], C[1]);
        if (lowest <= bedY + LAYER) continue;            // that is the first layer
        const alpha = Math.acos(Math.min(1, -ny)) * 180 / Math.PI;  // 0 = flat ceiling
        if (alpha < 25) bands.flat += area;
        else if (alpha < 45) bands.steep += area;
        else bands.fine += area;
        if (alpha < worst) { worst = alpha; worstAt = [A[0].toFixed(0), A[1].toFixed(0), A[2].toFixed(0)]; }
        if (alpha < 45) {
            // Nothing directly under it. NB this counts BRIDGES as well as
            // islands — the drumhead underside is the biggest term on every
            // track piece and it is a bridge between two walls by design, which
            // FDM spans without help. What actually costs support is the same
            // area starting near the plate with no anchor, so that is split out.
            const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3, cz = (A[2] + B[2] + C[2]) / 3;
            if (!somethingBelow(positions, indices, cx, cy, cz)) {
                unsupported += area;
                if (cy < bedY + 5) lowIsland += area;
            }
        }
    }
    return { ...bands, unsupported, lowIsland, worst: worstAt ? worst : null };
}

function somethingBelow(P, I, x, y, z) {
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], cx = P[c], cz = P[c + 2];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (l1 < 0 || l2 < 0 || 1 - l1 - l2 < 0) continue;
        const hit = l1 * P[a + 1] + l2 * P[b + 1] + (1 - l1 - l2) * P[c + 1];
        if (hit < y - 0.05) return true;
    }
    return false;
}

function audit(name, geom) {
    const { positions, indices } = arrays(geom);
    const r = analyzeMesh(positions, indices);
    const bed = bedStability(positions, indices);
    let lo = Infinity;
    for (let i = 1; i < positions.length; i += 3) lo = Math.min(lo, positions[i]);
    const oh = overhangProfile(positions, indices, lo);
    return {
        name,
        ok: r.isManifold && r.isConsistent && r.windsOutward,
        volCm3: r.volumeMm3 / 1000,
        massG: (r.volumeMm3 / 1000) * PLA_G_PER_CM3,
        w: bed.widthMm, d: bed.depthMm, h: bed.heightMm,
        contact: bed.contactMm2,
        frac: bed.contactFraction,
        slender: bed.slenderness,
        ...oh
    };
}

await initCSG();

// ---------------------------------------------------------------------------
const SEQ = ['start', 'straight', 'curveL', 'curveR', 'lift', 'powered', 'elevator', 'straight', 'end'];
const rows = [];
for (const style of ['viaduct', 'minimal']) {
    const { pieces } = layoutTrack(SEQ, { skirtStyle: style });
    const sups = planPillarPositions(pieces);
    for (const type of ['start', 'straight', 'curveL', 'lift', 'powered', 'elevator', 'end']) {
        const pc = pieces.filter(p => p.type === type).at(-1);
        if (!pc) continue;
        const support = sups.find(s => s.pieceIndex === pc.index);
        rows.push(audit(`${type} (${style})`,
            buildPieceExportGeometry(pc, { support, forPrint: true })));
    }
}
for (const style of ['viaduct', 'minimal']) {
    const sw = layoutTrack([{ type: 'switchL', gate: 'main', main: ['straight'], branch: ['straight'] }],
        { skirtStyle: style });
    const sups = planPillarPositions(sw.pieces);
    const main = sw.pieces.find(p => p.role === 'main');
    rows.push(audit(`switchL (${style})`, buildSwitchExportGeometry(main,
        sw.pieces.find(p => p.role === 'branch'),
        { support: sups.find(s => s.pieceIndex === main.index), forPrint: true })));
}

rows.push(audit('bowtie_key', buildKeyGeometry()));
rows.push(audit('gate_paddle', buildGateGeometry(SPEC, { forPrint: true })));
for (const v of SPACER_VARIANTS) {
    rows.push(audit(`spacer ${v.code} (${v.heightMm})`,
        buildSpacerGeometry(v.heightMm, SPEC, { rings: v.rings })));
}
rows.push(audit('support_foot', buildSupportFootGeometry()));
for (const size of STANDARD.riserSizes) rows.push(audit(`riser ${size}`, buildRiserGeometry(size)));
rows.push(audit('support_jog', buildJogGeometry()));
rows.push(audit('scenery_tower', buildTowerGeometry(100)));
rows.push(audit('scenery_patio', buildPatioGeometry()));

const f2 = (x) => x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2);
out(`# Print suitability — geometry v${GEOMETRY_VERSION}\n`);
out('| part | ok | cm³ | g | W×D×H mm | 1st layer mm² | contact | slender | ≤25° | 25–45° | unsupported | low island |');
out('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
    out(`| ${r.name} | ${r.ok ? '✔' : '✘'} | ${f2(r.volCm3)} | ${f2(r.massG)} | `
        + `${r.w.toFixed(0)}×${r.d.toFixed(0)}×${r.h.toFixed(0)} | ${r.contact.toFixed(0)} | `
        + `${(r.frac * 100).toFixed(0)}% | ${r.slender.toFixed(1)} | ${r.flat.toFixed(0)} | `
        + `${r.steep.toFixed(0)} | ${r.unsupported.toFixed(0)} | ${r.lowIsland.toFixed(0)} |`);
}

// ---------------------------------------------------------------------------
out('\n# The height ladder\n');
out(`Grid ${STANDARD.gridMm} mm · foot ${STANDARD.footHeight} · risers `
    + `${STANDARD.riserSizes.join(', ')} · jog ${SPEC.jog.heightMm} · spacers `
    + SPACER_VARIANTS.map(v => `${v.code} ${v.heightMm}`).join(', ') + '\n');

const LIB = [
    ['spiral', ['straight', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'straight', 'straight']],
    ['lifts', ['straight', 'curveL', 'curveL', 'lift', 'lift', 'curveR', 'straight']],
    ['flat run', ['straight', 'straight', 'straight']]
];
out('| design | style | supports | off-grid | worst residual | riser count |');
out('|---|---|---|---|---|---|');
for (const [name, seq] of LIB) {
    for (const style of ['viaduct', 'minimal']) {
        const { pieces } = layoutTrack(seq, { skirtStyle: style });
        const sups = planPillarPositions(pieces)
            .filter(s => supportsPillar(s) && needsPier(pieces[s.pieceIndex]));
        let offGrid = 0, worst = 0, risers = 0;
        for (const sup of sups) {
            const pc = pieces[sup.pieceIndex];
            const stack = stackHeightMm(pc, sup);
            const dec = decomposeSupport(stack);
            if (stack > 1 && !dec) { offGrid++; continue; }
            risers += dec ? dec.risers.length : 0;
            const built = (dec ? STANDARD.footHeight + dec.risers.reduce((a, b) => a + b, 0) : 0)
                + (sup.mode === 'jog' ? SPEC.jog.heightMm : 0) + spacerHeightMm(pc);
            worst = Math.max(worst, Math.abs(built - socketMouthY(pc, sup.s)));
        }
        out(`| ${name} | ${style} | ${sups.length} | ${offGrid} | ${worst.toFixed(3)} mm | ${risers} |`);
    }
}

out('\n## What each piece type asks the ladder for\n');
out('| piece | style | mouth above rim | spacer | remainder the stack must make |');
out('|---|---|---|---|---|');
for (const style of ['viaduct', 'minimal']) {
    const { pieces } = layoutTrack(SEQ, { skirtStyle: style });
    const seen = new Set();
    for (const pc of pieces) {
        if (seen.has(pc.type)) continue;
        seen.add(pc.type);
        const mouth = socketMouthY(pc) - pc.rimY;
        const sp = spacerHeightMm(pc);
        const v = spacerVariant(sp);
        out(`| ${pc.type} | ${style} | ${mouth.toFixed(3)} | ${sp ? `${v?.code} ${sp}` : '—'} | `
            + `${(mouth - sp).toFixed(3)} |`);
    }
}

// ---------------------------------------------------------------------------
// Same run, second format. The markdown is the source of truth; this renders
// it, so the two can never disagree.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const cell = (t) => {
    const v = inline(t.trim());
    if (v === '✔') return '<td class="ok">✔</td>';
    if (v === '✘') return '<td class="bad">✘</td>';
    return `<td>${v}</td>`;
};

const body = [];
let table = null;
// entries may carry embedded newlines (a heading written with a blank line
// around it), so flatten before parsing or those lines never match a rule
for (const raw of md.join('\n').split('\n')) {
    const line = raw.trimEnd();
    const isRow = line.startsWith('|');
    if (!isRow && table) { body.push(`<table>${table.join('')}</table>`); table = null; }
    if (isRow) {
        const cells = line.slice(1, -1).split('|');
        if (cells.every(c => /^\s*-+\s*$/.test(c))) continue;      // the --- rule
        if (!table) {
            table = [`<tr>${cells.map(c => `<th>${inline(c.trim())}</th>`).join('')}</tr>`];
        } else {
            table.push(`<tr>${cells.map(cell).join('')}</tr>`);
        }
        continue;
    }
    if (line.startsWith('## ')) body.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) body.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line) body.push(`<p class="desc">${inline(line)}</p>`);
}
if (table) body.push(`<table>${table.join('')}</table>`);

writeFileSync(new URL('../reports/print-audit.md', import.meta.url), md.join('\n') + '\n');
writeFileSync(new URL('../reports/print-audit.html', import.meta.url), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Klip Klop Konstructor — Print Suitability Audit</title>
<style>
:root { color-scheme: light dark;
  --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e;
  --line:#e4e1d7; --card:#f6f4ec; }
@media (prefers-color-scheme: dark) { :root {
  --surface-1:#1a1a19; --text-primary:#fff; --text-secondary:#c3c2b7;
  --line:#3a3831; --card:#232320; } }
body { margin:0 auto; max-width:1040px; padding:24px 20px 80px;
  font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;
  background:var(--surface-1); color:var(--text-primary); }
h1 { font-size:22px; } h2 { font-size:17px; margin:34px 0 6px; }
.desc { color:var(--text-secondary); max-width:78ch; }
.wrap { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:12.5px; margin:8px 0 4px;
  font-variant-numeric:tabular-nums; }
th { text-align:left; color:var(--text-secondary); font-weight:600; white-space:nowrap; }
td,th { padding:4px 8px; border-bottom:1px solid var(--line); }
tr:nth-child(even) td { background:var(--card); }
td:first-child { white-space:nowrap; }
code { background:var(--card); padding:0 4px; border-radius:3px; font-size:12px; }
.ok { color:#0ca30c; font-weight:700; } .bad { color:#d03b3b; font-weight:700; }
</style></head><body>
${body.map(b => b.startsWith('<table') ? `<div class="wrap">${b}</div>` : b).join('\n')}
</body></html>
`);
