#!/usr/bin/env node
/**
 * WHICH WAY DOES THE PONY GO AT THE FROG — and does the gate actually decide?
 *
 *   node scripts/frog_steer.mjs [switchL|switchR]
 *
 * simulate.js is one-dimensional along a resolved path; route CHOICE is a
 * lateral question it cannot ask. This models the choice with the physics the
 * project already has:
 *
 *   GRAVITY   the walker drifts toward the steepest descent of the REAL
 *             walking surface (sampled off the built export mesh, so the
 *             bank, the flush frog and the eased descent are all in it).
 *             Inside the frog the shared surface is the MAIN's plane, whose
 *             fall line points down the MAIN — this is Brett's observation,
 *             "the pony really wants to keep going down the straight path",
 *             as a measurable field.
 *   RACK      the front pads mesh with the washboard, and a rack meshing at
 *             an angle resolves a sideways component every strike
 *             (PHYSICS.md §3.1) — so each grip pulls the heading toward the
 *             local ridge field's drive direction. In the frog both routes'
 *             fields are feathered; the drive blends by where the walker
 *             stands.
 *   GATE      a rigid segment from the pin at the diverting yaw. A stride
 *             that would cross it slides along it instead. Past the tip the
 *             walker is free — which is exactly why blade LENGTH matters.
 *
 * The stride is the grip-release ratchet: 15 mm per strike (6 ridges at the
 * Standard pitch), heading updated at each grip. Gains are stated, not
 * hidden, and are calibrated on one requirement: a walker on a PLAIN CURVE
 * must follow it (the rack must deliver the ~3.1 deg/stride a Standard curve
 * demands, with margin). The model's value is COMPARATIVE — gate lengths and
 * profiles against each other — not absolute capture percentages.
 */

import { layoutTrack, planPosAt, pieceFrame, pieceInFrame, SPEC } from '../js/track.js';
import { initCSG, buildSwitchExportGeometry, gatePinPosition, GATE } from '../js/pieces.js';
import { topSurface } from './deck_probe.mjs';
import { planPillarPositions } from '../js/track.js';

const STRIDE = 15;               // mm per grip — 6 ridges at the 2.5 pitch
const RACK_GAIN = 0.55;          // fraction of heading error closed per grip
const GRAV_GAIN_DEG_PER_SLOPE = 60; // deg of pull per unit of cross-slope (tan)
const PLAY = (48 - 38) / 2;      // lateral play of the figure's centre, mm

const hand = process.argv[2] ?? 'switchL';

await initCSG();
const sw = layoutTrack([{ type: hand, gate: 'branch', main: ['straight'], branch: ['straight'] }],
    { skirtStyle: 'block' });
const main0 = sw.pieces.find((p) => p.role === 'main');
const branch0 = sw.pieces.find((p) => p.role === 'branch');
const sups = planPillarPositions(sw.pieces);
const g = buildSwitchExportGeometry(main0, branch0,
    { support: sups.find((x) => x.pieceIndex === main0.index) });
const frame = pieceFrame(main0);
const main = pieceInFrame(main0, frame);
const branch = pieceInFrame(branch0, frame);
const top = topSurface(g.positions, g.indices);
const pin = gatePinPosition(main, branch);

/** Surface gradient by central differences on the real mesh — averaged over
 *  a full ridge pitch first, or the washboard's own flanks dominate the
 *  reading: at d=2.0 on the 2.5 pitch the "fall line" swung +-26 deg with
 *  sampling phase. The walker's pad spans several ridges; so does this. */
function smoothTop(x, z) {
    let sum = 0, n = 0;
    for (let dx = -2.5; dx <= 2.5; dx += 1.25) {
        for (let dz = -2.5; dz <= 2.5; dz += 1.25) {
            const y = top(x + dx, z + dz);
            if (y != null) { sum += y; n++; }
        }
    }
    return n >= 12 ? sum / n : null;
}
function fallLine(x, z) {
    const d = 6.0;
    const yx1 = smoothTop(x + d, z), yx0 = smoothTop(x - d, z);
    const yz1 = smoothTop(x, z + d), yz0 = smoothTop(x, z - d);
    if ([yx1, yx0, yz1, yz0].some((v) => v == null)) return null;
    const gx = (yx1 - yx0) / (2 * d), gz = (yz1 - yz0) / (2 * d);
    const mag = Math.hypot(gx, gz);
    // downhill direction and how steep it is
    return mag < 1e-6 ? null : { h: Math.atan2(-gz, -gx), slope: mag };
}

/** Nearest station of a piece to a point: s and lateral offset. */
function nearest(piece, x, z) {
    let best = null;
    for (let s = 0; s <= piece.planLen; s += 2) {
        const p = planPosAt(piece, s);
        const dx = x - p.x, dz = z - p.z;
        const u = dx * Math.sin(p.h) - dz * Math.cos(p.h);
        const d2 = dx * dx + dz * dz;
        if (!best || d2 < best.d2) best = { s, u, h: p.h, d2 };
    }
    return best;
}

/** Blended rack drive direction: each route's ridges drive along its own
 *  heading; weight by how deep the walker stands in each channel. */
function rackDrive(x, z) {
    const m = nearest(main, x, z), b = nearest(branch, x, z);
    const inM = Math.max(0, 1 - Math.abs(m.u) / (main.innerWidth / 2));
    const inB = Math.max(0, 1 - Math.abs(b.u) / (branch.innerWidth / 2));
    if (inM + inB < 1e-6) return null;
    // blend on the circle (headings differ by <90 deg here)
    let dh = b.h - m.h;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return m.h + dh * (inB / (inM + inB));
}

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/** March one walker; returns 'main' | 'branch' | 'stuck'. */
function walk(u0, gateLen) {
    // gate geometry for this length, in the main frame
    let seg = null;
    if (gateLen > 0) {
        const p0 = { x: pin.x, z: pin.z };
        // recompute the diverting yaw for the candidate length the way
        // gatePinPosition does: tip on the branch's outer wall line
        const h = main.entry.h;
        const right = [Math.sin(h), -Math.cos(h)];
        const wallHalf = main.innerWidth / 2;
        const outer = (s) => {
            const q = planPosAt(branch, Math.min(s, branch.planLen));
            const off = ((q.x - main.entry.x) * right[0] + (q.z - main.entry.z) * right[1]) * pin.hingeSide;
            const turn = Math.abs(branch.turn ?? 0) * Math.min(s, branch.planLen) / (branch.planLen || 1);
            return off + (branch.innerWidth / 2) / Math.max(0.2, Math.cos(turn));
        };
        const reach = Math.max(0, wallHalf - outer(pin.s + gateLen));
        const yaw = h + pin.hingeSide * Math.asin(Math.min(0.95, reach / gateLen));
        // THE WALKER IS A BODY, NOT A POINT. It rides the blade with its
        // flank, so its CENTRE tracks a line parallel to the blade, half a
        // figure width to the channel side — which is why a 22.5 mm reach
        // herds a centre 41 mm across. The first point-model run missed this
        // and the gate captured nothing at any length.
        const half = 38 / 2;
        // normal pointing INTO the channel: the hinge wall sits at
        // lat = +(wall)·hingeSide, so away-from-hinge is the RIGHT vector of
        // the blade heading times -hingeSide. (The first draft had this
        // inverted — the guide line sat inside the wall and no walker ever
        // met it, which read as "the gate captures nothing at any length".)
        const inward = { x: Math.sin(yaw) * -pin.hingeSide, z: -Math.cos(yaw) * -pin.hingeSide };
        seg = { x0: p0.x + inward.x * half, z0: p0.z + inward.z * half,
            x1: p0.x + Math.cos(yaw) * gateLen + inward.x * half,
            z1: p0.z + Math.sin(yaw) * gateLen + inward.z * half };
    }

    const start = planPosAt(main, 2);
    let x = start.x + Math.sin(start.h) * u0, z = start.z - Math.cos(start.h) * u0;
    let psi = start.h;
    for (let step = 0; step < 40; step++) {
        // grip: rack pulls the heading toward the local drive direction
        const drive = rackDrive(x, z);
        if (drive != null) psi += RACK_GAIN * wrap(drive - psi);
        // gravity: pull toward the surface fall line, scaled by its steepness
        const f = fallLine(x, z);
        if (f) {
            const pull = Math.min(0.5, (GRAV_GAIN_DEG_PER_SLOPE * Math.PI / 180) * f.slope);
            psi += pull * wrap(f.h - psi);
        }
        // stride, clipped by the gate blade
        let nx = x + Math.cos(psi) * STRIDE, nz = z + Math.sin(psi) * STRIDE;
        if (seg) {
            const dxs = seg.x1 - seg.x0, dzs = seg.z1 - seg.z0;
            const cross = (ax, az, bx, bz) => ax * bz - az * bx;
            const sideA = cross(dxs, dzs, x - seg.x0, z - seg.z0);
            const sideB = cross(dxs, dzs, nx - seg.x0, nz - seg.z0);
            const tHit = (() => {  // segment-segment intersection parameter on the blade
                const rx = nx - x, rz = nz - z;
                const den = cross(rx, rz, dxs, dzs);
                if (Math.abs(den) < 1e-9) return null;
                const t = cross(seg.x0 - x, seg.z0 - z, dxs, dzs) / den;
                const u = cross(seg.x0 - x, seg.z0 - z, rx, rz) / den;
                return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
            })();
            if (tHit != null && Math.sign(sideA || 1) !== Math.sign(sideB || -1)) {
                // slide the remaining stride along the blade, toward the tip
                const hit = { x: x + (nx - x) * tHit, z: z + (nz - z) * tHit };
                const bl = Math.hypot(dxs, dzs);
                const ux = dxs / bl, uz = dzs / bl;
                const rest = STRIDE * (1 - tHit);
                nx = hit.x + ux * rest; nz = hit.z + uz * rest;
                psi = Math.atan2(uz, ux);
            }
        }
        // CONTAINMENT IS THE FIGURE'S CENTRE PLAY, +-5 mm about a channel
        // centreline (48 channel, 38 body) — the first draft allowed the
        // body to overlap a wall by 14 mm and walkers cruised out of the
        // frog embedded in the resuming rail. Inside the frog the union of
        // channels is wider than either, so legality is "within play of
        // EITHER centreline"; the blade may legitimately hold the walker
        // outside both while it rides (the rails there are cut).
        const m = nearest(main, nx, nz), b = nearest(branch, nx, nz);
        // THE FROG IS OPEN. Between the mouth and the nose the inner rails
        // are cut away (the clearance envelopes), so there is nothing to
        // clamp a straddling walker against — clamping there teleported
        // blade-delivered walkers back into the main's play and made the
        // gate score WORSE than no gate, which is how the flaw was noticed.
        const frogOpen = m.s > 16 && m.s < 105 && b.s < 115;
        if (!frogOpen && Math.abs(m.u) > PLAY && Math.abs(b.u) > PLAY) {
            if (Math.abs(m.u) - PLAY < Math.abs(b.u) - PLAY) {
                const p = planPosAt(main, m.s);
                const uC = Math.sign(m.u) * PLAY;
                nx = p.x + Math.sin(p.h) * uC; nz = p.z - Math.cos(p.h) * uC;
            } else {
                const p = planPosAt(branch, b.s);
                const uC = Math.sign(b.u) * PLAY;
                nx = p.x + Math.sin(p.h) * uC; nz = p.z - Math.cos(p.h) * uC;
            }
        }
        x = nx; z = nz;
        if (process.env.TRACE) {
            const tm = nearest(main, x, z), tb = nearest(branch, x, z);
            console.log(`    step ${String(step).padStart(2)}  m.s ${tm.s.toFixed(0).padStart(4)} m.u ${tm.u.toFixed(1).padStart(6)}  b.s ${tb.s.toFixed(0).padStart(4)} b.u ${tb.u.toFixed(1).padStart(6)}  psi ${(wrap(psi - main.entry.h) * 180 / Math.PI).toFixed(1)}`);
        }
        // DECISION AT THE FROG NOSE. Where the two inner rails resume as a V
        // (main-s ~105 at the Standard), the pony's body meets the nose and
        // is deflected toward whichever centreline it is already closer to —
        // the nose strikes the body off-centre and pushes it the other way.
        const m2 = nearest(main, x, z), b2 = nearest(branch, x, z);
        if (m2.s >= 105 || b2.s >= 115) {
            return Math.abs(b2.u) < Math.abs(m2.u) ? 'branch' : 'main';
        }
    }
    return 'stuck';
}

// --- report ---------------------------------------------------------------

if (process.env.TRACE) {
    console.log('TRACE: one walker, u0=0, blade 78');
    console.log('  ->', walk(0, Number(process.env.LEN ?? 78)));
    process.exit(0);
}

console.log(`\n${hand} — the frog's own fall line, sampled down the main channel`);
console.log('   s    fall-line vs main heading (deg; 0 = straight on, + = toward branch)');
for (let s = 10; s <= 130; s += 15) {
    const p = planPosAt(main, s);
    const f = fallLine(p.x, p.z);
    if (!f) continue;
    const rel = wrap(f.h - p.h) * (180 / Math.PI) * -pin.hingeSide;
    console.log(String(s).padStart(4), '  ', rel.toFixed(1).padStart(6),
        `  slope ${(Math.atan(f.slope) * 180 / Math.PI).toFixed(1)} deg`);
}

console.log('\nroute capture over starting offsets u0 = -5..5 (gate set to branch):');
console.log('  blade      captured to branch');
for (const len of [0, 52, 78, 95]) {
    let nb = 0, n = 0;
    for (let u0 = -5; u0 <= 5; u0 += 1) {
        n++;
        if (walk(u0, len) === 'branch') nb++;
    }
    const label = len === 0 ? 'no gate' : `${len} mm${len === 52 ? '  (old)' : len === GATE.len ? '  (shipped)' : ''}`;
    console.log(`  ${label.padEnd(14)} ${nb}/${n}`);
}
