/**
 * The lateral half of the physics. `simulate.js` never reads channel width, so
 * until this module existed the +3 mm curve widening, the 46–50 mm channel
 * range and the 120 mm minimum radius were three published numbers with no
 * test between them. These check that the model reproduces all three from the
 * figure's own geometry, and then use it to assert the thing the old
 * "not pinched at its interior seams" test was standing in for: that the figure
 * actually fits, everywhere, on every scene.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutTrack, resolveRidePath, appendSpiralTier, SPEC, STANDARD, innerWidthAt } from '../js/track.js';
import { deserializeScene } from '../js/scene_format.js';
import {
    CLEARANCE, walkerFootprint, strideMm, yawAmplitudeRad, sweptBandMm,
    signedRadiusOf, requiredWidthAt, channelFitProfile, checkChannelFit
} from '../js/clearance.js';

const SCENES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenes');
const sceneFiles = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).sort();

const helix = (turns = 2) => layoutTrack(
    ['straight', ...Array.from({ length: turns }, () => appendSpiralTier([], 'L')).flat(), 'straight'],
    { slopeDeg: STANDARD.slopeDeg }
).pieces;

describe('the footprint is read off the figure, not asserted', () => {
    test('only the part below the rails counts', () => {
        const fp = walkerFootprint();
        // the classic body silhouette runs −23…+23 at hoof level and the
        // pendulum swings back past it; the nose and head are above the rails
        // and the channel is open up there, so they constrain nothing
        expect(fp.lengthMm).toBeGreaterThan(45);
        expect(fp.lengthMm).toBeLessThan(50);
        expect(fp.zMax).toBeCloseTo(23, 3);
        expect(fp.zMin).toBeLessThan(-23);   // pendulum at full swing

        // raise the rails past the knight's nose and it starts to count
        const knight = walkerFootprint({ style: 'knight' });
        expect(walkerFootprint({ style: 'knight', railHeightMm: 60 }).lengthMm)
            .toBeGreaterThan(knight.lengthMm);
    });

    test('the width is what the figure is actually printed at', () => {
        expect(walkerFootprint().widthMm).toBe(STANDARD.innerWidth - 4);
        expect(walkerFootprint({ channelWidthMm: 46 }).widthMm).toBe(42);
        expect(walkerFootprint({ figureWidthMm: 40 }).widthMm).toBe(40);
    });

    test('a rider does not widen the footprint — it sits above the rails', () => {
        expect(walkerFootprint({ style: 'knight' }).widthMm)
            .toBe(walkerFootprint({ style: 'classic' }).widthMm);
    });
});

describe('yaw', () => {
    test('stride agrees with the gait model in physics.js', () => {
        // 2·l·sinα, the same expression assessSlope reports as strideMm
        expect(strideMm({})).toBeCloseTo(2 * 26 * Math.sin(18 * Math.PI / 180), 6);
    });

    test('a straight is walked square; a turn is tacked', () => {
        expect(yawAmplitudeRad(null)).toBe(0);
        expect(yawAmplitudeRad(STANDARD.curveRadius))
            .toBeCloseTo(strideMm({}) / (2 * STANDARD.curveRadius), 9);
        // tighter turn, more tacking
        expect(yawAmplitudeRad(120)).toBeGreaterThan(yawAmplitudeRad(200));
    });
});

describe('the model reproduces the published rule set', () => {
    const fp = walkerFootprint();

    test('a straight needs exactly the figure width', () => {
        expect(sweptBandMm(fp, null, 0)).toBeCloseTo(fp.widthMm, 6);
        // ...so the standard 48 mm channel is the 44 mm figure plus the 4 mm of
        // play PHYSICS.md §4 claims for it
        const straight = layoutTrack(['straight']).pieces.find(pc => pc.type === 'straight');
        expect(requiredWidthAt(straight, 75)).toBeCloseTo(fp.widthMm + CLEARANCE.lateralMm, 6);
        expect(straight.innerWidth).toBeGreaterThanOrEqual(requiredWidthAt(straight, 75));
    });

    test('+3 mm of curve widening is what a standard curve needs — not 2, not 5', () => {
        const curve = helix()[2];
        expect(curve.radius).toBeCloseTo(STANDARD.curveRadius, 3);
        const need = requiredWidthAt(curve, curve.planLen / 2);
        // the base channel is not enough...
        expect(need).toBeGreaterThan(STANDARD.innerWidth);
        // ...the widened one is, with under a millimetre to spare
        expect(need).toBeLessThanOrEqual(STANDARD.innerWidth + SPEC.curveWidenMm);
        expect(STANDARD.innerWidth + SPEC.curveWidenMm - need).toBeLessThan(1);
    });

    test('the 120 mm minimum radius is where the widening runs out', () => {
        const at = (R) => {
            const piece = { radius: R, turn: 1, planLen: (Math.PI / 2) * R };
            return requiredWidthAt(piece, 0);
        };
        const widened = STANDARD.innerWidth + SPEC.curveWidenMm;
        expect(at(SPEC.minCurveRadius)).toBeLessThanOrEqual(widened);
        expect(widened - at(SPEC.minCurveRadius)).toBeLessThan(0.6);   // all but spent
        expect(at(SPEC.minCurveRadius - 20)).toBeGreaterThan(widened);  // over the line
    });

    test('a tighter turn always demands more channel', () => {
        let prev = 0;
        for (const R of [400, 300, 200, 150, 120, 100]) {
            const need = requiredWidthAt({ radius: R, turn: 1, planLen: R }, 0);
            expect(need).toBeGreaterThan(prev);
            prev = need;
        }
    });
});

describe('fit against a real track', () => {
    test('the standard straight run comes out at its stated 4 mm of play', () => {
        const fit = channelFitProfile(resolveRidePath(layoutTrack(['straight', 'straight']).pieces));
        expect(fit.worstPlayMm).toBeCloseTo(4, 2);
    });

    test('a helix interior agrees with the piece-local answer', () => {
        // where both neighbours are curves of the same radius the two models
        // are the same statement, which is what makes the local form usable
        const pieces = helix(3);
        const interior = pieces.filter(pc => pc.radius)[5];
        const fit = channelFitProfile(resolveRidePath(pieces), { stationStepMm: 3 });
        const inside = fit.stations.filter(st =>
            st.pieceName === interior.name && st.s > 60 && st.s < interior.planLen - 60);
        expect(inside.length).toBeGreaterThan(5);
        const local = interior.innerWidth - (requiredWidthAt(interior, 0) - CLEARANCE.lateralMm);
        for (const st of inside) expect(st.playMm).toBeCloseTo(local, 2);
    });

    test('the figure fits on every scene, with margin over a binding print', () => {
        for (const file of sceneFiles) {
            const state = deserializeScene(JSON.parse(fs.readFileSync(path.join(SCENES_DIR, file), 'utf8')));
            const { pieces } = layoutTrack(state.sequence, {
                slopeDeg: state.slopeDeg, innerWidth: state.innerWidth, curveRadius: state.curveRadius
            });
            const check = checkChannelFit(resolveRidePath(pieces), {
                stationStepMm: 3,
                footprint: walkerFootprint({ channelWidthMm: state.innerWidth, walker: state.walker })
            });
            expect(`${file}: ${check.issues.map(i => i.code).join()}`).toBe(`${file}: `);
            expect(check.worstPlayMm).toBeGreaterThan(CLEARANCE.warnPlayMm);
        }
    });

    test('a channel too narrow for the figure is reported as an error', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { innerWidth: 44 });
        const check = checkChannelFit(resolveRidePath(pieces), { stationStepMm: 5 });
        expect(check.issues.map(i => i.code)).toContain('channel-too-narrow');
    });
});

describe('the seam rule, measured', () => {
    // This is the test the old "a helix is not pinched at its interior seams"
    // was a proxy for. It compares the three coherent ways to resolve a seam
    // instead of asserting one of them, so the rule in resolveSeamWidths has to
    // keep earning its place.
    const seq = ['straight', ...appendSpiralTier([], 'L'), ...appendSpiralTier([], 'L'), 'straight'];
    const under = (rewrite) => {
        const { pieces } = layoutTrack(seq, { slopeDeg: STANDARD.slopeDeg });
        rewrite(pieces);
        return channelFitProfile(resolveRidePath(pieces), { stationStepMm: 2 }).worstPlayMm;
    };

    const asBuilt = under(() => {});
    const narrowerWins = under(ps => {
        const by = new Map(ps.map(p => [p.index, p]));
        ps.forEach(p => { p.entryWidth = p.innerWidth; p.exitWidth = p.innerWidth; });
        for (const p of ps) {
            const q = p.prevIndex == null ? null : by.get(p.prevIndex);
            if (!q) continue;
            const w = Math.min(q.innerWidth, p.innerWidth);
            p.entryWidth = Math.min(p.entryWidth, w);
            q.exitWidth = Math.min(q.exitWidth, w);
        }
    });
    const collapsedToBase = under(ps => ps.forEach(p => {
        p.innerWidth = p.entryWidth = p.exitWidth = STANDARD.innerWidth;
    }));

    test('collapsing every face to the base width is the worst of the three', () => {
        // the change PLAN.md set out to make, had nothing measured it: it
        // leaves under a millimetre of play at the tightest point of a helix
        expect(collapsedToBase).toBeLessThan(1);
        expect(collapsedToBase).toBeLessThan(narrowerWins);
    });

    test('matching on the wider face beats matching on the narrower one', () => {
        expect(asBuilt).toBeGreaterThan(narrowerWins);
        expect(asBuilt).toBeGreaterThan(CLEARANCE.warnPlayMm);
    });

    test('the curve keeps the room; the straight gives it up', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: STANDARD.slopeDeg });
        for (const pc of pieces) {
            const mid = innerWidthAt(pc, pc.planLen / 2);
            expect(mid).toBeCloseTo(pc.innerWidth, 6);            // body unchanged
            expect(innerWidthAt(pc, 0)).toBeGreaterThanOrEqual(mid - 1e-9);
            expect(innerWidthAt(pc, pc.planLen)).toBeGreaterThanOrEqual(mid - 1e-9);
        }
    });
});
