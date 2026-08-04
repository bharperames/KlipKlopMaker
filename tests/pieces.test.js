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

describe('figure styles', () => {
    test('knight-style body is watertight and shares the physics chassis', async () => {
        const { bodySideOutline, FIGURE_STYLES } = await import('../js/geometry.js');
        expect(FIGURE_STYLES).toContain('knight');
        const { body } = buildFigureGeometries(48, { style: 'knight' });
        expectWatertight(body, 'knight figure body');
        // identical hoof cam: the last 10 outline points (cam + arch) match classic
        const classic = bodySideOutline('classic');
        const knight = bodySideOutline('knight');
        expect(knight.slice(-10)).toEqual(classic.slice(-10));
    });
});

describe('standard support parts', () => {
    test('foot and every riser size are watertight and stack to grid heights', async () => {
        const { buildSupportFootGeometry, buildRiserGeometry } = await import('../js/pieces.js');
        const { STANDARD } = await import('../js/track.js');
        expectWatertight(buildSupportFootGeometry(), 'support foot');
        for (const size of STANDARD.riserSizes) {
            expectWatertight(buildRiserGeometry(size), `riser ${size}`);
        }
    });
});

/**
 * Export meshes are decimated to SIMPLIFY_TOL_MM (see geometry.js). The bound
 * is a promise about SURFACE POSITION, so it is checked by rebuilding the same
 * part undecimated and comparing the two directly — that tests the decimation
 * itself rather than any analytic model of the washboard.
 */
describe('export decimation stays inside its error bound', () => {
    /** Topmost surface of the mesh at a given (x, z) column, or -Infinity. */
    const surfaceYAt = (mesh, x, z) => {
        const { positions: p, indices: idx } = mesh;
        let best = -Infinity;
        for (let t = 0; t < idx.length; t += 3) {
            const A = [p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]];
            const B = [p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]];
            const C = [p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]];
            const d = (B[2] - C[2]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[2] - C[2]);
            if (Math.abs(d) < 1e-12) continue;
            const a = ((B[2] - C[2]) * (x - C[0]) + (C[0] - B[0]) * (z - C[2])) / d;
            const b = ((C[2] - A[2]) * (x - C[0]) + (A[0] - C[0]) * (z - C[2])) / d;
            const c = 1 - a - b;
            if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
            best = Math.max(best, a * A[1] + b * B[1] + c * C[1]);
        }
        return best;
    };

    test('decimated surfaces stay within the tolerance of the undecimated part', async () => {
        const { SIMPLIFY_TOL_MM } = await import('../js/geometry.js');
        const { pieces } = layoutTrack(['straight'], { slopeDeg: 11.2167 });
        const pc = pieces[1];
        const lean = buildPieceExportGeometry(pc);
        const full = buildPieceExportGeometry(pc, { simplifyTol: 0 });

        expect(lean.indices.length).toBeLessThan(full.indices.length * 0.75);

        // sample across the whole deck, not just the centreline
        let worst = 0, n = 0;
        for (let s = 8; s <= pc.planLen - 8; s += 1.1) {
            for (const lat of [-18, -9, 0, 9, 18]) {
                const x = pc.entry.x + s;
                const a = surfaceYAt(full, x, lat);
                const b = surfaceYAt(lean, x, lat);
                if (!isFinite(a) || !isFinite(b)) continue;
                worst = Math.max(worst, Math.abs(a - b));
                n++;
            }
        }
        expect(n).toBeGreaterThan(400);
        expect(worst).toBeLessThanOrEqual(SIMPLIFY_TOL_MM);
    });

    test('decimation preserves volume, so no feature is lost', async () => {
        const { pieces } = layoutTrack(['straight', 'curveL'], { slopeDeg: 11.2167 });
        for (const pc of [pieces[1], pieces[2]]) {
            const lean = analyzeMesh(...Object.values({ p: buildPieceExportGeometry(pc) })
                .flatMap(m => [m.positions, m.indices]));
            const full = analyzeMesh(...Object.values({ p: buildPieceExportGeometry(pc, { simplifyTol: 0 }) })
                .flatMap(m => [m.positions, m.indices]));
            const drift = Math.abs(lean.volumeMm3 - full.volumeMm3) / full.volumeMm3;
            expect(drift).toBeLessThan(1e-3);        // < 0.1%
            expect(lean.isManifold).toBe(true);
            expect(lean.windsOutward).toBe(true);
        }
    });
});

describe('every part is ONE solid', () => {
    // analyzeMesh cannot catch this: two closed shells are still manifold,
    // consistently wound and outward-facing. The socket boss is a 12 mm cup
    // standing on the bed that reaches neither the floor nor a wall by itself,
    // so if its bulkhead ever goes missing the export silently becomes two
    // objects — a loose ring rattling around the plate.
    const componentCount = (g) => {
        const p = g.positions, ix = g.indices;
        const key = new Map(), rep = [], vid = [];
        const find = (a) => { while (rep[a] !== a) { rep[a] = rep[rep[a]]; a = rep[a]; } return a; };
        const union = (a, b) => { a = find(a); b = find(b); if (a !== b) rep[a] = b; };
        for (let i = 0; i < p.length; i += 3) {
            const k = `${p[i].toFixed(3)},${p[i + 1].toFixed(3)},${p[i + 2].toFixed(3)}`;
            if (!key.has(k)) { key.set(k, rep.length); rep.push(rep.length); }
            vid.push(key.get(k));
        }
        for (let i = 0; i < ix.length; i += 3) {
            union(vid[ix[i]], vid[ix[i + 1]]);
            union(vid[ix[i + 1]], vid[ix[i + 2]]);
        }
        return new Set([...key.values()].map(find)).size;
    };

    test('an outrigger arm lands on solid skirt, not on a window', async () => {
        // The arm sits 2 mm inboard of the wall and is 11 mm tall. If the
        // arcade opens a window under it the arm reaches into air and the
        // piece exports as two objects. A plain layout never plans an
        // outrigger — it takes a blocked column two tiers up — so the record
        // is built directly here rather than waiting for one to turn up.
        const { SPEC, planPosAt } = await import('../js/track.js');
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { slopeDeg: 11.2167 });
        for (const pc of pieces) {
            if (pc.type === 'start' || pc.type === 'end') continue;
            for (const f of [0.35, 0.5, 0.65]) {
                const s = f * pc.planLen;
                const at = planPosAt(pc, s);
                const side = pc.turn > 0 ? 1 : -1;
                const off = (pc.innerWidth / 2 + SPEC.wall + SPEC.socket.bossR + 4) * side;
                const support = {
                    pieceIndex: pc.index, mode: 'outrigger', side, s, h: at.h,
                    x: at.x + Math.sin(at.h) * off, z: at.z - Math.cos(at.h) * off
                };
                const g = buildPieceExportGeometry(pc, { support });
                expect(`${pc.name}@${f}: ${componentCount(g)} shell(s)`)
                    .toBe(`${pc.name}@${f}: 1 shell(s)`);
            }
        }
    });

    test('no track piece exports as two disconnected shells', async () => {
        const { planPillarPositions } = await import('../js/track.js');
        const { pieces } = layoutTrack(
            ['straight', 'curveL', 'curveL', 'curveL', 'straight', 'lift', 'straight'],
            { slopeDeg: 11.2167 });
        const supports = planPillarPositions(pieces);
        for (const pc of pieces) {
            if (pc.role === 'branch') continue;
            const g = buildPieceExportGeometry(pc, { support: supports.find(s => s.pieceIndex === pc.index) });
            expect(`${pc.name}: ${componentCount(g)} shell(s)`).toBe(`${pc.name}: 1 shell(s)`);
        }
    });
});

describe('mating faces line up', () => {
    // The width taper is only worth anything if it survives to the mesh, so
    // measure the widest point of the actual export solid at each face.
    test('no lateral step at any seam of a straight/curve/straight run', async () => {
        const { planPillarPositions } = await import('../js/track.js');
        const { pieces } = layoutTrack(
            ['straight', 'curveL', 'curveL', 'straight', 'curveR', 'straight'],
            { slopeDeg: 11.2167 });
        const supports = planPillarPositions(pieces);
        const mesh = new Map();
        for (const pc of pieces) {
            if (pc.role === 'branch') continue;
            mesh.set(pc.index, buildPieceExportGeometry(pc, { support: supports.find(s => s.pieceIndex === pc.index) }));
        }
        /** Widest outer half-width within 0.6 mm inboard of a face plane. */
        const faceHalfWidth = (g, face, inward) => {
            const dir = [Math.cos(face.h), Math.sin(face.h)];
            const right = [Math.sin(face.h), -Math.cos(face.h)];
            let w = 0;
            for (let i = 0; i < g.positions.length; i += 3) {
                const dx = g.positions[i] - face.x, dz = g.positions[i + 2] - face.z;
                const along = (dx * dir[0] + dz * dir[1]) * inward;
                if (along < -0.05 || along > 0.6) continue;
                w = Math.max(w, Math.abs(dx * right[0] + dz * right[1]));
            }
            return w;
        };
        let checked = 0;
        for (const pc of pieces) {
            if (pc.prevIndex == null || pc.role === 'branch') continue;
            const prev = pieces.find(q => q.index === pc.prevIndex);
            if (!prev || prev.role === 'branch') continue;
            const up = faceHalfWidth(mesh.get(prev.index), { x: prev.exit.x, z: prev.exit.z, h: prev.exit.h }, -1);
            const down = faceHalfWidth(mesh.get(pc.index), { x: pc.entry.x, z: pc.entry.z, h: pc.entry.h }, +1);
            expect(Math.abs(down - up)).toBeLessThan(0.02);
            checked++;
        }
        expect(checked).toBeGreaterThan(4);
    });
});

describe('bowtie pocket detent retains the key', () => {
    test('the detent is a ledge around the pocket, not a plug', async () => {
        const { SPEC } = await import('../js/track.js');
        const { computeMeshVolumeMm3 } = await import('../js/mesh_utils.js');
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11.2167 });
        const pc = pieces[1];
        const vol = () => {
            const g = buildPieceExportGeometry(pc);
            return computeMeshVolumeMm3(g.positions, g.indices);
        };
        const on = vol();
        const keep = SPEC.key.detentProud;
        SPEC.key.detentProud = 0;
        const off = vol();
        SPEC.key.detentProud = keep;

        const added = on - off;
        expect(added).toBeGreaterThan(5);      // it exists at all
        // A ledge is a thin ring. Filling the pocket section instead would add
        // roughly pocketArea * detentTall * 2 faces — hundreds of mm3.
        const pocketArea = (SPEC.key.neckHalf + SPEC.key.tipHalf) * SPEC.key.depth;
        expect(added).toBeLessThan(pocketArea * SPEC.key.detentTall * 2 * 0.25);
        expectWatertight(buildPieceExportGeometry(pc), 'piece with detent');
    });
});
