#!/usr/bin/env node
/**
 * MEASURE A PLATE THE WAY CALIPERS WOULD — from the written 3MF.
 *
 *   node scripts/measure_3mf.mjs test-parts/collet/collet.3mf
 *
 * The rule here is that a number is only trusted if it comes off the ARTIFACT,
 * not off the builder that produced it. Reading `SPEC.socket.boreDia` back and
 * printing it proves nothing: it was already wrong once when a module constant
 * shadowed the spec that was passed in, and the "no taper" variant came out
 * byte-identical to the tapered one without anything noticing.
 *
 * So this unzips the file, slices each object at a stated height, and takes an
 * across-flats and an across-corners reading with a ray from the axis — the
 * same two measurements you would take by hand, on the same feature.
 *
 * Exact slicing, not sampling: each triangle crossing the plane contributes one
 * segment, the ray is intersected against those segments, and parity along the
 * ray says where material starts and stops. A prism only has mesh vertices at
 * its section boundaries, so sampling vertices near a height finds nothing at
 * all in the middle of a shaft — an earlier version of this did exactly that
 * and reported a bore radius of 1e9.
 */

import fs from 'node:fs';
import * as fflate from 'fflate';
import { analyzeMesh } from '../js/mesh_utils.js';

/** Segments where the mesh crosses the horizontal plane z. Mesh is Z-up. */
function sliceAt(P, I, z) {
    const segs = [];
    for (let t = 0; t < I.length; t += 3) {
        const v = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
        const pts = [];
        for (let e = 0; e < 3; e++) {
            const a = v[e], b = v[(e + 1) % 3];
            const za = P[a + 2], zb = P[b + 2];
            if ((za > z) === (zb > z)) continue;
            const f = (z - za) / (zb - za);
            pts.push([P[a] + f * (P[b] - P[a]), P[a + 1] + f * (P[b + 1] - P[a + 1])]);
        }
        if (pts.length === 2) segs.push(pts);
    }
    return segs;
}

/**
 * March a ray out from (cx,cy) at `deg` and report every boundary crossing,
 * nearest first. Even index = material starts, odd = material ends.
 */
function crossings(segs, cx, cy, deg) {
    const ca = Math.cos(deg * Math.PI / 180), sa = Math.sin(deg * Math.PI / 180);
    const hits = [];
    for (const [[x1, y1], [x2, y2]] of segs) {
        const dx = x2 - x1, dy = y2 - y1;
        const den = ca * dy - sa * dx;
        if (Math.abs(den) < 1e-12) continue;
        const u = ((x1 - cx) * dy - (y1 - cy) * dx) / den;       // along the ray
        const s = ((x1 - cx) * sa - (y1 - cy) * ca) / den;       // along the segment
        if (u >= 0 && s >= 0 && s <= 1) hits.push(u);
    }
    return hits.sort((a, b) => a - b);
}

const file = process.argv[2];
if (!file) { console.error('usage: measure_3mf.mjs <file.3mf>'); process.exit(2); }
const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(file)));
const xml = fflate.strFromU8(zip['3D/3dmodel.model']);
const objs = [...xml.matchAll(/<object[^>]*name="([^"]*)"[\s\S]*?<\/object>/g)];

console.log(`\n${file} — ${objs.length} objects\n`);
console.log('part      mesh    BORE across-flats  across-corners   TENON AF root   AF tip   height');
for (const [blk, name] of objs) {
    const vs = [...blk.matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"/g)];
    const ts = [...blk.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)];
    const P = new Float64Array(vs.length * 3);
    vs.forEach((m, i) => { P[i * 3] = +m[1]; P[i * 3 + 1] = +m[2]; P[i * 3 + 2] = +m[3]; });
    const I = new Uint32Array(ts.length * 3);
    ts.forEach((m, i) => { I[i * 3] = +m[1]; I[i * 3 + 1] = +m[2]; I[i * 3 + 2] = +m[3]; });
    const r = analyzeMesh(P, I);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < P.length; i += 3) {
        x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]);
        y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
        z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]);
    }
    const ok = r.isManifold && r.isConsistent && r.windsOutward;
    if (z1 - z0 > 30) {                       // not a post — just report the gate
        console.log(`${name.padEnd(9)} ${ok ? ' ok  ' : '**NO**'}   (not a post: ${(x1-x0).toFixed(0)}x${(y1-y0).toFixed(0)}x${(z1-z0).toFixed(0)} mm)`);
        continue;
    }
    const cx = (x1 + x0) / 2, cy = (y1 + y0) / 2;
    // the slots are at 60/180/300, which is where both hexes put a corner,
    // so 30 deg reads a flat and 0 deg reads a corner on an unslotted ray
    const bore = sliceAt(P, I, z0 + 5);
    const bFlat = crossings(bore, cx, cy, 30)[0];
    const bCorn = crossings(bore, cx, cy, 120)[0];       // an intact corner
    const root = crossings(sliceAt(P, I, z0 + 15.2), cx, cy, 30);
    const tip = crossings(sliceAt(P, I, z0 + 22.5), cx, cy, 30);
    console.log(`${name.padEnd(9)} ${ok ? ' ok  ' : '**NO**'} `
        + `${(bFlat * 2).toFixed(3).padStart(15)} ${(bCorn * 2).toFixed(3).padStart(15)}   `
        + `${(root[root.length - 1] * 2).toFixed(3).padStart(12)} `
        + `${(tip[tip.length - 1] * 2).toFixed(3).padStart(8)} `
        + `${(z1 - z0).toFixed(2).padStart(8)}`);
}
