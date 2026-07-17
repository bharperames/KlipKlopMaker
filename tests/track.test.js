import {
    SPEC, layoutTrack, samplePath, stationsForPiece, checkClearances,
    effectiveRidgePitch, ridgeOffset, appendSpiralTier, degToRad
} from '../js/track.js';

describe('layoutTrack', () => {
    test('adds implicit start and end platforms around the user sequence', () => {
        const { pieces } = layoutTrack(['straight']);
        expect(pieces.map(p => p.type)).toEqual(['start', 'straight', 'end']);
    });

    test('straight pieces drop exactly planLen * tan(slope)', () => {
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 11 });
        const ramp = pieces[1];
        expect(ramp.drop).toBeCloseTo(150 * Math.tan(degToRad(11)), 6);
        expect(ramp.entryDeck - ramp.exitDeck).toBeCloseTo(ramp.drop, 6);
    });

    test('platforms are flat', () => {
        const { pieces } = layoutTrack(['straight']);
        expect(pieces[0].drop).toBe(0);
        expect(pieces[2].drop).toBe(0);
        expect(pieces[0].slopeDeg).toBe(0);
    });

    test('waterfall rule: every seam steps the downhill floor down 0.25 mm', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { slopeDeg: 11 });
        for (let i = 1; i < pieces.length; i++) {
            const lip = pieces[i - 1].exitDeck - pieces[i].entryDeck;
            expect(lip).toBeCloseTo(SPEC.waterfallStepMm, 9);
        }
    });

    test('lowest skirt rim rests exactly on the ground', () => {
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11 });
        const minRim = Math.min(...pieces.map(p => p.rimY));
        expect(minRim).toBeCloseTo(0, 9);
    });

    test('90° curve exits perpendicular at the correct offset', () => {
        const { pieces } = layoutTrack(['curveL'], { curveRadius: 150 });
        const curve = pieces[1];
        expect(Math.abs(curve.exit.h - curve.entry.h)).toBeCloseTo(Math.PI / 2, 9);
        const dx = curve.exit.x - curve.entry.x;
        const dz = curve.exit.z - curve.entry.z;
        expect(Math.hypot(dx, dz)).toBeCloseTo(150 * Math.SQRT2, 6);
        expect(curve.planLen).toBeCloseTo((Math.PI / 2) * 150, 6);
    });

    test('curves get dynamic widening; straights do not', () => {
        const { pieces } = layoutTrack(['straight', 'curveR'], { innerWidth: 48 });
        expect(pieces[1].innerWidth).toBe(48);
        expect(pieces[2].innerWidth).toBe(48 + SPEC.curveWidenMm);
    });

    test('slope outside the hard window raises an error issue', () => {
        const tooFlat = layoutTrack(['straight'], { slopeDeg: 5 });
        expect(tooFlat.issues.some(i => i.code === 'slope-out-of-range' && i.level === 'error')).toBe(true);
        const tooSteep = layoutTrack(['straight'], { slopeDeg: 16 });
        expect(tooSteep.issues.some(i => i.code === 'slope-out-of-range')).toBe(true);
        const marginal = layoutTrack(['straight'], { slopeDeg: 9 });
        expect(marginal.issues.some(i => i.code === 'slope-marginal' && i.level === 'warn')).toBe(true);
        const good = layoutTrack(['straight'], { slopeDeg: 11 });
        expect(good.issues.filter(i => i.code.startsWith('slope'))).toHaveLength(0);
    });

    test('radius below the rigid-body minimum raises an error', () => {
        const { issues } = layoutTrack(['curveL'], { curveRadius: 100 });
        expect(issues.some(i => i.code === 'radius-too-tight')).toBe(true);
    });

    test('a two-tier spiral at spec defaults has no clearance violations', () => {
        let seq = appendSpiralTier(appendSpiralTier([], 'L'), 'L');
        const { issues, pieces } = layoutTrack(seq, { slopeDeg: 11, curveRadius: 150 });
        expect(issues.filter(i => i.code === 'clearance')).toHaveLength(0);
        // stacked tiers really do overlap in plan — drop per tier must cover it
        const dropPerTier = 4 * ((Math.PI / 2) * 150 * Math.tan(degToRad(11)) + SPEC.waterfallStepMm);
        expect(dropPerTier).toBeGreaterThan(SPEC.clearanceHeight);
        expect(pieces[0].entryDeck).toBeGreaterThan(2 * SPEC.clearanceHeight);
    });
});

describe('checkClearances', () => {
    const fakePiece = (x, deck, name) => ({
        type: 'straight', name,
        planLen: 150, radius: null, turn: 0,
        entry: { x, z: 0, h: 0 }, exit: { x: x + 150, z: 0, h: 0 },
        entryDeck: deck, exitDeck: deck, drop: 0, slopeDeg: 11, rimY: deck - 12,
        center: null
    });

    test('flags overlapping pieces with insufficient vertical gap', () => {
        const a = fakePiece(0, 200, 'a');
        const b = fakePiece(50, 150, 'b'); // 50 mm above ground path, only 50 mm gap
        const mid = fakePiece(500, 200, 'mid');
        const issues = checkClearances([a, mid, b], { innerWidth: 48 });
        expect(issues.some(i => i.code === 'clearance')).toBe(true);
    });

    test('accepts overlapping pieces separated by more than the clearance height', () => {
        const a = fakePiece(0, 300, 'a');
        const b = fakePiece(50, 150, 'b'); // 150 mm gap > 100 required
        const mid = fakePiece(500, 200, 'mid');
        const issues = checkClearances([a, mid, b], { innerWidth: 48 });
        expect(issues.filter(i => i.code === 'clearance')).toHaveLength(0);
    });
});

describe('washboard phase snapping', () => {
    test('pitch snaps so an integer ridge count fits the piece', () => {
        const { pitch, count } = effectiveRidgePitch(150, 2.5);
        expect(count).toBe(60);
        expect(pitch * count).toBeCloseTo(150, 9);
    });

    test('ridge profile is zero (a valley) at both seam faces', () => {
        const { pieces } = layoutTrack(['curveL'], { curveRadius: 150 });
        for (const pc of pieces) {
            expect(ridgeOffset(0, pc.ridgePitch, SPEC.ridge.height)).toBeCloseTo(0, 9);
            expect(ridgeOffset(pc.planLen, pc.ridgePitch, SPEC.ridge.height)).toBeCloseTo(0, 6);
        }
    });

    test('ridge peaks at half pitch with the spec height', () => {
        expect(ridgeOffset(1.25, 2.5, 0.6)).toBeCloseTo(0.6, 9);
    });
});

describe('zero-bank rule', () => {
    test('sweep right-vectors stay horizontal through a helical curve', () => {
        const { pieces } = layoutTrack(['curveL', 'curveL'], { slopeDeg: 12 });
        for (const pc of pieces) {
            for (const st of stationsForPiece(pc, 5)) {
                expect(st.right[1]).toBe(0);
                expect(Math.hypot(st.right[0], st.right[2])).toBeCloseTo(1, 9);
            }
        }
    });
});

describe('samplePath', () => {
    test('is monotonic in distance and descends monotonically on ramps', () => {
        const { pieces } = layoutTrack(['straight', 'curveR', 'straight'], { slopeDeg: 11 });
        const samples = samplePath(pieces, 5);
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i].dist).toBeGreaterThan(samples[i - 1].dist);
            expect(samples[i].y).toBeLessThanOrEqual(samples[i - 1].y + 1e-9);
        }
    });
});

// ---------------------------------------------------------------------------
// v2: tree tracks — switches, lifts, open ends, ride-path resolution
// ---------------------------------------------------------------------------
import { resolveRidePath, openContainers, getContainer, nodeAt, isSwitchNode } from '../js/track.js';

describe('switch nodes', () => {
    const seq = ['straight', { type: 'switchL', gate: 'branch', main: ['straight'], branch: ['curveL', 'straight'] }];

    test('emits two role pieces and caps every leaf with an end platform', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: 11 });
        const roles = pieces.filter(p => p.switchKey);
        expect(roles.map(p => p.role).sort()).toEqual(['branch', 'main']);
        expect(pieces.filter(p => p.type === 'end')).toHaveLength(2);
    });

    test('ride path follows the gate', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: 11 });
        const ride = resolveRidePath(pieces);
        expect(ride.some(p => p.role === 'branch')).toBe(true);
        expect(ride.some(p => p.role === 'main')).toBe(false);
        expect(ride.at(-1).type).toBe('end');
        // flipping the gate flips the path
        const flipped = JSON.parse(JSON.stringify(seq));
        flipped[1].gate = 'main';
        const ride2 = resolveRidePath(layoutTrack(flipped, { slopeDeg: 11 }).pieces);
        expect(ride2.some(p => p.role === 'main')).toBe(true);
        expect(ride2.some(p => p.role === 'branch')).toBe(false);
    });

    test('ride path seams stay waterfall-consistent through the switch', () => {
        const { pieces } = layoutTrack(seq, { slopeDeg: 11 });
        const ride = resolveRidePath(pieces);
        for (let i = 1; i < ride.length; i++) {
            expect(ride[i - 1].exitDeck - ride[i].entryDeck).toBeCloseTo(SPEC.waterfallStepMm, 9);
        }
    });

    test('openContainers lists both branch ends, not the root', () => {
        const ends = openContainers(seq).map(p => JSON.stringify(p));
        expect(ends).toContain(JSON.stringify([1, 'main']));
        expect(ends).toContain(JSON.stringify([1, 'branch']));
        expect(ends).not.toContain(JSON.stringify([]));
    });

    test('tree helpers address nodes correctly', () => {
        expect(nodeAt(seq, [0])).toBe('straight');
        expect(isSwitchNode(nodeAt(seq, [1]))).toBe(true);
        expect(getContainer(seq, [1, 'branch'])).toHaveLength(2);
        expect(nodeAt(seq, [1, 'branch', 0])).toBe('curveL');
    });
});

describe('lift pieces', () => {
    test('ascend at the locked angle and carry the isLift flag', () => {
        const { pieces } = layoutTrack(['lift', 'straight'], { slopeDeg: 11 });
        const lift = pieces.find(p => p.isLift);
        expect(lift.exitDeck - lift.entryDeck).toBeCloseTo(150 * Math.tan(degToRad(11)), 6);
        expect(lift.slopeDeg).toBeCloseTo(-11, 9);
        // rim anchors to the uphill GRID BOUNDARY (entry + waterfall) so all
        // supports share one height family
        expect(lift.rimY).toBeCloseTo(lift.entryDeck + SPEC.waterfallStepMm - SPEC.skirtDepth, 9);
    });

    test('lowest rim still lands on the ground with lifts in play', () => {
        const { pieces } = layoutTrack(['lift', 'lift', 'curveL', 'curveL', 'straight'], { slopeDeg: 11 });
        expect(Math.min(...pieces.map(p => p.rimY))).toBeCloseTo(0, 9);
    });
});

// ---------------------------------------------------------------------------
// collision-aware support planning (pillars must never spear a lower tier)
// ---------------------------------------------------------------------------
import { planPillarPositions, planPosAt, deckYAt } from '../js/track.js';

describe('planPillarPositions', () => {
    const columnHits = (pieces, sup) => {
        const pc = pieces[sup.pieceIndex];
        for (const q of pieces) {
            if (q.index === sup.pieceIndex) continue;
            if (q.switchKey && q.switchKey === pc.switchKey) continue;
            const reach = q.innerWidth / 2 + 2.4 + 7; // outer half + pillar radius
            for (let k = 0; k <= 12; k++) {
                const s = (q.planLen * k) / 12;
                const p = planPosAt(q, s);
                if (deckYAt(q, s) >= pc.rimY - 1) continue;
                if (Math.hypot(sup.x - p.x, sup.z - p.z) < reach) return true;
            }
        }
        return false;
    };

    test('stacked double spiral gets outrigger supports that clear the tier below', () => {
        const seq = ['straight', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'straight'];
        const { pieces } = layoutTrack(seq, { slopeDeg: 11, curveRadius: 150 });
        const sups = planPillarPositions(pieces);
        expect(sups.length).toBeGreaterThan(5);
        for (const sup of sups) {
            expect(sup.mode).not.toBe('none');
            expect(columnHits(pieces, sup)).toBe(false);
        }
        // the upper tier (directly above the lower) must have gone outboard
        expect(sups.some(s => s.mode === 'outrigger')).toBe(true);
    });

    test('a simple elevated straight keeps a plain center pillar', () => {
        const { pieces } = layoutTrack(['straight', 'straight', 'straight'], { slopeDeg: 11 });
        const sups = planPillarPositions(pieces);
        expect(sups.every(s => s.mode === 'center')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// loop mode: closed circuits with lift-funded elevation closure
// ---------------------------------------------------------------------------
describe('loop mode', () => {
    const RING = ['lift', 'lift', 'lift', 'curveL', 'curveL', 'lift', 'lift', 'lift', 'curveL', 'curveL'];

    test('a balanced lift/descent ring closes with a legal waterfall step', () => {
        const { pieces, issues } = layoutTrack(RING, { slopeDeg: 11, curveRadius: 140, loop: true });
        expect(issues.filter(i => i.code === 'loop-open')).toHaveLength(0);
        expect(pieces.some(p => p.type === 'start' || p.type === 'end')).toBe(false);
        // ring returns to origin in plan
        const tail = pieces[pieces.length - 1];
        expect(Math.hypot(tail.exit.x, tail.exit.z)).toBeLessThan(5);
        // closure step-down within [waterfall, 3mm]
        const stepDown = tail.exitDeck - pieces[0].entryDeck;
        expect(stepDown).toBeGreaterThanOrEqual(SPEC.waterfallStepMm - 0.05);
        expect(stepDown).toBeLessThanOrEqual(3);
    });

    test('an unbalanced ring reports how it fails to close', () => {
        const short = ['lift', 'lift', 'curveL', 'curveL', 'lift', 'lift', 'lift', 'curveL', 'curveL'];
        const { issues } = layoutTrack(short, { slopeDeg: 11, curveRadius: 140, loop: true });
        expect(issues.some(i => i.code === 'loop-open')).toBe(true);
    });

    test('switches are rejected on the main ring', () => {
        const seq = ['lift', { type: 'switchL', gate: 'main', main: [], branch: [] }];
        const { issues } = layoutTrack(seq, { slopeDeg: 11, loop: true });
        expect(issues.some(i => i.code === 'loop-no-switch')).toBe(true);
    });

    test('the simulator runs laps to a circuit outcome', async () => {
        const { simulateRun } = await import('../js/simulate.js');
        const { pieces } = layoutTrack(RING, { slopeDeg: 11, curveRadius: 140, loop: true });
        const r = simulateRun(pieces, { mu: 0.6, loop: true, maxLaps: 3 });
        expect(r.outcome).toBe('circuit');
        expect(r.stats.laps).toBe(3);
        expect(r.events.filter(e => e.type === 'lap')).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// The Klip Klop Standard: locked parameters, 15mm grid, reusable supports
// ---------------------------------------------------------------------------
import { STANDARD, isStandardParams, decomposeSupport } from '../js/track.js';

describe('the Klip Klop Standard', () => {
    test('standard slope sits in the green zone; every tile nets a grid drop', () => {
        expect(STANDARD.slopeDeg).toBeGreaterThan(SPEC.slope.greenMin);
        expect(STANDARD.slopeDeg).toBeLessThan(SPEC.slope.greenMax);
        expect(150 * Math.tan(degToRad(STANDARD.slopeDeg)) + SPEC.waterfallStepMm).toBeCloseTo(30, 3);
        const arc = (Math.PI / 2) * STANDARD.curveRadius;
        expect(arc * Math.tan(degToRad(STANDARD.slopeDeg)) + SPEC.waterfallStepMm).toBeCloseTo(45, 2);
        expect(150 * Math.tan(degToRad(STANDARD.liftSlopeDeg)) - SPEC.waterfallStepMm).toBeCloseTo(30, 3);
        expect(STANDARD.curveRadius).toBeGreaterThanOrEqual(SPEC.minCurveRadius);
    });

    test('default layouts put every support rim on the 15 mm grid', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'curveL', 'lift', 'lift', 'curveR', 'straight']);
        for (const pc of pieces) {
            expect(Math.abs(pc.rimY / 15 - Math.round(pc.rimY / 15))).toBeLessThan(0.005);
            if (pc.rimY > 1) expect(decomposeSupport(pc.rimY)).not.toBeNull();
        }
    });

    test('supports decompose into foot + standard risers that sum exactly', () => {
        for (const h of [15, 30, 45, 75, 120, 135, 255, 300]) {
            const d = decomposeSupport(h);
            expect(d).not.toBeNull();
            expect(STANDARD.footHeight + d.risers.reduce((s, r) => s + r, 0)).toBeCloseTo(h, 6);
            for (const r of d.risers) expect(STANDARD.riserSizes).toContain(r);
        }
        expect(decomposeSupport(137)).toBeNull(); // off-grid = custom mode only
    });

    test('standard loops close exactly (6 lift tiles = 4 curve drops)', () => {
        const ring = ['lift', 'lift', 'lift', 'curveL', 'curveL', 'lift', 'lift', 'lift', 'curveL', 'curveL'];
        const { pieces, issues } = layoutTrack(ring, { loop: true });
        expect(issues.filter(i => i.code === 'loop-open')).toHaveLength(0);
        const tail = pieces[pieces.length - 1];
        expect(tail.exitDeck - pieces[0].entryDeck).toBeCloseTo(SPEC.waterfallStepMm, 3);
    });

    test('isStandardParams flags forks of the part library', () => {
        expect(isStandardParams({})).toBe(true);
        expect(isStandardParams({ slopeDeg: STANDARD.slopeDeg, curveRadius: STANDARD.curveRadius, innerWidth: 48 })).toBe(true);
        expect(isStandardParams({ slopeDeg: 11 })).toBe(false);
        expect(isStandardParams({ curveRadius: 150 })).toBe(false);
    });
});
