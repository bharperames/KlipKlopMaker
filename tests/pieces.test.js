/**
 * The money tests: every printable part the app exports — after all CSG
 * operations — must be a watertight, consistently wound solid.
 */
import { layoutTrack } from '../js/track.js';
import {
    initCSG, buildPieceExportGeometry, buildPieceDisplayGeometry,
    buildPillarGeometry, buildFigureGeometries
} from '../js/pieces.js';

beforeAll(async () => { await initCSG(); });
import { jest } from '@jest/globals';
import { analyzeMesh, verifyManifold, buildTopologyFromIndices, deduplicateGeometry } from '../js/mesh_utils.js';

jest.setTimeout(180000);

const analyzeGeometry = (g) => {
    if (g.positions) return analyzeMesh(g.positions, g.indices);
    const pos = g.attributes.position.array;
    const idx = g.index ? g.index.array : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
    return analyzeMesh(pos, idx);
};

const expectWatertight = (g, label) => {
    const r = analyzeGeometry(g);
    if (!r.isManifold || !r.isConsistent || !r.windsOutward) {
        throw new Error(`${label} not watertight: openEdges=${r.openEdges} nonManifold=${r.nonManifoldEdges} consistent=${r.isConsistent} outward=${r.windsOutward}`);
    }
    expect(r.volumeMm3).toBeGreaterThan(100);
    return r;
};

describe('exported track pieces survive CSG watertight', () => {
    const { pieces } = layoutTrack(['straight', 'curveL'], { slopeDeg: 11, curveRadius: 150 });

    test('start platform (bumper + receiver-free + boss/socket)', () => {
        const g = buildPieceExportGeometry(pieces[0], { isFirst: true, isLast: false });
        expectWatertight(g, 'start platform');
    });

    test('straight ramp with washboard, dovetail tab + receiver, boss/socket', () => {
        const g = buildPieceExportGeometry(pieces[1], { isFirst: false, isLast: false });
        expectWatertight(g, 'straight ramp');
    });

    test('helical curve with washboard and joints', () => {
        const g = buildPieceExportGeometry(pieces[2], { isFirst: false, isLast: false });
        expectWatertight(g, 'curve');
    });

    test('end platform (receiver, no tab)', () => {
        const g = buildPieceExportGeometry(pieces[3], { isFirst: false, isLast: true });
        expectWatertight(g, 'end platform');
    });
});

describe('support pillar', () => {
    test('stacked hex pillar is watertight at several heights', () => {
        for (const h of [20, 87.3, 250]) {
            expectWatertight(buildPillarGeometry(h), `pillar h=${h}`);
        }
    });
});

describe('walker figure parts', () => {
    test('body, pendulum and plug set are watertight after CSG', () => {
        const { body, pendulum, plugSet } = buildFigureGeometries(48);
        expectWatertight(body, 'figure body');
        expectWatertight(pendulum, 'figure pendulum');
        // plug set is a multi-shell plate: manifold + consistent, per-shell closed
        const { remappedIndices } = deduplicateGeometry(plugSet.positions, plugSet.indices);
        const m = verifyManifold(buildTopologyFromIndices(remappedIndices));
        expect(m.isManifold).toBe(true);
    });

    test('display geometry builds without CSG for the scene', () => {
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 11 });
        const g = buildPieceDisplayGeometry(pieces[1]);
        expect(g.attributes.position.count).toBeGreaterThan(50);
    });
});
