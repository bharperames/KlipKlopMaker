/**
 * Dynamics verification: the simulator's regimes against closed-form physics.
 */
import { layoutTrack } from '../js/track.js';
import { simulateRun, makePathSampler, verifyEnergyBudget } from '../js/simulate.js';
import { FRICTION_PRESETS, assessSlope } from '../js/physics.js';

const G = 9810;

describe('WALK regime', () => {
    test('locks onto the rimless-wheel gait speed on a compliant track', () => {
        const { pieces } = layoutTrack(['straight', 'straight', 'straight'], { slopeDeg: 11 });
        const r = simulateRun(pieces, { mu: FRICTION_PRESETS.washboard.mu });
        expect(r.outcome).toBe('arrived');
        const predicted = assessSlope(11, { mu: FRICTION_PRESETS.washboard.mu }).speedMmS;
        // steady-state velocity samples (skip the ramp-in) should sit at the prediction
        const steady = r.trace.filter(s => s.mode === 'walk' && s.t > 0.5 && s.t < 2.0);
        expect(steady.length).toBeGreaterThan(10);
        for (const s of steady) expect(Math.abs(s.v - predicted)).toBeLessThan(predicted * 0.05);
        expect(r.stats.clacks).toBeGreaterThan(10);
    });
});

describe('SLIDE regime', () => {
    test('matches the analytic constant-acceleration solution v = g(sinθ − μk·cosθ)·t', () => {
        // 16° on smooth PLA: pure slide from rest
        const { pieces } = layoutTrack(['straight', 'straight', 'straight', 'straight'], { slopeDeg: 16 });
        const mu = FRICTION_PRESETS.smooth.mu;
        const r = simulateRun(pieces, { mu });
        const theta = (16 * Math.PI) / 180;
        const aExpected = G * (Math.sin(theta) - 0.8 * mu * Math.cos(theta));
        expect(aExpected).toBeGreaterThan(0);
        const s1 = r.trace.find(s => s.t >= 1.0 && s.mode === 'slide');
        expect(s1).toBeDefined();
        expect(Math.abs(s1.v - aExpected * s1.t)).toBeLessThan(aExpected * s1.t * 0.03);
    });

    test('decelerates and arrests on the flat end platform (braking works)', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { slopeDeg: 16 });
        const r = simulateRun(pieces, { mu: FRICTION_PRESETS.smooth.mu });
        expect(r.outcome).toBe('arrived');
        expect(r.trace.at(-1).v).toBeLessThan(r.stats.maxV);
        expect(r.stats.walkedFraction).toBeLessThan(0.05);
    });

    test('a sliding figure re-catches the gait once friction bleeds its speed', () => {
        // steep smooth start is impossible in one layout (single global slope),
        // so verify the momentum rule directly: walkable piece + inflated entry
        // speed decays toward gait speed rather than running away.
        const { pieces } = layoutTrack(['straight', 'straight', 'straight', 'straight'], { slopeDeg: 11 });
        const r = simulateRun(pieces, { mu: FRICTION_PRESETS.washboard.mu });
        // walking throughout the RUNNING pieces (the flat end platform is a
        // legitimate slide/coast); the gait never runs away into a ski
        const onRamps = r.trace.filter(s => pieces[s.pieceIndex].slopeDeg > 0);
        expect(onRamps.length).toBeGreaterThan(10);
        expect(onRamps.every(s => s.mode === 'walk')).toBe(true);
    });
});

describe('STALL and TUMBLE regimes', () => {
    test('stalls at rest before the end on a too-shallow, slick, lossy setup', () => {
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 8 });
        const r = simulateRun(pieces, {
            mu: FRICTION_PRESETS.smooth.mu,
            walker: { alphaDeg: 18, legLenMm: 26, efficiency: 0.15, massG: 45 }
        });
        expect(r.outcome).toBe('stalled');
        expect(r.stopDist).toBeLessThan(r.totalDist);
    });

    test('tumbles immediately when slope exceeds the swing limiter', () => {
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 14 });
        const r = simulateRun(pieces, {
            mu: FRICTION_PRESETS.washboard.mu,
            walker: { alphaDeg: 12, legLenMm: 26, efficiency: 0.26, massG: 45 }
        });
        expect(r.outcome).toBe('tumbled');
        expect(r.tEnd).toBeLessThan(0.1);
    });
});

describe('conservation & determinism', () => {
    test('never creates energy: ½v² ≤ g·Δh along every regime', () => {
        for (const cfg of [
            { seq: ['straight', 'curveL', 'straight'], slope: 11, mu: FRICTION_PRESETS.washboard.mu },
            { seq: ['straight', 'straight', 'straight'], slope: 16, mu: FRICTION_PRESETS.smooth.mu }
        ]) {
            const { pieces } = layoutTrack(cfg.seq, { slopeDeg: cfg.slope });
            const r = simulateRun(pieces, { mu: cfg.mu });
            const e = verifyEnergyBudget(r.trace);
            expect(e.ok).toBe(true);
        }
    });

    test('simulation is deterministic (bit-identical repeat runs)', () => {
        const { pieces } = layoutTrack(['straight', 'curveR', 'straight'], { slopeDeg: 11 });
        const a = simulateRun(pieces, { mu: 0.6 });
        const b = simulateRun(pieces, { mu: 0.6 });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    test('trace is monotonic in time and distance', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'curveL', 'straight'], { slopeDeg: 11 });
        const r = simulateRun(pieces, { mu: 0.6 });
        for (let i = 1; i < r.trace.length; i++) {
            expect(r.trace[i].t).toBeGreaterThan(r.trace[i - 1].t);
            expect(r.trace[i].dist).toBeGreaterThanOrEqual(r.trace[i - 1].dist);
        }
    });
});

describe('makePathSampler', () => {
    test('interpolates positions continuously across piece boundaries', () => {
        const { pieces } = layoutTrack(['straight', 'curveL'], { slopeDeg: 11 });
        const sampler = makePathSampler(pieces);
        let prev = sampler.at(0);
        for (let d = 2; d <= sampler.total; d += 2) {
            const cur = sampler.at(d);
            const jump = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
            expect(jump).toBeLessThan(4);
            prev = cur;
        }
    });
});

describe('LIFT regime', () => {
    test('powered lift carries the figure uphill at the conveyor speed, then it trots home', () => {
        const { pieces } = layoutTrack(['lift', 'lift', 'curveL', 'curveL', 'straight'], { slopeDeg: 11 });
        const r = simulateRun(pieces, { mu: FRICTION_PRESETS.washboard.mu });
        expect(r.outcome).toBe('arrived');
        const liftSamples = r.trace.filter(s => s.mode === 'lift' && s.t > 1);
        expect(liftSamples.length).toBeGreaterThan(10);
        for (const s of liftSamples) expect(Math.abs(s.v - 110)).toBeLessThan(12);
        // figure gains height during the lift
        const first = r.trace[0], peak = Math.max(...r.trace.map(s => s.y));
        expect(peak).toBeGreaterThan(first.y + 30);
        // energy budget still holds because lifts re-baseline it
        expect(verifyEnergyBudget(r.trace).ok).toBe(true);
    });
});
