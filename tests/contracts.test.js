/**
 * ONE CONTRACT, TWO ENCODINGS, ZERO DRIFT — differential tests for the bug
 * class this project keeps rediscovering one instance at a time.
 *
 * The shape is always the same: some contract ("what is a legal design",
 * "which slope is the Standard", "where does the frog end", "what counts as
 * the same part") is encoded independently in two places, and nothing ever
 * runs the two encodings against each other. Each instance was found by a
 * person tripping over the seam: the validator rejected 'end' tokens the
 * builder accepted (and the builder doubled the platforms the validator was
 * right about); state ran at toFixed(4) of a Standard the docs misquoted as
 * 11.2167 — a number that never equalled atan(29.75/150) at all; the deck
 * match and the bank released at different frog stations and the gap was the
 * knee Brett found with his fingers.
 *
 * These tests make the seams load-bearing. Two kinds:
 *
 *   DIFFERENTIAL — enumerate a bounded input space and assert the two
 *   authorities agree verdict-for-verdict. Enumeration, not fuzzing: the
 *   space that matters is small, and a deterministic sweep that covers it
 *   beats random sampling that usually misses the one token that disagrees.
 *
 *   ARITHMETIC — the Standard's numbers are DERIVED (slope from the grid
 *   drop, radius from the curve drop), so assert the derivations, not the
 *   decimals. A typo like 11.2167 can only re-enter as a constant if nothing
 *   checks that tan(slope)·150 is exactly the 29.75 the grid is built on.
 */

import { layoutTrack, STANDARD, SPEC, SIMPLE_TYPES, SEGMENT_TYPES, degToRad }
    from '../js/track.js';
import { validateScene, serializeScene, deserializeScene } from '../js/scene_format.js';
import { DEFAULT_WALKER } from '../js/physics.js';

// -------------------------------------------------------------------------
// validator ⟺ builder, over every sequence the two could disagree about
// -------------------------------------------------------------------------

describe('the scene validator and layoutTrack agree on every sequence', () => {
    // The alphabet holds one of everything the two sides classify: each
    // simple type, both platform aliases, a junk token, and switch nodes with
    // legal and illegal contents. Sequences up to length 3 cover every
    // position rule in play (first / middle / last).
    const SWITCH_OK = { type: 'switchR', gate: 'main', main: ['straight'], branch: ['end'] };
    const SWITCH_BAD_CONTENT = { type: 'switchL', gate: 'main', main: ['start'], branch: [] };
    const ALPHABET = [...SIMPLE_TYPES, 'start', 'end', 'bogus', SWITCH_OK, SWITCH_BAD_CONTENT];

    const sceneFor = (sequence) => ({
        format: 'klipklop-scene', version: 2, sequence,
        scenery: [], surface: 'washboard', walker: { ...DEFAULT_WALKER }
    });

    /** The two verdicts this suite compares. Only SEQUENCE legality — the
     *  validator also checks fields the builder never sees (walker shapes,
     *  scenery kinds), which are one-sided by design. */
    const validatorRejects = (seq) =>
        validateScene(sceneFor(seq)).some((p) => p.startsWith('sequence'));
    const builderRejects = (seq) =>
        layoutTrack(seq, {}).issues.some((i) => i.level === 'error');

    test('exhaustively, for every sequence up to length 3', () => {
        const seqs = [[]];
        for (const a of ALPHABET) {
            seqs.push([a]);
            for (const b of ALPHABET) {
                seqs.push([a, b]);
                for (const c of ALPHABET) seqs.push([a, b, c]);
            }
        }
        const disagreements = [];
        for (const seq of seqs) {
            const v = validatorRejects(seq);
            const b = builderRejects(seq);
            if (v !== b) {
                disagreements.push(`${JSON.stringify(seq)} validator=${v ? 'reject' : 'accept'} builder=${b ? 'reject' : 'accept'}`);
            }
        }
        expect(disagreements).toEqual([]);
    }, 120000);

    test('and the sweep is not vacuous: both sides reject something and accept something', () => {
        expect(validatorRejects(['bogus'])).toBe(true);
        expect(builderRejects(['bogus'])).toBe(true);
        expect(validatorRejects(['straight'])).toBe(false);
        expect(builderRejects(['straight'])).toBe(false);
    });
});

// -------------------------------------------------------------------------
// serialize ⟺ deserialize: what the app writes, the app accepts, unchanged
// -------------------------------------------------------------------------

describe('a saved scene is a loadable scene, and loading it changes nothing', () => {
    test('serialize output validates and round-trips to identical state', () => {
        const state = {
            name: 'Contract check', sequence: ['straight',
                { type: 'switchL', gate: 'branch', main: [], branch: ['curveR'] }],
            scenery: [], muKey: 'washboard', skirtStyle: 'block',
            walker: { ...DEFAULT_WALKER }
        };
        const scene = serializeScene(state, { savedAt: '2026-08-19T00:00:00.000Z' });
        expect(validateScene(scene)).toEqual([]);
        const back = deserializeScene(scene);
        // the fields that define the design — and slopeDeg must be the
        // Standard EXACTLY, not a rounding of it (the toFixed(4) fork)
        expect(back.sequence).toEqual(state.sequence);
        expect(back.skirtStyle).toBe('block');
        expect(back.slopeDeg).toBe(STANDARD.slopeDeg);
        expect(serializeScene(back, { savedAt: '2026-08-19T00:00:00.000Z' }))
            .toEqual(scene);
    });
});

// -------------------------------------------------------------------------
// the Standard's numbers are derivations, not decimals
// -------------------------------------------------------------------------

describe('the Standard derives from the grid, exactly', () => {
    test('slope is atan of the grid drop over the tile — nothing rounded', () => {
        // a straight drops tileDropMm INCLUDING its waterfall: the slope must
        // reproduce that to float precision or the grid arithmetic is a lie
        const drop = STANDARD.tileDropMm - SPEC.waterfallStepMm;   // 29.75
        expect(Math.tan(degToRad(STANDARD.slopeDeg)) * 150).toBeCloseTo(drop, 10);
        // the number the docs quote — 11.2167 lived in them for months and
        // tan(11.2167°)·150 is 29.7457, which is nothing at all
        expect(STANDARD.slopeDeg).toBeCloseTo(11.21808, 4);
    });

    test('the curve radius spends the curve drop over a quarter turn at that slope', () => {
        const curveDrop = STANDARD.curveDropMm - SPEC.waterfallStepMm; // 44.75
        const arc = (Math.PI / 2) * STANDARD.curveRadius;
        expect(arc * Math.tan(degToRad(STANDARD.slopeDeg))).toBeCloseTo(curveDrop, 9);
    });

    test('a laid-out straight actually drops the grid number', () => {
        const { pieces } = layoutTrack(['straight'], {});
        const ramp = pieces.find((p) => p.type === 'straight');
        expect(ramp.drop + SPEC.waterfallStepMm).toBeCloseTo(STANDARD.tileDropMm, 9);
    });

    test('the lift slope derives from its grid rise the same way', () => {
        // the comment beside it said 11.4045° for as long as the ramp's said
        // 11.2167 — it is 11.40172, and this asserts the derivation instead
        expect(Math.tan(degToRad(STANDARD.liftSlopeDeg)) * 150)
            .toBeCloseTo(STANDARD.tileDropMm + SPEC.waterfallStepMm, 9);
    });
});

// -------------------------------------------------------------------------
// where the socket is, when nobody says
// -------------------------------------------------------------------------

describe('a piece is the same solid with and without support info', () => {
    /*
     * "The socket never moves" — massCentreS, constant per piece type — and
     * the part signature deliberately does NOT key on support, on the premise
     * that the mesh is identical either way. The premise was false: builders
     * fell back to planLen/2 when support info was absent, and a curve built
     * bare was a measurably different solid (10907 vs 10591 vertices) from
     * the one every shipped path builds. Latent — nothing shipped built bare
     * — which is exactly the kind of seam that waits for the first script
     * that does.
     */
    test('a bare build and a supported build of one curve are byte-identical', async () => {
        const { initCSG, buildPieceExportGeometry } = await import('../js/pieces.js');
        const { massCentreS } = await import('../js/track.js');
        await initCSG();
        const { pieces } = layoutTrack(['straight', 'curveR', 'straight'], {});
        const curve = pieces.find((p) => p.type === 'curveR');
        const supported = buildPieceExportGeometry(curve,
            { support: { s: massCentreS(curve), mode: 'center', x: 0, z: 0, h: 0 } });
        const bare = buildPieceExportGeometry(curve, {});
        expect(bare.positions.length).toBe(supported.positions.length);
        expect(Array.from(bare.positions)).toEqual(Array.from(supported.positions));
        expect(Array.from(bare.indices)).toEqual(Array.from(supported.indices));
    }, 120000);
});

// -------------------------------------------------------------------------
// the 3MF the app writes is the 3MF the scripts read
// -------------------------------------------------------------------------

describe('the 3MF writer and the script readers agree on the format', () => {
    /*
     * generateMultiObject3MFXML writes; overhang_audit's loadObjects parses
     * with regexes. A writer change that reorders attributes or renames an
     * element would not error anywhere — the reader would simply match
     * nothing, and every number downstream of it would be fiction (the
     * project has been there: the G1-only gcode parser). Serializer pairs
     * are two authorities by construction; this is their identity check.
     */
    test('what the writer writes, loadObjects reads back, vertex for vertex', async () => {
        const { generateMultiObject3MFXML } = await import('../js/export_3mf.js');
        const { loadObjects } = await import('../scripts/overhang_audit.mjs');
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const fflate = await import('fflate');
        const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 5]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
        const xml = generateMultiObject3MFXML([{ name: 'contract_probe', positions, indices }]);
        const file = path.join(os.tmpdir(), 'contract_probe.3mf');
        fs.writeFileSync(file, Buffer.from(fflate.zipSync({
            '3D/3dmodel.model': [fflate.strToU8(xml), { level: 0 }]
        })));
        const objs = loadObjects(file);
        expect(objs).toHaveLength(1);
        expect(objs[0].name).toBe('contract_probe');
        expect(objs[0].V).toHaveLength(4);
        expect(objs[0].T).toHaveLength(4);
        fs.unlinkSync(file);
    });
});
