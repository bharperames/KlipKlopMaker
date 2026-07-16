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
