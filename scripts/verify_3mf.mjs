#!/usr/bin/env node
/**
 * VERIFY A 3MF FROM THE FILE, NOT FROM THE CODE THAT WROTE IT.
 *
 * Run this on anything before it goes on a plate. It re-derives every mating
 * dimension by casting rays through the mesh in the shipped file, so a bug in
 * the builder, the exporter or the placement cannot agree with itself and pass.
 * Two real faults were caught exactly this way: a build transform that lifted
 * parts 45 mm into the air (the Z slot is height, not "back on the bed"), and
 * BambuStudio silently re-arranging the plate, which made "left to right" a
 * meaningless instruction for telling six near-identical coupons apart.
 *
 *   node scripts/verify_3mf.mjs test-parts/tenon_sweep/compare_cyl_vs_hex.3mf
 *
 * WHAT SUCCESS LOOKS LIKE, and it is the same statement for both geometries:
 *
 *   A shape is SNUG in a hole when the hole's diameter equals the shape's
 *   WIDEST inscribed dimension at the contact points, and it JAMS when the
 *   hole equals the shape's NARROWEST. The span between those two is the whole
 *   compliance budget, and it is why the round pairing has one at all.
 *
 *   · CYLINDER IN A HEX SOCKET — the cylinder lands on the six FLATS.
 *       free at  D  <  socket AF          (rattles)
 *       snug at  D === socket AF          <- the target
 *       biting   D  >  socket AF          (displaced material goes to the corners)
 *       cannot enter at all once D > socket ACROSS-CORNERS.
 *     So the usable band is socket AF -> socket AC: 8.75 -> 10.104, 1.354 mm.
 *
 *   · HEX TENON IN A ROUND BORE — the six CORNERS land on the bore.
 *       free at  D  >  tenon AC           (rattles)
 *       snug at  D === tenon AC           <- the target
 *       biting   D  <  tenon AC           (corners swage the bore)
 *       cannot enter at all once D < tenon AF.
 *     So the usable band is tenon AF -> tenon AC: 8.60 -> 9.93 drawn, and
 *     8.60 -> 9.65 on Brett's MEASURED printed tenons.
 *
 * Both bands are ~1.3 mm wide, against a process spread near 0.1 mm. That is
 * the point of going round: the hex-in-hex joint has no band at all, because
 * it is pinned by how much the nozzle rounds the socket's internal corners.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import * as fflate from 'fflate';
import { analyzeMesh } from '../js/mesh_utils.js';
import { SPEC } from '../js/track.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/verify_3mf.mjs <file.3mf>'); process.exit(1); }

const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(file)));
const xml = Buffer.from(zip['3D/3dmodel.model']).toString('utf8');

const objs = [];
for (const m of xml.matchAll(/<object id="(\d+)" type="model" name="([^"]*)">([\s\S]*?)<\/object>/g)) {
    const V = [...m[3].matchAll(/<vertex x="(-?[\d.eE+-]+)" y="(-?[\d.eE+-]+)" z="(-?[\d.eE+-]+)"/g)];
    const T = [...m[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)];
    const P = new Float32Array(V.length * 3);
    V.forEach((v, i) => { P[i * 3] = +v[1]; P[i * 3 + 1] = +v[2]; P[i * 3 + 2] = +v[3]; });
    const I = new Uint32Array(T.length * 3);
    T.forEach((t, i) => { I[i * 3] = +t[1]; I[i * 3 + 1] = +t[2]; I[i * 3 + 2] = +t[3]; });
    objs.push({ id: m[1], name: m[2], P, I,
        hash: crypto.createHash('sha1').update(Buffer.from(P.buffer)).digest('hex').slice(0, 8) });
}

/** First (inner) or last (outer) surface a horizontal ray meets at height h. */
function ray(P, I, h, th, inner) {
    const d = [Math.cos(th), Math.sin(th), 0];
    let best = inner ? Infinity : -Infinity, found = false;
    for (let t = 0; t < I.length; t += 3) {
        const A = I[t] * 3, B = I[t + 1] * 3, C = I[t + 2] * 3;
        const v = [[P[A], P[A + 1], P[A + 2]], [P[B], P[B + 1], P[B + 2]], [P[C], P[C + 1], P[C + 2]]];
        if (Math.max(v[0][2], v[1][2], v[2][2]) < h || Math.min(v[0][2], v[1][2], v[2][2]) > h) continue;
        const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
        const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
        const hh = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const q0 = e1[0] * hh[0] + e1[1] * hh[1] + e1[2] * hh[2];
        if (Math.abs(q0) < 1e-12) continue;
        const f = 1 / q0, sv = [-v[0][0], -v[0][1], h - v[0][2]];
        const u = f * (sv[0] * hh[0] + sv[1] * hh[1] + sv[2] * hh[2]);
        if (u < 0 || u > 1) continue;
        const q = [sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]];
        const vv = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
        if (vv < 0 || u + vv > 1) continue;
        const tt = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
        if (tt <= 1e-6) continue;
        found = true;
        best = inner ? Math.min(best, tt) : Math.max(best, tt);
    }
    return found ? best : null;
}

/** Narrowest and widest diameter of a feature — AF and ACROSS-CORNERS for a hex. */
function feature(P, I, h, inner) {
    const r = [];
    for (let a = 0; a < 180; a++) {
        const v = ray(P, I, h, (a / 180) * 2 * Math.PI, inner);
        if (v === null) return null;
        r.push(v);
    }
    const min = 2 * Math.min(...r), max = 2 * Math.max(...r);
    return { min: +min.toFixed(3), max: +max.toFixed(3), round: (max - min) < 0.05 };
}

const SOCK_AF = SPEC.socket.hexAF - SPEC.socket.socketShrinkAF;
const SOCK_AC = SOCK_AF / Math.cos(Math.PI / 6);
// Brett's tenon, MEASURED off printed parts with calipers, across corners.
// ONE NUMBER, NOT TWO. This carried a separate 9.73 for the foot on the theory
// that a broad part prints wider across corners than a slender one. Brett, on a
// later set: "Remove special cases for the foot tenon, it is behaving similar to
// a 15mm pillar as far as tenon size." So the foot is not a special case and
// does not set the bore.
const MEASURED_TENON_AC = { tenon: 9.65 };

console.log(`\n${file}`);
console.log(`${objs.length} objects   Metadata/: ${Object.keys(zip).some(k => k.startsWith('Metadata/')) ? 'PRESENT (unexpected)' : 'none (geometry only, as intended)'}\n`);

let bad = 0;
const table = [];
for (const o of objs) {
    const r = analyzeMesh(o.P, o.I);
    const ok = r.isManifold && r.isConsistent && r.windsOutward;
    if (!ok) bad++;
    // SAMPLE HEIGHTS FROM THE PART, NOT FROM A CONSTANT. Fixed z=5/z=19 is only
    // right for a 15 mm riser: on a 30 it reads the shaft as the "tenon", and
    // on a foot (which has no socket at all) it reads the flare as a "bore".
    // A socket opens at the bottom and a tenon is the last feature at the top.
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 2; i < o.P.length; i += 3) { zMin = Math.min(zMin, o.P[i]); zMax = Math.max(zMax, o.P[i]); }
    const bore = feature(o.P, o.I, zMin + 5, true);
    const tenon = feature(o.P, o.I, zMax - 5, false);
    // NOTCHES ARE A COUPON FEATURE AND THE TEST ONLY MEANS ANYTHING ON A 15 AF
    // RISER SHAFT. On a spacer the sample heights land in the tenon, which is
    // narrower than the Ø18 body below it, so all three read as "grooves" — a
    // false 3 on a part whose rings are its real label. Gate on the reference
    // band actually being a 15 AF shaft (radius 7.5) before counting.
    const uncut = ray(o.P, o.I, zMin + 10.2, 0, false);
    const riserShaft = uncut !== null && Math.abs(uncut - 7.5) < 0.4;
    const notches = !riserShaft ? null : [11.2, 12.5, 13.8]
        .map(h => ray(o.P, o.I, zMin + h, 0, false))
        .filter(v => v !== null && v < uncut - 0.5).length;
    table.push({ o, r, ok, bore, tenon, notches });
}

for (const t of table) {
    // A "bore" wider than the 15 AF shaft is the ray leaving the part, not a
    // hole; and an off-axis bore (the jog's, 45 mm out on its arm) is invisible
    // to an on-axis cast. Say so rather than print a number that looks real.
    // Anything wider than the 15 AF shaft is the ray leaving the part, not a
    // feature: an off-axis bore (the jog's, 45 mm out on its arm) is invisible
    // to an on-axis cast, and a part with no socket or tenon at all (a key, a
    // track tile) just reports its own outline. Say so rather than print a
    // number that looks like a mating dimension.
    const d = (f, what) => !f ? 'none'
        : f.min > 12 ? `no on-axis ${what} (min ${f.min.toFixed(2)} is the outer shell)`
        : f.round ? `round D ${f.min.toFixed(2)}`
        : `hex AF ${f.min.toFixed(2)} / AC ${f.max.toFixed(2)}`;
    console.log(`${t.o.name.padEnd(19)} ${t.o.hash}  ${t.ok ? 'watertight' : '*** NOT WATERTIGHT ***'}  ${(t.r.volumeMm3 / 1000).toFixed(2)} cm3` +
        (t.notches === null ? '' : `   ${t.notches} notch${t.notches === 1 ? '' : 'es'}`));
    console.log(`   bore  ${d(t.bore, 'bore')}`);
    console.log(`   tenon ${d(t.tenon, 'tenon')}`);
}

console.log('\n--- WHAT SUCCESS LOOKS LIKE -------------------------------------------');
for (const t of table) {
    if (t.tenon?.round && t.tenon.min < 12) {
        const D = t.tenon.min;
        console.log(`\n${t.notches ?? '-'} notch${t.notches === 1 ? ' ' : 'es'}  ROUND TENON D ${D.toFixed(2)}  ->  your existing HEX SOCKET (AF ${SOCK_AF.toFixed(2)}, AC ${SOCK_AC.toFixed(2)})`);
        console.log(`         contact on the six FLATS.  snug when D = AF = ${SOCK_AF.toFixed(2)}`);
        console.log(`         drawn interference ${(((D - SOCK_AF) / 2) >= 0 ? '+' : '')}${((D - SOCK_AF) / 2).toFixed(3)} /side;  will not enter past D ${SOCK_AC.toFixed(2)}`);
    } else if (t.bore?.round && t.bore.min < 12) {
        const D = t.bore.min;
        for (const [who, ac] of Object.entries(MEASURED_TENON_AC)) {
            console.log(`\n${t.notches ?? '-'} notch${t.notches === 1 ? ' ' : 'es'}  ROUND BORE D ${D.toFixed(2)}  <-  your HEX TENON (measured AC ${ac})`);
            console.log(`         contact on the six CORNERS.  snug when D = AC = ${ac}`);
            console.log(`         interference ${(((ac - D) / 2) >= 0 ? '+' : '')}${((ac - D) / 2).toFixed(3)} /side;  will not enter below D ${t.tenon.min.toFixed(2)} (tenon AF)`);
        }
    }
}
console.log(`\n${bad ? `*** ${bad} OBJECT(S) FAILED THE MESH GATE ***` : 'All objects watertight.'}`);
console.log('Snug = enters by firm hand pressure, no rock, no rattle, separates without tools.');
