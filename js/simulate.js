/**
 * simulate.js
 * Pure, deterministic time-stepped dynamics for a Klip-Klop figure on a
 * laid-out track — no DOM or Three.js. Drives both the interactive "Test ride"
 * animation and the offline verification harness, so what you watch is
 * exactly what the tests verify.
 *
 * Regimes:
 *  - WALK  — steady passive gait on a walkable piece; speed relaxes to the
 *            rimless-wheel prediction, hoof strikes are counted as clacks.
 *  - SLIDE — hooves have lost (or never had) grip: pure sliding dynamics
 *            v̇ = g·(sinθ − μk·cosθ). Covers skiing down a too-steep ramp
 *            AND coasting to a stop on flats/shallow pieces (negative v̇).
 *  - Terminal outcomes: 'arrived' (at rest on / past the end platform),
 *            'stalled' (at rest anywhere else), 'tumbled' (slope exceeded the
 *            swing limiter), 'timeout' (safety cap).
 */

import { assessSlope } from './physics.js';
import { samplePath } from './track.js';

const G = 9810; // mm/s²

/** Binary-search sampler over samplePath output. */
export function makePathSampler(pieces, step = 5) {
    const ss = samplePath(pieces, step);
    const total = ss[ss.length - 1].dist;
    function at(dist) {
        const d = Math.max(0, Math.min(total, dist));
        let lo = 0, hi = ss.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (ss[mid].dist <= d) lo = mid; else hi = mid;
        }
        const a = ss[lo], b = ss[hi];
        const f = b.dist === a.dist ? 0 : (d - a.dist) / (b.dist - a.dist);
        let dh = b.h - a.h;
        if (dh > Math.PI) dh -= 2 * Math.PI;
        if (dh < -Math.PI) dh += 2 * Math.PI;
        return {
            x: a.x + (b.x - a.x) * f,
            y: a.y + (b.y - a.y) * f,
            z: a.z + (b.z - a.z) * f,
            h: a.h + dh * f,
            slopeDeg: a.slopeDeg,
            pieceIndex: a.pieceIndex
        };
    }
    return { at, total, samples: ss };
}

/**
 * Runs the full dynamics simulation.
 *
 * @param {object[]} pieces - layoutTrack output
 * @param {object} opts - { mu, muK?, walker, dt?, maxT?, traceEvery?, startAtFirstRamp? }
 * @returns {{ outcome, tEnd, stopDist, totalDist, events, trace, stats }}
 */
export function simulateRun(pieces, opts = {}) {
    const mu = opts.mu ?? 0.6;
    const muK = opts.muK ?? 0.8 * mu; // kinetic ≈ 80% of static for PLA-PLA
    const walker = opts.walker;
    const dt = opts.dt ?? 0.002;
    const maxT = opts.maxT ?? 180;
    const traceEvery = opts.traceEvery ?? 0.02;

    const liftSpeed = opts.liftSpeedMmS ?? 55;
    const sampler = makePathSampler(pieces, 4);
    const assess = pieces.map(pc =>
        pc.isLift
            ? { status: 'lift', speedMmS: liftSpeed, stepHz: 0, strideMm: 0 }
            : pc.slopeDeg > 0
                ? assessSlope(pc.slopeDeg, { mu, walker })
                : { status: 'platform', speedMmS: 0, stepHz: 0, strideMm: 0 }
    );

    // start at the head of the first running piece (where a child places the
    // toy) — a descending ramp or a powered lift both count
    let dist = 0;
    if (opts.startAtFirstRamp !== false) {
        const first = sampler.samples.find(s => s.slopeDeg > 0 || pieces[s.pieceIndex]?.isLift);
        dist = first ? first.dist : 0;
    }

    const events = [];
    const trace = [];
    const stats = { clacks: 0, maxV: 0, walkDist: 0, slideDist: 0 };
    let t = 0, v = 0, mode = 'walk', lastPiece = -1, stepPhase = 0, lastTrace = -Infinity, laps = 0;
    let outcome = null;

    const logEvent = (type, detail) => events.push({ t: +t.toFixed(3), dist: +dist.toFixed(1), type, detail });

    while (t < maxT) {
        const here = sampler.at(dist);
        const pi = here.pieceIndex;
        const piece = pieces[pi];
        const a = assess[pi];
        const theta = (piece.slopeDeg * Math.PI) / 180;

        if (pi !== lastPiece) {
            logEvent('piece', `${piece.name} (${a.status})`);
            if (a.status === 'tumble') {
                outcome = 'tumbled';
                logEvent('outcome', 'slope exceeds swing limiter — figure pitches over its front axle');
                break;
            }
            lastPiece = pi;
        }

        // --- regime selection ---
        const gaitV = a.speedMmS;
        let nextMode;
        if (a.status === 'lift') {
            nextMode = 'lift'; // externally powered conveyor section
        } else if (a.status === 'walk') {
            // momentum rule: a figure sliding in much faster than the gait speed
            // cannot re-enter the rocking cycle — it keeps skiing.
            nextMode = (mode === 'slide' && v > 1.6 * gaitV) ? 'slide' : 'walk';
        } else {
            nextMode = 'slide'; // slide dynamics cover coasting & decel too
        }
        if (nextMode !== mode) {
            logEvent('mode', `${mode} → ${nextMode}`);
            mode = nextMode;
        }

        // --- integrate ---
        if (mode === 'lift') {
            v += (liftSpeed - v) * Math.min(1, dt * 6); // conveyor grabs the figure
        } else if (mode === 'walk') {
            v += (gaitV - v) * Math.min(1, dt * 8); // gait locks in over ~0.1 s
            stepPhase += a.stepHz * dt;
            if (stepPhase >= 1) { stepPhase -= 1; stats.clacks++; }
            stats.walkDist += v * dt;
        } else {
            const acc = G * (Math.sin(theta) - muK * Math.cos(theta));
            v += acc * dt;
            stats.slideDist += Math.max(0, v) * dt;
            if (v <= 0) {
                v = 0;
                outcome = piece.type === 'end' ? 'arrived' : 'stalled';
                logEvent('outcome', outcome === 'arrived'
                    ? 'came to rest in the corral'
                    : `came to rest on ${piece.name} — no gait energy available`);
                break;
            }
        }
        stats.maxV = Math.max(stats.maxV, v);

        dist += v * dt;
        t += dt;

        if (opts.loop) {
            // closed circuit: wrap the closure seam and count laps
            if (dist >= sampler.total - 0.5) {
                dist -= sampler.total - 0.5;
                laps++;
                lastPiece = -1;
                logEvent('lap', `lap ${laps} complete`);
                if (laps >= (opts.maxLaps ?? 3)) {
                    outcome = 'circuit';
                    logEvent('outcome', `perpetual circuit verified over ${laps} laps`);
                    break;
                }
            }
        } else if (dist >= sampler.total - 0.5) {
            dist = sampler.total;
            outcome = 'arrived';
            logEvent('outcome', 'reached the end of the track');
            break;
        }
        if (t - lastTrace >= traceEvery) {
            lastTrace = t;
            trace.push({
                t: +t.toFixed(3), dist: +dist.toFixed(2), v: +v.toFixed(2),
                y: +here.y.toFixed(2), mode, pieceIndex: pi
            });
        }
    }

    if (!outcome) {
        outcome = 'timeout';
        logEvent('outcome', 'safety time cap reached');
    }

    const runLength = pieces.filter(p => p.slopeDeg > 0).reduce((s, p) => s + p.planLen, 0);
    return {
        outcome,
        tEnd: +t.toFixed(3),
        stopDist: +dist.toFixed(1),
        totalDist: +sampler.total.toFixed(1),
        events,
        trace,
        stats: {
            ...stats,
            laps,
            walkedFraction: runLength > 0 ? Math.min(1, stats.walkDist / (runLength * Math.max(1, laps + 1))) : 0,
            descentTimeS: +t.toFixed(2)
        },
        assess
    };
}

/**
 * Physics sanity check used by the harness: within every PASSIVE span of the
 * trace, kinetic energy must never exceed the gravitational energy released
 * (per unit mass: ½v² ≤ g·(y₀ − y) + ε). Friction and hoof-strike losses only
 * remove energy — a violation means the integrator is creating energy.
 * Lift sections are externally powered, so the budget baseline resets at the
 * end of each lift.
 *
 * epsilon covers discretization, not physics: the baseline snapshots at trace
 * cadence (~20 ms), so a lift crest can sit a fraction of a millimetre above
 * the last lift sample (g·0.25 mm ≈ 2.5e3 mm²/s²). Real energy creation shows
 * up orders of magnitude larger.
 */
export function verifyEnergyBudget(trace, epsilon = 2.5e3) {
    if (!trace.length) return { ok: true, worst: 0 };
    let y0 = trace[0].y;
    let v0 = trace[0].v;
    let worst = -Infinity;
    for (const s of trace) {
        if (s.mode === 'lift') {
            y0 = s.y; v0 = s.v; // powered: re-baseline, skip the check
            continue;
        }
        const ke = 0.5 * s.v * s.v - 0.5 * v0 * v0;
        const pe = G * (y0 - s.y);
        worst = Math.max(worst, ke - pe);
    }
    return { ok: worst <= epsilon, worst };
}
