import {
    FRICTION_PRESETS, DEFAULT_WALKER, steadyOmega, integrateStep,
    assessSlope, goldilocksRange, ballastPlan, trackVerdict
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
