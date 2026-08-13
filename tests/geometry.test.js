import {
    signedArea2D, earClipTriangulate, sweepSolid, extrudePolygonY, extrudeOutlineX,
    channelProfile, pieceProfiles, bowtieKeyPlan, bowtiePocketPlan, hexPlan,
    circlePlan, bodySideOutline, pendulumSideOutline, figureVolumeEstimate
} from '../js/geometry.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { layoutTrack, stationsForPiece, SPEC } from '../js/track.js';

const triArea = (pts, [a, b, c]) => Math.abs(
    (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) -
    (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1])
) / 2;

describe('earClipTriangulate', () => {
    test('square → 2 triangles covering the full area', () => {
        const pts = [[0, 0], [2, 0], [2, 2], [0, 2]];
        const tris = earClipTriangulate(pts);
        expect(tris).toHaveLength(2);
        const area = tris.reduce((s, t) => s + triArea(pts, t), 0);
        expect(area).toBeCloseTo(4, 9);
    });

    test('concave polygon area is preserved regardless of input winding', () => {
        const concave = [[0, 0], [4, 0], [4, 3], [2, 3], [2, 1], [0, 1]];
        for (const pts of [concave, [...concave].reverse()]) {
            const tris = earClipTriangulate(pts);
            expect(tris).toHaveLength(pts.length - 2);
            const area = tris.reduce((s, t) => s + triArea(pts, t), 0);
            expect(area).toBeCloseTo(Math.abs(signedArea2D(pts)), 9);
        }
    });

    test('channel profile (the real staple shape) triangulates completely', () => {
        const pts = channelProfile({
            innerWidth: 48, wall: 2.4, railH: 14, floorThk: 2,
            deckY: 0, rimY: -12, ridge: 0.3
        });
        const tris = earClipTriangulate(pts);
        expect(tris).toHaveLength(pts.length - 2);
        const area = tris.reduce((s, t) => s + triArea(pts, t), 0);
        expect(area).toBeCloseTo(Math.abs(signedArea2D(pts)), 6);
    });
});

describe('primitive solids', () => {
    test('extrudePolygonY of a unit square is a watertight 1 mm³ cube', () => {
        const mesh = extrudePolygonY([[0, 0], [1, 0], [1, 1], [0, 1]], 0, 1);
        const r = analyzeMesh(mesh.positions, mesh.indices);
        expect(r.isManifold).toBe(true);
        expect(r.isConsistent).toBe(true);
        expect(r.windsOutward).toBe(true);
        expect(r.volumeMm3).toBeCloseTo(1, 9);
    });

    test('hex, bowtie and circle prisms are watertight with correct volume', () => {
        for (const plan of [hexPlan(9), bowtieKeyPlan({}), bowtiePocketPlan({}), circlePlan(5, 16)]) {
            const mesh = extrudePolygonY(plan, 0, 10);
            const r = analyzeMesh(mesh.positions, mesh.indices);
            expect(r.isManifold).toBe(true);
            expect(r.isConsistent).toBe(true);
            expect(r.windsOutward).toBe(true);
            expect(r.volumeMm3).toBeCloseTo(Math.abs(signedArea2D(plan)) * 10, 2);
        }
    });

    test('figure silhouettes extrude to watertight solids', () => {
        for (const outline of [bodySideOutline(), pendulumSideOutline()]) {
            const mesh = extrudeOutlineX(outline, -4, 4);
            const r = analyzeMesh(mesh.positions, mesh.indices);
            expect(r.isManifold).toBe(true);
            expect(r.isConsistent).toBe(true);
            expect(r.windsOutward).toBe(true);
            expect(r.volumeMm3).toBeGreaterThan(0);
        }
    });
});

describe('swept channel shells', () => {
    const buildShell = (piece, withRidges) => {
        const stations = stationsForPiece(piece, withRidges ? piece.ridgePitch / 6 : 10);
        const profiles = pieceProfiles(piece, stations, SPEC, withRidges);
        return sweepSolid(profiles, stations);
    };

    test('straight ramp shell (with washboard) is watertight and outward-wound', () => {
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 11 });
        const mesh = buildShell(pieces[1], true);
        const r = analyzeMesh(mesh.positions, mesh.indices);
        expect(r.isManifold).toBe(true);
        expect(r.isConsistent).toBe(true);
        expect(r.windsOutward).toBe(true);
        expect(r.volumeMm3).toBeGreaterThan(10000);
    });

    test('helical curve shell is watertight and never banks', () => {
        const { pieces } = layoutTrack(['curveL'], { slopeDeg: 12, curveRadius: 150 });
        const mesh = buildShell(pieces[1], true);
        const r = analyzeMesh(mesh.positions, mesh.indices);
        expect(r.isManifold).toBe(true);
        expect(r.isConsistent).toBe(true);
        expect(r.windsOutward).toBe(true);
    });

    test('rail crests are level across the channel (zero bank) on a curve', () => {
        const { pieces } = layoutTrack(['curveR'], { slopeDeg: 12 });
        const piece = pieces[1];
        const stations = stationsForPiece(piece, 20);
        const profiles = pieceProfiles(piece, stations, SPEC, false);
        const mesh = sweepSolid(profiles, stations);
        // For every sweep ring, exactly four vertices form the rail crests and
        // they must all sit at origin.y + railH — level across the channel.
        const K = profiles[0].length;
        const railTop = Math.max(...profiles[0].map(p => p[1]));
        for (let ring = 0; ring < stations.length; ring++) {
            const expected = stations[ring].origin[1] + railTop;
            let atCrest = 0;
            for (let k = 0; k < K; k++) {
                const y = mesh.positions[(ring * K + k) * 3 + 1];
                expect(y).toBeLessThanOrEqual(expected + 1e-4);
                if (Math.abs(y - expected) < 1e-4) atCrest++;
            }
            expect(atCrest).toBe(4);
        }
    });

    test('seam faces mate: exit profile of piece N matches entry profile of N+1 with only the waterfall offset', () => {
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11 });
        const [a, b] = [pieces[1], pieces[2]];
        const stA = stationsForPiece(a, 10);
        const stB = stationsForPiece(b, 10);
        const profA = pieceProfiles(a, stA, SPEC, true).at(-1);
        const profB = pieceProfiles(b, stB, SPEC, true)[0];
        // identical u coordinates, deck-relative shape identical above the floor
        for (let k = 0; k < profA.length; k++) {
            expect(profA[k][0]).toBeCloseTo(profB[k][0], 6);
        }
        // world deck heights: downhill entry is exactly waterfall lower
        expect(stA.at(-1).origin[1] - stB[0].origin[1]).toBeCloseTo(SPEC.waterfallStepMm, 9);
        // washboard seam rule: both faces sit in a ridge valley (offset 0)
        const railTopA = Math.max(...profA.map(p => p[1]));
        const railTopB = Math.max(...profB.map(p => p[1]));
        expect(railTopA).toBeCloseTo(SPEC.railHeight, 6);
        expect(railTopB).toBeCloseTo(SPEC.railHeight, 6);
    });
});

describe('figure volume estimate', () => {
    test('is in a plausible range for ballast planning', () => {
        const vol = figureVolumeEstimate(44);
        expect(vol).toBeGreaterThan(20000);  // > 20 cm³
        expect(vol).toBeLessThan(120000);    // < 120 cm³
    });
});

describe('facet tolerance', () => {
    test('tolerance-driven circle tessellation keeps sagitta under 0.1 mm', async () => {
        const { segmentsForCircle } = await import('../js/geometry.js');
        for (const r of [1.65, 4, 9.5, 15, 30, 150]) {
            const n = segmentsForCircle(r);
            const sagitta = r * (1 - Math.cos(Math.PI / n));
            expect(sagitta).toBeLessThanOrEqual(0.1 + 1e-9);
            expect(n).toBeLessThanOrEqual(96);
        }
    });

    test('curve-piece sweep stations keep chord error under 0.25 mm at export resolution', () => {
        const { pieces } = layoutTrack(['curveL'], { curveRadius: 150 });
        const pc = pieces[1];
        const step = pc.ridgePitch / 6;
        const sagitta = pc.radius * (1 - Math.cos(step / pc.radius / 2));
        expect(sagitta).toBeLessThan(0.001);
    });
});

describe('washboard station rate', () => {
    test('samples land on crest and valley, so ridge height is exact', async () => {
        const { ridgeStationSpacing, FACET_TOL_MM } = await import('../js/geometry.js');
        const { SPEC, ridgeOffset } = await import('../js/track.js');
        const h = SPEC.ridge.height, pitch = 2.5;
        const step = ridgeStationSpacing(h / 2, pitch);

        // an EVEN whole number of samples per ridge is what guarantees a
        // station at s=0 (valley) and s=pitch/2 (crest) for every ridge
        const perRidge = pitch / step;
        expect(Math.abs(perRidge - Math.round(perRidge))).toBeLessThan(1e-9);
        expect(Math.round(perRidge) % 2).toBe(0);
        expect(Math.round(perRidge)).toBeGreaterThanOrEqual(4);

        // sampling at that rate must reproduce the full peak-to-valley
        const ys = [];
        for (let s = 0; s <= pitch * 4 + 1e-9; s += step) ys.push(ridgeOffset(s, pitch, h));
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(h, 6);

        // and it must be no stricter than the facet tolerance the rest of the
        // geometry already accepts
        const chordErr = (step * step / 8) * (h / 2) * Math.pow((2 * Math.PI) / pitch, 2);
        expect(chordErr).toBeLessThanOrEqual(FACET_TOL_MM);
    });
});

describe('skirt arch windows print without support', () => {
    test('no unsupported run of crown exceeds the bridge limit', async () => {
        // The arch is a circle springing vertically off a pier, so it carries
        // itself until sqrt(2)/2 of the way up. Past that — and across any flat
        // the deck clips into it — the crown is a bridge, and what matters is
        // that no single bridged run gets too long. (The old rule here said no
        // tangent may be shallower than 45 deg at all, which outlaws every real
        // arch: a crown is horizontal by definition.)
        const { archedRimY, ARCH } = await import('../js/geometry.js');
        const { SPEC, layoutTrack, planPillarPositions } = await import('../js/track.js');
        for (const seq of [
            ['straight', 'curveL', 'straight'],
            ['straight', 'curveL', 'curveL', 'curveL', 'straight'],
            ['lift', 'straight', 'curveR']
        ]) {
            // THE ARCADE IS A VIADUCT FEATURE, so this pins the style rather than
            // riding the default. `minimal` is the default underside now and has
            // no arches at all, which made these three assert against a flat rim.
            const { pieces } = layoutTrack(seq, { slopeDeg: 11.2167, skirtStyle: 'viaduct' });
            const supports = planPillarPositions(pieces);
            for (const pc of pieces) {
                const sup = supports.find(s => s.pieceIndex === pc.index);
                const pads = sup && sup.mode !== 'none' ? [sup.s] : [];
                const forced = sup && sup.mode === 'outrigger' ? sup.s : null;
                const N = 3000, d = pc.planLen / N;
                let prev = archedRimY(pc, 0, SPEC, pads, forced), run = 0, worst = 0;
                for (let k = 1; k <= N; k++) {
                    const y = archedRimY(pc, k * d, SPEC, pads, forced);
                    const shallow = Math.abs(y - prev) / d < 1 && y > pc.rimY + 0.05;
                    run = shallow ? run + d : 0;
                    worst = Math.max(worst, run);
                    prev = y;
                }
                expect(`${pc.name} longest bridged run ${worst.toFixed(0)} mm`)
                    .toBe(`${pc.name} longest bridged run ${Math.min(worst, ARCH.maxBridge).toFixed(0)} mm`);
            }
        }
    });

    test('the arch soffit stays inside the printable envelope', async () => {
        // Two independent limits, and satisfying only one is what made the
        // slicer's "floating cantilever" so hard to pin down:
        //
        //   overhang   how far a layer may overstep the one below. The
        //              three-centred arch reached 75.6 deg from vertical and
        //              was rejected; the shape before it held 58.6 and passed.
        //   flat span  what has NOT closed by the crown is bridged in one
        //              layer. 47.6 mm passed, 51.9 mm was rejected — so the
        //              bound here is a measured edge, not a safe margin.
        //
        // Bisected on solo plates against Bambu Studio (a packed plate mis-
        // attributes the warning and caches the verdict across deletes, so
        // every packed-plate reading proved worthless). Confirmed by a hybrid
        // build that swapped ONLY this function and went clean.
        const { archedRimY } = await import('../js/geometry.js');
        const { SPEC, layoutTrack, planPillarPositions } = await import('../js/track.js');
        for (const seq of [
            ['straight', 'straight', 'straight'],
            ['straight', 'curveL', 'straight'],
            ['straight', 'curveL', 'curveL', 'curveL', 'straight'],
            ['lift', 'straight', 'curveR']
        ]) {
            // THE ARCADE IS A VIADUCT FEATURE, so this pins the style rather than
            // riding the default. `minimal` is the default underside now and has
            // no arches at all, which made these three assert against a flat rim.
            const { pieces } = layoutTrack(seq, { slopeDeg: 11.2167, skirtStyle: 'viaduct' });
            const supports = planPillarPositions(pieces);
            for (const pc of pieces) {
                const sup = supports.find(s => s.pieceIndex === pc.index);
                const pads = sup && sup.mode !== 'none' ? [sup.s] : [];
                const forced = sup && sup.mode === 'outrigger' ? sup.s : null;
                const N = 4000, d = pc.planLen / N;
                const ys = [];
                for (let k = 0; k <= N; k++) ys.push(archedRimY(pc, k * d, SPEC, pads, forced));
                // each raised run is one window
                const runs = [];
                let cur = null;
                for (let k = 0; k <= N; k++) {
                    if (ys[k] > pc.rimY + 0.05) cur = cur ? (cur.b = k, cur) : { a: k, b: k };
                    else if (cur) { runs.push(cur); cur = null; }
                }
                if (cur) runs.push(cur);
                for (const r of runs) {
                    let top = -Infinity, ti = r.a;
                    for (let k = r.a; k <= r.b; k++) if (ys[k] > top) { top = ys[k]; ti = k; }
                    // walk the left limb by height and measure the lean
                    const pts = [];
                    for (let h = 0.4; h <= top - pc.rimY; h += 0.4) {
                        for (let k = r.a; k <= ti; k++) {
                            if (ys[k] - pc.rimY >= h) { pts.push([h, k * d]); break; }
                        }
                    }
                    let lean = 0;
                    for (let i = 1; i < pts.length - 3; i++) {
                        const dh = pts[i][0] - pts[i - 1][0];
                        const dx = Math.abs(pts[i][1] - pts[i - 1][1]);
                        lean = Math.max(lean, Math.atan2(dx, dh) * 180 / Math.PI);
                    }
                    let lo = null, hi = null;
                    for (let k = r.a; k <= r.b; k++) if (ys[k] > top - 0.2) { if (lo === null) lo = k; hi = k; }
                    const span = (hi - lo) * d;
                    expect(`${pc.name} lean ${lean.toFixed(0)} span ${span.toFixed(0)}`).toBe(
                        `${pc.name} lean ${Math.min(lean, 58).toFixed(0)} span ${Math.min(span, 48).toFixed(0)}`);
                }
            }
        }
    });

    test('a window never cuts into the floor it is under', async () => {
        // The cap is one number for a whole window, so it has to clear the
        // LOWEST deck over that window. Taken at the window centre instead,
        // the downhill end of a long window put its ceiling above the local
        // floor underside: the skirt wall there is gone, and channelProfile
        // handed a rim above its own ceiling folds inside out.
        const { archedRimY, ARCH } = await import('../js/geometry.js');
        const { SPEC, layoutTrack, deckYAt, planPillarPositions } = await import('../js/track.js');
        for (const seq of [
            ['straight', 'curveL', 'straight'],
            ['straight', 'straight', 'curveL', 'curveL', 'straight'],
            ['lift', 'straight', 'curveR']
        ]) {
            // THE ARCADE IS A VIADUCT FEATURE, so this pins the style rather than
            // riding the default. `minimal` is the default underside now and has
            // no arches at all, which made these three assert against a flat rim.
            const { pieces } = layoutTrack(seq, { slopeDeg: 11.2167, skirtStyle: 'viaduct' });
            const supports = planPillarPositions(pieces);
            for (const pc of pieces) {
                const sup = supports.find(s => s.pieceIndex === pc.index);
                const pads = sup && sup.mode !== 'none' ? [sup.s] : [];
                for (let s = 0; s <= pc.planLen; s += 0.5) {
                    const headroom = deckYAt(pc, s) - archedRimY(pc, s, SPEC, pads);
                    // rim must stay at least `band` below the deck line, which
                    // keeps the full floor plus a lintel above every opening
                    expect(`${pc.name}@${s.toFixed(0)} headroom ${headroom.toFixed(2)}`)
                        .toBe(`${pc.name}@${s.toFixed(0)} headroom ${Math.max(headroom, ARCH.band - 0.01).toFixed(2)}`);
                }
            }
        }
    });

    test('every interior boundary is a pier of the full width, on the bed', async () => {
        // The skirt is piers and arches and nothing else — no mullions, no
        // bulkheads, no internal webs. Each interior boundary must put the rim
        // on the bed for the full pier width.
        const { archedRimY, windowBounds, ARCH } = await import('../js/geometry.js');
        const { SPEC, layoutTrack } = await import('../js/track.js');
        // pins the style for the same reason as the two tests above — piers and
        // arches only exist on a viaduct underside
        const { pieces } = layoutTrack(['straight', 'curveL', 'curveL', 'straight'],
            { slopeDeg: 11.2167, skirtStyle: 'viaduct' });
        for (const pc of pieces) {
            const pads = [pc.planLen / 2];
            const bounds = windowBounds(pc, SPEC, pads);
            for (let i = 1; i + 1 < bounds.length; i++) {
                for (const off of [-ARCH.pier / 2 + 0.2, 0, ARCH.pier / 2 - 0.2]) {
                    expect(`pier@${bounds[i].toFixed(0)}${off.toFixed(1)}: ${(archedRimY(pc, bounds[i] + off, SPEC, pads) - pc.rimY).toFixed(2)}`)
                        .toBe(`pier@${bounds[i].toFixed(0)}${off.toFixed(1)}: 0.00`);
                }
            }
        }
    });

    test('an arch actually opens', async () => {
        const { archedRimY } = await import('../js/geometry.js');
        const { SPEC, layoutTrack } = await import('../js/track.js');
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 11.2167 });
        const pc = pieces[1];
        let peak = 0;
        for (let s = 0; s <= pc.planLen; s += 0.25) {
            peak = Math.max(peak, archedRimY(pc, s, SPEC, [pc.planLen / 2]) - pc.rimY);
        }
        expect(peak).toBeGreaterThan(5);
    });
});

describe('bowtie pocket fits the key', () => {
    test('clearance is uniform along the whole engagement', async () => {
        const { bowtiePocketPlan, bowtieKeyPlan } = await import('../js/geometry.js');
        const { SPEC } = await import('../js/track.js');
        const K = SPEC.key, c = SPEC.jointClearanceMm;
        const poc = bowtiePocketPlan({ neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth, clearance: c });
        const keyX = z => K.neckHalf + ((K.tipHalf - K.neckHalf) / K.depth) * z;

        // pocket right wall, from its two right-hand vertices
        const [z0, x0] = [poc[1][1], poc[1][0]];
        const [z1, x1] = [poc[2][1], poc[2][0]];
        const wall = z => x0 + ((x1 - x0) / (z1 - z0)) * (z - z0);

        // The wall must be PARALLEL to the key flank. A mismatched slope binds
        // at one end and gapes at the other, which is what it used to do:
        // 0.153 mm at the tips (tighter than the proven 0.20) and 0.666 at the
        // neck. Sampling both ends is not enough — check across the engagement.
        for (let z = 0; z <= K.depth + 1e-9; z += 0.5) {
            expect(wall(z) - keyX(z)).toBeCloseTo(c, 6);
        }
        // and the key's tip must still clear the pocket's far end
        expect(z1).toBeGreaterThan(K.depth);
    });

    test('the key cannot be pulled straight out of the pocket', async () => {
        const { bowtiePocketPlan } = await import('../js/geometry.js');
        const { SPEC } = await import('../js/track.js');
        const K = SPEC.key;
        const poc = bowtiePocketPlan({ neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth, clearance: SPEC.jointClearanceMm });
        const mouthHalf = poc[1][0];
        // the whole point of a bowtie: the tip is wider than the mouth it would
        // have to pass through, so the joint locks in tension along the track
        expect(K.tipHalf).toBeGreaterThan(mouthHalf);
    });
});

describe('channel profile stays a simple polygon', () => {
    // A degenerate or self-intersecting profile cannot be ear-clipped, and the
    // end cap comes out as a triangle spanning the whole channel — a visible
    // flap at every seam. The rail-crest chamfers eat into the wall from both
    // sides, so this bites as soon as wall <= 2*cr.
    test('no zero-length or crossing edges at any wall thickness', async () => {
        const { channelProfile } = await import('../js/geometry.js');
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const properIntersect = (p1, p2, p3, p4) => {
            const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
            const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
            return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
                   ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
        };
        for (const wall of [3.0, 2.4, 2.0, 1.6, 1.2, 0.8]) {
            const pts = channelProfile({
                innerWidth: 48, wall, railH: 14, floorThk: 2,
                filletR: 2, deckY: 0, rimY: -12
            });
            const n = pts.length;
            for (let i = 0; i < n; i++) {
                const a = pts[i], b = pts[(i + 1) % n];
                expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1e-6);
            }
            for (let i = 0; i < n; i++) {
                for (let j = i + 2; j < n; j++) {
                    if (i === 0 && j === n - 1) continue;   // adjacent, shares a vertex
                    expect(properIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
                        .toBe(false);
                }
            }
        }
    });
});
