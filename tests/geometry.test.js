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

/*
 * THE ARCH WINDOW TESTS ARE GONE WITH THE ARCADE THEY GUARDED.
 *
 * They checked a viaduct skirt's three-centred arches: crown bridge length,
 * soffit overhang angle, and that every interior boundary was a full-width
 * pier standing on the bed. All three were sound tests of a thing that no
 * longer exists. `viaduct` was never a style anyone chose for how it looked —
 * it was an attempt at the under-deck problem that the cavity fill has since
 * solved properly, and it audited far worse than what it competed with: 56 mm
 * worst unsupported span on a straight and 66 on a curve, against 10 and 10
 * filled.
 *
 * What replaced them is not a like-for-like test but a better one:
 * `tests/pieces.test.js` gates EVERY minimal piece at no unsupported span over
 * 20 mm, measured from the mesh by scripts/overhang_audit.mjs, and that gate is
 * known to reject.
 */


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
