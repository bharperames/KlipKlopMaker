import {
    FRICTION_PRESETS, DEFAULT_WALKER, steadyOmega, integrateStep,
    assessSlope, goldilocksRange, ballastPlan, trackVerdict, stanceWaveform
} from '../js/physics.js';
import { layoutTrack } from '../js/track.js';

describe('rimless-wheel gait model', () => {
    test('no steady gait on flat or uphill ground', () => {
        expect(steadyOmega(0)).toBe(0);
        expect(steadyOmega(-5)).toBe(0);
        expect(assessSlope(0).status).toBe('stall');
    });

    test('walks in the spec green zone (10-12°) with washboard friction', () => {
        for (const deg of [10, 11, 12]) {
            const r = assessSlope(deg, { mu: FRICTION_PRESETS.washboard.mu });
            expect(r.status).toBe('walk');
            expect(r.speedMmS).toBeGreaterThan(10);
            expect(r.stepHz).toBeGreaterThan(1);
        }
    });

    test('stalls on a too-shallow ramp', () => {
        expect(assessSlope(3).status).toBe('stall');
    });

    test('slides on smooth PLA before it slides on washboard', () => {
        // tan(16°) = 0.287 > 0.85*0.32 → smooth floor skis; washboard still grips
        const smooth = assessSlope(16, { mu: FRICTION_PRESETS.smooth.mu });
        expect(smooth.status).toBe('slide');
        const ridged = assessSlope(16, { mu: FRICTION_PRESETS.washboard.mu });
        expect(ridged.status).not.toBe('slide');
    });

    test('tumbles when slope exceeds the swing limiter', () => {
        const r = assessSlope(20, { mu: FRICTION_PRESETS.washboard.mu });
        expect(r.status).toBe('tumble');
    });

    test('goldilocks zone with toy defaults brackets the empirical 8-14° window', () => {
        const { minDeg, maxDeg } = goldilocksRange({ mu: FRICTION_PRESETS.washboard.mu });
        expect(minDeg).toBeGreaterThan(4);
        expect(minDeg).toBeLessThan(10);
        expect(maxDeg).toBeGreaterThanOrEqual(14);
        expect(maxDeg).toBeLessThan(20);
    });

    test('step integration returns physically plausible cadence', () => {
        const omega = steadyOmega(11);
        const step = integrateStep(11, omega);
        expect(step).not.toBeNull();
        expect(step.stepTime).toBeGreaterThan(0.05);
        expect(step.stepTime).toBeLessThan(1.0);
    });

    test('higher slope walks faster', () => {
        const slow = assessSlope(10, { mu: 0.6 });
        const fast = assessSlope(13, { mu: 0.6 });
        expect(fast.speedMmS).toBeGreaterThan(slow.speedMmS);
    });

    /*
     * THE GRIP-RELEASE CYCLE ON THE RACK — Brett, off the toy: the front pad
     * grips a ridge and stops, the COM tips the body back and releases the
     * grip, and the front leg lands ready for the next grip "several ridges
     * down". Two model consequences, both pinned here.
     */
    test('the stride is quantised to whole ridges of the rack', () => {
        const r = assessSlope(11.217, { mu: 0.6, ridgePitchMm: 2.5 });
        // 2·26·sin(18°) = 16.07 mm of swing → the pad settles 6 ridges down
        expect(r.ridgesPerStep).toBe(6);
        expect(r.strideMm).toBeCloseTo(15.0, 5);
        // "several ridges down": the ratchet costs speed against smooth theory
        const smooth = assessSlope(11.217, { mu: 0.6 });
        expect(r.speedMmS).toBeLessThan(smooth.speedMmS);
        expect(r.speedMmS).toBeGreaterThan(smooth.speedMmS * 0.85);
        // even a coarse rack can never quantise the stride to zero
        expect(assessSlope(11.217, { mu: 0.6, ridgePitchMm: 30 }).ridgesPerStep).toBe(1);
    });

    test('the stance waveform is the step, reshaped for playback', () => {
        const w = stanceWaveform(11.2181);
        // endpoints are the stance's own: grip at -(alpha-gamma), strike at +(alpha+gamma)
        expect(w.phi01[0]).toBeCloseTo(w.phi0, 6);
        expect(w.phi01[w.phi01.length - 1]).toBeCloseTo(w.phi1, 6);
        // monotonic — the leg never swings backwards in a completed step
        for (let i = 1; i < w.phi01.length; i++) expect(w.phi01[i]).toBeGreaterThanOrEqual(w.phi01[i - 1]);
        // same physics as integrateStep, not a second opinion of it
        const step = integrateStep(11.2181, steadyOmega(11.2181));
        expect(w.stepTime).toBeCloseTo(step.stepTime, 2);
        // and the asymmetry is present: less than 45% of the stride is done
        // at half time — the slow grip, then the accelerating fall
        expect(w.s01[Math.floor(w.s01.length / 2)]).toBeLessThan(0.45);
    });

    test('each step splits into a grip phase and a release-swing phase', () => {
        const r = assessSlope(11.217, { mu: 0.6, ridgePitchMm: 2.5 });
        // grip: strike → top dead center, COM uphill of the pad, rack loaded.
        // swing: past TDC, falling forward into the next grip. Both real, and
        // the fall is the longer half — the grip is an arrest, not a dwell.
        expect(r.gripS).toBeGreaterThan(0.01);
        expect(r.swingS).toBeGreaterThan(r.gripS);
        expect(r.gripS + r.swingS).toBeCloseTo(1 / r.stepHz, 3);
    });
});

describe('ballastPlan', () => {
    test('printed PLA figure needs metal ballast to hit toy mass', () => {
        const plan = ballastPlan(30000, 15, 32); // ~30 cm³ solid volume, 15% infill
        expect(plan.plasticG).toBeGreaterThan(5);
        expect(plan.plasticG).toBeLessThan(32);
        expect(plan.ballastG).toBeGreaterThan(0);
        expect(plan.bbCount).toBe(Math.round(plan.ballastG / 0.35));
    });

    test('no negative ballast when the print is already heavy enough', () => {
        const plan = ballastPlan(100000, 100, 10);
        expect(plan.ballastG).toBe(0);
    });
});

describe('trackVerdict', () => {
    test('full walk verdict on a compliant layout', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { slopeDeg: 11 });
        const v = trackVerdict(pieces, { mu: FRICTION_PRESETS.washboard.mu });
        expect(v.allWalk).toBe(true);
        expect(v.descentTimeS).toBeGreaterThan(0);
        expect(v.perPiece[0].status).toBe('platform');
        expect(v.perPiece[1].status).toBe('walk');
    });

    test('flags a stalling layout', () => {
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 3 });
        const v = trackVerdict(pieces, { mu: FRICTION_PRESETS.washboard.mu });
        expect(v.allWalk).toBe(false);
    });
});
