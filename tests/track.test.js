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
