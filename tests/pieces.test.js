/**
 * The money tests: every printable part the app exports — after all CSG
 * operations — must be a watertight, consistently wound solid.
 */
import { jest } from '@jest/globals';
import { layoutTrack, pieceInFrame, SPEC, GEOMETRY_VERSION, innerWidthAt, deckYAt, planPosAt } from '../js/track.js';
import { partCode, pieceCode } from '../js/engrave.js';
import * as pieceBuilders from '../js/pieces.js';
import {
    initCSG, buildPieceExportGeometry, buildPieceDisplayGeometry,
    buildSwitchExportGeometry, buildSwitchDisplayGeometry,
    buildPillarGeometry, buildFigureGeometries, buildKeyGeometry, buildGateGeometry,
    buildTowerGeometry, buildPalmIslandGeometries, buildPatioGeometry,
    engraveOps, engravePoint
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
const expectNoFloatingProtrusion = (g, worldPiece, label) => {
    const { positions } = g.positions ? g : { positions: g.attributes.position.array };
    // Export geometry is built in the piece's OWN frame (entry at the origin,
    // heading +X, rim at Y=0) so the CSG never runs at tower coordinates, so
    // compare against the piece in that same frame rather than in the world.
    const piece = pieceInFrame(worldPiece);
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

    test('a straight between two curves is the SAME solid as any other', () => {
        // The channel is one width everywhere, so flanking a turn no longer
        // makes a different part. This is the shape that used to be
        // `straight_between_curves`; it is now just a straight, and the mesh
        // has to be byte-identical to prove it.
        const flanked = layoutTrack(['curveL', 'straight', 'curveL'], { slopeDeg: 11.2167 })
            .pieces.find(p => p.type === 'straight');
        const plainRun = layoutTrack(['straight', 'straight'], { slopeDeg: 11.2167 }).pieces;
        const plain = plainRun.filter(p => p.type === 'straight')[1];
        expect(flanked.entryWidth).toBe(flanked.innerWidth);
        expect(flanked.exitWidth).toBe(flanked.innerWidth);

        const a = buildPieceExportGeometry(flanked), b = buildPieceExportGeometry(plain);
        expectWatertight(a, 'straight beside curves');
        expectNoFloatingProtrusion(a, flanked, 'straight beside curves');
        expect(`tris ${a.indices.length}`).toBe(`tris ${b.indices.length}`);
        let worst = 0;
        for (let i = 0; i < a.positions.length; i++) {
            worst = Math.max(worst, Math.abs(a.positions[i] - b.positions[i]));
        }
        expect(`vertex delta ${worst.toExponential(1)}`).toBe('vertex delta 0.0e+0');
    });
});

describe('engraved part codes', () => {
    const { pieces } = layoutTrack(['straight', 'curveL', 'straight'], { slopeDeg: 11.2167 });

    const cutVolume = (build) => {
        const plain = analyzeGeometry(build(''));
        const marked = analyzeGeometry(build(undefined));
        expect(marked.isManifold && marked.isConsistent && marked.windsOutward).toBe(true);
        return plain.volumeMm3 - marked.volumeMm3;
    };

    test('a straight and a curve both come back watertight with material removed', () => {
        for (const pc of [pieces[1], pieces[2]]) {
            const cut = cutVolume(code => buildPieceExportGeometry(pc, code === '' ? { code: '' } : {}));
            // 0.5 mm deep over the inked area of a code between 8 and 15 chars
            expect(cut).toBeGreaterThan(5);
            expect(cut).toBeLessThan(60);
        }
    });

    test('the cut stays in the rail wall and never reaches the show face', () => {
        // measured on the cutter itself: on the finished part other geometry
        // (the arcade's own walls) also sits half a millimetre inside a face,
        // so the finished mesh cannot tell you where the code is
        for (const idx of [1, 2]) {
            const pc = pieceInFrame(pieces[idx]);
            const [op] = engraveOps(pc, pieceCode(pc, GEOMETRY_VERSION), SPEC);
            expect(op.op).toBe('subtract');
            const { positions } = op.geometry;
            let deepest = -Infinity, lowest = Infinity, highest = -Infinity, ahead = -Infinity;
            for (let i = 0; i < positions.length; i += 3) {
                // invert the placement by nearest station — exact enough at
                // 0.25 mm steps to bound the cut
                let bestS = 0, bestD = Infinity;
                for (let s = 0; s <= pc.planLen; s += 0.25) {
                    const p = planPosAt(pc, s);
                    const d = Math.hypot(p.x - positions[i], p.z - positions[i + 2]);
                    if (d < bestD) { bestD = d; bestS = s; }
                }
                deepest = Math.max(deepest, bestD - innerWidthAt(pc, bestS) / 2);
                const v = positions[i + 1] - deckYAt(pc, bestS);
                lowest = Math.min(lowest, v);
                highest = Math.max(highest, v);
                ahead = Math.max(ahead, bestS);
            }
            // outward from the channel, never as far as the outside face
            expect(deepest).toBeLessThanOrEqual(SPEC.engrave.depth + 1e-3);
            expect(deepest).toBeLessThan(SPEC.wall);
            expect(lowest).toBeGreaterThanOrEqual(SPEC.filletR);   // above the floor fillet
            expect(highest).toBeLessThan(SPEC.railHeight);         // below the crest
            expect(ahead).toBeLessThan(pc.planLen);
        }
    });

    test('engraving the channel can only widen it, never narrow it', () => {
        // the cut is in the wall the figure runs past, so it must not eat into
        // the clearance model's assumptions in the direction that would bind
        const pc = pieceInFrame(pieces[1]);
        const [op] = engraveOps(pc, pieceCode(pc, GEOMETRY_VERSION), SPEC);
        const { positions } = op.geometry;
        for (let i = 0; i < positions.length; i += 3) {
            let bestS = 0, bestD = Infinity;
            for (let s = 0; s <= pc.planLen; s += 0.5) {
                const p = planPosAt(pc, s);
                const d = Math.hypot(p.x - positions[i], p.z - positions[i + 2]);
                if (d < bestD) { bestD = d; bestS = s; }
            }
            // nothing is removed from INSIDE the channel envelope beyond the
            // hair of outset the boolean needs to bite cleanly
            expect(innerWidthAt(pc, bestS) / 2 - bestD).toBeLessThan(0.2);
        }
    });

    test('the code is not mirrored', () => {
        // Text on a face reads correctly iff its own axes form a right-handed
        // set with the normal pointing at the reader: read × up = out. Get it
        // backwards and every part in the library ships mirrored — cheap to
        // check, expensive to find on a printed bin of parts. The rule holds
        // whatever plane the code ends up on, which is why it is stated this
        // way rather than as "runs with travel".
        const cross = (a, b) => [
            a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const unit = (v) => { const L = Math.hypot(...v); return v.map(c => c / L); };
        for (const idx of [1, 2]) {
            const pc = pieceInFrame(pieces[idx]);
            const at = (u, v, w) => engravePoint(pc, SPEC, SPEC.engrave.marginMm, u, v, w, 0.15);
            const o = at(0, 0, 0);
            const read = unit(at(4, 0, 0).map((c, i) => c - o[i]));
            const up = unit(at(0, 2, 0).map((c, i) => c - o[i]));
            // the free-side normal: away from the material the cut goes into
            const out = unit(at(0, 0, 0).map((c, i) => c - at(0, 0, SPEC.engrave.depth)[i]));
            // sign, not equality: the text plane follows the deck's fall while
            // the cut is driven straight up, so the frame is slightly sheared
            const handed = cross(read, up).reduce((s, c, k) => s + c * out[k], 0);
            expect(`${pc.name} ${handed > 0.5 ? 'reads correctly' : 'is MIRRORED'}`)
                .toBe(`${pc.name} reads correctly`);
        }
    });

    test('a part too short for its code is left unmarked rather than failing', () => {
        const pc = pieceInFrame(pieces[1]);
        expect(engraveOps(pc, 'THIS CODE IS FAR TOO LONG TO FIT ALONG A TILE OF ANY LENGTH', SPEC)).toEqual([]);
        expect(engraveOps(pc, '', SPEC)).toEqual([]);
    });

    test('the small parts carry theirs on a flat face', () => {
        const { buildRiserGeometry, buildSupportFootGeometry, buildKeyGeometry } = pieceBuilders;
        const cases = [
            ['riser 120', c => buildRiserGeometry(120, SPEC, c === '' ? {} : { code: partCode('R120', GEOMETRY_VERSION) })],
            ['riser 15', c => buildRiserGeometry(15, SPEC, c === '' ? {} : { code: partCode('R15', GEOMETRY_VERSION) })],
            ['foot', c => buildSupportFootGeometry(SPEC, c === '' ? {} : { code: partCode('FOOT', GEOMETRY_VERSION) })],
            ['key', c => buildKeyGeometry(SPEC, c === '' ? {} : { code: partCode('KEY', GEOMETRY_VERSION) })]
        ];
        for (const [label, build] of cases) {
            const cut = cutVolume(build);
            expect(`${label} cut`).toBe(cut > 1 && cut < 40 ? `${label} cut` : `${label} cut was ${cut.toFixed(2)} mm3`);
        }
    });

    test('the scene never pays for engraving', () => {
        // display builders take no code and run no extra CSG — rebuilds stay cheap
        const display = buildPieceDisplayGeometry(pieces[1]);
        const plain = analyzeGeometry(display);
        expect(plain.isManifold).toBe(true);
        expect(pieceBuilders.buildRiserGeometry(30, SPEC)).toBeDefined();
    });
});

describe('export geometry is independent of where the piece sits in the tower', () => {
    test('the same curve exports byte-identically from three different heights', () => {
        // The builders share the display path's helpers, which work in world
        // coordinates, so a curve high in a spiral used to run its CSG out at
        // x~400, y~135. Float precision there is worse than at the origin and
        // the mesh changed with it: 14072 / 13986 / 14094 triangles for ONE
        // shape, volumes a mm3 apart. Slicers noticed — Bambu Studio flagged a
        // floating cantilever on some copies of a part and not others.
        //
        // An exported part is a function of its shape, not of its address.
        const { pieces } = layoutTrack(
            ['straight', 'curveL', 'straight', 'curveL', 'straight', 'straight'],
            { slopeDeg: 11.2167 });
        const curves = pieces.filter(p => p.type === 'curveL');
        expect(curves.length).toBeGreaterThan(1);
        // genuinely different elevations, or the test proves nothing
        expect(new Set(curves.map(c => c.rimY.toFixed(3))).size).toBe(curves.length);

        const built = curves.map(c => buildPieceExportGeometry(c));
        const ref = built[0];
        for (let i = 1; i < built.length; i++) {
            expect(`tris ${built[i].indices.length}`).toBe(`tris ${ref.indices.length}`);
            expect(built[i].positions.length).toBe(ref.positions.length);
            let worst = 0;
            for (let k = 0; k < ref.positions.length; k++) {
                worst = Math.max(worst, Math.abs(built[i].positions[k] - ref.positions[k]));
            }
            expect(`vertex delta ${worst.toExponential(1)}`).toBe('vertex delta 0.0e+0');
        }
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
                // export meshes are in the piece's own frame: entry at the
                // origin, heading +X, so arc length IS x
                const x = s;
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

    test('a jogged support changes the column, never the piece', async () => {
        // The offset lives in a separate part now, so a piece exports the same
        // solid whether its column runs straight down or steps aside. If that
        // ever stops being true the support axis is back in the track library.
        const { planPillarPositions } = await import('../js/track.js');
        const { pieces } = layoutTrack(
            ['straight', ...Array(8).fill('curveL'), 'straight'], { slopeDeg: 11.2167 });
        const sups = planPillarPositions(pieces);
        expect(sups.some(s => s.mode === 'jog')).toBe(true);
        for (const pc of pieces) {
            if (pc.type === 'start' || pc.type === 'end') continue;
            const sup = sups.find(s => s.pieceIndex === pc.index);
            const withSupport = buildPieceExportGeometry(pc, { support: sup });
            const plain = buildPieceExportGeometry(pc, {
                support: { ...sup, mode: 'center', x: 0, z: 0 } });
            expect(`${pc.name}: ${componentCount(withSupport)} shell(s)`)
                .toBe(`${pc.name}: 1 shell(s)`);
            expect(`${pc.name} tris ${withSupport.indices.length}`)
                .toBe(`${pc.name} tris ${plain.indices.length}`);
        }
    });

    test('no track piece exports as two disconnected shells', async () => {
        const { planPillarPositions } = await import('../js/track.js');
        // Every piece type, because a sealed void counts as a second shell and
        // the engraving is the thing most likely to make one: the code used to
        // start 6 mm in, which put its first glyph INSIDE the start platform's
        // bumper — a pocket with material on all six sides.
        for (const seq of [
            ['straight', 'curveL', 'curveL', 'curveL', 'straight', 'lift', 'straight'],
            ['straight', 'elevator', 'straight', 'powered', 'straight'],
            ['curveL', 'straight', 'curveR', 'straight', 'straight']
        ]) {
            const { pieces } = layoutTrack(seq, { slopeDeg: 11.2167 });
            const supports = planPillarPositions(pieces);
            for (const pc of pieces) {
                if (pc.role === 'branch') continue;
                const g = buildPieceExportGeometry(pc, { support: supports.find(s => s.pieceIndex === pc.index) });
                expect(`${pc.name}: ${componentCount(g)} shell(s)`).toBe(`${pc.name}: 1 shell(s)`);
            }
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
            // each mesh sits in its OWN frame now, so probe each with its own
            // face taken in that frame — the half-widths being compared are
            // intrinsic to the faces, not to where the pieces sit in the tower
            const prevLocal = pieceInFrame(prev), pcLocal = pieceInFrame(pc);
            const up = faceHalfWidth(mesh.get(prev.index), { x: prevLocal.exit.x, z: prevLocal.exit.z, h: prevLocal.exit.h }, -1);
            const down = faceHalfWidth(mesh.get(pc.index), { x: pcLocal.entry.x, z: pcLocal.entry.z, h: pcLocal.entry.h }, +1);
            expect(Math.abs(down - up)).toBeLessThan(0.02);
            checked++;
        }
        expect(checked).toBeGreaterThan(4);
    });
});

describe('nothing pokes up through the walking surface', () => {
    /**
     * The end rib used to be a prism with a LEVEL top taken at its face, under
     * a deck that falls 0.198 mm per mm. Over 12 mm of rib the deck drops
     * 2.4 mm; the floor is 2 mm thick; so the rib surfaced through the walking
     * surface near its inner edge — 0.28 mm proud on a straight, 0.48 on a
     * curve, where the flat slab also diverges from the arc and breaks through
     * further on one side than the other. It printed as a fin across the
     * washboard, and a hoof would have caught it.
     *
     * Anything under the deck can do this: the socket boss had the same fault
     * once. So this checks the surface itself rather than any one feature.
     */
    const highestAt = (g, x, z) => {
        const P = g.positions, I = g.indices;
        let best = -Infinity;
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], cx = P[c], cz = P[c + 2];
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(d) < 1e-12) continue;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            if (l1 < 0 || l2 < 0 || 1 - l1 - l2 < 0) continue;
            best = Math.max(best, l1 * P[a + 1] + l2 * P[b + 1] + (1 - l1 - l2) * P[c + 1]);
        }
        return best;
    };

    test.each(['straight', 'curveR', 'lift'])('%s: the floor is the highest thing in the channel', async (type) => {
        const { SPEC, pieceInFrame, planPosAt, deckYAt, innerWidthAt, planPillarPositions } =
            await import('../js/track.js');
        const { pieces } = layoutTrack(['straight', 'curveR', 'lift', 'straight'], { slopeDeg: 11.2167 });
        const sup = planPillarPositions(pieces);
        const world = pieces.find(p => p.type === type);
        const g = buildPieceExportGeometry(world, { support: sup.find(s => s.pieceIndex === world.index) });
        const pc = pieceInFrame(world);

        // the ends are where the ribs are, so sample them closely; the middle
        // carries the boss, so sample that too
        const stations = [];
        for (let s = 2; s <= SPEC.key.ribThk + 6; s += 1) stations.push(s, pc.planLen - s);
        for (let s = pc.planLen * 0.4; s <= pc.planLen * 0.6; s += 3) stations.push(s);

        let worst = { proud: -Infinity };
        for (const s of stations) {
            const p = planPosAt(pc, s), deck = deckYAt(pc, s);
            const right = [Math.sin(p.h), -Math.cos(p.h)];
            const half = innerWidthAt(pc, s) / 2 - SPEC.filletR - 0.5;
            for (let lat = -half; lat <= half; lat += 2) {
                const top = highestAt(g, p.x + right[0] * lat, p.z + right[1] * lat);
                // the washboard crest is the highest the floor may legitimately be
                const proud = top - (deck + SPEC.ridge.height);
                if (proud > worst.proud) worst = { proud, s, lat };
            }
        }
        // 0.1 mm of slack for the faceting of the swept ridges; the fault this
        // guards was 0.28-0.48 mm
        expect(`${type} proud by ${worst.proud.toFixed(2)} mm at s=${worst.s?.toFixed(0)}`)
            .toBe(`${type} proud by ${Math.min(worst.proud, 0.1).toFixed(2)} mm at s=${worst.s?.toFixed(0)}`);
    });
});

describe('the key can actually be fitted', () => {
    /**
     * Sweep the key up its slot and look for anything in the way.
     *
     * This is the test that was missing. The old one proved the detent EXISTED
     * and was a ledge rather than a plug — both true of a detent so proud that
     * the key could never reach it. A printed set came back with the keys
     * stopped a few millimetres short, on a shelf running right round the
     * pocket that nothing could enter past.
     *
     * So: take the key's real footprint, cast a ray up through the finished
     * mesh at every point of it, and require the whole travel from the rim to
     * the seated position to be clear. Geometry the key cannot pass fails here
     * whatever shape it is, and whether or not anyone remembered it exists.
     */
    const rayUp = (positions, indices, x, z) => {
        const hits = [];
        for (let t = 0; t < indices.length; t += 3) {
            const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
            const ax = positions[a], az = positions[a + 2];
            const bx = positions[b], bz = positions[b + 2];
            const cx = positions[c], cz = positions[c + 2];
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(d) < 1e-12) continue;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < 0 || l2 < 0 || l3 < 0) continue;
            hits.push(l1 * positions[a + 1] + l2 * positions[b + 1] + l3 * positions[c + 1]);
        }
        return hits.sort((p, q) => p - q);
    };
    /** Is (x, z) solid anywhere in [y0, y1]? */
    const blocked = (hits, y0, y1) => {
        for (let i = 0; i + 1 < hits.length; i += 2) {
            if (hits[i] < y1 && hits[i + 1] > y0) return Math.max(hits[i], y0);
        }
        return null;
    };

    /**
     * The key's own footprint, sampled — the REAL plan, chamfers and all, not
     * an idealised bowtie. Sampling the nominal outline instead would test a
     * key nobody prints and would miss exactly the corner the chamfer exists
     * for.
     */
    const keySamples = (keyPlan, step = 0.5) => {
        const xs = keyPlan.map(p => p[0]), zs = keyPlan.map(p => p[1]);
        const inside = (x, z) => {
            let hit = false;
            for (let i = 0, j = keyPlan.length - 1; i < keyPlan.length; j = i++) {
                const [xi, zi] = keyPlan[i], [xj, zj] = keyPlan[j];
                if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
            }
            return hit;
        };
        const pts = [];
        for (let z = Math.min(...zs); z <= Math.max(...zs); z += step) {
            for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
                if (inside(x, z)) pts.push([x, z]);
            }
        }
        return pts;
    };

    test('the key travels from the rim to its seat without meeting anything', async () => {
        const { SPEC, pieceInFrame } = await import('../js/track.js');
        const { bowtieKeyPlan } = await import('../js/geometry.js');
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11.2167 });
        const world = pieces[1];
        const pc = pieceInFrame(world);
        const g = buildPieceExportGeometry(world);

        // the entry pocket sits on the piece's entry face, which pieceInFrame
        // puts at the origin looking down +x; the pocket runs into the rib
        const keyH = SPEC.key.height - 2 * SPEC.jointClearanceMm;
        const pocketTop = (pc.entryDeck + SPEC.waterfallStepMm) - 3;
        const seatBottom = pocketTop - keyH;

        let worstBlock = null;
        // The key is sampled UNDERSIZE by exactly `detentProud`, because the
        // detent is meant to interfere by that much — it is the catch. So the
        // rule this enforces is "nothing narrows the throat by more than the
        // detent does", which tolerates the snap and fails anything bigger.
        const keyPlan = bowtieKeyPlan({
            neckHalf: SPEC.key.neckHalf, tipHalf: SPEC.key.tipHalf,
            depth: SPEC.key.depth, tipChamfer: SPEC.key.tipChamfer,
            clearance: -SPEC.key.detentProud
        });
        for (const [w, d] of keySamples(keyPlan)) {
            // plan coords → piece frame: lateral w, forward d from the face
            const x = pc.entry.x + d, z = pc.entry.z + w;
            const hits = rayUp(g.positions, g.indices, x, z);
            // travel: the key rises from the rim to its seat, so its own body
            // occupies [seatBottom, pocketTop] once there and everything below
            // must have been clear on the way up
            const at = blocked(hits, pc.rimY + 0.3, pocketTop - 0.05);
            if (at !== null && (worstBlock === null || at > worstBlock.y)) {
                worstBlock = { y: at, w, d };
            }
        }
        expect(`${worstBlock ? `blocked at y=${worstBlock.y.toFixed(2)} (lateral ${worstBlock.w.toFixed(1)}, depth ${worstBlock.d.toFixed(1)})` : 'clear'}`)
            .toBe('clear');
        expect(seatBottom).toBeGreaterThan(pc.rimY);
    });

    test('...and the detent is still there to catch it once seated', async () => {
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
        expect(added).toBeGreaterThan(1);      // it exists at all
        // A ledge is a thin ring. Filling the pocket section instead would add
        // roughly pocketArea * detentTall * 2 faces — hundreds of mm3.
        const pocketArea = (SPEC.key.neckHalf + SPEC.key.tipHalf) * SPEC.key.depth;
        expect(added).toBeLessThan(pocketArea * SPEC.key.detentTall * 2 * 0.25);
        expectWatertight(buildPieceExportGeometry(pc), 'piece with detent');
    });

    test('the flanks carry the fit, not the corners', async () => {
        // The printed set rattled AND would not seat, which sounds
        // contradictory and is not: at 0.2 mm clearance the corner
        // interference (0.20 mm) exceeded the flank gap (0.18 mm), so the key
        // stood on its four tips and never touched the surfaces meant to wedge
        // it. Both numbers have to be right, and only one of them is the
        // clearance.
        const { SPEC } = await import('../js/track.js');
        const { bowtieFit } = await import('../js/geometry.js');
        const K = SPEC.key;
        const shape = { neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth };
        const fit = bowtieFit({ ...shape, clearance: K.fitClearanceMm, tipChamfer: K.tipChamfer });
        expect(`corner ${fit.seats ? 'clears' : 'BINDS'}`).toBe('corner clears');
        expect(fit.cornerBindMm).toBeLessThan(-0.1);          // and with margin
        // a firm slide, not a rattle: tighter than the 0.18 that failed, and
        // not so tight the key cannot be pushed up a 39 mm throat by hand
        expect(fit.flankGapMm).toBeGreaterThan(0.05);
        expect(fit.flankGapMm).toBeLessThan(0.12);

        // and the chamfer is what buys it — without one, this clearance binds
        expect(bowtieFit({ ...shape, clearance: K.fitClearanceMm }).seats).toBe(false);
    });

    test('the track socket is cut tighter than every other socket', async () => {
        // Riser into riser is snug at the nominal size and must not change.
        // The same tenon in the track's boss came out loose even though the
        // two sockets measure identically, so the compensation belongs to the
        // track socket alone — and this is what stops someone "simplifying"
        // it back to one number.
        const { SPEC, layoutTrack, planPillarPositions, pieceInFrame, planPosAt } =
            await import('../js/track.js');
        const { buildRiserGeometry } = await import('../js/pieces.js');
        expect(SPEC.socket.trackShrinkAF).toBeGreaterThan(0);

        /** Narrowest across-flats of the hole on the axis, by plane section. */
        const socketAF = (g, cx, cz, y) => {
            const P = g.positions, I = g.indices;
            let best = Infinity;
            for (let t = 0; t < I.length; t += 3) {
                const v = [0, 1, 2].map(k => I[t + k] * 3);
                const seg = [];
                for (let e = 0; e < 3; e++) {
                    const a = v[e], b = v[(e + 1) % 3];
                    if ((P[a + 1] - y) * (P[b + 1] - y) > 0) continue;
                    if (Math.abs(P[b + 1] - P[a + 1]) < 1e-12) continue;
                    const f = (y - P[a + 1]) / (P[b + 1] - P[a + 1]);
                    seg.push([P[a] + (P[b] - P[a]) * f, P[a + 2] + (P[b + 2] - P[a + 2]) * f]);
                }
                if (seg.length < 2) continue;
                const [p, q] = seg;
                const dx = q[0] - p[0], dz = q[1] - p[1];
                const L2 = dx * dx + dz * dz || 1;
                const u = Math.max(0, Math.min(1, ((cx - p[0]) * dx + (cz - p[1]) * dz) / L2));
                best = Math.min(best, Math.hypot(cx - (p[0] + dx * u), cz - (p[1] + dz * u)));
            }
            return 2 * best;
        };

        const riser = socketAF(buildRiserGeometry(30), 0, 0, 5);
        expect(riser).toBeCloseTo(SPEC.socket.hexAF, 2);         // unchanged

        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11.2167 });
        const sup = planPillarPositions(pieces);
        const world = pieces[1];
        const g = buildPieceExportGeometry(world, { support: sup.find(s => s.pieceIndex === world.index) });
        const pc = pieceInFrame(world);
        const m = planPosAt(pc, pc.planLen / 2);
        const track = socketAF(g, m.x, m.z, pc.rimY + 5);
        expect(track).toBeCloseTo(SPEC.socket.hexAF - SPEC.socket.trackShrinkAF, 2);
        expect(track).toBeLessThan(riser);
    });

    test('the fit is chosen by simulation, and the corner is not the limiter', async () => {
        // `bowtieFitTrials` runs the printing variation rather than assuming a
        // single nominal, because the two failure modes pull opposite ways and
        // the printed set hit BOTH at once. What it found is that the CHAMFER
        // was the binding constraint, not the clearance: a 0.4 nozzle leaves a
        // ~0.30 ± 0.08 mm radius in the pocket's corner, and at 0.8 mm of
        // chamfer a fifth of printed keys still stood on their tips.
        const { SPEC } = await import('../js/track.js');
        const { bowtieFit, bowtieFitTrials, PROCESS } = await import('../js/geometry.js');
        const K = SPEC.key;
        const shape = { neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth };
        const tolerates = (ch) => {
            let r = 0.2;
            while (r < 1.2 && bowtieFit({ ...shape, clearance: K.fitClearanceMm, tipChamfer: ch, cornerRadius: r }).cornerBindMm <= PROCESS.maxPressMm) r += 0.01;
            return r - 0.01;
        };
        // the chosen chamfer clears any corner a 0.4 nozzle can leave, with margin
        expect(tolerates(K.tipChamfer)).toBeGreaterThan(PROCESS.cornerRadiusMm + 3 * PROCESS.cornerSigmaMm);
        // ...and it is past the knee: more chamfer would buy nothing
        const good = (ch) => bowtieFitTrials({ ...shape, tipChamfer: ch, clearance: K.fitClearanceMm }).pGood;
        expect(good(K.tipChamfer)).toBeGreaterThan(good(0.8));
        expect(good(K.tipChamfer * 1.5)).toBeLessThanOrEqual(good(K.tipChamfer) + 0.02);
        // the chosen clearance beats the 0.2 that was printed and rattled
        expect(good(K.tipChamfer)).toBeGreaterThan(
            bowtieFitTrials({ ...shape, tipChamfer: K.tipChamfer, clearance: 0.2 }).pGood);
        // deterministic: a simulation that moves on its own is not evidence
        expect(bowtieFitTrials({ ...shape, tipChamfer: 1.2, clearance: 0.08 }).pGood)
            .toBe(bowtieFitTrials({ ...shape, tipChamfer: 1.2, clearance: 0.08 }).pGood);
    });

    test('the detent leads in with a ramp, not a step', async () => {
        // a square ledge is a wall to shear through; the ramp is what the key
        // rides up. Guarded because the fix is invisible in a volume check.
        const { SPEC } = await import('../js/track.js');
        expect(SPEC.key.detentRamp).toBeGreaterThan(0.4);
        // and the interference it leaves, once a printed slot's ~0.16 mm/side
        // narrowing is counted, has to stay something a hand can push past
        // the catch is the detent minus the clearance it eats into
        const perSide = SPEC.key.detentProud - SPEC.key.fitClearanceMm;
        expect(perSide).toBeGreaterThan(0);        // it catches at all
        expect(perSide).toBeLessThan(0.1);         // and a hand can push past it
    });
});
