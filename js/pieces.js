/**
 * pieces.js
 * Three.js + Manifold-CSG assembly of printable parts. Two fidelity levels:
 *  - display geometry: coarse sweep, no ridges/joints — fast scene rebuilds
 *  - export geometry: fine washboard sweep + print-friendly joints
 *
 * Joint system (v2, slicer-verified friendly): every mating end face gets a
 * full-height internal END RIB (bed → drumhead ceiling, printing as a plain
 * wall) with a BOWTIE POCKET recessed into it. The rib is windowed through to
 * its back face — it used to keep a solid slab there to seal the underside,
 * which is not a job this part has.
 * A separate print-flat bowtie key bridges each seam, Hot-Wheels style.
 * No geometry ever overhangs: the old protruding dovetail tab was a floating
 * cantilever on the build plate.
 *
 * Interlock standard (used by everything): hex tenon AF 8.6 ↔ hex socket
 * AF 9 × 10 deep. Pillars, towers, palm trunks and track sockets all share it.
 */

import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import Module from 'manifold-3d';
import {
    SPEC, STANDARD, GEOMETRY_VERSION, stationsForPiece, planPosAt, deckYAt, innerWidthAt, bankAt,
    pieceFrame, pieceInFrame, supportInFrame, socketMouthY, collarFits, laysOnUnderside,
    undersidePlane
} from './track.js';
import {
    textRings, textWidthMm, textHeightMm, blockRings, blockSizeMm,
    pieceCode, partCode, isEngravable
} from './engrave.js';
import {
    sweepSolid, extrudePolygonY, extrudeOutlineX, pieceProfiles, segmentsForCircle,
    bowtieKeyPlan, bowtiePocketPlan, insetPolygon, hexPlan, hexRingPlan, circlePlan, SIMPLIFY_TOL_MM,
    ridgeStationSpacing, archStations,
    bodySideOutline, pendulumSideOutline, knightRiderOutline, knightCrestOutline, FIGURE, frogRidgeFade} from './geometry.js';
import { deduplicateGeometry } from './mesh_utils.js';

// --- Manifold WASM boolean kernel ---
let wasm = null;

/** Must be awaited once before any CSG-based builder runs. */
export async function initCSG() {
    if (!wasm) {
        wasm = await Module();
        wasm.setup();
    }
    return wasm;
}

/**
 * Arrays → renderable geometry. CSG/sweep output is fully vertex-welded, so
 * naive computeVertexNormals() averages across 90° edges and smears lighting
 * over flat walls (reads as "twisted normals" — it isn't; winding is verified).
 * toCreasedNormals splits normals at edges sharper than 30°: crisp corners,
 * smooth washboard/fillet arcs. Note: the result is NON-indexed — anything
 * reading .index must fall back to sequential indices.
 */
export function toBufferGeometry({ positions, indices }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return toCreasedNormals(g, Math.PI / 6);
}

function toArrays(g) {
    if (g.positions) return { positions: g.positions, indices: g.indices };
    const pos = g.attributes.position.array;
    const idx = g.index
        ? g.index.array
        : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// exported so an ASSEMBLY check can intersect two finished parts — see
// scripts/gate_swing.mjs. Nothing in the build path should need it.
export function toManifold(g) {
    if (!wasm) throw new Error('initCSG() must be awaited before building CSG geometry');
    const { positions, indices } = toArrays(g);
    const { uniqueVertices, remappedIndices } = deduplicateGeometry(positions, indices);
    const vertProperties = new Float32Array(uniqueVertices.length * 3);
    for (let i = 0; i < uniqueVertices.length; i++) {
        vertProperties[i * 3] = uniqueVertices[i].x;
        vertProperties[i * 3 + 1] = uniqueVertices[i].y;
        vertProperties[i * 3 + 2] = uniqueVertices[i].z;
    }
    const clean = [];
    for (let i = 0; i < remappedIndices.length; i += 3) {
        const a = remappedIndices[i], b = remappedIndices[i + 1], c = remappedIndices[i + 2];
        if (a !== b && b !== c && a !== c) clean.push(a, b, c);
    }
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts: new Uint32Array(clean) });
    mesh.merge();
    return new wasm.Manifold(mesh);
}

/**
 * Gate blade. The pivot sits ON THE WALL LINE, not inside the channel: a 44 mm
 * figure in a 48 mm channel has 4 mm of play in total, and an R5 hub inboard
 * of the wall ate 6.3 mm of it — the figure could not pass the pivot in either
 * gate position. On the wall line only `hubR - vaneThk/2` intrudes.
 *
 * The bore cannot live in a 1.6 mm wall (it is Ø3.5, wider than the wall), so
 * the switch grows a local boss for it BELOW the deck, where it is out of the
 * walking channel altogether, and the rail is slotted away over the blade's
 * length so the parked blade becomes that stretch of wall.
 */
/**
 * THE GATE PIVOT IS A SPLIT PIN, AND IT HAS TO BE.
 *
 * The gate must hold its position against the figure and still turn by hand.
 * The figure's push is 0.11-0.40 mN.m about the pivot (45 g at 128 mm/s
 * deflected 18 deg); the gate's own weight on its hub gives 0.010-0.020, so
 * friction from gravity is 10-40x short. A finger on the blade tip is
 * 52 mN.m, so the window between "holds" and "turns" is enormous — three
 * orders of magnitude — and the problem is purely that a plain cylindrical
 * fit cannot be placed inside it.
 *
 * It cannot because of the spread, not the target. Pin and bore together
 * carry 0.043 mm/side of sigma, and the whole usable band for a PIVOT —
 * clear enough to turn, tight enough to grip — is about 0.07 wide. A Monte
 * Carlo over the measured populations tops out near 58% good, with 15% of
 * them seized: on a bearing, interference is not a press you can lean on,
 * it is a gate that will not move.
 *
 * So the pin is compliant. A hollow pin with one axial slot is a C-spring —
 * a circlip, in effect. The bore stays a plain, rigid, fully enclosed round
 * hole; the PIN is the part that gives, squeezing its slot narrower as it
 * enters and pressing back out against the bore wall.
 *
 * PIN AND BORE ARE DRAWN THE SAME SIZE, Ø4.0, and the shrink does the rest.
 * Every hole in the measured set came out UNDER, by 0.05 to 0.38 mm, and no
 * external feature was out by more than 0.10. Draw the two the same and the
 * pin therefore prints 3.90-4.10 into a bore of 3.62-3.95: an interference of
 * 0 to 0.48 mm, on eleven readings, with no classification of holes and no
 * theory about why one socket differs from another. Taking only the external
 * readings near this size (the key, at +0.045) the floor rises to 0.10.
 *
 * Drawing the pin oversize on top of that — it was Ø4.2 for a while — adds
 * 0.2 mm the shrink has already provided and pushes the worst case from 1.19%
 * to 1.69% of bending strain in the wall for nothing.
 *
 * Nothing is asked to yield: at 0.8 mm of wall on a 1.6 mm mid-wall radius,
 * closing 0.48 mm is 1.19% strain, against PLA's 2-3% yield. It is a spring,
 * which is exactly what a rib standing proud of a rigid PLA wall is not.
 */
export const GATE = {
    vaneThk: 2.6,
    len: 52,
    hubR: 2.9,      // was 5; the rest was grip. Must clear the pin's shoulder.
    pinR: 2.0,      // Ø4.0 — the SAME as the bore; see below
    pinBoreR: 1.2,  // hollow, leaving 0.8 mm of wall: two perimeters, and a spring
    pinSlot: 1.0,   // the gap that makes it a C rather than a tube
    boreR: 2.0,     // Ø4.0, plain and fully enclosed — the pin is what gives
    /**
     * 3.2 mm of material around the bore, and the reason is structural, not
     * a print-shrinkage theory. The boss was R3.6, which leaves 1.6 mm of
     * wall around a Ø4 bore — thin for a bearing that takes its load
     * sideways, through a 52 mm blade. R5.2 doubles it.
     */
    bossR: 5.2
};

export const ADDITION = 'add';
export const SUBTRACTION = 'subtract';

/**
 * Runs a chain of boolean operations; the result is manifold by construction.
 * `simplifyTol` is exposed so tests can build an undecimated reference to
 * compare against — production always uses SIMPLIFY_TOL_MM.
 */
export function csgChain(baseGeometry, ops, simplifyTol = SIMPLIFY_TOL_MM) {
    let acc = toManifold(baseGeometry);
    for (const { op, geometry } of ops) {
        const other = toManifold(geometry);
        const next = op === SUBTRACTION ? acc.subtract(other) : acc.add(other);
        acc.delete();
        other.delete();
        acc = next;
    }
    // Decimate to a bounded surface error before handing back — see
    // SIMPLIFY_TOL_MM. Feature-detected so an older manifold build simply
    // returns the undecimated mesh instead of throwing.
    if (typeof acc.simplify === 'function' && simplifyTol > 0) {
        const lean = acc.simplify(simplifyTol);
        acc.delete();
        acc = lean;
    }
    const out = acc.getMesh();
    acc.delete();
    return {
        positions: new Float32Array(out.vertProperties),
        indices: new Uint32Array(out.triVerts)
    };
}

/** Plan-local (lateral px, forward pz) → world XZ at a face. */
function planToWorld(pts, face) {
    const { x, z, h } = face;
    const dir = [Math.cos(h), Math.sin(h)];
    const right = [Math.sin(h), -Math.cos(h)];
    return pts.map(([px, pz]) => [
        x + right[0] * px + dir[0] * pz,
        z + right[1] * px + dir[1] * pz
    ]);
}

// ---------------------------------------------------------------------------
// Track pieces
// ---------------------------------------------------------------------------

/**
 * Arc-length stations carrying a socket boss. A pier is nudged onto one when a
 * division is happening anyway, so it merges with the boss instead of standing
 * a few millimetres off it. `undefined` (no support info at all, e.g. a
 * standalone display build) falls back to the usual mid-piece boss.
 */
export const supportStations = (support, piece) =>
    support === undefined ? [piece.planLen / 2]
        : support && support.mode !== 'none' ? [support.s]
            : [];

/**
 * THE ELEVATOR'S HOUSING AND CAR SLOT — one copy, used by both builders.
 *
 * This block existed VERBATIM in buildPieceDisplayGeometry and
 * buildPieceExportGeometry. Twice while working on the fill I edited the
 * display copy believing I was in the export one, because a text search finds
 * display first; the second time it removed the export fill outright and every
 * piece silently regressed from a 10 mm worst span to 48-66. Two copies of a
 * block is two places to be wrong in and one place to look.
 */
function elevatorOps(piece, spec) {
    if (!(piece.type === 'elevator' || piece.isElevator)) return [];
    const Wo = piece.innerWidth / 2 + spec.wall;
    const dir = [Math.cos(piece.entry.h), Math.sin(piece.entry.h)];
    const right = [-Math.sin(piece.entry.h), Math.cos(piece.entry.h)];
    const at = (d, w) => [
        [piece.entry.x + dir[0] * d - right[0] * w, piece.entry.z + dir[1] * d - right[1] * w],
        [piece.entry.x + dir[0] * d + right[0] * w, piece.entry.z + dir[1] * d + right[1] * w]
    ];
    const box = (d0, d1, w) => { const a = at(d0, w), b = at(d1, w); return [a[0], a[1], b[1], b[0]]; };
    return [
        { op: ADDITION, geometry: toBufferGeometry(extrudePolygonY(
            box(40, 110, Wo), piece.rimY, piece.exitDeck - spec.floorThk + 0.5)) },
        // the car's shaft — a SUBTRACTION, which is why the under-deck fill has
        // to run before this and not after it
        { op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(
            box(15, 135, 6), piece.rimY - 5, piece.exitDeck + 15)) }
    ];
}

/** The start platform's bumper — one copy, used by both builders. */
function startBumperOps(piece, spec) {
    if (piece.type !== 'start') return [];
    const Wi = piece.innerWidth / 2;
    const bump = planToWorld(
        [[-Wi - 1, 2], [Wi + 1, 2], [Wi + 1, 10], [-Wi - 1, 10]], { ...piece.entry });
    return [{ op: ADDITION, geometry: toBufferGeometry(extrudePolygonY(
        bump, piece.entryDeck - 4, piece.entryDeck + spec.railHeight + 14)) }];
}

/** Fast, ridgeless shell for the interactive scene. */
export function buildPieceDisplayGeometry(piece, spec = SPEC, bossStations, support) {
    const pads = bossStations ?? [piece.planLen / 2];
    const stations = stationsForPiece(piece, 6, archStations(piece, spec, pads));
    const profiles = pieceProfiles(piece, stations, spec, false, pads);
    const shell = toBufferGeometry(sweepSolid(profiles, stations));
    const ops = [];

    // THE SAME FILL THE EXPORT USES, IN THE SAME PLACE. The scene must not tell
    // a different story from the plate — Brett, on a start piece in the app:
    // "Can we update the visual representation of the start/end tracks to show
    // that the back is not open anymore." It was never open in the export; the
    // display shell is swept from `pieceProfiles`, which still describes a
    // channel with an open bottom.
    //
    // FIRST, before the elevator's slot and before the joints, because all of
    // those CARVE. This sat after them until assertFillBeforeCarve was added
    // and threw on the very first elevator it saw — the display and export
    // orders had already drifted apart, which is the whole reason the assertion
    // exists rather than a comment saying "fill first".
    ops.push(...undersideSupportOps(piece, spec));

    ops.push(...elevatorOps(piece, spec));
    ops.push(...startBumperOps(piece, spec));

    const hasEntryJoint = !piece.isImplicitStart;
    const hasExitJoint = piece.type !== 'end';

    if (hasEntryJoint) {
        ops.push(...jointOps(
            { ...piece.entry }, piece.entryDeck,
            piece.entryDeck + spec.waterfallStepMm,
            skirtBottom(piece, { ...piece.entry }, spec),
            piece.entryWidth ?? piece.innerWidth, spec,
            (d) => deckYAt(piece, Math.min(piece.planLen, d))
        ));
    }
    if (hasExitJoint) {
        ops.push(...jointOps(
            { x: piece.exit.x, z: piece.exit.z, h: piece.exit.h + Math.PI },
            piece.exitDeck, piece.exitDeck,
            skirtBottom(piece, { x: piece.exit.x, z: piece.exit.z, h: piece.exit.h + Math.PI }, spec),
            piece.exitWidth ?? piece.innerWidth, spec,
            (d) => deckYAt(piece, Math.max(0, piece.planLen - d))
        ));
    }

    ops.push(...bossOps(piece, spec, support));

    return toBufferGeometry(csgChain(shell, assertFillBeforeCarve(ops, piece)));
}

/**
 * A route's travel envelope: the open air the figure sweeps through — the
 * full channel width from just above the washboard crests to above the rails.
 * Subtracting both routes' envelopes from the merged switch carves a proper
 * open frog: each route's rails are cut flush (to ridge-crest height) where
 * they would otherwise wall off the other route's channel.
 */
function routeClearanceEnvelope(piece, spec, maxStep = 10) {
    const stations = stationsForPiece(piece, maxStep);
    // SPARE ONLY THE WASHBOARD THAT IS ACTUALLY THERE. This was a constant
    // `ridge.height + 0.05`, which is right while a route is ribbed and wrong
    // the moment it is not: across the frog the ridges now fade to nothing
    // (frogRidgeFade), so a cut starting 0.65 mm above a FLAT deck left a
    // 0.65 mm lip of the other route's rail standing on it. Slivers like that
    // are what took the switch non-manifold — 414.9 cm3 and broken — while the
    // same fade on a plain straight or curve stayed watertight, which is how
    // the envelope was identified as the culprit rather than the fade.
    // CLEAR THE CRESTS THAT ARE ACTUALLY THERE. This was scaled by THIS route's
    // ridge fade, but the material the envelope cuts through belongs to the
    // OTHER route, which is fully ridged — so across the frog the floor dropped
    // to 0.05 above the deck and planed the other route's washboard off. With
    // the decks now coincident (frogBankKnots) a constant clears both.
    const h0At = () => spec.ridge.height + 0.05;
    const h1 = spec.railHeight + 8;
    // Follows the seam taper. Cutting at the body width all the way to the
    // mouth would eat into the other route's rails where the channel has
    // already narrowed back to the mating face.
    const profiles = stations.map(st => {
        const w = innerWidthAt(piece, st.s) / 2 - 0.05;
        const h0 = h0At(st.s);
        // THE FLOOR FOLLOWS THE DECK. Across a frog the deck leans (see
        // frogBankKnots) while the station frame stays level, so a level
        // envelope floor digs into the raised side of its own channel — it took
        // the branch's worst lateral step from 1.37 mm to 2.17. Only the floor
        // needs it; h1 is 8 mm over the rails either way.
        const tb = Math.tan(st.bank ?? 0);
        return [[-w, h0 - w * tb], [w, h0 + w * tb], [w, h1], [-w, h1]];
    });
    return sweepSolid(profiles, stations);
}

/** Display union of a switch's two route shells with an open frog. */
export function buildSwitchDisplayGeometry(mainPiece, branchPiece, spec = SPEC, bossStations, support) {
    const mk = (piece) => {
        const pads = bossStations ?? [piece.planLen / 2];
        const stations = stationsForPiece(piece, 8, archStations(piece, spec, pads));
        return toBufferGeometry(sweepSolid(pieceProfiles(piece, stations, spec, false, pads), stations));
    };

    const shell = mk(mainPiece);
    const ops = [{ op: ADDITION, geometry: mk(branchPiece) }];

    ops.push(
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(mainPiece, spec, 12)) },
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(branchPiece, spec, 12)) }
    );

    ops.push(...gateSeatOps(mainPiece, branchPiece, spec));
    ops.push(...jointOps(
        { ...mainPiece.entry }, mainPiece.entryDeck,
        mainPiece.entryDeck + spec.waterfallStepMm,
        skirtBottom(mainPiece, { ...mainPiece.entry }, spec),
        mainPiece.entryWidth ?? mainPiece.innerWidth, spec,
        (d) => deckYAt(mainPiece, Math.min(mainPiece.planLen, d))
    ));
    for (const pc of [mainPiece, branchPiece]) {
        ops.push(...jointOps(
            { x: pc.exit.x, z: pc.exit.z, h: pc.exit.h + Math.PI },
            pc.exitDeck, pc.exitDeck,
            skirtBottom(pc, { x: pc.exit.x, z: pc.exit.z, h: pc.exit.h + Math.PI }, spec),
            pc.exitWidth ?? pc.innerWidth, spec,
            (d) => deckYAt(pc, Math.max(0, pc.planLen - d))
        ));
    }
    ops.push(...bossOps(mainPiece, spec, support));

    // gate pivot bore
    const pinPos = gatePinPosition(mainPiece, branchPiece);
    const pin = new THREE.CylinderGeometry(1.65, 1.65, spec.railHeight + spec.floorThk + 10, segmentsForCircle(1.65));
    pin.translate(pinPos.x, pinPos.deckY + spec.railHeight / 2, pinPos.z);
    ops.push({ op: SUBTRACTION, geometry: pin });

    return toBufferGeometry(csgChain(shell, ops));
}

/** Fine washboard shell (positions/indices) for one piece. */
function fineShell(piece, spec, bossStations, forced) {
    const pads = bossStations ?? [piece.planLen / 2];
    const stations = stationsForPiece(piece,
        ridgeStationSpacing(spec.ridge.height / 2, piece.ridgePitch),
        archStations(piece, spec, pads, forced));
    const profiles = pieceProfiles(piece, stations, spec, true, pads, forced);
    return toBufferGeometry(sweepSolid(profiles, stations));
}

/**
 * The underside height at a joint face — the same surface the shell uses.
 *
 * `minimal` pieces have no flat rim, so the end rib, its bowtie pocket and its
 * lightening windows all have to stop where the shell stops or the piece grows
 * a full-depth block at each end and undoes the point of the variant. See
 * archedRimY.
 */
function skirtBottom(piece, face, spec) {
    if (piece.skirtStyle !== 'minimal') return piece.rimY;
    // THE SAME PLANE THE SHELL AND THE BOSS USE. It used to be `deck - D`
    // computed here, which is the plane under a straight and NOT under a curve
    // — the rib then sat up to 10 mm above its own underside and the end of the
    // part never reached the bed. Three places expressing one surface is what
    // put the boss in mid-air; there is one expression of it now.
    const pl = undersidePlane(piece, spec);
    const lying = laysOnUnderside(piece, spec);
    const dir = [Math.cos(face.h), Math.sin(face.h)];
    const right = [Math.sin(face.h), -Math.cos(face.h)];
    return (d = 0, u = 0) => {
        const y = pl.at(face.x + dir[0] * d + right[0] * u, face.z + dir[1] * d + right[1] * u);
        return lying ? y : Math.max(piece.rimY, y);
    };
}

/**
 * End rib + bowtie pocket at a joint face.
 * @param face - {x,z,h} where h points INWARD (into the piece body)
 * @param deckY - world deck-line height at this face
 * @param seamDeckY - world deck height of the UPHILL side of this seam
 *                    (pocket bands anchor here so both sides align absolutely)
 * @param rimY - piece rim (bed) height
 */
function jointOps(face, deckY, seamDeckY, rimAt, innerWidth, spec, deckAtDepth = null) {
    const Wi = innerWidth / 2;
    const K = spec.key;
    // The rib's bottom follows the same underside the shell does. On a viaduct
    // piece that is a flat rim and one number will do; on a minimal piece it is
    // the plane, which drops `ribThk`·grad = 2.4 mm across the rib — and a
    // LEVEL bottom there is the same fault the rib's level TOP had. Left level
    // it either lifts the end of the part off the bed (the plane runs away
    // below it) or protrudes through it, and protruding took measured bed
    // contact to zero.
    const rimFn = typeof rimAt === 'function' ? rimAt : () => rimAt;
    const corners = [[0, -Wi - 1], [0, Wi + 1], [K.ribThk, -Wi - 1], [K.ribThk, Wi + 1]]
        .map(([d, u]) => rimFn(d, u));
    const rimLow = Math.min(...corners);
    const rimHigh = Math.max(...corners);
    const rib = planToWorld(
        [[-Wi - 1, 0], [Wi + 1, 0], [Wi + 1, K.ribThk], [-Wi - 1, K.ribThk]],
        face
    );
    // jointClearanceMm exactly — the +0.05 fudge that used to be here is not
    // needed now the pocket wall is parallel to the key flank, and 0.20/side is
    // the clearance the printed hex joints are proven at.
    const pocketClearance = K.fitClearanceMm ?? spec.jointClearanceMm;
    // `c` is the FLANK clearance, which varies up the key's travel; the far
    // wall keeps the nominal clearance at every height (see bowtiePocketPlan)
    const pocketAt = (c) => planToWorld(bowtiePocketPlan({
        neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth,
        clearance: c, depthClearance: K.depthClearanceMm ?? pocketClearance
    }), face);
    const pocket = pocketAt(pocketClearance);

    // Detent band: the pocket profile narrowed by detentProud, sitting just
    // below where the key seats, so the key snaps past it and rests on it.
    const keyH = K.height - 2 * spec.jointClearanceMm;
    const pocketTop = seamDeckY - 3;
    const detentTop = pocketTop - keyH - 0.1;          // 0.1 mm of play
    const detentBot = detentTop - K.detentTall;
    // The detent is a RING, not a plug: refill the band with the full pocket
    // section, then cut the section narrowed by detentProud back out of it.
    // What is left is a detentProud ledge around the pocket wall, with the void
    // still continuous top to bottom so the key can be pushed through it.
    // NB: bowtiePocketPlan starts at z = -0.5 so the CUT passes cleanly through
    // the rib's outer skin. That is right for a subtraction and wrong for the
    // refill — it would add 0.5 mm of material PAST the end face, straight into
    // the mating piece, and break the no-protrusion print rule. The refill
    // therefore starts flush at z = 0.
    const flareK = (K.tipHalf - K.neckHalf) / K.depth;
    const detentPlan = (c, z0) => {
        const wall = (z) => K.neckHalf + c + flareK * z;
        const zFar = K.depth + c;
        return planToWorld([
            [-wall(z0), z0], [wall(z0), z0], [wall(zFar), zFar], [-wall(zFar), zFar]
        ], face);
    };
    // The void cut back out of that band tapers: full pocket width where the
    // key arrives, narrowing to the detent over `detentRamp`. That is what
    // makes it a wedge rather than a step — see SPEC.key.detentProud.
    const ramp = K.detentRamp ?? 0;
    const detentVoid = () => {
        const levels = [
            { y: detentBot - 0.5, c: pocketClearance },
            { y: detentBot + ramp, c: pocketClearance - K.detentProud },
            { y: detentTop + 0.5, c: pocketClearance - K.detentProud }
        ];
        return sweepSolid(
            levels.map(l => detentPlan(l.c, -0.5).map(([x, z]) => [x, -z])),
            levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
        );
    };
    const detent = (K.detentProud > 0 && detentBot > rimHigh + 0.5)
        ? [
            { op: ADDITION, geometry: toBufferGeometry(extrudePolygonY(detentPlan(pocketClearance, 0), detentBot, detentTop)) },
            { op: SUBTRACTION, geometry: toBufferGeometry(detentVoid()) }
        ]
        : [];
    // Lightening windows either side of the pocket. The rib is a solid slab
    // 50 x 12 mm by the full skirt-to-floor height — on an uphill face that is
    // ~40 mm tall and the ribs together are 25% of all track plastic. Only
    // three jobs actually need material: carrying the pocket, closing the end,
    // and giving the end a flat pad to print on. The pocket already voids the
    // middle, so the mass left is the two side slabs.
    //
    // Windows open DOWNWARD to the bed exactly like the pocket, so they add no
    // overhang. They run from just inside the mating face to one wall
    // thickness short of the back, which turns each side slab into a pair of
    // 1.5/1.6 mm skins on 2 mm posts. They used to stop at the pocket depth
    // instead, leaving 3.5 mm of solid backing across the whole face — 5 g per
    // tall rib, and its only job was sealing the chamber, which is not
    // something this part needs to do.
    /**
     * The rib, with its TOP FOLLOWING THE DECK.
     *
     * It used to be a prism with a level top taken at the face — and the deck
     * it lives under falls 0.198 mm per mm, so over `ribThk` = 12 mm the deck
     * drops 2.4 mm while the rib stayed put. The floor is 2 mm thick, so the
     * rib came up THROUGH the walking surface near its inner edge: 0.28 mm
     * proud on a straight and 0.48 on a curve, where the flat slab also
     * diverges from the arc and so breaks through further on one side than the
     * other. It shows in a print as a fin crossing the washboard.
     *
     * Same fault the socket boss had and the same fix (see slantedCylinder):
     * a level top cannot sit under a sloping floor — one edge is always wrong.
     */
    function ribSolid() {
        const top = (d) => (deckAtDepth ? deckAtDepth(d) : deckY) - spec.floorThk + 0.5;
        // the rib reaches the same underside the shell does, so a minimal
        // piece does not sprout a full-depth block at each end — and it FOLLOWS
        // it, so the end of the part lands on the bed with the rest of it
        const dir = [Math.cos(face.h), Math.sin(face.h)];
        const right = [Math.sin(face.h), -Math.cos(face.h)];
        const n = 5;
        const profiles = [], stations = [];
        for (let i = 0; i < n; i++) {
            const d = (K.ribThk * i) / (n - 1);
            const t = top(d), bL = rimFn(d, -Wi - 1), bR = rimFn(d, Wi + 1);
            profiles.push([[-Wi - 1, bL], [Wi + 1, bR], [Wi + 1, t], [-Wi - 1, t]]);
            stations.push({
                origin: [face.x + dir[0] * d, 0, face.z + dir[1] * d],
                right: [right[0], 0, right[1]], up: [0, 1, 0]
            });
        }
        return sweepSolid(profiles, stations);
    }

    /**
     * The pocket. Free up the throat, then the FLANKS close by `seatGripMm`
     * over `gripRiseMm`, then a `seatLandMm` land at that constant section
     * before the ceiling.
     *
     * The land is the whole point. A wedge that is still tightening when the
     * key arrives decides for itself where the key stops — and where the key
     * stops is where the two decks meet, so that has to be the ceiling and
     * nothing else. Over the land the key slides against a fixed interference
     * instead of an increasing one, so a hand can push it home against a hard
     * stop. See SPEC.key.seatGripMm.
     */
    function pocketVoid() {
        const rise = K.gripRiseMm ?? 0, grip = K.seatGripMm ?? 0, land = K.seatLandMm ?? 0;
        const landBase = pocketTop - land;
        const gripBase = landBase - rise;
        if (!(rise > 0 && grip > 0) || gripBase <= rimLow) {
            return extrudePolygonY(pocket, rimLow - 1, pocketTop);
        }
        const levels = [
            { y: rimLow - 1, c: pocketClearance },
            { y: gripBase, c: pocketClearance },
            { y: landBase, c: pocketClearance - grip },
            { y: pocketTop, c: pocketClearance - grip }
        ];
        return sweepSolid(
            levels.map(l => pocketAt(l.c).map(([x, z]) => [x, -z])),
            levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
        );
    }

    const WALL = 2.0;                       // material kept around each window
    const winZ0 = 1.5, winZ1 = K.ribThk - spec.wall;
    const winInner = K.tipHalf + WALL;
    const winOuter = Wi + 1 - WALL;
    // the windows are cut inside the rib, so they must clear its LOWEST top
    const ribTop = Math.min(deckY, deckAtDepth ? deckAtDepth(K.ribThk) : deckY) - spec.floorThk + 0.5;
    // A minimal piece's rib is only ~15 mm deep; lightening it further leaves
    // slivers around the pocket, and there is nothing left to save.
    const ribDepth = ribTop - rimHigh;
    const windows = (winOuter - winInner > 3 && ribDepth > 25)
        ? [-1, 1].map(sgn => ({
            op: SUBTRACTION,
            geometry: toBufferGeometry(extrudePolygonY(
                planToWorld([
                    [sgn * winInner, winZ0], [sgn * winOuter, winZ0],
                    [sgn * winOuter, winZ1], [sgn * winInner, winZ1]
                ], face),
                rimLow - 1, ribTop - WALL
            ))
        }))
        : [];

    return [
        { op: ADDITION, geometry: toBufferGeometry(ribSolid()) },
        { op: SUBTRACTION, geometry: toBufferGeometry(pocketVoid()) },
        ...detent,          // added back AFTER the pocket is cut
        ...windows
    ];
}

/**
 * Hex socket void with a 0.8 mm mouth flare — the lead-in chamfer that lets a
 * tenon self-align instead of binding on a sharp 90° opening (and absorbs
 * elephant-foot flare on the mating part).
 */
function hexSocketSolid(cx, cz, yOpen, yEnd, spec, afOverride = null, taperAF = 0, roofY = null) {
    const AF = afOverride ?? (spec.socket.hexAF - (spec.socket.socketShrinkAF ?? 0));
    const dir = Math.sign(yEnd - yOpen);
    const levels = [
        { y: yOpen, af: AF + 1.2 },
        { y: yOpen + dir * 0.8, af: AF },
        // closing slightly toward the far end makes a tenon wedge instead of
        // slip — see SPEC.socket.gripTaperAF
        { y: yEnd, af: AF - taperAF }
    ];
    // A ROOF ON THE BLIND END, in whatever headroom there is above it.
    //
    // A flat ceiling inside a blind hole is the shape a slicer plants support
    // under, and that support is inside the socket where it can never be got
    // out. `bossBoreSolids` solves it on a viaduct boss with a 45 deg cone, but
    // that needs 3.9 mm of clear height and a MINIMAL boss has none: its seat
    // is defined one socket depth below the floor, so the ceiling is always
    // ~2 mm under the deck. What is left is to spend the headroom that does
    // exist — closing at 45 deg over 1.6 mm takes the flat from 9 AF to 5.8,
    // which is 85 mm2 down to 29, and 5.8 mm is a hole any slicer bridges.
    if (roofY != null && dir * (roofY - yEnd) > 0.2) {
        const rise = Math.abs(roofY - yEnd);
        levels.push({ y: roofY, af: Math.max(0.6, AF - taperAF - 2 * rise) });
    }
    const profiles = levels.map(l => hexPlan(l.af).map(([x, z]) => [cx + x, -(cz + z)]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    return toBufferGeometry(sweepSolid(profiles, stations));
}


/**
 * A cylinder whose TOP FOLLOWS THE DECK instead of being level.
 *
 * The boss sits under a floor that falls at the ramp slope — 0.198 mm/mm, so
 * across a Ø19 boss the floor drops 3.8 mm. A flat-topped cylinder tall enough
 * to meet the floor on its uphill side therefore overshoots the underside on
 * its downhill side by 2.4 mm, and the floor is only 2 mm thick: the boss broke
 * through the walking surface, and the bore inside it cut a hole right through.
 * Raising or lowering a level top cannot fix that — one edge or the other is
 * always wrong — so the top has to slope with the deck.
 *
 * Built as a loft: stations march along the track through the boss, each
 * carrying the chord at that offset and its own top height. Ends are clamped to
 * a sliver rather than a point, since a zero-width profile has no cap to
 * triangulate.
 */
function slantedCylinder(bx, bz, heading, r, bottomAt, topAt, segs = 28) {
    const dir = [Math.cos(heading), Math.sin(heading)];
    const right = [Math.sin(heading), -Math.cos(heading)];
    // either end may be a level height or a function of the offset along the
    // track: the boss's TOP follows the deck, the collar's BOTTOM follows the
    // underside plane, and the ledge between them is level.
    const bot = typeof bottomAt === 'function' ? bottomAt : () => bottomAt;
    const top = typeof topAt === 'function' ? topAt : () => topAt;
    const profiles = [], stations = [];
    for (let i = 0; i <= segs; i++) {
        const a = (Math.PI * i) / segs;
        const ds = -r * Math.cos(a);
        const w = Math.max(0.15, r * Math.sin(a));
        // the bottom is sampled at BOTH edges of the chord, not just at its
        // centre. A plane under a curve is tilted across the track as well as
        // along it, and a bottom that only follows the along-track slope cuts
        // below it on one side — which put the part back on its boss.
        const y0 = bot(ds, -w), y1 = bot(ds, w);
        const t = Math.max(top(ds), Math.max(y0, y1) + 0.2);
        profiles.push([[-w, 0], [w, y1 - y0], [w, t - y0], [-w, t - y0]]);
        stations.push({
            origin: [bx + dir[0] * ds, y0, bz + dir[1] * ds],
            right: [right[0], 0, right[1]],
            up: [0, 1, 0]
        });
    }
    return toBufferGeometry(sweepSolid(profiles, stations));
}

/**
 * Upward bore that hollows a boss above its socket. Returns null when the boss
 * is too short for a bore to be worth it.
 */
function bossBoreSolids(cx, cz, heading, piece, spec, underside, yStart) {
    const rSock = spec.socket.hexAF / 2;          // inscribed in the hex: no ledge
    const rBore = spec.socket.bossR - 3;          // leave a 3 mm wall
    const flare = rBore - rSock;
    // The bore's roof used to be a flat lid held CAP below the floor: a Ø13
    // horizontal ceiling inside a blind hole, which is exactly the shape a
    // slicer plants support under. It is a CONE now, closing at 45 deg, so the
    // whole bore is self-supporting end to end and there is no flat anywhere
    // in it. The apex is level rather than following the deck — over a Ø13
    // bore the deck falls 2.6 mm, and a level apex placed under the LOWEST
    // point of that is simpler than lofting a sloped tip.
    const yApex = underside(rBore) - 0.4;
    if (yApex - (yStart + flare) < rBore * 0.6) return [];

    // One lofted sleeve, sampled at a common point count so the hex can turn
    // into the round bore without a step: hex at the socket top, flared out at
    // 45°, straight, then closed at 45° to a point.
    const n = Math.max(24, segmentsForCircle(rBore));
    const place = (pts) => pts.map(([x, z]) => [cx + x, -(cz + z)]);
    const ring = (r) => place(circlePlan(r, n));
    const at = (y) => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] });

    const yRoof = Math.max(yStart + flare + 0.2, yApex - rBore);
    const profiles = [
        place(hexRingPlan(spec.socket.hexAF, n)),
        ring(rBore),
        ring(rBore),
        ring(Math.max(0.3, rBore - (yApex - yRoof)))
    ];
    const heights = [yStart, yStart + flare, yRoof, yApex];
    return [toBufferGeometry(sweepSolid(profiles, heights.map(at)))];
}

/**
 * Pillar-socket boss ops. `support` comes from planPillarPositions (collision-
 * aware); without one, a center boss at the midpoint is used (ground pieces).
 * Outrigger mode adds a printable arm at rim level (on the bed — no overhang)
 * carrying the socket boss outboard of the tier below.
 */
function bossOps(piece, spec, support) {
    if (support?.mode === 'none') return [];
    const ops = [];
    let bx, bz, bossHeading = 0, bossUnderside = null, mouthY = piece.rimY;

    // The boss is always at mid-piece. It used to move along the track, and
    // grow an outrigger arm when that was not enough, whenever the column below
    // was blocked — which made the TRACK a different solid for a reason that
    // belongs to the SUPPORT. The offset now lives in a jog (SPEC.jog), so
    // every piece of a type is one shape.
    {
        const s = support?.s ?? piece.planLen / 2;
        const f = s / piece.planLen;
        const m = planPosAt(piece, s);
        bx = m.x; bz = m.z;
        const ceilY = (piece.entryDeck - piece.drop * f) - spec.floorThk;
        // floor underside at an offset ds along the track from the boss centre
        const grad = piece.planLen > 0 ? piece.drop / piece.planLen : 0;
        bossHeading = m.h;
        bossUnderside = (ds) => ceilY - grad * ds;
        // viaduct: the rim, and the boss is a column down to it. minimal: just
        // under the piece's own underside, and the boss is only a recess — the
        // spacer carries the mouth the rest of the way to the grid.
        mouthY = socketMouthY(piece, s, spec);
        if (laysOnUnderside(piece, spec)) {
            // ONE POST, from the print plane up to the floor, at the collar's
            // diameter the whole way. It used to be a bossR post with a wider
            // collar under it, and that step was a level annulus facing DOWN —
            // the same 78.8 deg ramp the tilt exists to get rid of, and it read
            // on screen as a brim round the boss. One diameter has no step.
            //
            // The plane is `undersidePlane`, NOT `deck - D`. They are the same
            // surface under a straight and 5.3 mm apart under a curve, where
            // the plane is fitted; built to the wrong one the post stopped
            // short and the boss floated.
            const pl = undersidePlane(piece, spec);
            const dir = [Math.cos(bossHeading), Math.sin(bossHeading)];
            const rt = [Math.sin(bossHeading), -Math.cos(bossHeading)];
            const planeAt = (ds, lat = 0) =>
                pl.at(bx + dir[0] * ds + rt[0] * lat, bz + dir[1] * ds + rt[1] * lat);
            const { collarR, collarBoreR } = spec.socket;
            ops.push({
                op: ADDITION,
                geometry: slantedCylinder(bx, bz, bossHeading, collarR, planeAt,
                    (ds) => bossUnderside(ds) + 0.5)
            });
            // Bored out below the seat so the spacer's body tucks up inside it —
            // but NOT square to the mouth. A flat annulus there is the last
            // unsupported face on a track piece and the strands Brett keeps
            // photographing; see SPEC.socket.mouthLandMm. The bore stops
            // `coneRun` short and a 45 degree cone carries it the rest of the
            // way in, leaving a flat LAND for the support column to bear on.
            const rHex = (spec.socket.hexAF - (spec.socket.socketShrinkAF ?? 0))
                / 2 / Math.cos(Math.PI / 6);
            const land = spec.socket.mouthLandMm ?? 0;
            const rLand = Math.min(collarBoreR, rHex + land);
            const coneRun = Math.max(0, collarBoreR - rLand);      // 45 degrees
            ops.push({
                op: SUBTRACTION,
                geometry: slantedCylinder(bx, bz, bossHeading, collarBoreR,
                    (ds, lat) => planeAt(ds, lat) - 0.5,
                    coneRun > 0 ? mouthY - coneRun : mouthY)
            });
            if (coneRun > 0) {
                // vertical truncated cone, wide at the bottom: material grows
                // inward one layer at a time instead of appearing all at once
                const segs = 64;
                ops.push({
                    op: SUBTRACTION,
                    geometry: toBufferGeometry(sweepSolid(
                        [circlePlan(collarBoreR, segs), circlePlan(rLand, segs)]
                            .map((pl) => pl.map(([x, z]) => [bx + x, -(bz + z)])),
                        [mouthY - coneRun, mouthY].map((y) => ({
                            origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
                    ))
                });
            }
        } else {
            ops.push({
                op: ADDITION,
                geometry: slantedCylinder(bx, bz, bossHeading, spec.socket.bossR,
                    mouthY, (ds) => bossUnderside(ds) + 0.5)
            });
        }
    }
    // the roof is only worth building where the 45 deg BORE cannot be: on a
    // viaduct boss the bore replaces the ceiling entirely and a roof under it
    // would just be a second, redundant cut
    const socketTop = mouthY + spec.socket.depth;
    const rCorner = spec.socket.hexAF / 2 / Math.cos(Math.PI / 6);
    const roofY = bossUnderside
        ? Math.max(socketTop, Math.min(socketTop + spec.socket.hexAF / 2,
            // the LOWEST floor underside across the socket, either way the
            // deck runs — a lift climbs, so its downhill corner is -rCorner
            Math.min(bossUnderside(rCorner), bossUnderside(-rCorner)) - 0.4))
        : null;
    ops.push({
        op: SUBTRACTION,
        // undersize like every other socket now — hexSocketSolid applies
        // socket.socketShrinkAF itself, so this no longer overrides the AF
        geometry: hexSocketSolid(bx, bz, mouthY - 0.5, socketTop, spec,
            null, spec.socket.gripTaperAF ?? 0, roofY)
    });
    // Core the boss out above the socket: only the socket walls carry the
    // tenon, so a solid post is ~6.6 cm3 doing nothing. The bore continues the
    // socket upward at 45 deg — self-supporting, and it keeps the void open to
    // the bed so nothing is trapped. A `minimal` boss is 12 mm tall and all of
    // it is socket, so there is nothing left to core and this returns nothing.
    if (bossUnderside) {
        for (const g of bossBoreSolids(bx, bz, bossHeading, piece, spec, bossUnderside,
            mouthY + spec.socket.depth)) {
            ops.push({ op: SUBTRACTION, geometry: g });
        }
    }
    return ops;
}

/**
 * Full watertight export mesh for a NON-SWITCH piece: washboard floor,
 * end ribs with bowtie pockets, start bumper, pillar-socket boss.
 */
/**
 * Where a track piece's code goes, and which way round it reads.
 *
 * The face is the CHANNEL WALL — the inside of one rail, from the deck up to
 * the crest. Vertical, on the inside, and not a surface anything depends on:
 * not a mating face, not the bed contact, not the walking floor. The outer wall
 * is the show surface of an assembled tower and never carries the code.
 *
 * It costs nothing to put it here. The pocket only ever makes the channel
 * LOCALLY WIDER, so it cannot bind a figure, and it sits above the 2 mm floor
 * fillet the hooves actually run against. The cut is under a third of the
 * 1.6 mm wall, so three perimeters survive at a 0.4 nozzle and nothing reaches
 * the outside face.
 *
 * The alternatives were tried and do not work. The end rib (the plan's first
 * choice) has a bowtie pocket down the middle and two lightening windows either
 * side, leaving a pair of ~10 mm panels — and it is a mating face. The drumhead
 * underside is big and hidden but it is the acoustic membrane, and the socket
 * boss rises to meet it on the centreline, where text becomes a sealed void
 * rather than a pocket. The INNER SKIRT WALL sounds right and is not: the
 * arcade cuts arches through it, so the only band that survives end to end is
 * `ARCH.band` minus the floor — 1.6 mm, under half a cap height.
 *
 * Which rail is not a preference either, and on a SWITCH neither rail is free
 * for its whole length. Two routes are merged into one solid, so each route's
 * clearance envelope cuts the other's rails open at the mouth to make the frog;
 * and the gate blade is hinged on the wall OPPOSITE the branch, with 52 mm of
 * that rail slotted away so the parked blade becomes it. A code aimed at the
 * gate rail cut into thin air and half of it silently vanished.
 *
 * Neither rail is free end to end, so a switch marks the GATE rail and starts
 * past the slot (`switchEngraveSpot`). The branch rail was tried and is worse:
 * the branch route runs alongside it for 110 mm of a 150 mm tile.
 *
 * Reading order follows: looking at a face from its free side, along −n, the
 * reader's left-to-right runs along `Y × n`, which is +dir on one rail and
 * −dir on the other. So the block is laid out backwards along the track on the
 * far rail, and comes out reading the same way on both. `engravePoint` is the
 * single place that knows this; there is no second copy of the rule to drift.
 */
export const engraveSide = (piece) => (piece && piece.switchType === 'switchR' ? -1 : 1);


/**
 * Local text coords → world. `u` runs along the wall in reading order from the
 * start of the block, `v` up from the deck, `w` into the wall starting `outset`
 * proud of the channel face. Every vertex is placed through its own station, so
 * the code follows the deck's fall and a curve's arc instead of chording across
 * them — at R 143 a 30 mm label would otherwise stand 0.8 mm off at its ends
 * and not cut at all.
 */
export function engravePoint(piece, spec, sStart, u, v, w, outset = 0, side = 1, wide = 0) {
    // on the far rail the reader's left-to-right runs against travel, so the
    // block is laid out backwards along the track and reads the same either way
    const along = side > 0 ? sStart + u : sStart + wide - u;
    const s = Math.max(0, Math.min(piece.planLen, along));
    const p = planPosAt(piece, s);
    const right = [Math.sin(p.h), -Math.cos(p.h)];
    // channel face; material lies further out, so the cut runs outward from
    // the channel and never reaches the show surface
    const off = side * (innerWidthAt(piece, s) / 2 - outset + w);
    return [p.x + right[0] * off, deckYAt(piece, s) + v, p.z + right[1] * off];
}

/**
 * Cuts `text` into the rail wall. One subtraction: the stroke rings are unioned
 * in 2D first, which both resolves every overlap where strokes meet and lets
 * the counters of A, O, R and 8 come out as real holes. Sixty separate boolean
 * ops per part would show up in export time next to the arcade.
 *
 * Returns [] rather than throwing when the text does not fit — a part too short
 * to mark is not a reason to fail an export.
 */
export function engraveOps(piece, text, spec = SPEC, opts = {}) {
    const E = spec.engrave;
    if (!E || !text || !piece || !(piece.planLen > 0)) return [];
    if (!wasm) throw new Error('initCSG() must be awaited before engraving');
    const font = { capHeight: E.capHeight, strokeMm: E.minFeature };
    const wide = textWidthMm(text, font), tall = textHeightMm(font);
    const sStart = opts.sStart ?? E.marginMm;
    if (sStart + wide > piece.planLen - E.marginMm) return [];
    // the band is the rail, less the floor fillet below and the crest above
    if (tall + spec.filletR + 1 > spec.railHeight) return [];
    const vBase = spec.filletR + (spec.railHeight - spec.filletR - tall) / 2;

    const rings = textRings(text, font);
    // The map (u, v, w) → world is orientation-REVERSING here: reading order
    // had to run with travel for the code to be legible, and that is the
    // handedness that costs.
    const side = opts.side ?? engraveSide(piece);
    const cut = cutSolid(rings, E.depth, (u, v, w) =>
        engravePoint(piece, spec, sStart, u, vBase + v, w, ENGRAVE_OUTSET, side, wide), true);
    return cut ? [{ op: SUBTRACTION, geometry: cut }] : [];
}

/** How far outside the surface the cut starts, so the boolean has a clean bite. */
const ENGRAVE_OUTSET = 0.15;

/**
 * Rings → a solid to subtract, with every vertex placed by `place`.
 *
 * The rings are unioned in 2D FIRST. That is what turns a pile of overlapping
 * stroke stadiums into letters, and it is also the difference between one
 * boolean per part and sixty — which would have shown up in export time next to
 * the arcade. It also gets the counters of A, O, R and 8 for free, as real
 * holes that `Manifold.extrude` triangulates correctly.
 *
 * `flip` swaps two indices per triangle, for placements whose Jacobian is
 * negative; without it manifold is handed an inside-out solid and the
 * subtraction quietly does nothing.
 */
function cutSolid(rings, depth, place, flip = false) {
    if (!rings.length) return null;
    if (!wasm) throw new Error('initCSG() must be awaited before engraving');
    const section = wasm.CrossSection.union(rings);
    const solid = wasm.Manifold.extrude(section, depth + ENGRAVE_OUTSET);
    const mesh = solid.getMesh();
    const src = mesh.vertProperties, tri = mesh.triVerts;
    const positions = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
        const p = place(src[i], src[i + 1], src[i + 2]);
        positions[i] = p[0]; positions[i + 1] = p[1]; positions[i + 2] = p[2];
    }
    const indices = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i += 3) {
        indices[i] = tri[i];
        indices[i + 1] = tri[i + (flip ? 2 : 1)];
        indices[i + 2] = tri[i + (flip ? 1 : 2)];
    }
    section.delete();
    solid.delete();
    return { positions, indices };
}

/**
 * Engraves a block of lines into a FLAT face — the parts with no rail to write
 * along. `origin` is where the block's bottom-left corner sits, `right` and `up`
 * span the face, and the cut goes in along right × up.
 */
export function engraveFlatOps(lines, origin, right, up, spec = SPEC, opts = {}) {
    const E = spec.engrave;
    if (!E || !lines.length) return [];
    const font = {
        capHeight: opts.capHeight ?? E.capHeight, strokeMm: E.minFeature,
        leadingMm: opts.leadingMm
    };
    const depth = opts.depth ?? E.depth;
    const inward = [
        -(right[1] * up[2] - right[2] * up[1]),
        -(right[2] * up[0] - right[0] * up[2]),
        -(right[0] * up[1] - right[1] * up[0])
    ];
    const cut = cutSolid(blockRings(lines, font), depth, (u, v, w) => {
        const d = w - ENGRAVE_OUTSET;   // w = 0 sits ENGRAVE_OUTSET proud of the face
        return [
            origin[0] + right[0] * u + up[0] * v + inward[0] * d,
            origin[1] + right[1] * u + up[1] * v + inward[1] * d,
            origin[2] + right[2] * u + up[2] * v + inward[2] * d
        ];
    }, true);   // (right, up, right×up) is right-handed, so (u, v, inward) is not
    return cut ? [{ op: SUBTRACTION, geometry: cut }] : [];
}

/**
 * The walls that hold a `minimal` piece's deck ceiling up — see SPEC.underside.
 *
 * Both shapes are built the same way: a thin wall swept from the underside
 * PLANE (the surface the part is laid on, so every wall reaches the bed) up to
 * the deck ceiling. The top is pushed 0.3 mm INTO the floor, which is already
 * solid, so the union's shape is unchanged and the floor stays `floorThk` — but
 * no face is exactly coplanar with the shell's ceiling. On a curve the two
 * surfaces are tessellated at different angles and never quite coincide; on a
 * STRAIGHT they are exactly parallel over a big flat rectangle, and without the
 * offset the union came back with 18 non-manifold edges.
 *
 * Both stop `key.ribThk + 0.5` from each face, clear of the end ribs and their
 * bowtie pockets — the key rises through that space.
 */
/**
 * FILL BEFORE CARVE, checked rather than remembered.
 *
 * Every op that ADDS material under the deck has to precede every op that cuts
 * a feature out of it. Broken three times in one session, each time silently
 * and each time differently:
 *
 *   · the fill ran after `jointOps` and put plastic back into the bowtie pocket
 *     that had just been cut, then sealed the remains into a void — the part
 *     exported as TWO SHELLS
 *   · the same order would have refilled the elevator's car shaft, whose slot
 *     is a subtraction issued by the piece itself
 *   · a mis-targeted edit removed the export fill entirely and every piece went
 *     from a 10 mm worst span to 48-66 with nothing failing
 *
 * The first two are ordering, the third is absence, and a comment saying "fill
 * first" caught none of them. So the fill is TAGGED where it is produced and
 * this asserts the tag never appears after a SUBTRACTION. It is cheap — a scan
 * of a list of at most a few dozen entries — and it fails loudly at build time
 * rather than quietly in a printed part.
 *
 * It deliberately does NOT require all additions before all subtractions: the
 * elevator adds its housing and then cuts its shaft, which is correct.
 */
export const FILL_TAG = 'underside-fill';

export function assertFillBeforeCarve(ops, piece) {
    let cut = -1;
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].op === SUBTRACTION && cut < 0) cut = i;
        if (ops[i].tag === FILL_TAG && cut >= 0) {
            throw new Error(
                `op order: the under-deck fill for ${piece?.type ?? 'piece'} is at ${i}, `
                + `after a SUBTRACTION at ${cut}. Everything that carves must follow `
                + `everything that fills — see assertFillBeforeCarve.`);
        }
    }
    return ops;
}

/**
 * FILL THE CAVITY. One rule for every piece that has one.
 *
 * This used to be three rules chosen by shape — spines along a straight, ribs
 * across a curve, nothing at all for the flat platforms — each with a capital
 * flared at the ceiling so the slicer would anchor to it. Audited from the
 * geometry (`scripts/overhang_audit.mjs`, which measures how far a ceiling has
 * to bridge before it lands on something) that scheme leaves 24 mm spans on a
 * straight, 24 on a curve and 36 on a platform, against 6-12 mm when the cavity
 * is simply filled. The filled part is also FASTER despite being heavier,
 * because sparse infill lays down quicker than tall thin walls: the curve goes
 * 3h46 -> 3h01 for +9 g and the straight 1h20 -> 1h15 for +6 g.
 *
 * It is one solid swept between the underside and the floor, so it carries no
 * shape-specific reasoning at all and cannot be got wrong for the next piece
 * type. Brett, on the ribbed switch: "it looks more like a CSG union of the two
 * without really looking at it from a new minimalistic but print ready
 * structure." This is that structure. The slicer, not us, decides how much
 * plastic goes inside it.
 */
function undersideSupportOps(piece, spec) {
    // A CAVITY IS NOT A TILT. This asked `laysOnUnderside`, which answers "is
    // this printed tilted onto its underside plane" and is FALSE for the flat
    // start and end platforms, their drop being zero. They were therefore given
    // nothing while having the plainest cavity in the project.
    if (piece.skirtStyle !== 'minimal') return [];     // the arcade holds a viaduct up
    // ELEVATORS TOO. This skipped them as a "solid block from the rim up to
    // the deck", which is true only where the HOUSING is: it spans s 40-110,
    // and the landings either side of it carry deck over open channel — 9.8 mm
    // of cavity at the entry and 100 mm at the exit. Audited, that left the
    // elevator the one piece in the library failing the span gate, 24 mm across
    // 7 clusters and 891 mm2, while everything else sat at 12 or under.
    if (!(piece.planLen > 0)) return [];
    const lying = laysOnUnderside(piece, spec);
    const pl0 = undersidePlane(piece, spec);
    // THE SAME EXPRESSION `skirtBottom` USES: a rim-down piece's cavity floor is
    // its RIM, not the underside plane, and three places expressing one surface
    // is what once put the boss in mid-air.
    // AN ELEVATOR HAS NO UNDERSIDE PLANE WORTH CONSULTING. `undersidePlane`
    // fits a plane to the deck, and an elevator's deck is not a ramp — it is a
    // flat at 11.8, a lift, and a flat at 102. The best-fit plane through that
    // climbs steadily and reaches 85 mm at the exit end, so `max(rimY, plane)`
    // started the fill 75 mm up and left the exit LANDING floating: probed at
    // (138, -8) the part had material only from 75 to 102.3, with nothing
    // beneath it. The elevator prints rim-down, so its cavity floor is the RIM
    // and nothing else.
    const floorAt = (x, z) => (lying ? pl0.at(x, z)
        : (piece.isElevator || piece.type === 'elevator')
            ? piece.rimY
            : Math.max(piece.rimY, pl0.at(x, z)));

    // WIDE AT THE DECK, CLEAR OF THE WALL AT THE SOLE — and the taper is the
    // whole point, because the two ends of the fill want opposite things.
    //
    // At the SOLE the fill's face must not run parallel to the wall. Reaching
    // `innerWidth/2 + wall/2` buries it INSIDE the 2.4 mm wall, between the
    // channel at 24 and the sole edge at 26.4, where the boolean has two
    // near-parallel faces to reconcile against it: 100 degenerate triangles at
    // the bed, which Brett found in the app's mesh — "it happens as a small
    // kind of pie slice on the side that widens". Swept: 25.2 gives 100, the
    // sole edge 26.4 gives 601, exactly ON the wall at 24.00 the mesh goes
    // NON-MANIFOLD, and 0.5 clear of it gives 5.
    //
    // But a fill that clears the wall for its WHOLE height is a separate body,
    // so the slicer lays a full set of perimeters down each side of the gap
    // instead of merging into the wall. That costs 15.6 g and 29 minutes on a
    // curve, and it costs the same whether the gap is 0.1 or 0.5 — measured,
    // all four gaps came out at ~116 g against 100.7 for the merged one. The
    // price is having a gap at all, not its width.
    //
    // So the fill merges into the wall at the deck, where merging is free, and
    // pulls clear of it at the sole, which is the only place the slivers formed:
    // 102.8 g and 18 slivers, against 116.3/5 for a straight-sided fill and
    // 100.7/100 for the buried one. Most of the saving, most of the fix.
    const uTop = piece.innerWidth / 2 + spec.wall;    // merged into the wall
    const uBot = piece.innerWidth / 2 - 0.5;          // clear of it
    // FULL LENGTH, not rib to rib. Inside an end rib this is a union with solid
    // material and adds nothing; at a face that has NO rib — the start
    // platform's bumper end — stopping at `ribThk` left a 24 mm span hanging
    // over the first 11.5 mm, which was the last cluster on the whole part.
    // 0.5 mm shy of each face so nothing can protrude past it.
    const s0 = 0.5, s1 = piece.planLen - 0.5;
    if (s1 - s0 < 2) return [];
    // AND THE TOP FOLLOWS THE DECK. Across a switch's frog the deck leans (see
    // frogBankKnots) while the station frame stays level, so a level fill top
    // leaves a wedge of void under the raised side — 3.7 mm at the wall on a
    // 7.9 deg bank. The span audit does not see it, because it is a shallow
    // taper rather than a wide flat ceiling, but the slicer does: it is the
    // difference between a switch that slices silent and one that reports a
    // floating cantilever. Zero bank on every other piece, so this is the fill
    // it has always been elsewhere.
    const topAt = (u, tb) => -spec.floorThk + 0.3 + u * tb;
    const N = Math.max(2, Math.ceil((s1 - s0) / 3) + 1);
    const stations = [], profiles = [];
    for (let i = 0; i < N; i++) {
        const s = s0 + ((s1 - s0) * i) / (N - 1);
        const p = planPosAt(piece, s), y = deckYAt(piece, s);
        const right = [Math.sin(p.h), 0, -Math.cos(p.h)];
        const tb = Math.tan(bankAt(piece, s));
        stations.push({ s, origin: [p.x, y, p.z], right });
        const bot = (u) => floorAt(p.x + right[0] * u, p.z + right[2] * u) - y;
        profiles.push([[-uBot, bot(-uBot)], [uBot, bot(uBot)],
                       [uTop, topAt(uTop, tb)], [-uTop, topAt(-uTop, tb)]]);
    }
    return [{ op: ADDITION, tag: FILL_TAG,
        geometry: toBufferGeometry(sweepSolid(profiles, stations)) }];
}

export function buildPieceExportGeometry(piece, opts = {}) {
    // Do the booleans at the origin, not at the piece's address in the tower.
    // The display path needs world coordinates and these builders share its
    // helpers, so without this a curve high in a spiral ran its CSG out at
    // x~400, y~135 and paid for it in float precision. See pieceInFrame.
    const frame = pieceFrame(piece);
    piece = pieceInFrame(piece, frame);
    opts = { ...opts, support: supportInFrame(opts.support, frame) };
    const spec = opts.spec ?? SPEC;
    const hasEntryJoint = opts.hasEntryJoint ?? !piece.isImplicitStart;
    const hasExitJoint = opts.hasExitJoint ?? piece.type !== 'end';
    const stations = supportStations(opts.support, piece);
    const shell = fineShell(piece, spec, stations);
    const ops = [];
    // UNDER-DECK FILL AND EXPERIMENTS ENTER HERE, AND ONLY HERE.
    //
    // Four curve variants were built in scratchpad scripts that CONCATENATED
    // ribs and lattice onto the shell instead of unioning them, and every score
    // taken off the resulting non-manifold meshes was void (see HANDOFF §3.2).
    // The fix is not discipline, it is a seam: `extraOps` is handed the piece
    // already in its own frame and its ops go through `csgChain` with the rest,
    // so an experiment is manifold by construction or it is not built at all.
    //
    // BEFORE THE JOINTS AND THE BOSS, because everything after this CARVES: the
    // bowtie pocket, the socket bore, the engraved code. Filling last put the
    // plastic straight back into the pocket that had just been cut — the key
    // throat tests caught that — and sealed what was left of it into an
    // internal void, so the part exported as two shells. Fill the cavity first,
    // then cut the features out of it; the order is the intent.    //
    // BEFORE THE ELEVATOR'S OPS TOO, because its slot is a SUBTRACTION: filled
    // afterwards the fill puts the car's shaft back. The elevator is the only
    // piece that carves before the general fill would otherwise run.
    if (opts.extraOps) ops.push(...opts.extraOps(piece, spec));
    else ops.push(...undersideSupportOps(piece, spec));

    ops.push(...elevatorOps(piece, spec));
    ops.push(...startBumperOps(piece, spec));

    if (hasEntryJoint) {
        // seam's uphill deck = this entry + the waterfall step
        ops.push(...jointOps(
            { ...piece.entry }, piece.entryDeck,
            piece.entryDeck + spec.waterfallStepMm,
            skirtBottom(piece, { ...piece.entry }, spec),
            piece.entryWidth ?? piece.innerWidth, spec,
            (d) => deckYAt(piece, Math.min(piece.planLen, d))
        ));
    }
    if (hasExitJoint) {
        ops.push(...jointOps(
            { x: piece.exit.x, z: piece.exit.z, h: piece.exit.h + Math.PI },
            piece.exitDeck, piece.exitDeck,
            skirtBottom(piece, { x: piece.exit.x, z: piece.exit.z, h: piece.exit.h + Math.PI }, spec),
            piece.exitWidth ?? piece.innerWidth, spec,
            (d) => deckYAt(piece, Math.max(0, piece.planLen - d))
        ));
    }
    ops.push(...bossOps(piece, spec, opts.support));
    ops.push(...engraveOps(piece, opts.code ?? pieceCode(piece, GEOMETRY_VERSION), spec));
    const solid = csgChain(shell, assertFillBeforeCarve(ops, piece), opts.simplifyTol);
    return opts.forPrint ? tiltOntoUnderside(solid, piece, spec) : solid;
}

/**
 * PRINT ORIENTATION: lay a `minimal` piece on its own underside.
 *
 * The whole point of the minimal variant is a constant-depth underside, and a
 * constant-depth underside under a straight ramp is a PLANE — it just is not a
 * horizontal one. Printed rim-down, that plane is a wall bottom ramping at
 * 11.22°, which advances 1.01 mm per 0.2 mm layer: a 78.8° overhang against
 * the 45-60° FDM tolerates, so the slicer plants tree supports under the whole
 * length of the part (measured: 44.66 g of support against 72.04 g of model).
 * Rotated by its own slope the plane is on the bed and the overhang is gone.
 *
 * IT IS NOT A ROTATION OF THE WHOLE LIBRARY. Three conditions, all necessary:
 *
 *  - `minimal` only. A viaduct piece already has a flat rim on the bed.
 *  - NO RADIUS. A curve's constant-depth underside is a helicoid, measured
 *    5.15 mm from its own best-fit plane, and no rotation flattens it. A curve
 *    has to have its underside CUT as a plane first — see TODO §4 step 5.
 *  - The boss has to reach the plane, which is `collarFits` — at the standard
 *    slope, `SPEC.skirt.minimalDepthMm >= 15.21`. Below that the collar cannot
 *    be built without protruding past the plane, and the piece laid down
 *    balances on it: the first version of this measured 2 mm² of bed contact
 *    against 618 rim-down, and was reverted for it.
 *
 * Modelled Y-up with the ramp descending along +X, so this is a rotation about
 * Z through the deck's own slope angle — a proper rotation, so a chiral part
 * is never mirrored. Applied to the EXPORT mesh only: the scene keeps assembly
 * orientation, because that is where you check whether a tower stands up.
 */
export function tiltOntoUnderside(solid, piece, spec = SPEC) {
    if (!laysOnUnderside(piece, spec)) return solid;
    // Rotate the underside plane's normal onto +Y. For a straight this is the
    // pitch about Z it always was; for a curve the plane is skewed as well as
    // pitched, so it takes a general rotation about a horizontal axis. One
    // Rodrigues rotation covers both, and a rotation is a proper one — a
    // chiral part is never mirrored.
    const pl = undersidePlane(piece, spec);
    const len = Math.hypot(pl.a, 1, pl.b);
    const n = [-pl.a / len, 1 / len, -pl.b / len];
    const cos = n[1], sin = Math.hypot(n[0], n[2]);
    if (sin < 1e-9) return solid;
    const k = [-n[2] / sin, 0, n[0] / sin];          // unit axis = n x Y
    const p = solid.positions ?? solid.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
        const v = [p[i], p[i + 1], p[i + 2]];
        const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
        const cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
        for (let j = 0; j < 3; j++) p[i + j] = v[j] * cos + cr[j] * sin + k[j] * kv * (1 - cos);
    }
    return solid;
}

/**
 * Whether a piece is exported lying on its underside — the same test the
 * collar is built on, exposed so a test can assert the two agree.
 */
export const printsLyingDown = (piece, spec = SPEC) => laysOnUnderside(piece, spec);

/**
 * Where a switch's code goes: which rail, and how far along.
 *
 * The gate rail — the wall opposite the branch — because the branch rail has
 * the branch route running alongside it for 110 mm of a 150 mm tile. The catch
 * is that the gate rail is exactly the one slotted away over the blade's
 * length, so the code starts after the slot rather than at the usual margin.
 * Aimed at the slot it cut into thin air and half of it silently vanished.
 */
function switchEngraveSpot(mainPiece, branchPiece, spec = SPEC) {
    const pin = gatePinPosition(mainPiece, branchPiece);
    return { side: pin.hingeSide, sStart: pin.s + GATE.len + 3 };
}

/**
 * Switch part: union of the straight-through and diverging shells, one entry
 * joint, two exit joints, a boss, and a vertical gate-pin bore at the fork.
 */
export function buildSwitchExportGeometry(mainPiece, branchPiece, opts = {}) {
    // Both halves are merged into ONE solid, so they must share a frame —
    // normalise the branch against the main piece's, never its own.
    const frame = pieceFrame(mainPiece);
    mainPiece = pieceInFrame(mainPiece, frame);
    branchPiece = pieceInFrame(branchPiece, frame);
    // one underside for one solid — see undersidePlane
    const planeGroup = [mainPiece, branchPiece];
    mainPiece = { ...mainPiece, planeGroup };
    branchPiece = { ...branchPiece, planeGroup };
    opts = { ...opts, support: supportInFrame(opts.support, frame) };
    const spec = opts.spec ?? SPEC;
    const stations = supportStations(opts.support, mainPiece);
    const shell = fineShell(mainPiece, spec, stations);
    const ops = [{ op: ADDITION, geometry: fineShell(branchPiece, spec) }];

    // THE FILL GOES IN FIRST, before the frog is opened and before the joints.
    // Everything after this CARVES — the route envelopes, the bowtie pockets,
    // the socket bore, the gate seat, the code — so a cavity filled here is one
    // the carving still gets to cut through. Filled last it put plastic back
    // into the pockets and sealed them into internal voids.
    //
    // One fill per ROLE, and `extraOps` overrides per role: returning nothing
    // for one falls back to that role's default, so a caller can treat the two
    // halves differently. The hook used to be missing here entirely, silently —
    // a solid-cavity switch was built, sliced and compared against the ribbed
    // one and the two came out byte-identical at 142.6 cm3.
    // ONE FILL PER ROLE. Merging the two into a single solid before the union
    // was tried, on the theory that their overlap across the frog was what left
    // 178 degenerate triangles at the bed. It is not, and it made it worse
    // (227): each route's fill runs close to the OTHER route's walls at shallow
    // angles all through the frog, which no amount of pre-resolving fixes.
    // The remaining slivers are a switch-only artefact of two channels crossing
    // — the single pieces are down to 0-5 — and the part is watertight with a
    // 12 mm worst span either way.
    for (const pc of [mainPiece, branchPiece]) {
        ops.push(...(opts.extraOps?.(pc, spec) ?? undersideSupportOps(pc, spec)));
    }

    // open the frog: neither route's rails may cross the other's channel
    ops.push(
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(mainPiece, spec, 4)) },
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(branchPiece, spec, 4)) }
    );

    ops.push(...jointOps(
        { ...mainPiece.entry }, mainPiece.entryDeck,
        mainPiece.entryDeck + spec.waterfallStepMm,
        skirtBottom(mainPiece, { ...mainPiece.entry }, spec),
        mainPiece.entryWidth ?? mainPiece.innerWidth, spec,
        (d) => deckYAt(mainPiece, Math.min(mainPiece.planLen, d))
    ));
    for (const pc of [mainPiece, branchPiece]) {
        ops.push(...jointOps(
            { x: pc.exit.x, z: pc.exit.z, h: pc.exit.h + Math.PI },
            pc.exitDeck, pc.exitDeck,
            skirtBottom(pc, { x: pc.exit.x, z: pc.exit.z, h: pc.exit.h + Math.PI }, spec),
            pc.exitWidth ?? pc.innerWidth, spec,
            (d) => deckYAt(pc, Math.max(0, pc.planLen - d))
        ));
    }
    ops.push(...bossOps(mainPiece, spec, opts.support));

    ops.push(...gateSeatOps(mainPiece, branchPiece, spec));
    ops.push(...engraveOps(mainPiece, opts.code ?? pieceCode(mainPiece, GEOMETRY_VERSION), spec,
        switchEngraveSpot(mainPiece, branchPiece, spec)));

    const solid = csgChain(shell, assertFillBeforeCarve(ops, mainPiece));
    return opts.forPrint ? tiltOntoUnderside(solid, mainPiece, spec) : solid;
}

/**
 * Gate pivot: the blade hinges on the wall OPPOSITE the branch, just before
 * the mouth. Parked flat along that wall → figure runs straight through;
 * swung inward → it sweeps across the channel and deflects the figure into
 * the diverging route (how the original playset gates work).
 */
/**
 * The switch-side half of the gate: a boss to carry the pivot bore, a slot in
 * the rail for the blade to live in, and the bore itself.
 *
 * The BOSS sits below the deck. A Ø3.5 bore is wider than the 2.4 mm wall it
 * would otherwise pass through, so the wall is thickened locally — and put
 * below the deck it takes nothing from the walking channel.
 *
 * The SLOT removes the rail over the blade's length. That is the point of the
 * whole arrangement: parked, the blade FILLS the slot and is that stretch of
 * wall, so the figure runs straight past it; swung, the blade leaves and the
 * gap it leaves behind is outboard of the branch's own wall, which by then has
 * taken over.
 */
function gateSeatOps(mainPiece, branchPiece, spec) {
    const pin = gatePinPosition(mainPiece, branchPiece);
    const h = mainPiece.entry.h;
    const face = { x: mainPiece.entry.x, z: mainPiece.entry.z, h };
    const Wi = mainPiece.innerWidth / 2, Wo = Wi + spec.wall;
    const side = pin.hingeSide;
    const deck = pin.deckY;

    // Boss: local thickening under the wall around the pin bore, and NO
    // further. It used to run from the rim, so a socket needing ~15 mm of
    // material grew a column the full depth of the skirt down to the bed —
    // visible as a post beside the gate and pure waste. bossR's own comment
    // already said "below the deck"; the extrude did not agree.
    //
    // The bore reaches 15 mm under the deck, so the barrel covers that plus a
    // little, then a cone closes it off. The cone is as tall as it is wide,
    // i.e. 45 deg from vertical, well inside what prints unsupported — a flat
    // disc there would be a ceiling hanging off the wall.
    const bossDrop = 17;
    const nB = Math.max(16, segmentsForCircle(GATE.bossR));
    // sweepSolid wants (u,v) = (x,-z), same convention bossBoreSolids uses
    const ring = (r) => circlePlan(r, nB).map(([px, pz]) => [pin.x + px, -(pin.z + pz)]);
    const at = (y) => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] });
    const boss = toBufferGeometry(sweepSolid(
        [ring(0.4), ring(GATE.bossR), ring(GATE.bossR)],
        [deck - bossDrop - GATE.bossR, deck - bossDrop, deck + 0.2].map(at)));

    // slot: the rail, removed over the blade's length
    const slot = toBufferGeometry(extrudePolygonY(planToWorld([
        [(Wi - 0.3) * side, pin.s], [(Wo + 1.5) * side, pin.s],
        [(Wo + 1.5) * side, pin.s + GATE.len], [(Wi - 0.3) * side, pin.s + GATE.len]
    ], face), deck + 0.05, deck + spec.railHeight + 2));

    const bore = new THREE.CylinderGeometry(GATE.boreR, GATE.boreR,
        spec.railHeight + spec.floorThk + 20, segmentsForCircle(GATE.boreR));
    bore.translate(pin.x, deck + spec.railHeight / 2 - 4, pin.z);

    return [
        { op: ADDITION, geometry: boss },
        { op: SUBTRACTION, geometry: slot },
        { op: SUBTRACTION, geometry: bore }
    ];
}

/**
 * Where the gate blade pivots, and how far it swings.
 *
 * It is a railway POINT BLADE, not a barrier: parked it continues the main
 * route's wall so the figure runs straight past; swung, its tip lands on the
 * branch's outer wall so the two form one continuous curve into the turn.
 * Both positions are therefore read off the geometry rather than chosen:
 *
 *  - the hinge goes where the branch's outer wall first LEAVES the main's,
 *    which is the actual point of divergence (~25 mm in on the standard
 *    switch). It used to sit at a flat 16 mm and 4 mm inboard of the wall —
 *    floating in mid-channel, upstream of anything to divert.
 *  - the swing is whatever puts the blade's tip on the branch's outer wall at
 *    the blade's far end (~18 deg). It used to be asin((innerWidth-4)/50),
 *    which has no relation to the blade and came out at 62 deg: a 52 mm blade
 *    thrown 46 mm across a 48 mm channel, i.e. a door, and one that closed the
 *    branch as surely as the main since at 16 mm in the two routes are still
 *    the same channel.
 */
export function gatePinPosition(mainPiece, branchPiece) {
    const h = mainPiece.entry.h;
    const dir = [Math.cos(h), Math.sin(h)];
    const right = [Math.sin(h), -Math.cos(h)];
    // THE HINGE IS ON THE WALL OPPOSITE THE BRANCH, and it is DERIVED, not
    // tabulated. This was `switchL ? 1 : -1` with a comment asserting which way
    // a switchL curls — true until the turn sign was corrected in 2.6.0, after
    // which the pin sat on the SAME wall as the branch on both hands: the blade
    // would have hinged into the diverging route instead of across it. Brett
    // caught it: "when you flipped the left/right switches you moved (or didn't
    // move) the hole that the gate arm plugs into."
    //
    // Reading the branch's actual divergence means a future sign change cannot
    // desynchronise this again — there is nothing left to keep in step.
    const hingeSide = (() => {
        if (!branchPiece) return mainPiece.switchType === 'switchL' ? -1 : 1;
        const e = planPosAt(branchPiece, branchPiece.planLen);
        const lat = (e.x - mainPiece.entry.x) * right[0] + (e.z - mainPiece.entry.z) * right[1];
        return lat >= 0 ? -1 : 1;          // opposite the side the branch leaves on
    })();
    const wall = mainPiece.innerWidth / 2;

    /** Branch's outer (hinge-side) wall as a lateral offset in the main frame. */
    const branchOuter = (s) => {
        if (!branchPiece) return wall;
        const q = planPosAt(branchPiece, Math.min(s, branchPiece.planLen));
        const dx = q.x - mainPiece.entry.x, dz = q.z - mainPiece.entry.z;
        const off = (dx * right[0] + dz * right[1]) * hingeSide;
        const turn = Math.abs(branchPiece.turn ?? 0) * Math.min(s, branchPiece.planLen)
            / (branchPiece.planLen || 1);
        return off + (branchPiece.innerWidth / 2) / Math.max(0.2, Math.cos(turn));
    };

    // divergence: first station where the branch wall has pulled clear
    let sHinge = 0;
    while (sHinge < mainPiece.planLen && wall - branchOuter(sHinge) < 0.5) sHinge += 1;
    sHinge = Math.min(sHinge, mainPiece.planLen - GATE.len);

    const reach = Math.max(0, wall - branchOuter(sHinge + GATE.len));
    // pivot on the wall line: parked, the blade's inner face IS the wall
    const lat = (wall + GATE.vaneThk / 2) * hingeSide;
    return {
        x: mainPiece.entry.x + dir[0] * sHinge + right[0] * lat,
        z: mainPiece.entry.z + dir[1] * sHinge + right[1] * lat,
        deckY: mainPiece.entryDeck - (sHinge / mainPiece.planLen) * mainPiece.drop,
        hingeSide,
        s: sHinge,
        yawParked: h,
        // + hingeSide, not −: the tip's lateral offset moves by −len·sin(δ),
        // so a positive δ carries it INTO the channel on the +right wall.
        yawDiverting: h + hingeSide * Math.asin(Math.min(0.95, reach / GATE.len))
    };
}

/**
 * Section-view helper: removes everything on the +normal side of a plane and
 * CAPS the result, because the cut is a real boolean rather than a rendering
 * clip plane. A clip plane would expose the shell's back faces and the joint
 * would read as hollow — exactly the confusion these views exist to remove.
 * Axis-aligned unit normals only, which is all the fixed vignettes need.
 * Needs initCSG().
 */
export function sectionGeometry(geom, { origin, normal, extent = 800 }) {
    const box = new THREE.BoxGeometry(extent, extent, extent);
    const h = extent / 2;
    box.translate(
        origin[0] + normal[0] * h,
        origin[1] + normal[1] * h,
        origin[2] + normal[2] * h
    );
    return csgChain(geom, [{ op: SUBTRACTION, geometry: box }]);
}

/** Printable connector key — one per seam, prints flat in stacks. */
export function buildKeyGeometry(spec = SPEC, opts = {}) {
    const K = spec.key;
    const h = K.height - 2 * spec.jointClearanceMm;
    if (opts.code) {
        const plain = buildKeyGeometry(spec);
        // the key prints flat, so its top face is the last layer laid down —
        // the crispest surface on the part and the one you are holding when
        // you want to know what it is
        const lines = String(opts.code).split(' ');
        const size = blockSizeMm(lines, { capHeight: spec.engrave.capHeight, strokeMm: spec.engrave.minFeature });
        const marks = engraveFlatOps(
            lines,
            [-size.widthMm / 2, h, size.heightMm / 2],
            [1, 0, 0], [0, 0, -1], spec
        );
        return marks.length ? csgChain(toBufferGeometry(plain), marks) : plain;
    }
    // drawn pre-distorted so it PRINTS at nominal — see SPEC.key.printComp
    const comp = K.printComp ?? { neckMm: 0, tipMm: 0, depthMm: 0 };
    const shape = {
        neckHalf: K.neckHalf - comp.neckMm, tipHalf: K.tipHalf + comp.tipMm,
        depth: K.depth + (comp.depthMm ?? 0), tipChamfer: K.tipChamfer
    };
    const nominal = bowtieKeyPlan(shape).map(([x, z]) => [x, -z]);
    // THE DRIVE TAPER — see SPEC.key.taperLeadMm. The key rises into its seat
    // from the rim, so the LEADING end is the top: it is drawn under nominal so
    // it enters, and the trailing end over nominal so it wedges as the last of
    // it is driven home. A negative offset is an OUTWARD one; insetPolygon
    // re-intersects the offset edges either way, so the bowtie's rake is
    // preserved at both ends instead of being scaled about a centre (which
    // would move the tips and the waist by different amounts).
    const grip = insetPolygon(nominal, -(K.taperGripMm ?? 0));
    const lead = insetPolygon(nominal, K.taperLeadMm ?? 0);
    // a TRUE inward offset, so the chamfer band's quads stay planar and the
    // chamfer is the same 0.5 mm on every edge — see insetPolygon
    // 0.5 mm chamfers top and bottom: elephant-foot proof and drops into
    // its pockets without snagging a sharp corner
    return sweepSolid(
        [insetPolygon(grip, 0.5), grip, lead, insetPolygon(lead, 0.5)],
        [0, 0.5, h - 0.5, h].map(y => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
    );
}

/**
 * Printable switch gate: pivot hub + vane that deflects the figure into the
 * selected route, with a pin that drops into the deck bore. Prints on its side.
 */
/**
 * `forPrint` turns the gate over to stand on its blade with the PIN UP.
 *
 * Modelled, the pin hangs 8 mm below everything else — that is the assembly
 * frame, where the hub sits on the deck and the pin reaches down into the
 * bore. Exported straight from that frame the part lands on the bed on the
 * tip of its pin: 3.4 mm² of contact with the whole blade cantilevered in
 * mid-air. Turned over it rests on the blade's top edge and the hub's top
 * face — 148 mm², both flat, neither functional — and the pin becomes a
 * vertical tube whose bore and slot print as straight extrusions with no
 * overhang and no bridge across the one surface here that has to be round.
 *
 * 180° about X: a proper rotation, so the C's slot stays on the side away
 * from the vane.
 */
export function buildGateGeometry(spec = SPEC, opts = {}) {
    if (opts.forPrint) {
        const g = buildGateGeometry(spec);
        const p = g.positions ?? g.attributes.position.array;
        for (let i = 0; i < p.length; i += 3) { p[i + 1] = -p[i + 1]; p[i + 2] = -p[i + 2]; }
        return g;
    }
    const PIN_L = 8;
    // hub + pin as a stacked-radius sweep along Y (vane added via CSG)
    const levels = [
        { y: -PIN_L, r: GATE.pinR - 0.35 },    // lead-in: the C has to start in
        { y: -PIN_L + 1, r: GATE.pinR },
        { y: 0, r: GATE.pinR },
        { y: 0, r: GATE.hubR },                // hub, shoulder onto the deck
        { y: spec.railHeight - 2, r: GATE.hubR }
    ];
    const nHub = segmentsForCircle(Math.max(...levels.map(l => l.r)));
    const profiles = levels.map(l => circlePlan(l.r, nHub).map(([x, z]) => [x, -z]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    const hub = toBufferGeometry(sweepSolid(profiles, stations));
    const vane = new THREE.BoxGeometry(GATE.vaneThk, spec.railHeight - 2, GATE.len);
    vane.translate(0, (spec.railHeight - 2) / 2, GATE.len / 2 - 2);

    // The C: a hollow through the pin and one axial slot. Both stop 0.6 mm
    // short of the shoulder so the hub stays solid — the spring is the pin,
    // and a slot carried up into the hub would only weaken the part where the
    // vane is cantilevered off it.
    const cavity = new THREE.CylinderGeometry(GATE.pinBoreR, GATE.pinBoreR, PIN_L + 1,
        segmentsForCircle(GATE.pinBoreR));
    cavity.translate(0, -PIN_L / 2 - 0.6, 0);
    // Slot faces AWAY from the vane, so the C opens across the axis the vane
    // loads it on: the blade's push closes the gap rather than spreading it.
    const slot = new THREE.BoxGeometry(GATE.pinSlot, PIN_L + 1, GATE.pinR + 1);
    slot.translate(0, -PIN_L / 2 - 0.6, -(GATE.pinR + 1) / 2);
    return csgChain(hub, [
        { op: ADDITION, geometry: vane },
        { op: SUBTRACTION, geometry: cavity },
        { op: SUBTRACTION, geometry: slot }
    ]);
}

// ---------------------------------------------------------------------------
// Support pillars & interlocking scenery (shared hex tenon/socket standard)
// ---------------------------------------------------------------------------

function stackedHex(levels) {
    const profiles = levels.map(l => hexPlan(l.af).map(([x, z]) => [x, -z]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    return sweepSolid(profiles, stations);
}

/**
 * A ROUND SOCKET FOR A HEX TENON — the inversion, and Brett's second idea:
 * "the whole round and the post a hexagon, so that the corners of the hexagon
 * can drive themselves into the cylindrical hole".
 *
 * It puts each feature where FDM is good. An EXTERNAL hex corner is only a
 * direction change and comes out crisp; it is the INTERNAL corners a nozzle
 * cannot reach into, and those are what round off and make the current hex
 * socket's fit a lottery. A round hole has none. Six corners also yield far
 * more readily than six lines, so it absorbs more spread again.
 *
 * The cost, and it is the one that matters for a toy taken apart and rebuilt:
 * corners driving into a round hole is PLASTIC, not elastic. It swages the bore
 * once and each reassembly starts from a larger hole. Worth measuring against
 * the cylinder-in-hex rather than assuming either way.
 *
 * Mirrors hexSocketSolid: a mouth flare so the tenon starts, and a 45 deg roof
 * on the blind end so the slicer does not plant support inside a hole that can
 * never be reached.
 */
/**
 * A SLOTTED HEX SOCKET — the pillar joint, settled in plastic 2026-08-18.
 *
 * A hex tenon in a plain ROUND bore never worked across the real spread of
 * printed tenons, and now we know why: a cylinder can only touch a hex on its
 * CORNERS, and corners are the one feature a 0.4 mm nozzle cannot reproduce —
 * it rounds them going out on a post and fills them in going into a hole. So
 * the grip rode on the least repeatable dimension on the part, which is why
 * `boreDia` moved five times in a single day and why, on the ladder, "none of
 * the round bore hole collets felt like they worked with the range of tenons
 * I have."
 *
 * A hex socket beds on six FLATS over the whole engagement instead, and three
 * slots let it open for an oversize tenon. Measured against nine bases, two
 * copies of each rung agreeing:
 *   8.75 AF (the shipped socket, slotted)  too loose on the smallest
 *   8.60 AF                                acceptable on the smallest, snug on
 *                                          the largest — "acceptable because of
 *                                          collet flex"
 *   8.45 AF                                too tight on the largest
 *
 * THE TENON IS UNTOUCHED, which was the whole constraint: it still mates with
 * every hex socket in every ramp and curve already printed.
 *
 * The slots sit at 60/180/300 deg, where BOTH hexes put a corner — the shaft's,
 * so the cut misses the engraved flat, and the bore's, so each finger keeps two
 * whole flats to bear on. They run out past the shaft's 8.66 corner radius, so
 * they SEVER the shell: the first layer is three islands of ~38 mm2 rather than
 * one of 116. That is inherent — a collet's fingers must be free at the mouth
 * and the mouth is at the bed — so these parts want a brim. See the CLAUDE.md
 * note on islands.
 */
function colletSocketOps(spec, cx = 0, opts = {}) {
    const AF = spec.socket.colletAF;
    const reach = spec.socket.colletSlotReach;
    const ops = [{ op: SUBTRACTION,
        geometry: hexSocketSolid(cx, 0, -0.5, spec.socket.depth, spec, AF) }];
    for (let i = 0; i < 3; i++) {
        const a = ((i + 0.5) / 3) * 2 * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rect = [[3.0, -0.5], [9.0, -0.5], [9.0, 0.5], [3.0, 0.5]]
            .map(([u, v]) => [cx + u * ca - v * sa, u * sa + v * ca]);
        ops.push({ op: SUBTRACTION,
            geometry: toBufferGeometry(extrudePolygonY(rect, -1, reach)) });
    }
    // AN INTEGRAL BRIM, OPT-IN, because the slots leave three first-layer
    // islands and one of them spaghettified on Brett's plate.
    //
    // It goes on AFTER the slots and is NOT slotted itself: while it is there
    // it ties the three fingers together, which is exactly what a first layer
    // needs and exactly what a collet must not have in service. So it is a
    // print aid — three snips at the slots and it peels off, and the joint is
    // the joint again. Slotting it would keep the islands and defeat the point.
    //
    // Annular, from just outside the bore's corner radius, so the socket mouth
    // stays clear and a tenon can still be trial-fitted before it comes off.
    // A slicer brim does the same job with no snipping; this exists because our
    // 3MF carries GEOMETRY ONLY and cannot ask for one (see the CLAUDE.md note
    // on Metadata/project_settings.config).
    if (opts.brim) {
        const B = spec.socket.brim;
        const n = segmentsForCircle(B.radiusMm);
        const ring = (r) => circlePlan(r, n).map(([x, z]) => [cx + x, -z]);
        ops.push({ op: ADDITION, geometry: toBufferGeometry(
            extrudePolygonY(ring(B.radiusMm), 0, B.thickMm)) });
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(
            extrudePolygonY(ring(B.innerR), -1, B.thickMm + 0.5)) });
    }
    return ops;
}

function roundSocketSolid(dia, yOpen, yEnd, roofY = null, cx = 0, cz = 0) {
    const r = dia / 2;
    const dir = Math.sign(yEnd - yOpen);
    const levels = [
        { y: yOpen, r: r + 0.6 },
        { y: yOpen + dir * 0.8, r },
        { y: yEnd, r }
    ];
    if (roofY != null && dir * (roofY - yEnd) > 0.2) {
        levels.push({ y: roofY, r: Math.max(0.3, r - Math.abs(roofY - yEnd)) });
    }
    const profiles = levels.map(l => circlePlan(l.r, 96).map(([x, z]) => [cx + x, -(cz + z)]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    return toBufferGeometry(sweepSolid(profiles, stations));
}

/**
 * A ROUND TENON FOR A HEX SOCKET — Brett's idea, and it explains the defect it
 * is meant to fix.
 *
 * A hex tenon in a hex socket is FACE contact: six flats, 4.3 mm wide by 8 mm
 * engaged. Face contact has almost no compliance, so 0.035 mm of interference
 * goes straight from "loose" to "will not move" — which is exactly the window
 * once thought to be measured between a foot's tenon and a riser's — but the
 * foot has since been remeasured at a riser's size and is NOT a special case,
 * and exactly the spread seen between three nominally identical feet off one
 * plate. When the process spread is as wide as the whole tolerance window, no
 * sizing change can work.
 *
 * A cylinder in the same hex is SIX LINE CONTACTS, tangent to the flats. Line
 * contact flattens locally at low force, so the same interference is absorbed
 * rather than resisted; it never reaches the corners, which is where a printed
 * hex is worst formed; and six symmetric contacts centre the part better than a
 * clearance hex fit does. It also prints as steady arc moves instead of six
 * direction changes a layer, and — unlike a blind hex bore — a shaft diameter
 * can actually be measured.
 *
 * Backward compatible on purpose: the inscribed circle of a hex IS its
 * across-flats, so this mates with every hex socket already printed.
 *
 * Sized deliberately OVERSIZE. Line contact absorbs oversize and does nothing
 * for undersize — a small cylinder in a big hex simply rattles — so every unit
 * wants to land in interference and let the contacts take up the spread.
 */
function roundTenon(dia, y0, y1, leadIn = 1.0) {
    const r = dia / 2;
    const levels = [
        { y: y0, r },
        { y: y1 - leadIn, r },
        { y: y1, r: Math.max(0.4, r - 0.7) }   // insertion chamfer, as the hex has
    ];
    // NOT `segmentsForCircle`. That holds the facet sagitta under FACET_TOL_MM
    // = 0.1 mm, which is right for a surface you look at and wrong for one that
    // mates: at this radius it returns a 15-gon whose ACROSS-FLATS is 0.18 mm
    // under the nominal diameter — two and a half times the 0.07 mm diametral
    // window this joint has to live in, and it would reintroduce the very thing
    // the cylinder exists to escape, a polygon whose fit depends on how its
    // corners happen to land against the socket's flats. 96 sides puts the
    // flat-to-corner difference at 0.004 mm, which is noise here.
    const segs = 96;
    const profiles = levels.map(l => circlePlan(l.r, segs).map(([x, z]) => [x, -z]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    return sweepSolid(profiles, stations);
}

const TENON_AF = SPEC.socket.hexAF - 2 * SPEC.jointClearanceMm; // 8.6
/**
 * Across-flats at the TIP of a tenon — see SPEC.socket.tenonTaperAF.
 *
 * A FUNCTION OF THE SPEC, not a constant folded from the default one. As a
 * constant it was computed at module load, so a caller passing a modified spec
 * got the default taper regardless — a fit-test plate built a "no taper"
 * riser that was byte-identical to the tapered one, and the comparison would
 * have been printed and read as meaningful. TENON_AF has the same hazard and
 * is left alone only because nothing overrides it.
 */
const tenonTipAF = (spec = SPEC) => TENON_AF - (spec.socket.tenonTaperAF ?? 0);

/** Hex support pillar with base flare and top tenon. Zero CSG. */
export function buildPillarGeometry(heightMm, spec = SPEC) {
    return toBufferGeometry(stackedHex([
        { y: 0, af: 24.8 },                                   // elephant-foot chamfer
        { y: 0.6, af: 26 },
        { y: 4, af: 26 },
        { y: 4, af: 15 },
        { y: heightMm, af: 15 },
        { y: heightMm, af: TENON_AF },
        { y: heightMm + spec.socket.depth - 2, af: tenonTipAF(spec) },
        { y: heightMm + spec.socket.depth - 1, af: tenonTipAF(spec) - 1.4 }  // insertion lead-in
    ]));
}

/**
 * STANDARD SUPPORT SYSTEM — no more cut-to-height "magic" pillars. A support
 * is one FOOT (flared base, 15 mm) plus stacked RISERS (15/30/60/120 mm),
 * all sharing the hex tenon/socket interlock. Any 15 mm-grid height is
 * reachable from five reusable part designs.
 */
/**
 * The JOG: an offset riser. Hex tenon up into a track piece's mid socket, a
 * flat arm, and a hex socket down for the riser stack — so a support column
 * can step sideways out of the way of the tier below without the TRACK having
 * to change shape for it.
 *
 * Exactly one grid unit tall, so it substitutes for a 15 mm riser instead of
 * adding an off-grid step and every stack still decomposes onto the grid.
 *
 * Prints flat on its own underside with no overhangs: the arm is a constant
 * 15 mm-tall slab between two hex bosses, and the socket opens downward to the
 * bed exactly as a riser's does.
 */
export function buildJogGeometry(spec = SPEC, opts = {}) {
    const H = SPEC.jog.heightMm, arm = SPEC.jog.armMm;
    const hex = (cx) => hexPlan(15).map(([x, z]) => [cx + x, -z]);
    const waist = 15 / 2 - 1.5;
    const at = (y) => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] });
    // one prism per end plus the bar between them; the union is a single slab
    const ends = [0, arm].map(cx => toBufferGeometry(
        sweepSolid([hex(cx), hex(cx)], [at(0), at(H)])));
    const bar = toBufferGeometry(extrudePolygonY(
        [[0, -waist], [arm, -waist], [arm, waist], [0, waist]], 0, H));
    // tenon on the socket end, so the jog is the TOP of the stack and the
    // riser it replaces goes on underneath
    const tenon = toBufferGeometry(sweepSolid(
        [hexPlan(TENON_AF).map(([x, z]) => [x, -z]),
         hexPlan(tenonTipAF(spec)).map(([x, z]) => [x, -z]),
         hexPlan(tenonTipAF(spec) - 1.4).map(([x, z]) => [x, -z])],
        [at(H), at(H + spec.socket.depth - 2), at(H + spec.socket.depth - 1)]));
    return csgChain(ends[0], [
        { op: ADDITION, geometry: bar },
        { op: ADDITION, geometry: ends[1] },
        { op: ADDITION, geometry: tenon },
        ...colletSocketOps(spec, arm, opts),
        ...hexFlatEngraveOps(opts.code ?? null, 15, 0, H, spec, { capHeight: 1.6 })
    ]);
}

/**
 * The foot's flare is 36 AF, up from 26.
 *
 * A column is a 15 mm hex shaft standing up to 600 mm; at 26 across the flats
 * the base gave it a 13 mm lever against its own height, and they went over
 * in use. 36 takes that to 18 and the bed contact from 533 mm² to 1022, for
 * 4 mm of extra flare height and no change to anything it mates with — the
 * tenon, the shaft and the 15 mm grid are all untouched.
 *
 * It is not made larger still because feet sit on the ground under adjacent
 * columns, and planPillarPositions only keeps columns 9 mm clear of the
 * SHAFT; two feet 40 mm apart would foul each other before the app noticed.
 */
export function buildSupportFootGeometry(spec = SPEC, opts = {}) {
    // The foot takes the round tenon too — see roundTenon. It has to: the foot's
    // tenon was once thought to measure 9.73 against a riser's 9.65; it does not,
    // it prints like a 15 mm pillar's, and
    // it is the joint Brett found "too tight" on one of three otherwise
    // identical prints. Leaving it hex would fix the loose end and keep the
    // tight one. The JOG is the only part that keeps a hex tenon, because its
    // angle is what aims the 45 mm offset.
    const round = opts.roundTenonDia;
    // `tenonTrimAF` takes a little off THIS tenon only. Brett, on the sweep
    // plate: "the support tenon when pushed all the way into the original
    // smallest bore on the 6-part sweep test becomes completely stuck ... We
    // might just need to make the support foot tenon slightly smaller." A
    // riser stuck on a riser can be worked apart; a riser stuck on the foot is
    // the bottom of the stack and there is nothing to brace against. So this
    // joint is allowed to be the loose one. Default 0 — it is only a special
    // case if a print says it has to be, which is what the fit plate asks.
    const trim = opts.tenonTrimAF ?? 0;
    const shoulderAF = TENON_AF - trim, tipAF = tenonTipAF(spec) - trim;
    const shaft = [
        { y: 0, af: 34.8 },                                  // elephant-foot chamfer
        { y: 0.6, af: 36 },
        { y: 4, af: 36 },
        { y: 4, af: 15 },
        { y: STANDARD.footHeight, af: 15 }
    ];
    const body = toBufferGeometry(round ? stackedHex(shaft) : stackedHex([
        ...shaft,
        { y: STANDARD.footHeight, af: shoulderAF },
        { y: STANDARD.footHeight + spec.socket.depth - 2, af: tipAF },
        { y: STANDARD.footHeight + spec.socket.depth - 1, af: tipAF - 1.4 }
    ]));
    // The foot's shaft is 11 mm of usable flat and FOOT needs 12, so its code
    // goes on the BASE — the one part in the library with a big flat disc
    // going spare, and where a part number has always lived on a printed part.
    // It is the bed-contact face, which costs nothing: the slicer just leaves a
    // hole in the first few layers.
    const marks = opts.code
        ? engraveFlatOps(String(opts.code).split(' '), baseMarkOrigin(opts.code, spec),
            [1, 0, 0], [0, 0, 1], spec)
        : [];
    const ops = [
        ...(round ? [{ op: ADDITION, geometry: toBufferGeometry(roundTenon(
            round, STANDARD.footHeight - 0.4, STANDARD.footHeight + spec.socket.depth - 1)) }] : []),
        ...marks
    ];
    return ops.length ? toBufferGeometry(csgChain(body, ops)) : body;
}

/** Centres a two-line block on a part's base plane (y = 0), reading from +Y. */
function baseMarkOrigin(code, spec) {
    const size = blockSizeMm(String(code).split(' '), { capHeight: spec.engrave.capHeight });
    return [-size.widthMm / 2, 0, -size.heightMm / 2];
}

/**
 * SPACER — the short adapter under a `minimal` piece.
 *
 * A minimal piece's underside follows the deck, so its socket mouth lands
 * wherever the deck happens to be rather than on the 15 mm grid, and the
 * riser ladder cannot compose under it. This makes up the remainder. It is
 * the jog's move applied to the pad: take the support's problem out of the
 * track piece rather than growing the piece to solve it.
 *
 * TWO of them, one for straights and one for curves — the decision is that a
 * lift shares the straight's, accepting ~0.1 mm at the pier (the waterfall
 * step is 0.25, so it is below noticing) rather than shipping two parts a
 * tenth apart that nobody could tell apart.
 *
 * THE BODY IS A D, and that is the whole point of its shape. Every other
 * support part — riser, foot, tower, jog — is a 15 AF hex, and a 17.5 spacer
 * beside a 15 riser is 2.6 mm different: invisible in a bag, and the wrong
 * one under a pier tilts the deck it carries. Round is unmistakable by eye
 * and by touch. The flat then earns its place three times: it carries the
 * code, which a plain cylinder has nowhere to put; it gives fingers
 * something to bear on, which is the one thing the hex body was doing; and
 * it is a rotational reference, so the code faces the same way when seated.
 *
 * Grooves count the variant — one ring for the short, two for the tall — so
 * the pair is told apart in isolation and not only side by side.
 */
export function buildSpacerGeometry(heightMm, spec = SPEC, opts = {}) {
    const R = 9;                       // Ø18: reads as a collar, not a post
    const FLAT = 6.6;                  // how far the flat cuts in from the axis
    const n = segmentsForCircle(R);
    const body = toBufferGeometry(sweepSolid(
        // hexRingPlan, not hexPlan: sweepSolid lofts profiles point-to-point,
        // so the hex tenon has to be sampled at the circle's own point count
        [circlePlan(R, n), circlePlan(R, n),
         hexRingPlan(TENON_AF, n), hexRingPlan(tenonTipAF(spec), n),
         hexRingPlan(tenonTipAF(spec) - 1.4, n)
        ].map(pl => pl.map(([x, z]) => [x, -z])),
        [0, heightMm, heightMm,
         heightMm + spec.socket.depth - 2,
         heightMm + spec.socket.depth - 1
        ].map(y => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
    ));
    const ops = [
        // the socket the riser stack plugs into, opening downward. The SAME
        // joint as a riser's and a jog's — a hex tenon gripped for friction —
        // so it takes the same slotted hex collet. It was briefly left as a
        // round bore on the reasoning that "the collar rings a pillar rather
        // than gripping it", which this line's own comment disproves.
        ...colletSocketOps(spec, 0, opts),
        // the flat: a slab taken off one side of the body only
        {
            op: SUBTRACTION,
            geometry: toBufferGeometry(extrudePolygonY(
                [[FLAT, -R - 2], [R + 2, -R - 2], [R + 2, R + 2], [FLAT, R + 2]],
                -1, heightMm + 0.001))
        }
    ];
    /**
     * One ring per variant, counted rather than measured.
     *
     * THE CUTTER HAS TO BE A TUBE. `sweepSolid` over circle profiles makes a
     * solid of revolution — it contains the AXIS — so a bicone 10 → 8.3 → 10
     * subtracted straight from the body does not cut a groove, it eats the
     * core: at the waist all that was left was a 0.76 mm shell, and the part
     * read on screen as though it were in three pieces. It stayed watertight
     * throughout, so nothing caught it; the test now bounds how much a ring may
     * remove, not just how little.
     *
     * So the bicone has its own bore taken out first, and what is subtracted
     * from the spacer is the annular V that is left.
     */
    const rings = opts.rings ?? 1;
    const waist = R - 0.7;
    for (let i = 0; i < rings; i++) {
        const y = 2.5 + i * 3;
        if (y + 1.2 >= heightMm) break;
        const bicone = toBufferGeometry(sweepSolid(
            [circlePlan(R + 1, n), circlePlan(waist, n), circlePlan(R + 1, n)]
                .map(pl => pl.map(([x, z]) => [x, -z])),
            [y, y + 0.6, y + 1.2].map(yy => ({ origin: [0, yy, 0], right: [1, 0, 0], up: [0, 0, -1] }))
        ));
        const bore = toBufferGeometry(sweepSolid(
            [circlePlan(waist, n), circlePlan(waist, n)].map(pl => pl.map(([x, z]) => [x, -z])),
            [y - 1, y + 2.2].map(yy => ({ origin: [0, yy, 0], right: [1, 0, 0], up: [0, 0, -1] }))
        ));
        ops.push({
            op: SUBTRACTION,
            geometry: toBufferGeometry(csgChain(bicone, [{ op: SUBTRACTION, geometry: bore }]))
        });
    }
    // the code goes on the flat, reading up the part
    if (opts.code) {
        const lines = String(opts.code).split(' ');
        const size = blockSizeMm(lines, { capHeight: spec.engrave.capHeight * 0.7,
            strokeMm: spec.engrave.minFeature });
        if (size.heightMm < heightMm - 2 && size.widthMm < 2 * R - 2) {
            ops.push(...engraveFlatOps(lines,
                [FLAT, (heightMm - size.widthMm) / 2, size.heightMm / 2],
                [0, 1, 0], [0, 0, -1], spec, { capHeight: spec.engrave.capHeight * 0.7 }));
        }
    }
    return csgChain(body, ops);
}

/** Stackable riser: hex tube with a socket below and a tenon above. Needs initCSG. */
export function buildRiserGeometry(sizeMm, spec = SPEC, opts = {}) {
    // `roundTenonDia` swaps the hex tenon for a cylinder — see roundTenon. The
    // shaft, the shoulder and the socket are untouched, so a swept set of these
    // can be tried in sockets that are already printed.
    const round = opts.roundTenonDia;
    const body = toBufferGeometry(round
        ? stackedHex([{ y: 0, af: 15 }, { y: sizeMm, af: 15 }])
        : stackedHex([
            { y: 0, af: 15 },
            { y: sizeMm, af: 15 },
            { y: sizeMm, af: TENON_AF },
            { y: sizeMm + spec.socket.depth - 2, af: tenonTipAF(spec) },
            { y: sizeMm + spec.socket.depth - 1, af: tenonTipAF(spec) - 1.4 }
        ]));
    return csgChain(body, [
        ...(round ? [{ op: ADDITION, geometry: toBufferGeometry(
            roundTenon(round, sizeMm - 0.4, sizeMm + spec.socket.depth - 1)) }] : []),
        // `hexSocketAF` puts the ORIGINAL hex socket back, at a stated size.
        // Opt-in and test-only: the round bore is what ships. It exists because
        // hex-on-hex is the one pillar joint that has never been in doubt
        // ("very nice and tight"), so a slotted hex is a candidate the round
        // bore has to beat, and a candidate has to be buildable to be tried.
        // `hexSocketAF` / `roundSocketDia` stay as TEST hooks so a ladder can
        // still be built; the shipped socket is the collet.
        ...(opts.roundSocketDia
            ? [{ op: SUBTRACTION, geometry: roundSocketSolid(opts.roundSocketDia, -0.5, spec.socket.depth) }]
            : opts.hexSocketAF
                ? [{ op: SUBTRACTION, geometry: hexSocketSolid(0, 0, -0.5, spec.socket.depth, spec, opts.hexSocketAF) },
                   ...(opts.slots === false ? [] : colletSocketOps(spec).slice(1))]
                : colletSocketOps(spec, 0, opts)),
        // The code gets the WHOLE shaft to centre itself on now. It used to be
        // pushed into the band above the last grid mark, because centring on
        // sizeMm/2 put it exactly where a groove ran on a 30 and a 60 and the
        // code came out bisected. With the grooves gone there is nothing to
        // avoid, and a 60 mm riser gives the block 60 mm to sit in rather than
        // the 14 it was squeezed into.
        // capHeight forwarded, because a caller that asks for bigger text and
        // silently gets 2.4 has no way to tell. Test articles want a code you
        // can read across a bench; shipped risers keep the default.
        ...hexFlatEngraveOps(opts.code ?? null, 15, 1, sizeMm, spec,
            opts.capHeight ? { capHeight: opts.capHeight } : {})
    ]);
}

/*
 * THE 15 mm GRID MARKS ARE GONE, and they were a legibility idea that misread
 * as a structural one.
 *
 * A shallow V groove was cut at every 15 mm line so a riser would say how tall
 * it was — a 60 wore three of them, and you could count units instead of
 * reaching for calipers. Brett, on a printed set: "the indents every 15mm of
 * the longer pillars just end up looking like connected sections that can be
 * pulled apart, this is confusing, we can eliminate those height markers."
 *
 * That is the whole case against them. Every OTHER horizontal line in this
 * system is a joint — risers stack, spacers ring, tenons shoulder — so a
 * groove around a shaft reads as a seam, and a part that looks like four parts
 * invites someone to pull it apart. The engraved code already says which riser
 * it is, on a surface that cannot be mistaken for a joint.
 *
 * Do not reintroduce them as "just a scribe line" or a shallower groove: the
 * problem is the RING, not its depth.
 */

/**
 * Puts a whole code on ONE flat of a hex prism, as two stacked lines turned on
 * their side so the block runs up the part.
 *
 * Turned, because that is the only way the whole code lands on one face. An
 * across-flats-15 hex gives an 8.66 mm face, and two stacked lines need 6.6 mm
 * across it — they fit turned, while `R120` upright would need 7.6 mm of width
 * on a face that has 8.66 total and no room for margins. Along the part there
 * is 13 mm on even the shortest riser. So you read it by turning the part in
 * your hand, not by turning it over and hunting the next flat.
 *
 * `HEX_FLAT_CAP` and not the full cap height for the same reason: 3.5 mm caps
 * make a two-line block 9.2 mm tall, which does not fit an 8.66 mm face at all.
 *
 * Engraving is OPT-IN here, unlike on track pieces: this builder serves the
 * scene as well as the exporter, a tower draws a hundred risers, and the cut is
 * invisible at scene scale. No code, no CSG.
 */
export const HEX_FLAT_CAP = 2.4;

function hexFlatEngraveOps(code, acrossFlats, y0, y1, spec = SPEC, opts = {}) {
    if (!code) return [];
    const font = { capHeight: opts.capHeight ?? HEX_FLAT_CAP, strokeMm: spec.engrave.minFeature };
    const lines = String(code).split(' ');
    const size = blockSizeMm(lines, font);
    const faceWidth = acrossFlats / Math.sqrt(3);
    if (size.widthMm > (y1 - y0) - 2 || size.heightMm > faceWidth - 1) return [];
    // hexPlan puts vertices at 0° and 60°, so a face centre sits at 30°
    const a = Math.PI / 6;
    const n = [Math.cos(a), 0, Math.sin(a)];
    // turned on its side: reading runs +Y, and the block's own "up" is the
    // horizontal tangent t with Y × t = n
    const read = [0, 1, 0];
    const up = [-n[2], 0, n[0]];
    const c = [n[0] * (acrossFlats / 2), (y0 + y1) / 2, n[2] * (acrossFlats / 2)];
    return engraveFlatOps(lines,
        [c[0] - up[0] * (size.heightMm / 2), c[1] - size.widthMm / 2, c[2] - up[2] * (size.heightMm / 2)],
        read, up, spec, { capHeight: font.capHeight });
}

/**
 * Scenery tower: fat hex trunk, top tenon (supports track like a pillar),
 * bottom socket (stacks on another tower or a patio). Needs initCSG.
 */
export function buildTowerGeometry(heightMm = 100, spec = SPEC) {
    const body = toBufferGeometry(stackedHex([
        { y: 0, af: 42.8 },                                   // elephant-foot chamfer
        { y: 0.6, af: 44 },
        { y: 6, af: 44 },
        { y: 6, af: 34 },
        { y: heightMm, af: 34 },
        { y: heightMm, af: 44 },
        { y: heightMm + 6, af: 44 },
        { y: heightMm + 6, af: TENON_AF },
        { y: heightMm + 6 + spec.socket.depth - 2, af: tenonTipAF(spec) },
        { y: heightMm + 6 + spec.socket.depth - 1, af: tenonTipAF(spec) - 1.4 }
    ]));
    const socket = hexSocketSolid(0, 0, -0.5, spec.socket.depth, spec);
    return csgChain(body, [{ op: SUBTRACTION, geometry: socket }]);
}

/**
 * Palm island: hex island plate with a center socket, plus a separate palm
 * tree (tapered trunk, star frond crown, bottom tenon). Needs initCSG.
 */
export function buildPalmIslandGeometries(spec = SPEC) {
    const plate = toBufferGeometry(stackedHex([
        { y: 0, af: 84 },
        { y: 6, af: 84 },
        { y: 6, af: 70 },
        { y: 10, af: 70 }
    ]));
    const socket = hexSocketSolid(0, 0, 10.5, 2, spec); // mouth at the top
    const island = csgChain(plate, [{ op: SUBTRACTION, geometry: socket }]);

    // palm: hex tenon (was a circumscribed circle that could not fit the
    // socket flats!) → tapered trunk → crown of fronds (8-point star)
    const tenon = toBufferGeometry(stackedHex([
        { y: -8, af: tenonTipAF(spec) - 1.4 },   // insertion lead-in
        { y: -7, af: tenonTipAF(spec) },         // tip: tapered, see tenonTaperAF
        { y: 0.5, af: TENON_AF }             // shoulder: full size
    ]));
    const trunkLevels = [
        { y: 0, r: 6 },
        { y: 66, r: 4 }
    ];
    const nTrunk = segmentsForCircle(Math.max(...trunkLevels.map(l => l.r)));
    const profiles = trunkLevels.map(l => circlePlan(l.r, nTrunk).map(([x, z]) => [x, -z]));
    const stations = trunkLevels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    const trunk = toBufferGeometry(sweepSolid(profiles, stations));
    const star = [];
    for (let i = 0; i < 16; i++) {
        const r = i % 2 === 0 ? 30 : 9;
        const a = (i / 16) * 2 * Math.PI;
        star.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    const crown = toBufferGeometry(extrudePolygonY(star, 63, 67));
    const palm = csgChain(trunk, [{ op: ADDITION, geometry: tenon }, { op: ADDITION, geometry: crown }]);
    return { island, palm };
}

/**
 * Patio: figure parking plate with guard rails on three sides and four
 * corner sockets for planting palms/towers. Open side faces +X. Needs initCSG.
 */
export function buildPatioGeometry(spec = SPEC) {
    const S = 75; // half-size
    const plate = toBufferGeometry(extrudePolygonY(
        [[-S, -S], [S, -S], [S, S], [-S, S]], 0, 8
    ));
    const t = spec.wall, railTop = 8 + spec.railHeight;
    const rails = [
        [[-S, -S], [S, -S], [S, -S + t], [-S, -S + t]],
        [[-S, S - t], [S, S - t], [S, S], [-S, S]],
        [[-S, -S], [-S + t, -S], [-S + t, S], [-S, S]]
    ];
    const ops = rails.map(r => ({ op: ADDITION, geometry: toBufferGeometry(extrudePolygonY(r, 7.5, railTop)) }));
    for (const [cx, cz] of [[-S + 14, -S + 14], [S - 14, -S + 14], [-S + 14, S - 14], [S - 14, S - 14]]) {
        ops.push({ op: SUBTRACTION, geometry: hexSocketSolid(cx, cz, 8.5, 1.5, spec) }); // mouth at the top
    }
    return csgChain(plate, ops);
}

// ---------------------------------------------------------------------------
// Walker figure
// ---------------------------------------------------------------------------

function cylinderX(r, x0, x1, cz, cy, segments = segmentsForCircle(r)) {
    const g = new THREE.CylinderGeometry(r, r, x1 - x0, segments);
    g.rotateZ(Math.PI / 2); // cylinder axis Y → X
    g.translate((x0 + x1) / 2, cy, cz);
    return g;
}

/** Builds all printable figure parts at the measured `FIGURE.widthMm`. */
export function buildFigureGeometries(trackInnerWidth = SPEC.innerWidth.default, opts = {}) {
    const W = (opts.widthMm ?? FIGURE.widthMm);
    const style = opts.style ?? 'classic';
    const F = FIGURE;

    const bodyBase = toBufferGeometry(extrudeOutlineX(bodySideOutline(style), -W / 2, W / 2));
    const slot = new THREE.BoxGeometry(F.slot.halfW * 2, F.slot.yMax - F.slot.yMin, F.slot.zMax - F.slot.zMin);
    slot.translate(0, (F.slot.yMax + F.slot.yMin) / 2, (F.slot.zMax + F.slot.zMin) / 2);
    const riderOps = style === 'knight'
        ? [
            { op: ADDITION, geometry: toBufferGeometry(extrudeOutlineX(knightRiderOutline(), -12, 12)) },
            { op: ADDITION, geometry: toBufferGeometry(extrudeOutlineX(knightCrestOutline(), -3, 3)) }
        ]
        : [];
    const body = csgChain(bodyBase, [
        ...riderOps,
        { op: SUBTRACTION, geometry: slot },
        { op: SUBTRACTION, geometry: cylinderX(F.axle.holeBodyR, -W / 2 - 1, W / 2 + 1, F.axle.z, F.axle.y) },
        { op: SUBTRACTION, geometry: cylinderX(F.bodyBallast.r, -W / 2 - 1, W / 2 + 1, F.bodyBallast.z, F.bodyBallast.y) }
    ]);

    const pw = F.pendulumW / 2;
    const pendBase = toBufferGeometry(extrudeOutlineX(pendulumSideOutline(), -pw, pw));
    const pendulum = csgChain(pendBase, [
        { op: SUBTRACTION, geometry: cylinderX(F.axle.holePendR, -pw - 1, pw + 1, F.axle.z, F.axle.y) },
        { op: SUBTRACTION, geometry: cylinderX(F.pendBallast.r, -pw - 1, pw + 1, F.pendBallast.z, F.pendBallast.y) }
    ]);

    const plugSet = mergeSolids([
        ...plugPair(F.bodyBallast.r - 0.15, 0, 0),
        ...plugPair(F.pendBallast.r - 0.15, 26, 0),
        ...plugPair(F.axle.holeBodyR - 0.18, 52, 0)
    ]);

    return { body, pendulum, plugSet, widthMm: W };
}

function plugPair(stemR, offsetX, offsetZ) {
    const mk = (ox) => {
        const levels = [
            { y: 0, r: stemR + 2 },
            { y: 1.5, r: stemR + 2 },
            { y: 1.5, r: stemR },
            { y: 5.5, r: stemR }
        ];
        const nPlug = segmentsForCircle(Math.max(...levels.map(l => l.r)));
        const profiles = levels.map(l => circlePlan(l.r, nPlug).map(([x, z]) => [x, -z]));
        const stations = levels.map(l => ({ origin: [ox, l.y, offsetZ], right: [1, 0, 0], up: [0, 0, -1] }));
        return sweepSolid(profiles, stations);
    };
    return [mk(offsetX), mk(offsetX + 14)];
}

/** Concatenates disjoint closed solids into one multi-shell mesh. */
export function mergeSolids(solids) {
    let vTotal = 0, iTotal = 0;
    for (const s of solids) { vTotal += s.positions.length; iTotal += s.indices.length; }
    const positions = new Float32Array(vTotal);
    const indices = new Uint32Array(iTotal);
    let vo = 0, io = 0;
    for (const s of solids) {
        positions.set(s.positions, vo * 3);
        for (let i = 0; i < s.indices.length; i++) indices[io + i] = s.indices[i] + vo;
        vo += s.positions.length / 3;
        io += s.indices.length;
    }
    return { positions, indices };
}

// ---------------------------------------------------------------------------
// Calibration coupons
// ---------------------------------------------------------------------------

/**
 * A small plate of parts carrying ONLY the surfaces that touch something else,
 * so a fit can be measured with calipers in an hour instead of after a 3 hour
 * track piece.
 *
 * THE COUPONS ARE CUT FROM THE REAL PARTS, not drawn to match them. A pocket
 * redrawn "the same" would have to reproduce the flank clearance, the detent,
 * the grip taper and the seat land, and the day one of those changed the
 * coupon would keep certifying the old number. So `truncate()` builds the
 * actual piece and subtracts everything outside a band of it: whatever the
 * real joint is, that is what gets measured.
 *
 * AND THEY KEEP THE PLASTIC AROUND THE FEATURE. A hole's printed size depends
 * on how much material surrounds it — the same drawing comes out a quarter of
 * a millimetre apart in a slender part and a massive one — so a coupon thinned
 * down for print speed would measure its own thinness rather than the fit.
 * Each coupon keeps the real part's full section and its real print
 * orientation, and is shortened only in extent. Brett: "you can make it as
 * thick as need be."
 */
const CAL = {
    gateKeepMm: 34,      // a block around the gate pin bore, along the piece
    gateWidthMm: 15      // and across it, inward from the hinge wall
};

/**
 * The ramp coupon is a WHOLE SHORT TILE, not a band cut out of a long one.
 *
 * It began as two separate coupons — an end rib for the pocket, a mid-piece
 * band for the socket — and both paid for it at their cut faces: a band taken
 * out of the middle of a piece has TWO of them, open and bridged, and they
 * printed badly. A tile laid out short has none. It arrives rib to rib, so one
 * part carries a key pocket at each end AND the socket between them, every
 * face is a face the real part has, and there is nothing artificial to print.
 *
 * Only the LENGTH is off-Standard. Slope, channel, rib, pocket, boss and
 * socket are all built by the shipped builders from the same SPEC, so every
 * surface being measured is the surface that ships. 65 mm is the shortest that
 * still clears the collar of both end ribs (5.7 mm each side at the Standard
 * slope); below about 55 the boss starts to crowd the entry rib.
 *
 * Exported because the CALLER lays the tile out — this module never lays out
 * track — and both sides have to agree on the number.
 */
export const CALIBRATION = { rampTileLenMm: 65 };

/**
 * Everything outside `[dFrom, dTo]` measured forward from `face`, as cutters.
 * Only the gate bearing needs these now — the ramp coupon is a whole tile.
 * Two boxes rather than an intersection, because csgChain only adds and
 * subtracts — and a box big enough to swallow a track piece is cheaper than
 * teaching it a third operation.
 */
function bandCutters(face, dFrom, dTo, spec) {
    const BIG = 400, LO = -400, HI = 400;
    const box = (a, b) => toBufferGeometry(extrudePolygonY(
        planToWorld([[-BIG, a], [BIG, a], [BIG, b], [-BIG, b]], face), LO, HI));
    return [
        { op: SUBTRACTION, geometry: box(-BIG, dFrom) },
        { op: SUBTRACTION, geometry: box(dTo, BIG) }
    ];
}

/** The same trim, across the piece instead of along it. */
function sideCutters(face, pxFrom, pxTo) {
    const BIG = 400, LO = -400, HI = 400;
    const box = (a, b) => toBufferGeometry(extrudePolygonY(
        planToWorld([[a, -BIG], [b, -BIG], [b, BIG], [a, BIG]], face), LO, HI));
    return [
        { op: SUBTRACTION, geometry: box(-BIG, pxFrom) },
        { op: SUBTRACTION, geometry: box(pxTo, BIG) }
    ];
}

/**
 * The coupon set, with what to measure on each and the number it should come
 * out at. The nominals are READ OFF THE SPEC rather than typed in here, so a
 * measurement sheet cannot quietly go stale the way a hardcoded table would.
 *
 * @param {object} src  { piece, support, switchMain, switchBranch } — laid out
 *   by the caller, because this module never lays out track.
 */
export function buildCalibrationCoupons(src, spec = SPEC) {
    const K = spec.key, S = spec.socket;
    const tenonAF = S.hexAF - 2 * spec.jointClearanceMm;
    const tenonTipAFc = tenonAF - (S.tenonTaperAF ?? 0);
    const ac = (af) => af / Math.cos(Math.PI / 6);
    const fit = K.fitClearanceMm ?? spec.jointClearanceMm;
    const out = [];

    if (src.piece) {
        out.push({
            name: 'cal_ramp',
            count: 1,
            note: 'A whole short ramp tile: a key pocket at EACH end and the socket '
                + 'between them. Rib to rib, so it has no cut faces — only its length '
                + 'is off-Standard, every mating surface is the shipped one.',
            build: () => buildPieceExportGeometry(src.piece,
                { support: src.support, spec, forPrint: true }),
            measures: [
                ['pocket mouth, across the neck (each end)', 2 * (K.neckHalf + fit)],
                ['pocket mouth, across the tips (each end)', 2 * (K.tipHalf + fit)],
                ['pocket depth into the face', K.depth + (K.depthClearanceMm ?? fit)],
                ['rib thickness', K.ribThk],
                ['channel width between rails', src.piece.innerWidth],
                ['socket across flats', S.hexAF],
                ['socket depth from its mouth', S.depth],
                // THE MOUTH IS A LAND PLUS A CONE now, not a flat annulus, and
                // this coupon is the only place in the set that carries one.
                // It is the feature that was throwing strands on every printed
                // socket and the one that tripped the slicer's cantilever
                // warning; a sheet that did not list it would certify a mouth
                // nobody has looked at.
                ['socket mouth, flat bearing land (radial width)', S.mouthLandMm ?? 0],
                ['counterbore diameter where it meets the sole', 2 * S.collarBoreR]
            ]
        });
    }
    out.push({
        name: 'cal_key',
        count: 1,
        // ONE, and it is also the ladder's chip. It used to be two here plus
        // two free chips on the section card — four keys for a set that needs
        // one. Brett: "It seems like we are print four keys and only one is
        // needed." The chips are gone and this key does both jobs: it mates
        // with cal_ramp's pockets, and it is what you push down the bowtie
        // ladder if that fit misses.
        // IT IS DIRECTIONAL NOW. The key carries a drive taper — the lead end
        // is under nominal so it enters, the grip end over nominal so it wedges
        // as the last of it is driven home. Brett's complaint was never
        // clearance ("they are still also a little loose in their slots"); a
        // prismatic key has exactly ONE fit and the ladder says the drawn one is
        // already in the proven band. A taper has a range and the user drives it
        // to the one that grips.
        note: 'The shipped bowtie key. DIRECTIONAL: the engraved face is the LEAD '
            + 'end and goes in first — driven the other way round it stops early. '
            + 'Mates with cal_ramp, and is the chip for the bowtie ladder.',
        build: () => buildKeyGeometry(spec, { code: partCode('KEY', GEOMETRY_VERSION) }),
        measures: [
            ['across the neck', 2 * K.neckHalf],
            ['across the tips, GRIP end (engraving down)', 2 * (K.tipHalf + (K.taperGripMm ?? 0))],
            ['across the tips, LEAD end (engraving up)', 2 * (K.tipHalf - (K.taperLeadMm ?? 0))],
            ['depth', K.depth],
            ['height', K.height - 2 * spec.jointClearanceMm]
        ]
    });
    out.push({
        name: 'cal_post_15',
        count: 1,
        note: 'One grid unit of hex post: the tenon that goes into the socket above '
            + 'and the socket that takes the tenon below. Mates with cal_socket.',
        build: () => buildRiserGeometry(15, spec, { code: partCode('R15', GEOMETRY_VERSION) }),
        // THE SOCKET IN A POST IS A ROUND BORE, not a hex. This sheet still
        // asked for it "across flats", which is a reading you cannot take on a
        // round hole — and the bore is the fit that failed in the field, so it
        // is the one measurement here that most needed to be right.
        measures: [
            ['tenon across flats (shoulder)', tenonAF],
            ['tenon ACROSS CORNERS at the shoulder', +ac(tenonAF).toFixed(2)],
            ['tenon ACROSS CORNERS at the tip (lead-in taper)', +ac(tenonTipAFc).toFixed(2)],
            ['shaft across flats', 15],
            ['socket bore DIAMETER in the base', S.boreDia],
            ['height, shoulder to shoulder', 15]
        ]
    });
    // THE SECOND POST, and the reason there has to be one: with a single
    // cal_post_15 the only joint you can test is post-into-the-RAMP's socket.
    // Post-into-POST is a different piece of plastic — a socket sunk in a slim
    // hex shaft, not one sunk in the mass under a deck — and this project has
    // already measured that a hole's printed size depends on the material
    // around it. Two posts is the smallest arrangement that can tell them apart.
    //
    // 12 mm, not 15: deliberately NOT a grid unit, so a test article can never
    // be mistaken for a spacer and built into a tower. It is the shortest shaft
    // that still fully houses the 10 mm socket without breaking through.
    out.push({
        name: 'cal_post_short',
        count: 1,
        note: 'The mate for cal_post_15: stack them to test post-on-post, which is '
            + 'a socket in a slim shaft rather than one sunk under a deck. 12 mm '
            + 'so it is not a grid unit and cannot be built into a tower.',
        build: () => buildRiserGeometry(12, spec, { code: partCode('R12', GEOMETRY_VERSION) }),
        measures: [
            ['tenon across flats (shoulder)', tenonAF],
            ['tenon ACROSS CORNERS at the shoulder', +ac(tenonAF).toFixed(2)],
            ['tenon ACROSS CORNERS at the tip (lead-in taper)', +ac(tenonTipAFc).toFixed(2)],
            ['shaft across flats', 15],
            ['socket bore DIAMETER in the base', S.boreDia],
            ['height, shoulder to shoulder', 12]
        ]
    });
    out.push({
        name: 'cal_gate_paddle',
        count: 1,
        note: 'The shipped gate paddle. Its hub, split pin and vane are the gate\'s '
            + 'moving touch points.',
        build: () => buildGateGeometry(spec, { forPrint: true }),
        measures: [
            ['vane thickness', GATE.vaneThk],
            ['hub diameter', 2 * GATE.hubR],
            ['pin diameter', 2 * GATE.pinR],
            ['pin slot width', GATE.pinSlot],
            ['blade length', GATE.len]
        ]
    });
    if (src.switchMain && src.switchBranch) {
        out.push({
            name: 'cal_gate_bearing',
            count: 1,
            note: 'The block of a real switch around the gate pin bore — the fixed '
                + 'half of the gate bearing. Takes cal_gate_paddle\'s pin.',
            build: () => {
                const frame = pieceFrame(src.switchMain);
                let main = pieceInFrame(src.switchMain, frame);
                let branch = pieceInFrame(src.switchBranch, frame);
                // ONE UNDERSIDE FOR ONE SOLID, and the coupon has to fit the
                // same plane the shell was cut with. Tilted onto a plane
                // fitted to the main half alone — which is what you get by
                // forgetting `planeGroup` — the block came off the bed
                // entirely: 0 mm2 of contact, balanced on one corner.
                const planeGroup = [main, branch];
                main = { ...main, planeGroup };
                branch = { ...branch, planeGroup };
                const pin = gatePinPosition(main, branch);
                const solid = buildSwitchExportGeometry(src.switchMain, src.switchBranch,
                    { spec, forPrint: false });
                // TRIMMED ACROSS AS WELL AS ALONG. Kept full width this coupon
                // was the heaviest thing on the plate — 26 g and 42 mm tall to
                // measure two diameters — because it dragged in the far rail
                // and the whole deck spanning between them. That deck is also
                // the only reason it drew a floating-cantilever warning. The
                // bore lives in the hinge rail, so the far rail 48 mm away
                // contributes nothing to it and is not "context" worth paying
                // for. `lat` is where the pin sits: on the hinge-side wall.
                const lat = pin.hingeSide * (main.innerWidth / 2 + GATE.vaneThk / 2);
                const inward = -pin.hingeSide * CAL.gateWidthMm;
                const d0 = Math.max(-1, pin.s - CAL.gateKeepMm / 2);
                const d1 = pin.s + CAL.gateKeepMm / 2;
                // AND THE BACK IS CLOSED WITH A PLAIN WALL. Cut open, the strip
                // of deck left inboard of the rail is anchored along the rail
                // and free at the cut — a genuine floating cantilever, and the
                // one Bambu keeps naming. In the whole switch that deck is a
                // bridge between two rails; taking one rail away turns it into
                // a diving board. A wall from the underside plane up to the
                // deck gives it its second anchor back for 2.4 mm of plastic.
                //
                // It is a PLAIN VERTICAL WALL, not a slice of skirt at the ramp
                // angle, because this coupon exists to verify the swing arm's
                // socket and nothing else. Brett: "the back doesn't have to be
                // at the normal ramp angle."
                const latInner = lat + inward;
                const u0 = latInner, u1 = latInner + pin.hingeSide * spec.wall;
                const pl = undersidePlane(main, spec);
                const dirV = [Math.cos(main.entry.h), Math.sin(main.entry.h)];
                const rightV = [Math.sin(main.entry.h), -Math.cos(main.entry.h)];
                const N = 5, profiles = [], stations = [];
                for (let i = 0; i < N; i++) {
                    const d = d0 + ((d1 - d0) * i) / (N - 1);
                    const px = main.entry.x + dirV[0] * d, pz = main.entry.z + dirV[1] * d;
                    const at = (u) => pl.at(px + rightV[0] * u, pz + rightV[1] * u);
                    const top = deckYAt(main, Math.min(Math.max(d, 0), main.planLen));
                    profiles.push([[u0, at(u0)], [u1, at(u1)], [u1, top], [u0, top]]);
                    stations.push({ origin: [px, 0, pz],
                        right: [rightV[0], 0, rightV[1]], up: [0, 1, 0] });
                }
                // AND THE RAILS COME OFF. Measured on the built mesh, the
                // swing arm's socket is a void on the bore axis from z 8 to
                // z 24 and there is no material at all above z 25 except a
                // 12 x 2 mm blade of rail top standing 12 mm proud — a thin
                // cantilever that is nothing to do with the socket and is what
                // the slicer keeps naming. Capping at the deck keeps the whole
                // socket and takes the blade.
                const capProfiles = [], capStations = [];
                for (let i = 0; i < N; i++) {
                    const d = d0 + ((d1 - d0) * i) / (N - 1);
                    const top = deckYAt(main, Math.min(Math.max(d, 0), main.planLen));
                    capProfiles.push([[-400, top], [400, top], [400, 400], [-400, 400]]);
                    capStations.push({
                        origin: [main.entry.x + dirV[0] * d, 0, main.entry.z + dirV[1] * d],
                        right: [rightV[0], 0, rightV[1]], up: [0, 1, 0]
                    });
                }
                const cut = csgChain(toBufferGeometry(solid), [
                    ...bandCutters(main.entry, d0, d1, spec),
                    // OUTBOARD OF THE PIN, whichever wall the pin is on. This was
                    // a bare `lat + 6`, which only reaches past the wall while
                    // hingeSide is POSITIVE; once the hinge moved to the other
                    // wall in 2.6.0 the same expression cut inward and took the
                    // bore with it, which is what the coupon test caught.
                    ...(() => { const outboard = lat + 6 * pin.hingeSide;
                        return sideCutters(main.entry, Math.min(outboard, latInner),
                            Math.max(outboard, latInner)); })(),
                    { op: SUBTRACTION, geometry: toBufferGeometry(sweepSolid(capProfiles, capStations)) },
                    { op: ADDITION, geometry: toBufferGeometry(sweepSolid(profiles, stations)) }
                ]);
                return tiltOntoUnderside(cut, main, spec);
            },
            measures: [
                ['gate bore diameter', 2 * GATE.boreR],
                ['boss diameter around the bore', 2 * GATE.bossR]
            ]
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Calibration SECTIONS — a printed XY cross-section, measured by camera
// ---------------------------------------------------------------------------

/**
 * Five layers of the mating profiles, flat, for measuring with a camera
 * instead of calipers.
 *
 * WHY A SECTION AND NOT A PART. Calipers on a 26 mm coupon measure one chord
 * at a time, by hand, with the operator's feel in the number. A 1 mm section
 * lies dead flat on an ArUco sheet, and one photograph gives every dimension
 * at once, to the sheet's own scale, repeatably and without anyone's opinion
 * in it. This is the "tolerance coupon" of the printing community: a graded
 * set of holes and islands that characterises a printer and filament pair.
 *
 * THE PROFILES ARE THE SHIPPED ONES. Every outline here comes from the same
 * plan function the real part is swept from — `bowtieKeyPlan`,
 * `bowtiePocketPlan`, `hexPlan`, `circlePlan` — so the card cannot drift from
 * the geometry it is certifying.
 *
 * HOLES AND ISLANDS BOTH, because they carry opposite error. A hole prints
 * small and an island prints large, by roughly the same amount and for the
 * same reason, so measuring only one of them tells you half of a fit.
 *
 * THE REFERENCE SQUARES ARE NOT DECORATION. Two exact squares, 10.000 and
 * 20.000 mm, appear as both a hole and an island. They are how the camera
 * checks its OWN scale: if the 20 mm reference reads 20.14, every other
 * number on the card carries that same 0.7% and the ArUco fit is what needs
 * fixing, not the printer.
 *
 * A CAVEAT WORTH PRINTING NEXT TO THE NUMBERS: seen from above, a hole's
 * silhouette is its NARROWEST layer and an island's is its WIDEST, and on a
 * five-layer part that is the squished first layer in both cases. So this
 * measures the first layer, elephant foot included, while the surfaces that
 * actually mate on a track piece are at mid-height. Slice the section with
 * the same first-layer settings and compensation as production or the offset
 * is not the production one.
 */
export const SECTION = {
    thicknessMm: 1.0,          // five 0.2 mm layers: liftable, still a section
    gapMm: 7,                  // between shapes: wide enough that two holes
                               // never share a wall thin enough to distort
    cardMarginMm: 9,
    maxCardWidthMm: 200,       // inside a 256 mm bed with room to place it
    /**
     * A CHAMFER ON THE BOTTOM, so the first layers cannot be what the camera
     * measures. Seen from above an island shows its widest layer and a hole its
     * narrowest, and layer 1 is the odd one out at both ends: the slicer
     * deflates it on purpose (`elefant_foot_compensation`, 0.15 mm per side in
     * the P2S Standard profile — measured, a 20.000 mm square is programmed
     * 19.700 on layer 1 and 20.000 above it) and the squish against the bed
     * then spreads it back by an unknown amount. Whether those two cancel is
     * exactly the thing nobody knows, so the section must not REST on the
     * answer. Chamfered 0.4 mm the bottom two layers are inset by more than
     * either effect, the silhouette is governed by the normal layers above,
     * and those are the layers a real part mates on. The bowtie key has
     * carried the same 0.5 mm chamfer for the same reason.
     */
    chamferMm: 0.4,
    /**
     * THE FIT TEST IS A SEPARATE, THICKER CARD. A 1 mm hole is a knife-edge
     * gauge, not a joint: the male part barely engages, so "fits" comes down to
     * how hard you pushed. 3 mm gives fifteen layers of real flank contact and
     * still prints in minutes. The camera card stays at 1 mm, because parallax
     * through a hole grows with thickness and that is the one measurement thin
     * helps — the two jobs want opposite things, so they get two parts.
     */
    ladderThicknessMm: 3.0,
    /**
     * The bowtie ladder is DERIVED FROM THE SHIPPED CLEARANCE, not listed.
     *
     * A hardcoded list is how this broke: coarsening it to [0, 0.06, 0.12, ...]
     * looked right because 0.12 is `fitClearanceMm` — but the rung that mates is
     * `fitClearanceMm - printComp.tipMm` = 0.05, because the key is drawn 0.07
     * wider on every flank than the pocket is cut. The list silently stopped
     * containing the only rung that matters, and a ladder that cannot tell you
     * whether TODAY'S clearance is right is worth nothing. Derived, it follows
     * `printComp` and `fitClearanceMm` wherever they go.
     *
     * 0.06 APART. Brett: ".05mm is not enough to make a difference" — 0.025 per
     * side, a third of the 0.07/side already recorded as unfeelable. The old
     * eight-rung sweep had neighbours nobody could tell apart, which is half a
     * card of plastic buying nothing.
     *
     * One rung TIGHTER than shipped (clamped at zero) because that end is
     * informative: the recorded PETG reading was "will not enter 0.00,
     * extremely snug at 0.05", and a rung the key refuses is what brackets the
     * fit from below.
     */
    ladderStepMm: 0.06,
    ladderRungs: 5
};

/** Per-side clearances for the bowtie ladder, centred on what ships. */
export function ladderSteps(spec = SPEC) {
    const K = spec.key;
    const shipped = +(K.fitClearanceMm - K.printComp.tipMm).toFixed(3);
    const out = [];
    for (let i = -1; i < SECTION.ladderRungs - 1; i++) {
        out.push(+Math.max(0, shipped + i * SECTION.ladderStepMm).toFixed(3));
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The nominal outlines, in one place, so geometry and manifest agree.
 *
 * A GRADED SERIES, not just the functional sizes. Printed error is not one
 * number: a hole's shrinkage depends on its diameter, because the same
 * over-extrusion at the perimeter eats a larger fraction of a small hole, and
 * corner geometry matters too — a hex loses its points before a circle loses
 * its rim. Measuring Ø2 through Ø16 and AF 6 through AF 15 gives an error CURVE
 * to interpolate the real features against, instead of one point and a hope.
 * The sizes that actually mate (socket AF 9, tenon AF 8.6, riser AF 15, gate
 * bore Ø4) are IN the series, so they are read off the same curve.
 */
function sectionFeatures(spec = SPEC) {
    const K = spec.key;
    const f = [];

    /**
     * ONE LADDER, FOR ONE JOINT. Everything else that used to be on these cards
     * has been removed, and the reason is the same each time: the calibration
     * set now exists to TRANSFER a settled geometry to new filament or a new
     * printer, not to discover it, so an article earns its place only if it
     * answers something the real coupons cannot.
     *
     * Gone, and why:
     *  · the whole SECTION CARD — a graded Ø2-16 / AF 6-15 series, reference
     *    squares, islands and an ArUco workflow — existed to build an XY error
     *    CURVE for predicting feature sizes. Nothing decides anything from that
     *    curve any more; the joints are measured directly and the joints are the
     *    truth. It also could not answer a mass question, and it carried its own
     *    caveat that a 5-layer part shows the squished first layer.
     *  · `lad_pin`, the gate bore. Brett: "if that is an approximation of the
     *    gate pin, we don't need it, the calibration parts print the gate. and
     *    the coupon that has the hole." Exactly — `cal_gate_paddle` is the real
     *    pin and `cal_gate_bearing` is the real bore, so the ladder was gauging
     *    a model of a joint that is already on the plate as itself.
     *  · `lad_hex`, the track socket. Mass-dependent like the pillar joint was,
     *    and a 3 mm card is a third mass again — see the note on SECTION.
     *  · every CHIP. `chip_tenon` is a bare hex cylinder that `cal_post_15`
     *    already carries as a real tenon; `chip_key_20`/`_24` were two keys for
     *    a comparison that 2.3 settled. `cal_key` is the chip now.
     *
     * What survives is the bowtie ladder, because it is the one that worked:
     * it read the key's clearance correctly, and CLAUDE.md records why — its
     * holes are uniform insets, so they report every direction at once. The
     * cavity is the KEY's own outline grown by the clearance (a true normal
     * offset), not the half-pocket a single rib carries: an assembled seam
     * presents the whole bowtie, and that is what the key has to pass.
     */
    for (const c of ladderSteps(spec)) {
        const tag = String(Math.round(c * 100)).padStart(2, '0');
        f.push({ id: `lad_key_${tag}`, kind: 'hole', group: 'ladder', card: 'ladder', tag,
            label: `bowtie cavity +${c.toFixed(2)}/side`, clearancePerSide: c,
            nominal: { acrossTips: +(2 * K.tipHalf + 2 * c).toFixed(3) },
            plan: insetPolygon(bowtieKeyPlan({ neckHalf: K.neckHalf, tipHalf: K.tipHalf,
                depth: K.depth, tipChamfer: K.tipChamfer }), -c),
            mates: Math.abs(c - (K.fitClearanceMm - K.printComp.tipMm)) < 1e-9 ? 'ships today' : null });
    }

    return f;
}

/**
 * A slab whose BOTTOM is chamfered away, so its first layers are inset by more
 * than any elephant foot and the silhouette belongs to the normal layers above.
 *
 * `outward` builds a CUTTER instead: the same taper the other way, so a hole
 * comes out widest at the bed and its narrowest section is a normal layer too.
 * A cutter also has to start below the slab, or the boolean meets a coplanar
 * face at y = 0.
 */
function chamferedSlab(plan, thickness, outward) {
    const C = SECTION.chamferMm;
    const lip = insetPolygon(plan, outward ? -C : C);
    const flip = (p) => p.map(([x, z]) => [x, -z]);
    const levels = outward
        ? [[-1, lip], [0, lip], [C, plan], [thickness + 1, plan]]
        : [[0, lip], [C, plan], [thickness, plan]];
    return sweepSolid(
        levels.map(([, p]) => flip(p)),
        levels.map(([y]) => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
    );
}

/** Plan bbox, so the packer can give each shape a cell that fits it. */
function planExtent(plan) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of plan) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return { w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/**
 * The card (every hole) and the islands (each its own free chip), plus the
 * manifest a measuring script reads.
 *
 * Holes are packed into rows GROUPED BY SERIES and ordered by size, because a
 * photograph is read by a human before it is read by a script: a row that runs
 * small to large is obviously a series, and a missing or bridged-over hole is
 * visible at a glance instead of needing the manifest to notice.
 *
 * Positions come back in CARD COORDINATES with +X right and +Y away, which is
 * what the rectified photograph shows — NOT the app's Y-up frame.
 */
export function buildCalibrationSection(spec = SPEC) {
    const T = SECTION.thicknessMm, GAP = SECTION.gapMm, M = SECTION.cardMarginMm;
    const feats = sectionFeatures(spec);

    /** Pack one card's holes into rows and cut them, returning the solid. */
    const buildCard = (holes, thickness, order) => {
        const rows = [];
        for (const group of order) {
            const inGroup = holes.filter(f => f.group === group);
            if (!inGroup.length) continue;
            let row = [], wide = 0;
            for (const f of inGroup) {
                const e = planExtent(f.plan);
                if (row.length && wide + e.w + GAP > SECTION.maxCardWidthMm - 2 * M) {
                    rows.push(row); row = []; wide = 0;
                }
                row.push({ f, e }); wide += e.w + GAP;
            }
            if (row.length) rows.push(row);
        }
        let z = 0;
        const placed = [];
        for (const row of rows) {
            const rowW = row.reduce((a, r) => a + r.e.w + GAP, -GAP);
            const rowD = Math.max(...row.map(r => r.e.d));
            let x = -rowW / 2;
            for (const { f, e } of row) {
                placed.push({ f, cx: x + e.w / 2 - e.cx, cz: z + rowD / 2 - e.cz });
                x += e.w + GAP;
            }
            z += rowD + GAP;
        }
        const totalD = z - GAP;
        for (const p of placed) p.cz -= totalD / 2;
        const halfW = Math.max(...placed.map(p => p.cx + planExtent(p.f.plan).w / 2)) + M;
        const halfD = totalD / 2 + M;
        const slab = chamferedSlab(
            [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]], thickness, false);
        const ops = [];
        for (const { f, cx, cz } of placed) {
            f.centre = [+cx.toFixed(3), +(-cz).toFixed(3)];
            // the CUTTER is chamfered the other way, so the hole is widest at
            // the bottom and its narrowest section is a normal layer
            ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(
                chamferedSlab(f.plan.map(([x, zz]) => [cx + x, cz + zz]), thickness, true)) });
            // A LABEL, because the rungs are meant to be indistinguishable.
            // Adjacent ladder steps differ by 0.05 mm per side — that is the
            // point of a ladder and it is also why an unlabelled card cannot be
            // used: you cannot tell which hole accepted the chip. Engraved
            // rather than embossed so nothing stands proud of a card that has
            // to lie flat, and cut into the TOP face where you are looking.
            // Safe for the camera too: an engraved groove stays dark, while a
            // hole reads as white paper through it, so labels never register as
            // features.
            if (!f.tag || !isEngravable(f.tag)) continue;
            const capHeight = Math.min(2.6, SECTION.gapMm - 3.4);
            const size = blockSizeMm([f.tag], { capHeight, strokeMm: spec.engrave.minFeature });
            const e = planExtent(f.plan);
            ops.push(...engraveFlatOps([f.tag],
                [cx - size.widthMm / 2, thickness, cz + e.d / 2 + 1.2 + size.heightMm],
                [1, 0, 0], [0, 0, -1], spec,
                { capHeight, depth: Math.min(0.4, thickness * 0.35) }));
        }
        return { geometry: csgChain(toBufferGeometry(slab), ops),
                 size: [+(2 * halfW).toFixed(2), +(2 * halfD).toFixed(2)] };
    };

    // ONE CARD. The section card and every free chip are gone — see
    // sectionFeatures for what each was and why it stopped earning its place.
    const ladder = buildCard(feats.filter(f => f.kind === 'hole'),
        SECTION.ladderThicknessMm, ['ladder']);
    const parts = [{ name: 'ladder_card', geometry: ladder.geometry }];

    return {
        parts,
        manifest: {
            geometryVersion: GEOMETRY_VERSION,
            ladderThicknessMm: SECTION.ladderThicknessMm,
            ladderCardSizeMm: ladder.size,
            note: 'A HAND test, not a camera one. Push the printed cal_key down '
                + 'the row; the first rung it enters is the clearance that shape '
                + 'needs. Rungs are 0.06 mm apart because 0.05 is below what a '
                + 'hand can tell apart.',
            features: feats.map(f => ({
                id: f.id, kind: f.kind, group: f.group, label: f.label, tag: f.tag ?? null,
                card: 'ladder', nominal: f.nominal, mates: f.mates ?? null,
                clearancePerSide: f.clearancePerSide ?? null,
                heightMm: f.heightMm ?? SECTION.ladderThicknessMm,
                centreMm: f.centre ?? [0, 0],
                outlineMm: f.plan.map(([x, zz]) => [+x.toFixed(4), +(-zz).toFixed(4)])
            }))
        }
    };
}
