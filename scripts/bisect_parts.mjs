#!/usr/bin/env node
/**
 * bisect_parts.mjs
 * Builds the SAME piece from several git commits and writes them into one 3MF
 * as separately named objects.
 *
 * A slicer that complains about some objects and not others then names the
 * commit that introduced the problem, in a single pass. Parameter sweeps only
 * help when you already know which parameter matters; this needs no such
 * guess, which is the point when a sweep has just come back with every variant
 * failing.
 *
 * Usage:
 *   node scripts/bisect_parts.mjs a8a1161 2a009a4 ff55e48 HEAD
 *   node scripts/bisect_parts.mjs --piece curveL <commits...>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fflate from 'fflate';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(ROOT, 'test-parts')));
const PIECE = arg('piece', 'straight');
const SPACING = Number(arg('spacing', 60));
// One file per commit instead of one combined file. Needed because a slicer's
// per-object attribution can be unreliable: Bambu has reported a "floating
// cantilever" against an object that slices clean once its plate-mates are
// deleted. Only a solo plate answers "is THIS part printable".
const SOLO = argv.includes('--solo');
// Only these flags consume the next token; --solo is boolean, so treating
// every flag as value-taking would eat the first commit.
const VALUED = new Set(['--out', '--piece', '--spacing']);
const commits = argv.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && VALUED.has(argv[i - 1])));

if (!commits.length) {
    console.error('give at least one commit, e.g.  node scripts/bisect_parts.mjs 2a009a4 ff55e48 HEAD');
    process.exit(1);
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Materialise js/ at `rev` into a scratch dir and build the piece there. */
function buildAt(rev, work) {
    fs.mkdirSync(path.join(work, 'js'), { recursive: true });
    for (const f of git('ls-tree', '--name-only', `${rev}:js`).trim().split('\n')) {
        if (!f.endsWith('.js')) continue;
        fs.writeFileSync(path.join(work, 'js', f), git('show', `${rev}:js/${f}`));
    }
    // the pure/CSG modules need three + manifold; borrow the checkout's
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(work, 'package.json'));

    fs.writeFileSync(path.join(work, 'build.mjs'), `
import fs from 'node:fs';
import { layoutTrack, planPillarPositions } from './js/track.js';
import { initCSG, buildPieceExportGeometry } from './js/pieces.js';
await initCSG();
const { pieces } = layoutTrack(['straight', ${JSON.stringify(PIECE)}, 'straight'], {});
const pc = pieces.find(p => p.type === ${JSON.stringify(PIECE)}) ?? pieces[1];
const sup = planPillarPositions(pieces).find(s => s.pieceIndex === pc.index);
const g = buildPieceExportGeometry(pc, { support: sup });
fs.writeFileSync('mesh.json', JSON.stringify({
    positions: Array.from(g.positions), indices: Array.from(g.indices) }));
`);
    execFileSync(process.execPath, ['build.mjs'], { cwd: work, stdio: 'pipe' });
    const m = JSON.parse(fs.readFileSync(path.join(work, 'mesh.json'), 'utf8'));
    return { positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) };
}

/** Centre in X/Y and drop to Z=0 so the row lays out predictably. */
function seat(g) {
    const p = g.positions;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity, mny = Infinity;
    for (let i = 0; i < p.length; i += 3) {
        mnx = Math.min(mnx, p[i]); mxx = Math.max(mxx, p[i]);
        mnz = Math.min(mnz, p[i + 2]); mxz = Math.max(mxz, p[i + 2]);
        mny = Math.min(mny, p[i + 1]);
    }
    const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
    for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= mny; p[i + 2] -= cz; }
    return g;
}

fs.mkdirSync(OUT, { recursive: true });
// Clear stale output from a PREVIOUS combined run, which may have had more
// objects than this one and would otherwise leave orphans. Solo mode needs no
// clearing — it overwrites each plate by name — and must not run it, or a
// second invocation would delete the plates from the first.
if (!SOLO) {
    for (const f of fs.readdirSync(OUT)) if (f.startsWith('bisect.')) fs.unlinkSync(path.join(OUT, f));
}

const parts = [], legend = [];
commits.forEach((rev, i) => {
    const short = git('rev-parse', '--short', rev).trim();
    const subject = git('log', '-1', '--format=%s', rev).trim();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `kk-${short}-`));
    try {
        const g = seat(buildAt(rev, work));
        const name = `${String(i + 1)}_${short}`;
        parts.push({ name, positions: g.positions, indices: g.indices, at: [0, (i - (commits.length - 1) / 2) * SPACING, 0] });
        legend.push(`  Object_${i + 1}  ${name.padEnd(12)} ${subject.slice(0, 66)}`);
        console.log(`built ${short}  ${g.indices.length / 3} tris  ${subject.slice(0, 60)}`);
    } catch (e) {
        console.error(`! ${short} failed to build: ${String(e.message).split('\n')[0]}`);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

if (!parts.length) { console.error('nothing built'); process.exit(1); }

const wrap = (xml) => Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
}));

if (SOLO) {
    for (const p of parts) {
        const file = path.join(OUT, `bisect_solo_${PIECE}_${p.name}.3mf`);
        fs.writeFileSync(file, wrap(generateMultiObject3MFXML([{ ...p, at: [0, 0, 0] }])));
        console.log(`-> ${file}`);
    }
    fs.writeFileSync(path.join(OUT, `bisect_solo_${PIECE}.txt`),
        `commit bisect (SOLO) — ${PIECE}\n\nOne plate per commit; slice each on its own.\n\n${legend.join('\n')}\n`);
    process.exit(0);
}

const xml = generateMultiObject3MFXML(parts);
fs.writeFileSync(path.join(OUT, 'bisect.3mf'), Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
})));
const text = `commit bisect — ${PIECE}\n\nObjects front to back:\n\n${legend.join('\n')}\n`;
fs.writeFileSync(path.join(OUT, 'bisect.txt'), text);
console.log(`\n-> ${path.join(OUT, 'bisect.3mf')}\n${legend.join('\n')}`);
