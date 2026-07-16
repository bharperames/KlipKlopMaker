#!/usr/bin/env node
/**
 * generate_reports.mjs
 * Solves every scene in scenes/ with the same simulator the tests use and
 * writes a self-contained visual report to reports/index.html:
 * summary table, per-scene stats + expectation checks, velocity/elevation
 * charts (inline SVG), regime timeline, and a 3D screenshot if
 * reports/img/<scene>.png exists (produced by the Playwright shot runner).
 *
 * Usage: node scripts/generate_reports.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutTrack, resolveRidePath } from '../js/track.js';
import { FRICTION_PRESETS } from '../js/physics.js';
import { simulateRun, verifyEnergyBudget } from '../js/simulate.js';
import { deserializeScene } from '../js/scene_format.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENES = path.join(ROOT, 'scenes');
const OUT = path.join(ROOT, 'reports');
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });

// dataviz reference palette (light/dark handled via CSS variables)
const SERIES_1 = 'var(--series-1)';
const MODE_COLORS = { walk: '#0ca30c', slide: '#ec835a' }; // status: good / serious

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Minimal line chart: thin 2px line, recessive grid, direct axis labels. */
function svgLineChart({ points, xLabel, yLabel, width = 640, height = 220, bands = [], marks = [] }) {
    const P = { l: 52, r: 14, t: 14, b: 34 };
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1e-6);
    const yMin = Math.min(0, ...ys), yMax = Math.max(...ys) * 1.08 + 1e-6;
    const X = v => P.l + ((v - x0) / (x1 - x0)) * (width - P.l - P.r);
    const Y = v => height - P.b - ((v - yMin) / (yMax - yMin)) * (height - P.t - P.b);
    const ticksY = 4, ticksX = 6;
    let grid = '', labels = '';
    for (let i = 0; i <= ticksY; i++) {
        const v = yMin + ((yMax - yMin) * i) / ticksY;
        grid += `<line x1="${P.l}" y1="${Y(v)}" x2="${width - P.r}" y2="${Y(v)}" class="grid"/>`;
        labels += `<text x="${P.l - 6}" y="${Y(v) + 3.5}" class="tick" text-anchor="end">${v >= 100 ? v.toFixed(0) : v.toFixed(1)}</text>`;
    }
    for (let i = 0; i <= ticksX; i++) {
        const v = x0 + ((x1 - x0) * i) / ticksX;
        labels += `<text x="${X(v)}" y="${height - P.b + 16}" class="tick" text-anchor="middle">${v >= 100 ? v.toFixed(0) : v.toFixed(1)}</text>`;
    }
    const bandRects = bands.map(b =>
        `<rect x="${X(b.from)}" y="${P.t}" width="${Math.max(0, X(b.to) - X(b.from))}" height="${height - P.t - P.b}" fill="${b.color}" opacity="0.13"/>`
    ).join('');
    const line = `<polyline fill="none" stroke="${SERIES_1}" stroke-width="2" stroke-linejoin="round" points="${points.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/>`;
    const markEls = marks.map(m => {
        const nearRight = X(m.x) > width - 110;
        return `<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="4.5" fill="${m.color}" stroke="var(--surface-1)" stroke-width="2"/>` +
            `<text x="${X(m.x) + (nearRight ? -8 : 8)}" y="${Y(m.y) - 8}" class="marklabel"` +
            `${nearRight ? ' text-anchor="end"' : ''}>${esc(m.label)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img" style="max-width:100%">
        ${bandRects}${grid}
        <line x1="${P.l}" y1="${Y(Math.max(0, yMin))}" x2="${width - P.r}" y2="${Y(Math.max(0, yMin))}" class="axis"/>
        ${line}${markEls}${labels}
        <text x="${(P.l + width - P.r) / 2}" y="${height - 4}" class="axislabel" text-anchor="middle">${esc(xLabel)}</text>
        <text transform="rotate(-90)" x="${-(P.t + (height - P.t - P.b) / 2)}" y="14" class="axislabel" text-anchor="middle">${esc(yLabel)}</text>
    </svg>`;
}

/** Contiguous mode bands over time for chart underlays. */
function modeBands(trace) {
    const bands = [];
    for (const s of trace) {
        const last = bands[bands.length - 1];
        if (last && last.mode === s.mode) last.to = s.t;
        else bands.push({ mode: s.mode, from: s.t, to: s.t, color: MODE_COLORS[s.mode] ?? '#999' });
    }
    return bands;
}

function checkExpectations(exp, result, layout) {
    const checks = [];
    const add = (label, ok, actual) => checks.push({ label, ok, actual });
    if (exp.outcome) add(`outcome = ${exp.outcome}`, result.outcome === exp.outcome, result.outcome);
    if (exp.maxTimeS !== undefined) add(`time ≤ ${exp.maxTimeS}s`, result.tEnd <= exp.maxTimeS, `${result.tEnd}s`);
    if (exp.minClacks !== undefined) add(`clacks ≥ ${exp.minClacks}`, result.stats.clacks >= exp.minClacks, result.stats.clacks);
    if (exp.minWalkedFraction !== undefined) add(`walked ≥ ${exp.minWalkedFraction * 100}%`, result.stats.walkedFraction >= exp.minWalkedFraction, `${(result.stats.walkedFraction * 100).toFixed(0)}%`);
    if (exp.maxWalkedFraction !== undefined) add(`walked ≤ ${exp.maxWalkedFraction * 100}%`, result.stats.walkedFraction <= exp.maxWalkedFraction, `${(result.stats.walkedFraction * 100).toFixed(0)}%`);
    if (exp.minMaxV !== undefined) add(`peak speed ≥ ${exp.minMaxV} mm/s`, result.stats.maxV >= exp.minMaxV, `${result.stats.maxV.toFixed(0)} mm/s`);
    if (exp.minLaps !== undefined) add(`laps ≥ ${exp.minLaps}`, result.stats.laps >= exp.minLaps, result.stats.laps);
    const errs = [...new Set(layout.issues.filter(i => i.level === 'error').map(i => i.code))].sort();
    const expected = [...(exp.layoutErrors ?? [])].sort();
    add(`layout errors = [${expected.join(', ') || 'none'}]`, JSON.stringify(errs) === JSON.stringify(expected), `[${errs.join(', ') || 'none'}]`);
    const energy = verifyEnergyBudget(result.trace);
    add('energy budget (no energy creation)', energy.ok, energy.ok ? 'holds' : `violated by ${energy.worst.toFixed(0)} mm²/s²`);
    return checks;
}

const sceneFiles = fs.readdirSync(SCENES).filter(f => f.endsWith('.json')).sort();
const sections = [];
const summary = [];

for (const file of sceneFiles) {
    const id = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(SCENES, file), 'utf8'));
    const st = deserializeScene(raw);
    const layout = layoutTrack(st.sequence, { slopeDeg: st.slopeDeg, innerWidth: st.innerWidth, curveRadius: st.curveRadius, loop: st.loop });
    const result = simulateRun(resolveRidePath(layout.pieces), { mu: FRICTION_PRESETS[st.muKey].mu, walker: st.walker, loop: st.loop, maxLaps: 3 });
    const checks = checkExpectations(raw.expect ?? {}, result, layout);
    const pass = checks.every(c => c.ok);
    summary.push({ id, name: raw.name, outcome: result.outcome, expected: raw.expect?.outcome, t: result.tEnd, clacks: result.stats.clacks, maxV: result.stats.maxV, pass });

    const vChart = svgLineChart({
        points: result.trace.map(s => [s.t, s.v]),
        xLabel: 'time (s)', yLabel: 'speed (mm/s)',
        bands: modeBands(result.trace).map(b => ({ ...b })),
        marks: result.trace.length ? [{
            x: result.trace.at(-1).t, y: result.trace.at(-1).v,
            color: result.outcome === 'arrived' ? MODE_COLORS.walk : '#d03b3b',
            label: result.outcome
        }] : []
    });
    const profile = svgLineChart({
        points: result.trace.map(s => [s.dist, s.y]),
        xLabel: 'distance along track (mm)', yLabel: 'deck height (mm)',
        marks: result.trace.length ? [{
            x: result.stopDist, y: result.trace.at(-1).y,
            color: result.outcome === 'arrived' ? MODE_COLORS.walk : '#d03b3b',
            label: `stop @ ${result.stopDist} mm`
        }] : []
    });

    const eventRows = result.events.slice(0, 24).map(e =>
        `<tr><td>${e.t.toFixed(2)}s</td><td>${e.dist} mm</td><td>${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`
    ).join('');
    const checkRows = checks.map(c =>
        `<tr><td>${c.ok ? '<span class="ok">✔</span>' : '<span class="bad">✖</span>'}</td><td>${esc(c.label)}</td><td>${esc(String(c.actual))}</td></tr>`
    ).join('');

    // Inline as a data URI so the report is one self-contained file that
    // renders identically over http, file://, and artifact hosting.
    const imgPath = path.join(OUT, 'img', `${id}.png`);
    const img = fs.existsSync(imgPath)
        ? `<img src="data:image/png;base64,${fs.readFileSync(imgPath).toString('base64')}" alt="3D view of ${esc(raw.name)}">`
        : '<div class="noimg">no screenshot (run the shot runner)</div>';

    sections.push(`
    <section id="${id}">
        <h2>${pass ? '✅' : '❌'} ${esc(raw.name)} <span class="sub">${id}</span></h2>
        <p class="desc">${esc(raw.description ?? '')}</p>
        <div class="cols">
            <div>${img}</div>
            <div>
                <table class="checks"><thead><tr><th></th><th>expectation</th><th>actual</th></tr></thead><tbody>${checkRows}</tbody></table>
                <div class="statline">
                    outcome <b>${result.outcome}</b> · ${result.tEnd}s · ${result.stats.clacks} clacks ·
                    peak ${result.stats.maxV.toFixed(0)} mm/s · walked ${(result.stats.walkedFraction * 100).toFixed(0)}% ·
                    drop ${layout.totalDropMm.toFixed(0)} mm
                </div>
            </div>
        </div>
        <h3>Speed over time <span class="modes">${[...new Set(result.trace.map(s => s.mode))].map(m =>
            `<span class="modechip" style="--c:${MODE_COLORS[m]}">${m}</span>`).join(' ')}</span></h3>
        ${vChart}
        <h3>Elevation profile</h3>
        ${profile}
        <details><summary>Event timeline (${result.events.length} events)</summary>
            <table class="events"><thead><tr><th>t</th><th>dist</th><th>type</th><th>detail</th></tr></thead><tbody>${eventRows}</tbody></table>
        </details>
    </section>`);
}

const summaryRows = summary.map(s =>
    `<tr><td>${s.pass ? '<span class="ok">✔ pass</span>' : '<span class="bad">✖ FAIL</span>'}</td>
     <td><a href="#${s.id}">${esc(s.name)}</a></td><td>${esc(s.outcome)}</td><td>${esc(s.expected ?? '—')}</td>
     <td>${s.t}s</td><td>${s.clacks}</td><td>${s.maxV.toFixed(0)}</td></tr>`
).join('');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Klip Klop Maker — Scene Verification Report</title>
<style>
:root { color-scheme: light dark;
  --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e;
  --series-1:#2a78d6; --line:#e4e1d7; --card:#f6f4ec; }
@media (prefers-color-scheme: dark) { :root {
  --surface-1:#1a1a19; --text-primary:#fff; --text-secondary:#c3c2b7;
  --series-1:#3987e5; --line:#3a3831; --card:#232320; } }
body { margin:0 auto; max-width:960px; padding:24px 20px 80px;
  font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;
  background:var(--surface-1); color:var(--text-primary); }
h1 { font-size:22px; } h2 { font-size:17px; margin:34px 0 4px; } h3 { font-size:13px; color:var(--text-secondary); margin:18px 0 4px; }
.sub { color:var(--text-secondary); font-weight:400; font-size:12px; }
.desc { color:var(--text-secondary); max-width:72ch; }
table { border-collapse:collapse; width:100%; font-size:12.5px; }
th { text-align:left; color:var(--text-secondary); font-weight:600; }
td,th { padding:4px 8px; border-bottom:1px solid var(--line); }
.ok { color:#0ca30c; font-weight:700; } .bad { color:#d03b3b; font-weight:700; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; margin-top:10px; }
.cols img { width:100%; border-radius:10px; border:1px solid var(--line); }
.noimg { padding:40px 10px; text-align:center; color:var(--text-secondary); border:1px dashed var(--line); border-radius:10px; }
.statline { margin-top:8px; color:var(--text-secondary); font-size:12.5px; }
svg .grid { stroke:var(--line); stroke-width:1; }
svg .axis { stroke:var(--text-secondary); stroke-width:1; }
svg .tick { fill:var(--text-secondary); font-size:10px; }
svg .axislabel { fill:var(--text-secondary); font-size:11px; }
svg .marklabel { fill:var(--text-primary); font-size:11px; font-weight:600; }
svg { background:var(--card); border-radius:10px; margin:4px 0 10px; }
.modechip { display:inline-block; font-size:11px; padding:1px 8px; border-radius:99px;
  background:color-mix(in srgb, var(--c) 18%, transparent); color:var(--c); font-weight:700; }
details { margin:8px 0 4px; } summary { cursor:pointer; color:var(--text-secondary); }
section { border-top:2px solid var(--line); margin-top:26px; }
.meta { color:var(--text-secondary); font-size:12.5px; }
@media (max-width:720px){ .cols{grid-template-columns:1fr;} }
</style></head><body>
<h1>🐴 Klip Klop Maker — Scene Verification Report</h1>
<p class="meta">Every bundled scene laid out, simulated with the rimless-wheel + sliding dynamics engine
(<code>js/simulate.js</code> — the same code the Jest harness runs), and checked against its embedded expectations.
Charts: speed trace with regime underlays (<span class="modechip" style="--c:${MODE_COLORS.walk}">walk</span>
<span class="modechip" style="--c:${MODE_COLORS.slide}">slide</span>) and the descent profile.</p>
<table><thead><tr><th>verdict</th><th>scene</th><th>outcome</th><th>expected</th><th>time</th><th>clacks</th><th>peak mm/s</th></tr></thead>
<tbody>${summaryRows}</tbody></table>
${sections.join('\n')}
</body></html>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
const passCount = summary.filter(s => s.pass).length;
console.log(`Report written to reports/index.html — ${passCount}/${summary.length} scenes pass`);
for (const s of summary) console.log(` ${s.pass ? '✔' : '✖'} ${s.id}: ${s.outcome} in ${s.t}s (${s.clacks} clacks)`);
