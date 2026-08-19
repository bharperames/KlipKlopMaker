import {
    SPEC, layoutTrack, samplePath, stationsForPiece, checkClearances,
    effectiveRidgePitch, ridgeOffset, appendSpiralTier, degToRad,
    supportBossPos, stackHeightMm, needsPier, laysOnUnderside, undersidePlane
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

    /*
     * THE LOWEST POINT OF THE LOWEST PART RESTS ON THE GROUND — which for a
     * tilted-slab piece is its UNDERSIDE, not its rim: the underside plane
     * hangs 4.75 mm below rimY on a straight and ~12.5 on a curve. Grounding
     * on rims alone put a grounded slab curve below y=0, which Brett caught
     * in the assembled inspector view: "some of the curve is actually below
     * the ground". The lift is snapped to whole grid units so decks stay on
     * the 15 mm grid, so the invariant is a band, not an exact zero: nothing
     * below ground, and never a full spare grid unit of daylight.
     */
    test('the lowest point of the lowest part rests on the ground (within one grid unit)', () => {
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11 });
        const lowest = Math.min(...pieces.map((pc) => {
            if (!laysOnUnderside(pc, SPEC)) return pc.rimY;
            const pl = undersidePlane(pc, SPEC);
            let lo = pc.rimY;
            const Wo = pc.innerWidth / 2 + SPEC.wall;
            for (let s = 0; s <= pc.planLen; s += 5) {
                const q = planPosAt(pc, s);
                for (const u of [-Wo, Wo]) lo = Math.min(lo, pl.at(q.x + Math.sin(q.h) * u, q.z - Math.cos(q.h) * u));
            }
            return lo;
        }));
        expect(lowest).toBeGreaterThanOrEqual(0);
        expect(lowest).toBeLessThan(STANDARD.gridMm);
        // and the rims themselves stay on the grid datum
        const minRim = Math.min(...pieces.map(p => p.rimY));
        expect(minRim % STANDARD.gridMm).toBeCloseTo(0, 9);
    });

    /*
     * The stranded-end warning measures against the layout's own datum, not
     * absolute zero — the slab ground lift moved the datum up a grid unit and
     * every grounded slab design read as stranded until it did. Both halves
     * pinned: a real parity trap still warns, and a clean Y stays silent.
     */
    test('a stranded end is still caught, and a grounded one is not', () => {
        // main leg drops 4 units to its end, branch 3 — the main grounds the
        // datum and the branch's end hangs exactly one unit up: the parity trap
        const trapped = layoutTrack([
            { type: 'switchR', gate: 'main', main: ['straight', 'end'], branch: ['end'] }
        ], {});
        expect(trapped.issues.filter(i => i.code === 'stranded-end')).toHaveLength(1);
        const clean = layoutTrack(['straight',
            { type: 'switchR', gate: 'branch', main: ['straight', 'straight', 'end'], branch: ['curveR', 'straight', 'end'] }
        ], {});
        expect(clean.issues.filter(i => i.code === 'stranded-end')).toHaveLength(0);
    });

    test('a block layout still grounds its rims at exactly zero', () => {
        // a block piece's lowest point IS its rim, so no lift is needed and
        // the old invariant survives unchanged for this style
        const { pieces } = layoutTrack(['straight', 'straight'],
            { slopeDeg: 11, skirtStyle: 'block' });
        expect(Math.min(...pieces.map(p => p.rimY))).toBeCloseTo(0, 9);
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

    test('nothing is widened at the Standard; a custom build can still ask', () => {
        const std = layoutTrack(['straight', 'curveR'], { innerWidth: 48 });
        expect(std.pieces[1].innerWidth).toBe(48);
        expect(std.pieces[2].innerWidth).toBe(48);      // a curve needs nothing extra
        const custom = layoutTrack(['straight', 'curveR'], { innerWidth: 48, curveWidenMm: 3 });
        expect(custom.pieces[1].innerWidth).toBe(48);
        expect(custom.pieces[2].innerWidth).toBe(51);   // ...unless asked
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
import { SEGMENT_TYPES, isKnownNode } from '../js/track.js';

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

    test('lowest rim still lands on the grid datum with lifts in play', () => {
        // grounding is by the lowest UNDERSIDE now (see the ground-shift test),
        // lifted in whole grid units — so the rim invariant is grid membership,
        // with the true low point pinned in [0, grid) by the same shift
        const { pieces } = layoutTrack(['lift', 'lift', 'curveL', 'curveL', 'straight'], { slopeDeg: 11 });
        const minRim = Math.min(...pieces.map(p => p.rimY));
        expect(minRim % STANDARD.gridMm).toBeCloseTo(0, 9);
        expect(minRim).toBeLessThanOrEqual(STANDARD.gridMm);
    });
});

// ---------------------------------------------------------------------------
// collision-aware support planning (pillars must never spear a lower tier)
// ---------------------------------------------------------------------------
import { planPillarPositions, planPosAt, deckYAt, massCentreS } from '../js/track.js';

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

    test('a stacked double spiral jogs its columns clear of the tier below', () => {
        const seq = ['straight', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'straight'];
        const { pieces } = layoutTrack(seq, { slopeDeg: 11, curveRadius: 150 });
        const sups = planPillarPositions(pieces);
        expect(sups.length).toBeGreaterThan(5);
        for (const sup of sups) {
            expect(sup.mode).not.toBe('none');
            expect(columnHits(pieces, sup)).toBe(false);
        }
        // the upper tier sits directly over the lower, so it has to step aside
        expect(sups.some(s => s.mode === 'jog')).toBe(true);
    });

    test('the BOSS sits under the weight, and depends on nothing else', () => {
        // What keeps a track piece ONE shape is that the socket's position is
        // a property of the piece and nothing else — not of which column ends
        // up under it, not of where that column had to dodge to. It is not
        // mid-LENGTH: the rim anchors at the piece's low end, so the skirt is
        // as deep as the drop at the top and `skirtDepth` at the bottom, and
        // the weight sits at ~39% of a curve. A pier at 50% is downhill of it
        // and the piece tips toward the start, which is what they did.
        const seq = ['straight', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'curveL', 'straight'];
        const { pieces } = layoutTrack(seq, { slopeDeg: 11, curveRadius: 150 });
        const byType = new Map();
        for (const sup of planPillarPositions(pieces)) {
            const pc = pieces.find(p => p.index === sup.pieceIndex);
            expect(sup.s).toBeCloseTo(massCentreS(pc), 9);
            const boss = supportBossPos(pc, sup);
            expect(boss.x).toBeCloseTo(planPosAt(pc, massCentreS(pc)).x, 9);
            // every piece of a type puts it in the same place, whatever mode
            // the column ended up in — that is the one-shape rule
            const frac = sup.s / pc.planLen;
            if (byType.has(pc.type)) expect(frac).toBeCloseTo(byType.get(pc.type), 9);
            else byType.set(pc.type, frac);
        }
        // and it is genuinely uphill of centre, not a rounding difference
        const curve = pieces.find(p => p.type === 'curveL');
        expect(massCentreS(curve) / curve.planLen).toBeLessThan(0.45);
        expect(massCentreS(curve) / curve.planLen).toBeGreaterThan(0.33);
    });

    test('a jog costs the stack exactly one grid unit, so it still decomposes', () => {
        const seq = ['straight', ...Array(8).fill('curveL'), 'straight'];
        // This used to run BOTH undersides, because a viaduct boss ran down to
        // the rim and a minimal one recesses its seat into a sloping underside.
        // The viaduct is gone, so only the second route exists: the SPACER
        // carries whatever the recess adds and the rim says nothing about the
        // stack. What has to hold is unchanged — the height still decomposes
        // onto the grid.
        for (const skirtStyle of ['minimal']) {
            const { pieces } = layoutTrack(seq, { skirtStyle });
            for (const sup of planPillarPositions(pieces)) {
                const pc = pieces.find(p => p.index === sup.pieceIndex);
                if (!needsPier(pc)) continue;
                const h = stackHeightMm(pc, sup);
                expect(`${pc.name} ${skirtStyle} decomposes`).toBe(
                    `${pc.name} ${skirtStyle} ${decomposeSupport(h) ? 'decomposes' : 'OFF-GRID'}`);
            }
        }
    });

    test('a simple elevated straight keeps a plain center pillar', () => {
        const { pieces } = layoutTrack(['straight', 'straight', 'straight'], { slopeDeg: 11 });
        const sups = planPillarPositions(pieces);
        expect(sups.every(s => s.mode === 'center')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// implicit circuits: topology is analyzed from the geometry, not declared
// ---------------------------------------------------------------------------
describe('implicit circuits', () => {
    const RING = ['lift', 'lift', 'lift', 'curveL', 'curveL', 'lift', 'lift', 'lift', 'curveL', 'curveL'];

    test('a geometrically closed chain IS a circuit: no platforms, legal seam', () => {
        const { pieces, isCircuit } = layoutTrack(RING);
        expect(isCircuit).toBe(true);
        expect(pieces.some(p => p.type === 'start' || p.type === 'end')).toBe(false);
        const tail = pieces[pieces.length - 1];
        expect(Math.hypot(tail.exit.x, tail.exit.z)).toBeLessThan(5);
        const stepDown = tail.exitDeck - pieces[0].entryDeck;
        expect(stepDown).toBeGreaterThanOrEqual(SPEC.waterfallStepMm - 0.05);
        expect(stepDown).toBeLessThanOrEqual(3);
    });

    test('an unbalanced chain is simply an open run with corrals', () => {
        const { pieces, isCircuit } = layoutTrack(RING.slice(1));
        expect(isCircuit).toBe(false);
        expect(pieces[0].type).toBe('start');
        expect(pieces.filter(p => p.type === 'end')).toHaveLength(1);
    });

    test('root chains containing switches are never circuits', () => {
        const seq = ['straight', { type: 'switchL', gate: 'main', main: [], branch: [] }];
        expect(layoutTrack(seq).isCircuit).toBe(false);
    });

    test('the simulator runs laps to a circuit outcome on an analyzed circuit', async () => {
        const { simulateRun } = await import('../js/simulate.js');
        const layout = layoutTrack(RING);
        const r = simulateRun(layout.pieces, { mu: 0.6, loop: layout.isCircuit, maxLaps: 3 });
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
        const { pieces, isCircuit } = layoutTrack(ring);
        expect(isCircuit).toBe(true);
        const tail = pieces[pieces.length - 1];
        expect(tail.exitDeck - pieces[0].entryDeck).toBeCloseTo(SPEC.waterfallStepMm, 3);
    });

    test('isStandardParams flags forks of the part library', () => {
        expect(isStandardParams({})).toBe(true);
        expect(isStandardParams({ slopeDeg: STANDARD.slopeDeg, curveRadius: STANDARD.curveRadius, innerWidth: 48 })).toBe(true);
        expect(isStandardParams({ slopeDeg: 11 })).toBe(false);
        expect(isStandardParams({ curveRadius: 150 })).toBe(false);
    });

    test('powered track is flat, has zero drop, and has isLift=true', () => {
        const { pieces } = layoutTrack(['powered']);
        const poweredPiece = pieces[1];
        expect(poweredPiece.type).toBe('powered');
        expect(poweredPiece.drop).toBe(0);
        expect(poweredPiece.slopeDeg).toBe(0);
        expect(poweredPiece.isLift).toBe(true);
        expect(poweredPiece.exitDeck).toBe(poweredPiece.entryDeck);
    });

    test('generates loop closure warnings for close but unaligned ends', () => {
        const { isCircuit, issues } = layoutTrack(['elevator', 'curveL', 'curveL', 'powered', 'curveL', 'curveL']);
        expect(isCircuit).toBe(false);
        const warning = issues.find(i => i.code === 'circuit-mismatch');
        expect(warning).toBeDefined();
        expect(warning.level).toBe('warn');
        expect(warning.msg).toContain('height is too low by');
    });
});


import { innerWidthAt } from '../js/track.js';

describe('seam widths', () => {
    // At the Standard every piece is one width, so all of this is a no-op and
    // that is the point: nothing to blend means one shape per piece type. The
    // machinery only fires for a custom build that asks for a widened turn, so
    // that is where it has to be exercised — testing it at the Standard would
    // pass on `48 === 48` and prove nothing.
    const seams = (pieces) => pieces
        .map(pc => [pc.prevIndex == null ? null : pieces.find(q => q.index === pc.prevIndex), pc])
        .filter(([a]) => a);
    const WIDE = { curveWidenMm: 3 };

    test('at the Standard the channel is one width from end to end', () => {
        for (const seq of [
            ['straight', 'curveL', 'straight'],
            ['straight', ...appendSpiralTier([], 'L'), 'straight'],
            [{ type: 'switchL', gate: 'main', main: ['straight'], branch: ['curveL'] }]
        ]) {
            for (const pc of layoutTrack(seq, {}).pieces) {
                expect(`${pc.name} ${pc.entryWidth}/${pc.innerWidth}/${pc.exitWidth}`)
                    .toBe(`${pc.name} 48/48/48`);
                for (const s of [0, 15, pc.planLen / 2, pc.planLen]) {
                    expect(innerWidthAt(pc, s)).toBeCloseTo(48, 9);
                }
            }
        }
    });

    test('a widened build still has no lateral ledge at any seam', () => {
        for (const seq of [
            ['straight', 'curveL', 'straight'],
            ['straight', 'curveL', 'curveL', 'curveL', 'curveL', 'straight'],
            ['curveR', 'straight', 'curveL'],
            [{ type: 'switchL', gate: 'main', main: ['straight'], branch: ['curveL'] }]
        ]) {
            const { pieces } = layoutTrack(seq, WIDE);
            for (const [a, b] of seams(pieces)) {
                expect(a.exitWidth).toBeCloseTo(b.entryWidth, 6);
                expect(innerWidthAt(a, a.planLen)).toBeCloseTo(innerWidthAt(b, 0), 6);
            }
        }
    });

    test('a widened curve keeps its full width through the body', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'curveL', 'straight'], WIDE);
        for (const pc of pieces) {
            if (!pc.radius) continue;
            expect(pc.innerWidth).toBe(51);
            expect(innerWidthAt(pc, pc.planLen / 2)).toBeCloseTo(pc.innerWidth, 6);
            // and the taper is monotone out from each face — no waist
            let prev = innerWidthAt(pc, 0);
            for (let s = 0; s <= pc.planLen / 2; s += 1) {
                const w = innerWidthAt(pc, s);
                expect(w).toBeGreaterThanOrEqual(prev - 1e-9);
                prev = w;
            }
        }
    });

    test('matching on the WIDER face keeps a widened curve one solid', () => {
        // the widened value is the maximum any seam can reach, so every curve
        // face takes it whatever it neighbours — which is what stops a helix
        // needing _entry/_through/_exit variants nobody can tell apart
        const { pieces } = layoutTrack(
            ['straight', ...appendSpiralTier([], 'L'), ...appendSpiralTier([], 'L'), 'straight'],
            WIDE);
        const curves = pieces.filter(pc => pc.radius);
        expect(curves.length).toBe(8);
        for (const pc of curves) {
            expect(`${pc.name} ${pc.entryWidth}/${pc.innerWidth}/${pc.exitWidth}`)
                .toBe(`${pc.name} 51/51/51`);
        }
        // ...and a lone curve between two straights is the same solid again
        const lone = layoutTrack(['straight', 'curveL', 'straight'], WIDE).pieces.find(pc => pc.radius);
        expect(lone.entryWidth).toBe(51);
        expect(lone.exitWidth).toBe(51);
    });

    test('so the flare lands on the straight, and relaxes inside it', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], WIDE);
        const [before, curve, after] = [pieces[1], pieces[2], pieces[3]];
        expect(before.exitWidth).toBeCloseTo(curve.innerWidth, 6);
        expect(after.entryWidth).toBeCloseTo(curve.innerWidth, 6);
        expect(innerWidthAt(before, 0)).toBeCloseTo(before.innerWidth, 6);
        expect(innerWidthAt(before, before.planLen)).toBeCloseTo(curve.innerWidth, 6);
        expect(innerWidthAt(before, before.planLen / 2)).toBeCloseTo(before.innerWidth, 6);
    });

    test('the wall leaves a mating face parallel to its neighbour', () => {
        // smoothstep, so the taper has zero slope at the seam: a finite
        // difference across the face must not show a kink
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], WIDE);
        const curve = pieces.find(pc => pc.radius);
        const straight = pieces[1];
        for (const [pc, s] of [[straight, straight.planLen], [curve, 0], [curve, curve.planLen]]) {
            const d = 0.5;
            const inner = s === 0 ? d : pc.planLen - d;
            const slope = Math.abs(innerWidthAt(pc, inner) - innerWidthAt(pc, s)) / d;
            expect(slope).toBeLessThan(0.01);
        }
    });
});

// ---------------------------------------------------------------------------
// The spacer: what puts a minimal piece's socket back on the grid
// ---------------------------------------------------------------------------
import { socketMouthY, spacerHeightMm, spacerVariant, supportsPillar, SPACER_VARIANTS }
    from '../js/track.js';

describe('the spacer', () => {
    const SPIRAL = ['straight', 'curveL', 'curveL', 'curveL', 'curveL',
        'curveL', 'curveL', 'curveL', 'curveL', 'straight', 'straight'];
    const LIFTS = ['straight', 'curveL', 'curveL', 'lift', 'lift', 'curveR', 'straight'];

    const chain = (seq, skirtStyle) => {
        const { pieces } = layoutTrack(seq, { skirtStyle });
        return planPillarPositions(pieces)
            .filter(s => supportsPillar(s) && needsPier(pieces[s.pieceIndex]))
            .map(s => ({ sup: s, pc: pieces[s.pieceIndex] }));
    };


    /**
     * THE WHOLE POINT. A minimal piece's socket mouth lands wherever the deck
     * happens to be, which is never a grid line — so the parts under it have
     * to add up to it anyway: riser stack (a multiple of 15) + jog + spacer.
     * If this drifts, columns stop reaching their sockets.
     */
    test.each([['spiral', SPIRAL], ['lifts', LIFTS]])(
        'every %s support composes: foot + risers + jog + spacer = the mouth', (_name, seq) => {
            const worst = [];
            for (const { sup, pc } of chain(seq, 'minimal')) {
                const stack = stackHeightMm(pc, sup);
                const dec = decomposeSupport(stack);
                expect(stack > 1 ? dec : null).not.toBe(undefined);
                if (stack > 1) expect(dec).not.toBeNull();
                const built = (dec ? STANDARD.footHeight + dec.risers.reduce((a, b) => a + b, 0) : 0)
                    + (sup.mode === 'jog' ? SPEC.jog.heightMm : 0)
                    + spacerHeightMm(pc);
                worst.push(Math.abs(built - socketMouthY(pc, sup.s)));
            }
            expect(worst.length).toBeGreaterThan(4);
            // 0.08 is the LIFT, and it is a decision: a lift's own remainder is
            // 16.6645 against a straight's 16.5888, and two spacers 0.08 apart
            // is worse than no distinguishing feature at all. Its deck sits
            // 0.08 low instead, beside a waterfall step of 0.25.
            expect(Math.max(...worst)).toBeLessThan(0.08);
        });

    /**
     * A spacer exists to make up a RECESSED seat, and only a piece that is laid
     * on its own underside has one. Platforms are level: they print rim-down,
     * their boss reaches the rim like a viaduct boss, and they take none.
     */
    test('every spacer a build asks for is one of the library variants', () => {
        const heights = new Set();
        for (const { pc } of [...chain(SPIRAL, 'minimal'), ...chain(LIFTS, 'minimal')]) {
            const h = spacerHeightMm(pc);
            if (h > 0) heights.add(h);
        }
        expect(heights.size).toBeGreaterThan(0);
        for (const h of heights) expect(spacerVariant(h)).not.toBeNull();
        // and a spacer is asked for ONLY where the seat is off the grid. Since
        // the seat snaps down onto a grid line wherever the depth allows, that
        // is now curves alone — a straight, a lift and a switch all land on a
        // line and the riser stack reaches them directly.
        for (const { pc } of chain(SPIRAL, 'minimal')) {
            expect(`${pc.type} spacer ${spacerHeightMm(pc) > 0}`)
                .toBe(`${pc.type} spacer ${!!pc.radius}`);
        }
    });

    /**
     * A grounded piece has no rim under its boss — its underside follows the
     * deck and only touches rimY at the exit boundary — so it cannot rest on
     * its own skirt. (The comparison here used to be against a grounded
     * VIADUCT piece, which could; that underside no longer exists.)
     */
    test('a grounded minimal piece still needs something under it', () => {
        // "grounded" = the lowest piece in the layout. Its rim is no longer at
        // 0 — the ground shift lifts a slab layout one grid unit so the
        // underside plane clears the floor — so find it by minimum, not by
        // rimY < 1.
        const all = chain(SPIRAL, 'minimal');
        const ground = all.reduce((a, b) => (b.pc.rimY < a.pc.rimY ? b : a));
        expect(needsPier(ground.pc)).toBe(true);
        // one grid unit for the lift plus the grid unit its seat already sat
        // up: foot + R15, still a standard stack on the grid
        const h = stackHeightMm(ground.pc, ground.sup);
        expect(h % 15).toBeCloseTo(0, 2);
        expect(h).toBeGreaterThan(0);
        expect(decomposeSupport(h)).not.toBeNull();
    });

    /**
     * An unrecognised token used to become a CURVE. `makePiece` dispatches on
     * the token with a final `else` meaning "curve", so a scene asking for
     * `platform` got a 225.6 mm curve carrying the previous piece's drop, with
     * nothing in `issues` — plausible on screen and wrong everywhere else.
     */
    test('an unrecognised piece type is reported and builds nothing', () => {
        const { pieces, issues } = layoutTrack(['start', 'straight', 'platform', 'curveR', 'end'],
            { skirtStyle: 'minimal' });
        const bad = issues.filter(i => i.code === 'unknown-piece');
        expect(bad).toHaveLength(1);
        expect(bad[0].level).toBe('error');
        expect(bad[0].msg).toContain('platform');
        // and no phantom piece: one curve was asked for, one curve exists
        expect(pieces.filter(p => /^curve/.test(p.type))).toHaveLength(1);
        expect(pieces.some(p => p.type === 'platform')).toBe(false);
    });

    test('every SEGMENT_TYPES token actually builds', () => {
        for (const kind of SEGMENT_TYPES) {
            const { pieces, issues } = layoutTrack([kind], { skirtStyle: 'minimal' });
            expect(`${kind}: ${issues.filter(i => i.code === 'unknown-piece').length}`).toBe(`${kind}: 0`);
            expect(`${kind}: built`).toBe(`${kind}: ${pieces.some(p => p.type === kind) ? 'built' : 'MISSING'}`);
        }
    });

    test('platforms and elevators keep the rim boss and take no spacer', () => {
        const { pieces } = layoutTrack(['start', 'straight', 'elevator', 'powered', 'end'],
            { skirtStyle: 'minimal' });
        for (const pc of pieces.filter(p => ['start', 'end', 'powered', 'elevator'].includes(p.type))) {
            expect(`${pc.type} mouth ${socketMouthY(pc).toFixed(2)}`).toBe(`${pc.type} mouth ${pc.rimY.toFixed(2)}`);
            expect(spacerHeightMm(pc)).toBe(0);
        }
    });
});
