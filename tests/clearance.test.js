/**
 * The lateral half of the physics. `simulate.js` never reads channel width, so
 * until this module existed the curve widening, the channel range and the
 * 120 mm minimum radius were published numbers with no test between them —
 * and the widening turned out to be an artefact of an oversized figure rather
 * than a requirement of the track. These check the model against the two
 * physical measurements it now rests on (a 38 mm toy, a channel that prints
 * 1 mm narrow than drawn) and then assert the thing that matters: that the
 * figure fits, everywhere, on every scene.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutTrack, resolveRidePath, appendSpiralTier, SPEC, STANDARD, innerWidthAt } from '../js/track.js';
import { FIGURE } from '../js/geometry.js';
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

    test('the width is measured off the toy, not derived from the track', () => {
        // it used to be `channelWidth − 4`, which meant the figure justified
        // whatever channel it was given and the channel justified the figure
        expect(walkerFootprint().widthMm).toBe(FIGURE.widthMm);
        expect(walkerFootprint({ channelWidthMm: 60 }).widthMm).toBe(FIGURE.widthMm);
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
        const straight = layoutTrack(['straight']).pieces.find(pc => pc.type === 'straight');
        expect(requiredWidthAt(straight, 75)).toBeCloseTo(fp.widthMm + CLEARANCE.lateralMm, 6);
        expect(straight.innerWidth).toBeGreaterThanOrEqual(requiredWidthAt(straight, 75));
    });

    test('one channel width covers every legal radius — no widening needed', () => {
        // This is the measurement that deleted `curveWidenMm`. A real figure
        // swept through the TIGHTEST legal turn is the worst case anywhere on
        // any track, and the standard channel already covers it.
        const at = (R) => requiredWidthAt({ radius: R, turn: 1, planLen: (Math.PI / 2) * R }, 0);
        const worst = at(SPEC.minCurveRadius);
        expect(worst).toBeGreaterThan(at(STANDARD.curveRadius));   // 120 is the worst case
        expect(worst).toBeLessThanOrEqual(STANDARD.innerWidth);
        expect(STANDARD.innerWidth - worst).toBeGreaterThan(2);     // and not by a whisker
        expect(SPEC.curveWidenMm).toBe(0);
    });

    test('the widening only existed to carry an oversized figure', () => {
        // 44 mm was `channelWidth − 4`; at that width a standard curve really
        // does need more than 48, which is where the +3 mm came from
        const fat = walkerFootprint({ figureWidthMm: 44 });
        const curve = { radius: STANDARD.curveRadius, turn: 1, planLen: 225 };
        expect(requiredWidthAt(curve, 0, { footprint: fat })).toBeGreaterThan(STANDARD.innerWidth);
        expect(requiredWidthAt(curve, 0)).toBeLessThan(STANDARD.innerWidth);
    });

    test('there is headroom for a figure wider than the one measured', () => {
        // the toy is not a spec sheet; leave room for the next one to measure
        // a millimetre or two differently
        const curve = { radius: SPEC.minCurveRadius, turn: 1, planLen: 200 };
        for (const W of [FIGURE.widthMm, FIGURE.widthMm + 1, FIGURE.widthMm + 2]) {
            const need = requiredWidthAt(curve, 0, { footprint: walkerFootprint({ figureWidthMm: W }) });
            expect(`${W} mm needs ${need <= STANDARD.innerWidth}`).toBe(`${W} mm needs true`);
        }
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
    test('a straight run reports the play the plastic actually has', () => {
        // nominal 48, less the measured 1 mm a printed channel loses, less the
        // 38 mm figure
        const fit = channelFitProfile(resolveRidePath(layoutTrack(['straight', 'straight']).pieces));
        expect(fit.worstPlayMm).toBeCloseTo(
            STANDARD.innerWidth - CLEARANCE.printNarrowingMm - FIGURE.widthMm, 2);
        // and the model is honest about the difference between CAD and a part
        const cad = channelFitProfile(resolveRidePath(layoutTrack(['straight', 'straight']).pieces),
            { printNarrowingMm: 0 });
        expect(cad.worstPlayMm - fit.worstPlayMm).toBeCloseTo(CLEARANCE.printNarrowingMm, 6);
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
        const local = interior.innerWidth - CLEARANCE.printNarrowingMm
            - (requiredWidthAt(interior, 0) - CLEARANCE.lateralMm);
        for (const st of inside) expect(st.playMm).toBeCloseTo(local, 1);
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
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { innerWidth: 38 });
        const check = checkChannelFit(resolveRidePath(pieces), { stationStepMm: 5 });
        expect(check.issues.map(i => i.code)).toContain('channel-too-narrow');
    });
});

describe('one width, everywhere', () => {
    // The seam-width machinery is still here and still correct, because a
    // custom-parameter build can ask for a widened turn. At the Standard it is
    // a no-op, and that is what deletes the `_into_curve` family: with nothing
    // to blend, a curve and a straight are each ONE shape wherever they sit.
    const seq = ['straight', ...appendSpiralTier([], 'L'), ...appendSpiralTier([], 'L'), 'straight'];

    test('every piece on a helix is the same channel, face to face', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: STANDARD.slopeDeg });
        for (const pc of pieces) {
            expect(`${pc.name} body`).toBe(`${pc.name} ${pc.innerWidth === STANDARD.innerWidth ? 'body' : 'WIDENED'}`);
            expect(pc.entryWidth).toBe(pc.innerWidth);
            expect(pc.exitWidth).toBe(pc.innerWidth);
            for (const s of [0, 10, 30, pc.planLen / 2, pc.planLen - 10, pc.planLen]) {
                expect(innerWidthAt(pc, s)).toBeCloseTo(STANDARD.innerWidth, 9);
            }
        }
    });

    test('so a helix has exactly two distinct track shapes, not eight', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: STANDARD.slopeDeg });
        const shape = (pc) => [pc.type, pc.innerWidth, pc.entryWidth, pc.exitWidth,
            pc.planLen.toFixed(1)].join('|');
        const running = pieces.filter(pc => pc.type === 'straight' || pc.radius);
        expect(new Set(running.map(shape)).size).toBe(2);
    });

    test('the wider-face rule still holds if a build asks for widening', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: STANDARD.slopeDeg });
        // simulate a custom build: give the curves 3 mm and re-resolve by hand
        const by = new Map(pieces.map(p => [p.index, p]));
        pieces.forEach(p => { if (p.radius) p.innerWidth += 3; p.entryWidth = p.innerWidth; p.exitWidth = p.innerWidth; });
        for (const p of pieces) {
            const q = p.prevIndex == null ? null : by.get(p.prevIndex);
            if (!q) continue;
            const w = Math.max(q.innerWidth, p.innerWidth);
            p.entryWidth = Math.max(p.entryWidth, w);
            q.exitWidth = Math.max(q.exitWidth, w);
        }
        for (const [a, b] of pieces.map(pc => [pc.prevIndex == null ? null : by.get(pc.prevIndex), pc]).filter(([a]) => a)) {
            expect(a.exitWidth).toBeCloseTo(b.entryWidth, 6);      // no lateral ledge
        }
        for (const pc of pieces.filter(p => p.radius)) {
            expect(pc.entryWidth).toBe(pc.innerWidth);             // curves stay one shape
        }
    });
});
