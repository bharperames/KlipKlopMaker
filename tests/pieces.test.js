/**
 * The money tests: every printable part the app exports — after all CSG
 * operations — must be a watertight, consistently wound solid.
 */
import { jest } from '@jest/globals';
import { layoutTrack } from '../js/track.js';
import {
    initCSG, buildPieceExportGeometry, buildPieceDisplayGeometry,
    buildSwitchExportGeometry, buildSwitchDisplayGeometry,
    buildPillarGeometry, buildFigureGeometries, buildKeyGeometry, buildGateGeometry,
    buildTowerGeometry, buildPalmIslandGeometries, buildPatioGeometry
} from '../js/pieces.js';
import { analyzeMesh, verifyManifold, buildTopologyFromIndices, deduplicateGeometry } from '../js/mesh_utils.js';

beforeAll(async () => { await initCSG(); });

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

/**
 * Print-friendliness: with the piece resting rim-down on the bed, no solid
 * material may float in mid-air. The bowtie joint system keeps every feature
 * either on the bed or attached above bed-supported walls, and nothing may
 * protrude beyond the end faces (the old cantilevered tab did).
 */
const expectNoFloatingProtrusion = (g, piece, label) => {
    const { positions } = g.positions ? g : { positions: g.attributes.position.array };
    // all geometry stays within the swept footprint: nothing pokes past the
    // entry/exit faces by more than a hair (ribs/pockets are internal)
    const dirIn = [Math.cos(piece.entry.h), Math.sin(piece.entry.h)];
    const dirOut = [Math.cos(piece.exit.h), Math.sin(piece.exit.h)];
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], z = positions[i + 2];
        const beforeEntry = (x - piece.entry.x) * dirIn[0] + (z - piece.entry.z) * dirIn[1];
        const pastExit = (x - piece.exit.x) * dirOut[0] + (z - piece.exit.z) * dirOut[1];
        if (beforeEntry < -0.6 || pastExit > 0.6) {
            throw new Error(`${label}: vertex protrudes past an end face (cantilever risk): entry=${beforeEntry.toFixed(2)} exit=${pastExit.toFixed(2)}`);
        }
    }
};

describe('exported track pieces survive CSG watertight and stay inside their footprint', () => {
    const { pieces } = layoutTrack(['straight', 'curveL', 'lift'], { slopeDeg: 11, curveRadius: 150 });

    test('start platform', () => {
        const g = buildPieceExportGeometry(pieces[0]);
        expectWatertight(g, 'start platform');
    });

    test('straight ramp with washboard, end ribs + bowtie pockets, boss/socket', () => {
        const pc = pieces.find(p => p.type === 'straight');
        const g = buildPieceExportGeometry(pc);
        expectWatertight(g, 'straight ramp');
        expectNoFloatingProtrusion(g, pc, 'straight ramp');
    });

    test('helical curve with washboard and joints', () => {
        const pc = pieces.find(p => p.type === 'curveL');
        const g = buildPieceExportGeometry(pc);
        expectWatertight(g, 'curve');
        expectNoFloatingProtrusion(g, pc, 'curve');
    });

    test('powered lift section (ascending channel)', () => {
        const pc = pieces.find(p => p.isLift);
        expect(pc.exitDeck).toBeGreaterThan(pc.entryDeck);
        const g = buildPieceExportGeometry(pc);
        expectWatertight(g, 'lift');
        expectNoFloatingProtrusion(g, pc, 'lift');
    });

    test('end platform', () => {
        const g = buildPieceExportGeometry(pieces.at(-1));
        expectWatertight(g, 'end platform');
    });
});

describe('switch parts', () => {
    const { pieces } = layoutTrack(
        [{ type: 'switchL', gate: 'main', main: ['straight'], branch: ['straight'] }],
        { slopeDeg: 11, curveRadius: 150 }
    );
    const main = pieces.find(p => p.role === 'main');
    const branch = pieces.find(p => p.role === 'branch');

    test('layout emits two role pieces sharing entry and rim plane', () => {
        expect(main.entry).toEqual(branch.entry);
        expect(main.entryDeck).toBe(branch.entryDeck);
        expect(main.rimY).toBe(branch.rimY);
        expect(Math.abs(branch.turn)).toBeCloseTo(Math.PI / 2, 9);
    });

    test('merged switch export (union + 3 joints + gate bore) is watertight', () => {
        const g = buildSwitchExportGeometry(main, branch);
        expectWatertight(g, 'switch part');
    });

    test('switch display union builds', () => {
        const g = buildSwitchDisplayGeometry(main, branch);
        expect(g.attributes.position.count).toBeGreaterThan(100);
    });

    test('gate paddle is watertight', () => {
        expectWatertight(buildGateGeometry(), 'gate paddle');
    });
});

describe('connector key (Hot-Wheels-style bowtie)', () => {
    test('key is watertight and smaller than its pockets by the clearance', () => {
        const g = buildKeyGeometry();
        const r = expectWatertight(g, 'connector key');
        expect(r.volumeMm3).toBeGreaterThan(500);
        // key height must clear the 6 mm pocket band
        let maxY = -Infinity;
        for (let i = 1; i < g.positions.length; i += 3) maxY = Math.max(maxY, g.positions[i]);
        expect(maxY).toBeLessThan(6);
    });
});

describe('support pillar & interlocking scenery', () => {
    test('stacked hex pillar is watertight at several heights', () => {
        for (const h of [20, 87.3, 250]) {
            expectWatertight(buildPillarGeometry(h), `pillar h=${h}`);
        }
    });

    test('tower (top tenon + bottom stacking socket) is watertight', () => {
        expectWatertight(buildTowerGeometry(100), 'tower');
    });

    test('palm island plate and palm tree are watertight', () => {
        const { island, palm } = buildPalmIslandGeometries();
        expectWatertight(island, 'palm island');
        expectWatertight(palm, 'palm tree');
    });

    test('patio with rails and corner sockets is watertight', () => {
        expectWatertight(buildPatioGeometry(), 'patio');
    });
});

describe('walker figure parts', () => {
    test('body, pendulum and plug set are watertight after CSG', () => {
        const { body, pendulum, plugSet } = buildFigureGeometries(48);
        expectWatertight(body, 'figure body');
        expectWatertight(pendulum, 'figure pendulum');
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
