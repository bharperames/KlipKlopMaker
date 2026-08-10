/**
 * The money tests: every printable part the app exports — after all CSG
 * operations — must be a watertight, consistently wound solid.
 */
import { jest } from '@jest/globals';
import {
    layoutTrack, pieceInFrame, SPEC, GEOMETRY_VERSION, innerWidthAt, deckYAt, planPosAt,
    planPillarPositions, socketMouthY
} from '../js/track.js';
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
        // Slack for the faceting of the swept ridges. Probed along a curve the
        // reading oscillates from -0.43 to +0.10 with a period of exactly the
        // ridge pitch: it IS the washboard, and its meshed crest sits ~0.10
        // above the analytic one. 0.10 of slack put the test exactly on that
        // value, so re-faceting the sweep — which any change to the arch pier
        // spacing does — moved it to 0.11 and failed on nothing. 0.15 still
        // guards the fault this exists for by 3x: a rib or a boss surfacing
        // through the floor read 0.28 to 0.48.
        expect(`${type} proud by ${worst.proud.toFixed(2)} mm at s=${worst.s?.toFixed(0)}`)
            .toBe(`${type} proud by ${Math.min(worst.proud, 0.15).toFixed(2)} mm at s=${worst.s?.toFixed(0)}`);
    });
});

describe('the minimal skirt', () => {
    /**
     * `SPEC.skirt.style = 'minimal'` had NO coverage at all — it shipped as a
     * second underside for every track piece with nothing asserting it was
     * even watertight. These are the three claims the variant makes.
     *
     * The boss is the interesting one. On a viaduct piece it is a column from
     * the rim up to the floor; on a minimal piece there is no rim under it, so
     * it is a RECESS — 12 mm of socket in the underside and nothing below —
     * and the spacer makes up the rest of the way to the grid.
     */
    const { pieces } = layoutTrack(['start', 'straight', 'curveL', 'lift', 'straight', 'end'],
        { slopeDeg: 11.2167, skirtStyle: 'minimal' });

    /** Every surface height at (x,z), high to low. */
    const surfacesAt = (g, x, z) => {
        const P = g.positions, I = g.indices;
        const ys = [];
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], cx = P[c], cz = P[c + 2];
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(d) < 1e-12) continue;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
            if (l1 < 0 || l2 < 0 || 1 - l1 - l2 < 0) continue;
            ys.push(l1 * P[a + 1] + l2 * P[b + 1] + (1 - l1 - l2) * P[c + 1]);
        }
        return ys.sort((p, q) => q - p);
    };

    const built = (type) => {
        const world = pieces.filter(p => p.type === type).at(-1);
        const support = planPillarPositions(pieces).find(s => s.pieceIndex === world.index);
        return { g: buildPieceExportGeometry(world, { support }), pc: pieceInFrame(world), support };
    };

    test.each(['straight', 'curveL', 'lift'])('%s exports watertight', (type) => {
        const { g, pc } = built(type);
        expectWatertight(g, `minimal ${type}`);
        expectNoFloatingProtrusion(g, pc, `minimal ${type}`);
    });

    test.each(['straight', 'curveL', 'lift'])('%s: the boss is a recess, not a column to the rim', (type) => {
        const { g, pc, support } = built(type);
        const mouth = socketMouthY(pc, support.s);
        expect(mouth).toBeGreaterThan(pc.rimY + 10);   // well clear of the rim

        // nothing of the boss reaches down toward the rim: sample the mesh
        // inside the boss footprint and take the lowest surface there. A
        // column would read at the rim; a recess reads at its own mouth.
        const p = planPosAt(pc, support.s);
        const dir = [Math.cos(p.h), Math.sin(p.h)], right = [Math.sin(p.h), -Math.cos(p.h)];
        let lowest = Infinity;
        for (let ds = -8; ds <= 8; ds += 1) {
            for (let lat = -8; lat <= 8; lat += 1) {
                if (ds * ds + lat * lat > 64) continue;
                const ys = surfacesAt(g, p.x + dir[0] * ds + right[0] * lat,
                    p.z + dir[1] * ds + right[1] * lat);
                if (ys.length) lowest = Math.min(lowest, ys.at(-1));
            }
        }
        expect(`${type} boss bottoms at rim+${(lowest - pc.rimY).toFixed(1)}`)
            .toBe(`${type} boss bottoms at rim+${(mouth - pc.rimY).toFixed(1)}`);
    });

    /**
     * THE 1.03 mm. `minimalDepthMm` is 12 = a 10 mm socket under a 2 mm floor,
     * and that is exact at one point only: the socket is a hex 10.39 mm across
     * corners and the deck falls 0.198 mm/mm, so putting the mouth at the
     * underside leaves the socket's LEVEL ceiling 1.03 mm inside the floor at
     * its downhill corner. Measured that way the walking surface over the
     * socket came out 1.27-1.38 mm thick — a flat blind hole under three
     * layers of PLA. socketMouthY drops the mouth by that much instead.
     *
     * Nothing else catches this: the mesh stays watertight, and the
     * "floor is the highest thing" test above reads the TOP surface, which a
     * hollow under it does not move.
     */
    test.each(['straight', 'curveL', 'lift'])('%s: the floor over the socket keeps its thickness', (type) => {
        const { g, pc, support } = built(type);
        const p = planPosAt(pc, support.s);
        const dir = [Math.cos(p.h), Math.sin(p.h)], right = [Math.sin(p.h), -Math.cos(p.h)];
        let thinnest = Infinity, at = null;
        for (let ds = -9; ds <= 9; ds += 0.5) {
            for (let lat = -9; lat <= 9; lat += 0.5) {
                if (ds * ds + lat * lat > 81) continue;
                const ys = surfacesAt(g, p.x + dir[0] * ds + right[0] * lat,
                    p.z + dir[1] * ds + right[1] * lat);
                if (ys.length < 2) continue;
                if (ys[0] - ys[1] < thinnest) { thinnest = ys[0] - ys[1]; at = [ds, lat]; }
            }
        }
        // the washboard means the top surface is a ridge, so the reading runs
        // slightly OVER floorThk; it must never run under it.
        expect(`${type} floor ${thinnest.toFixed(2)} mm at ${at}`)
            .toBe(`${type} floor ${Math.max(thinnest, SPEC.floorThk).toFixed(2)} mm at ${at}`);
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
        // The key is sampled at its PRINTED size, and the travel checked is
        // the free part of the throat — from the rim up to where the grip
        // taper starts. Above that the pocket closes on the key on purpose.
        const keyPlan = bowtieKeyPlan({
            neckHalf: SPEC.key.neckHalf, tipHalf: SPEC.key.tipHalf,
            depth: SPEC.key.depth, tipChamfer: SPEC.key.tipChamfer
        });
        for (const [w, d] of keySamples(keyPlan)) {
            // plan coords → piece frame: lateral w, forward d from the face
            const x = pc.entry.x + d, z = pc.entry.z + w;
            const hits = rayUp(g.positions, g.indices, x, z);
            // travel: the key rises from the rim to its seat, so its own body
            // occupies [seatBottom, pocketTop] once there and everything below
            // must have been clear on the way up
            const freeTop = pocketTop - (SPEC.key.gripRiseMm ?? 0) - (SPEC.key.seatLandMm ?? 0) - 0.2;
            const at = blocked(hits, pc.rimY + 0.3, freeTop);
            if (at !== null && (worstBlock === null || at > worstBlock.y)) {
                worstBlock = { y: at, w, d };
            }
        }
        expect(`${worstBlock ? `blocked at y=${worstBlock.y.toFixed(2)} (lateral ${worstBlock.w.toFixed(1)}, depth ${worstBlock.d.toFixed(1)})` : 'clear'}`)
            .toBe('clear');
        expect(seatBottom).toBeGreaterThan(pc.rimY);
    });

    test('the far wall never moves, at any height', async () => {
        // The grip is a taper on the FAR wall, not a step on the flanks. This
        // reads the built mesh: pocket depth at a series of heights, which has
        // to be flat up the throat and then close as the key nears its seat.
        const { SPEC, pieceInFrame } = await import('../js/track.js');
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11.2167 });
        const world = pieces[1];
        const pc = pieceInFrame(world);
        const g = buildPieceExportGeometry(world);
        const pocketTop = (pc.entryDeck + SPEC.waterfallStepMm) - 3;

        /**
         * How deep the void runs in from the face on the centreline, by
         * marching a ray along +x and taking the last point still in air.
         */
        const depthAt = (y) => {
            const P = g.positions, I = g.indices;
            const solidAt = (x) => {          // ray up from (x, 0) — inside iff odd crossings
                let n = 0;
                for (let t = 0; t < I.length; t += 3) {
                    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
                    const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], cx = P[c], cz = P[c + 2];
                    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
                    if (Math.abs(d) < 1e-12) continue;
                    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (0 - cz)) / d;
                    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (0 - cz)) / d;
                    const l3 = 1 - l1 - l2;
                    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
                    if (l1 * P[a + 1] + l2 * P[b + 1] + l3 * P[c + 1] > y) n++;
                }
                return n % 2 === 1;
            };
            let far = 0;
            for (let x = 0.5; x < SPEC.key.depth + 0.6; x += 0.05) if (!solidAt(x)) far = x;
            return far;
        };
        const K = SPEC.key;
        const rise = K.gripRiseMm, land = K.seatLandMm;
        const low = depthAt(pocketTop - rise - land - 5);
        const mid = depthAt(pocketTop - rise - land);
        const top = depthAt(pocketTop - 0.5);
        // The far wall is FLAT the whole way up, and that is the point. It used
        // to close by 0.3 mm over the last of the travel, which puts the key's
        // two tips in compression between two pockets at once — and the only
        // place that force can go is into shoving the pieces apart. Anything
        // here bigger than the ray march's own step is a regression.
        expect(`throat flat: ${Math.abs(mid - low) < 0.06}`).toBe('throat flat: true');
        expect(`far wall does not move: ${Math.abs(mid - top) < 0.06}`).toBe('far wall does not move: true');
    });

    test('the flanks close toward the seat, then hold for the land', async () => {
        // The grip is on the FLANKS, because they are the only surfaces whose
        // tightening pulls the seam SHUT. Read the built mesh: pocket width on
        // the centreline at a series of heights.
        const { SPEC, pieceInFrame } = await import('../js/track.js');
        const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: 11.2167 });
        const world = pieces[1];
        const pc = pieceInFrame(world);
        const g = buildPieceExportGeometry(world);
        const pocketTop = (pc.entryDeck + SPEC.waterfallStepMm) - 3;
        const K = SPEC.key;

        // half-width of the void at (depth d into the face, height y), by
        // walking outward until the ray up hits solid
        const halfWidthAt = (y, d) => {
            let w = 0;
            for (let z = 0.05; z < K.tipHalf + 2; z += 0.005) {
                const hits = rayUp(g.positions, g.indices, pc.entry.x + d, pc.entry.z + z);
                let solid = false;
                for (const h of hits) if (h > y) solid = !solid;
                if (solid) break;          // walked out of the void into the rib
                w = z;
            }
            return w;
        };
        const D = 4;                                   // mid-depth, clear of both ends
        const free = halfWidthAt(pocketTop - K.gripRiseMm - K.seatLandMm - 3, D);
        const landBot = halfWidthAt(pocketTop - K.seatLandMm + 0.1, D);
        const seat = halfWidthAt(pocketTop - 0.3, D);
        expect(`closes by the seat: ${(free - landBot).toFixed(2)}`)
            .toBe(`closes by the seat: ${K.seatGripMm.toFixed(2)}`);
        // ...and then STOPS closing. The land is what lets the key be pushed
        // the last of the way against a hard ceiling instead of stalling in a
        // wedge that is still tightening — the ceiling is the joint's vertical
        // register, so where the key stops is where the two decks meet.
        expect(Math.abs(seat - landBot)).toBeLessThan(0.005);
    });

    test('the gate pin is a C, not a cylinder', async () => {
        // The pivot has to hold against the figure and still turn by hand, and
        // a plain fit cannot: the measured spread is 0.043 mm/side against a
        // usable pivot band about 0.07 wide, so a Monte Carlo tops out near
        // 58% good with 15% SEIZED. The pin is therefore drawn oversize and
        // slotted, so it closes onto whatever the bore turns out to be. This
        // reads the built mesh rather than the spec: a hollow with a gap in it.
        const { GATE } = await import('../js/pieces.js');
        const g = buildGateGeometry();
        const P = g.positions, I = g.indices;
        const solidAt = (x, z, y) => {
            let n = 0;
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
                const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], cx = P[c], cz = P[c + 2];
                const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
                if (Math.abs(d) < 1e-12) continue;
                const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
                const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
                const l3 = 1 - l1 - l2;
                if (l1 < 0 || l2 < 0 || l3 < 0) continue;
                if (l1 * P[a + 1] + l2 * P[b + 1] + l3 * P[c + 1] > y) n++;
            }
            return n % 2 === 1;
        };
        // ring through the middle of the pin wall, halfway down the pin
        const R = (GATE.pinR + GATE.pinBoreR) / 2;
        let air = 0;
        for (let i = 0; i < 72; i++) {
            const a = ((i + 0.5) / 72) * 2 * Math.PI;
            if (!solidAt(R * Math.cos(a), R * Math.sin(a), -4)) air++;
        }
        // one slot, and only one: the arc a `pinSlot`-wide cut subtends here,
        // to within the 5 deg the sampling can resolve
        const gapDeg = (air / 72) * 360;
        const nominal = 2 * Math.asin(Math.min(1, GATE.pinSlot / (2 * R))) * 180 / Math.PI;
        expect(`gap ${gapDeg.toFixed(0)} vs ${nominal.toFixed(0)} deg, within 5`)
            .toBe(`gap ${gapDeg.toFixed(0)} vs ${nominal.toFixed(0)} deg, ` +
                `${Math.abs(gapDeg - nominal) <= 5 ? 'within 5' : 'OFF'}`);
        expect(solidAt(0, 0, -4)).toBe(false);        // hollow
        expect(GATE.pinR - GATE.pinBoreR).toBeCloseTo(0.8, 6);   // two perimeters of spring
        // Pin and bore are drawn the SAME size, and the shrink supplies the
        // interference: every hole in the measured set came out under, and no
        // external feature was out by more than 0.10, so equal nominals land
        // between 0 and 0.48 mm of interference on the readings alone — no
        // classification of holes, no theory about why one socket differs
        // from another. Drawing the pin oversize on top of that only adds
        // bending strain in the wall for grip the shrink already provides.
        expect(GATE.pinR).toBe(GATE.boreR);
        const { PRINT_DEVIATION } = await import('../js/geometry.js');
        expect(PRINT_DEVIATION.hole.devMm).toBeLessThan(0);
        expect(Math.abs(PRINT_DEVIATION.external.devMm))
            .toBeLessThan(Math.abs(PRINT_DEVIATION.hole.devMm));
    });

    test('the far wall clears the key under every hole reading in the set', async () => {
        // Front-to-back was the dimension that actually jammed. The key half
        // is a 9.00 external feature (prints 8.95-9.05 on the measured ±0.10)
        // going into a pocket that is a hole in a track piece (the track
        // sockets ran -0.05 to -0.15; the worst hole anywhere read -0.38).
        // At the flank clearance of 0.12 the worst case is NEGATIVE.
        const { SPEC } = await import('../js/track.js');
        const K = SPEC.key;
        const worstGap = (holeDev) =>
            (K.depth + K.depthClearanceMm + holeDev / 2) - (K.depth + 0.10 / 2);
        expect(`at the flank clearance ${K.fitClearanceMm}: ` +
            `${((K.depth + K.fitClearanceMm - 0.15 / 2) - (K.depth + 0.05)).toFixed(3)}`)
            .toBe('at the flank clearance 0.12: -0.005');
        expect(worstGap(-0.15)).toBeGreaterThan(0);      // a track-piece hole
        expect(worstGap(-0.38)).toBeGreaterThan(0);      // the worst on record
        // and the rib still has material behind the pocket
        expect(K.ribThk - (K.depth + K.depthClearanceMm)).toBeGreaterThan(2.5);
    });

    test('the gate is exported standing on its blade, not on the pin tip', async () => {
        // The assembly frame hangs the pin 8 mm below everything else, and the
        // exporter drops a part's lowest point to the bed — so straight from
        // that frame the gate lands on the TIP OF ITS PIN with the whole blade
        // in mid-air. `forPrint` turns it over.
        const bedContact = (g) => {
            const P = g.positions, I = g.indices;
            let lo = Infinity;
            for (let i = 1; i < P.length; i += 3) lo = Math.min(lo, P[i]);
            let area = 0;
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
                if (Math.max(P[a + 1], P[b + 1], P[c + 1]) > lo + 0.15) continue;
                area += Math.abs((P[b] - P[a]) * (P[c + 2] - P[a + 2])
                    - (P[c] - P[a]) * (P[b + 2] - P[a + 2])) / 2;
            }
            return area;
        };
        const assembly = bedContact(buildGateGeometry());
        const printed = bedContact(buildGateGeometry(SPEC, { forPrint: true }));
        expect(assembly).toBeLessThan(10);          // a spike
        expect(printed).toBeGreaterThan(100);       // the blade edge and the hub face
        // and it is still a solid: a proper rotation cannot flip the winding
        expectWatertight(buildGateGeometry(SPEC, { forPrint: true }), 'gate, print orientation');
    });

    test('the grip cannot spend the seat height', async () => {
        // The decks meet flush at the seam only if the key seats hard against
        // both pocket ceilings, so the seat is a HARD STOP and not an outcome.
        // What this rules out is the arrangement that was here before: a wedge
        // still tightening at the moment the key arrives, which converts
        // process variation into seat height at a huge gain. At the old
        // 0.3 mm over 10 mm of rise, 0.1 mm of process moved the seat 3.3 mm —
        // a 33x amplification into a step across the walking surface.
        const { SPEC } = await import('../js/track.js');
        const K = SPEC.key;
        const keyH = K.height - 2 * SPEC.jointClearanceMm;
        // the last of the travel is at CONSTANT section: no wedge, so nothing
        // in the geometry can stop the key short of the ceiling
        expect(K.seatLandMm).toBeGreaterThan(1);
        // the grip is a light interference, in the range the hex joint seats by
        // hand at, not a wedge that has to be driven
        expect(K.seatGripMm).toBeGreaterThan(0);
        expect(K.seatGripMm).toBeLessThanOrEqual(0.04);
        // it is fully engaged by the time the key seats — the ramp plus the
        // land fit inside the key's own height, so the whole flank is bearing
        expect(K.gripRiseMm + K.seatLandMm).toBeLessThanOrEqual(keyH);
        // and the flanks still start as an easy slide up the throat
        expect(K.fitClearanceMm - K.seatGripMm).toBeGreaterThan(0.08);
        expect(K.detentProud).toBe(0);                   // superseded, not forgotten
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

    test('the key is NOT pre-distorted, because the slot distorts with it', async () => {
        // Measured, the key prints with a shallower rake than it is drawn with:
        // the nozzle fills its concave waist and rounds its convex tips. That
        // looked like a reason to draw it pre-distorted, and it was wrong —
        // the SLOT does exactly the same thing, so the two stay parallel and
        // the errors cancel. Printed flares came out 0.392 for the key and
        // 0.383 for the slot.
        //
        // Kept as a test because the key's numbers ALONE are convincing and
        // point the wrong way. Comparing a printed part against a drawn one is
        // what made this look like a rake problem.
        const { SPEC } = await import('../js/track.js');
        const K = SPEC.key;
        expect(K.printComp.neckMm).toBe(0);
        expect(K.printComp.tipMm).toBe(0);

        const keyFlarePrinted = ((23.45 / 2) - (16.40 / 2)) / K.depth;      // measured
        const slotFlarePrinted = ((23.90 / 2) - (16.85 / 2)) / (K.depth + 0.2);
        expect(Math.abs(keyFlarePrinted - slotFlarePrinted)).toBeLessThan(0.02);

        // and the gap that leaves is even end to end, which is what a flank
        // fit needs — it is the SIZE of it that was wrong, not its shape
        const gapNear = (16.85 - 16.40) / 2, gapFar = (23.90 - 23.45) / 2;
        expect(Math.abs(gapNear - gapFar)).toBeLessThan(0.05);
        // drawn 0.2 measured 0.225, so drawing less is the whole correction
        expect(K.fitClearanceMm).toBeLessThan(0.2);
    });

});
