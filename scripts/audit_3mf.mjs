/**
 * IS THIS 3MF ACTUALLY A SOLID? Run this on anything before slicing it.
 *
 * Four curve experiments were sliced, scored, written up and recommended
 * before anyone asked. Bambu found 1580 non-manifold edges in the lattice;
 * this script finds the same 1580. A slicer's reading of a non-manifold mesh
 * is undefined, so every number taken off those slices was void.
 *
 *   node scripts/audit_3mf.mjs test-parts/curve_experiments/*.3mf
 */
import fs from 'node:fs';
import * as fflate from '/Users/brettharper/Code/KlipKlopMaker/node_modules/fflate/esm/browser.js';
import { analyzeMesh } from '/Users/brettharper/Code/KlipKlopMaker/js/mesh_utils.js';
for (const f of process.argv.slice(2)) {
    const z = fflate.unzipSync(new Uint8Array(fs.readFileSync(f)));
    const xml = Buffer.from(z['3D/3dmodel.model']).toString('utf8');
    for (const [, attrs, body] of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
        const name = /name="([^"]*)"/.exec(attrs)?.[1] ?? '?';
        const V = [...body.matchAll(/<vertex x="(-?[\d.eE+-]+)" y="(-?[\d.eE+-]+)" z="(-?[\d.eE+-]+)"/g)];
        const T = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)];
        if (!V.length) continue;
        const P = new Float32Array(V.length * 3);
        V.forEach((v, i) => { P[i*3] = +v[1]; P[i*3+1] = +v[2]; P[i*3+2] = +v[3]; });
        const I = new Uint32Array(T.length * 3);
        T.forEach((t, i) => { I[i*3] = +t[1]; I[i*3+1] = +t[2]; I[i*3+2] = +t[3]; });
        const r = analyzeMesh(P, I);
        const ok = r.isManifold && r.isConsistent && r.windsOutward;
        console.log(`${ok ? '  OK  ' : ' FAIL '} ${(f.split('/').pop().slice(0,44)+'                                            ').slice(0,46)} ${(name+'          ').slice(0,12)} open=${String(r.openEdges).padStart(5)} nonmanifold=${String(r.nonManifoldEdges).padStart(5)} winding=${r.isConsistent} vol=${(r.volumeMm3/1000).toFixed(1)}cm3`);
    }
}
