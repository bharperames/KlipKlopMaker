#!/usr/bin/env node
/**
 * SWING THE GATE AGAINST THE TRACK AND SEE WHAT IT HITS.
 *
 *   node scripts/gate_swing.mjs [switchL|switchR]
 *
 * Brett, off a printed switch: the gate "cannot be pushed all the way down,
 * because the angle of the hole drives the back of the gate into the wall
 * segment of the track", and even seated he expects "the arm of the gate would
 * intersect the wall it is supposed to be able to tuck into."
 *
 * Both are answerable from the meshes and neither ever was, because nothing
 * here had assembled the two parts. `tests/pieces.test.js` checks that each is
 * watertight and prints; it has never checked that they FIT.
 *
 * So this does the assembly: it drops the paddle down the bore axis and swings
 * it through its range, taking the manifold INTERSECTION with the track at each
 * step. Intersection volume is the measurement — zero means clear, and anything
 * else is plastic in two places at once, with a bounding box saying where.
 *
 * The suspicion worth testing first: the bore is a PLAIN VERTICAL CYLINDER
 * (`gateSeatOps`) while the deck and its rails fall at 11.2 deg. So the pin
 * axis is plumb and the slot the blade parks in is sloped, and the two are 11.2
 * deg out of square with each other.
 */

import { layoutTrack, planPillarPositions, pieceFrame, pieceInFrame, SPEC } from '../js/track.js';
import { initCSG, buildSwitchExportGeometry, buildGateGeometry, gatePinPosition,
    toBufferGeometry, toManifold, GATE } from '../js/pieces.js';

/** Rigid transform of a flat position array: rotate about Y, then translate. */
function place(P, yaw, about, dy) {
    const out = new Float64Array(P.length);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < P.length; i += 3) {
        const x = P[i] - about[0], z = P[i + 2] - about[2];
        out[i] = about[0] + x * c - z * s;
        out[i + 1] = P[i + 1] + dy;
        out[i + 2] = about[2] + x * s + z * c;
    }
    return out;
}

/**
 * Split the interference at the deck. BELOW it the pin sits in its bore at
 * 0.00 clearance on purpose — "a great fit, perfect" — so overlap there is the
 * joint working, not a fault. ABOVE it there is nothing but blade and rail, and
 * any overlap is plastic in two places at once.
 */
function overlap(trackMan, P, I, deckY = null) {
    const m = toManifold({ positions: P, indices: I });
    const hit = trackMan.intersect(m);
    let above = null;
    if (deckY != null && hit.volume() > 0.001) {
        const box = toManifold({
            positions: new Float64Array([
                -500, deckY + 0.2, -500, 500, deckY + 0.2, -500, 500, deckY + 0.2, 500, -500, deckY + 0.2, 500,
                -500, deckY + 400, -500, 500, deckY + 400, -500, 500, deckY + 400, 500, -500, deckY + 400, 500]),
            indices: new Uint32Array([0,1,2, 0,2,3, 4,6,5, 4,7,6, 0,5,1, 0,4,5,
                                      1,6,2, 1,5,6, 2,7,3, 2,6,7, 3,4,0, 3,7,4])
        });
        const a = hit.intersect(box);
        above = a.volume();
        a.delete(); box.delete();
    }
    const vol = hit.volume();
    let bb = null;
    if (vol > 0.001) {
        const mesh = hit.getMesh();
        const V = mesh.vertProperties;
        bb = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
        for (let i = 0; i < V.length; i += mesh.numProp) {
            bb.x0 = Math.min(bb.x0, V[i]); bb.x1 = Math.max(bb.x1, V[i]);
            bb.y0 = Math.min(bb.y0, V[i + 1]); bb.y1 = Math.max(bb.y1, V[i + 1]);
            bb.z0 = Math.min(bb.z0, V[i + 2]); bb.z1 = Math.max(bb.z1, V[i + 2]);
        }
    }
    hit.delete(); m.delete();
    return { vol, bb, above };
}

export async function swing(hand = 'switchL') {
    await initCSG();
    const sw = layoutTrack([{ type: hand, gate: 'main', main: ['straight'], branch: ['straight'] }],
        { skirtStyle: 'minimal' });
    const sups = planPillarPositions(sw.pieces);
    const main0 = sw.pieces.find((p) => p.role === 'main');
    const branch0 = sw.pieces.find((p) => p.role === 'branch');
    // the piece as it SITS IN A TOWER, not tilted for the bed
    const g = buildSwitchExportGeometry(main0, branch0,
        { support: sups.find((x) => x.pieceIndex === main0.index) });
    const frame = pieceFrame(main0);
    const pin = gatePinPosition(pieceInFrame(main0, frame), pieceInFrame(branch0, frame));
    const gate = buildGateGeometry(SPEC);
    return { g, pin, gate, main: pieceInFrame(main0, frame) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const hand = process.argv[2] ?? 'switchL';
    const { g, pin, gate } = await swing(hand);
    const track = toManifold(g);
    const P0 = gate.positions ?? gate.attributes.position.array;
    const I0 = gate.indices ?? (gate.index ? gate.index.array
        : Uint32Array.from({ length: P0.length / 3 }, (_, i) => i));

    // the gate is drawn about its own pin at the origin, parked along +x
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 1; i < P0.length; i += 3) { y0 = Math.min(y0, P0[i]); y1 = Math.max(y1, P0[i]); }
    console.log(`\n${hand}  pin at s=${pin.s.toFixed(1)}  deckY=${pin.deckY.toFixed(2)}  `
        + `side=${pin.hingeSide}  yaw parked=${(pin.yawParked * 180 / Math.PI).toFixed(1)}deg `
        + `diverting=${(pin.yawDiverting * 180 / Math.PI).toFixed(1)}deg`);
    console.log(`gate spans y ${y0.toFixed(2)} .. ${y1.toFixed(2)} about its own pin\n`);

    const seatY = pin.deckY;
    const base = place(P0, 0, [0, 0, 0], 0);
    for (let i = 0; i < base.length; i += 3) { base[i] += pin.x; base[i + 2] += pin.z; }

    console.log('INSERTION — lowering the gate down the bore, parked yaw');
    console.log('  drop   remaining   interference   where');
    for (const d of [12, 9, 6, 4, 3, 2, 1, 0.5, 0]) {
        const P = place(base, pin.yawParked, [pin.x, 0, pin.z], seatY + d);
        const o = overlap(track, P, I0, pin.deckY);
        console.log(`  ${String(d).padStart(4)} mm  ${d === 0 ? '  SEATED  ' : '          '}  `
            + `${o.vol > 0.001 ? o.vol.toFixed(1).padStart(8) + ' mm3' : '     none   '}`
            + `   above deck ${(o.above ?? 0).toFixed(1).padStart(6)} mm3`
            + (o.bb ? `   y ${o.bb.y0.toFixed(1)}..${o.bb.y1.toFixed(1)}` : ''));
    }

    console.log('\nSWING — seated, from parked to fully diverting');
    console.log('  yaw off parked   interference   where');
    const span = pin.yawDiverting - pin.yawParked;
    for (let k = 0; k <= 8; k++) {
        const yaw = pin.yawParked + (span * k) / 8;
        const P = place(base, yaw, [pin.x, 0, pin.z], seatY);
        const o = overlap(track, P, I0, pin.deckY);
        const deg = ((yaw - pin.yawParked) * 180 / Math.PI);
        console.log(`  ${deg.toFixed(1).padStart(8)} deg     `
            + `${o.vol > 0.001 ? o.vol.toFixed(1).padStart(8) + ' mm3' : '     none   '}`
            + `   above deck ${(o.above ?? 0).toFixed(1).padStart(6)} mm3`
            + (o.bb ? `   y ${o.bb.y0.toFixed(1)}..${o.bb.y1.toFixed(1)}` : ''));
    }
    track.delete();
}
