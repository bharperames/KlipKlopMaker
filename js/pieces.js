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
    SPEC, STANDARD, GEOMETRY_VERSION, stationsForPiece, planPosAt, deckYAt, innerWidthAt,
    pieceFrame, pieceInFrame, supportInFrame, socketMouthY, collarFits, laysOnUnderside,
    undersidePlane
} from './track.js';
import {
    textRings, textWidthMm, textHeightMm, blockRings, blockSizeMm,
    pieceCode, partCode
} from './engrave.js';
import {
    sweepSolid, extrudePolygonY, extrudeOutlineX, pieceProfiles, segmentsForCircle,
    bowtieKeyPlan, bowtiePocketPlan, insetPolygon, hexPlan, hexRingPlan, circlePlan, SIMPLIFY_TOL_MM,
    ridgeStationSpacing, archStations,
    bodySideOutline, pendulumSideOutline, knightRiderOutline, knightCrestOutline, FIGURE
} from './geometry.js';
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

function toManifold(g) {
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
function csgChain(baseGeometry, ops, simplifyTol = SIMPLIFY_TOL_MM) {
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

/** Fast, ridgeless shell for the interactive scene. */
export function buildPieceDisplayGeometry(piece, spec = SPEC, bossStations, support) {
    const pads = bossStations ?? [piece.planLen / 2];
    const stations = stationsForPiece(piece, 6, archStations(piece, spec, pads));
    const profiles = pieceProfiles(piece, stations, spec, false, pads);
    const shell = toBufferGeometry(sweepSolid(profiles, stations));
    const ops = [];

    if (piece.type === 'elevator' || piece.isElevator) {
        const Wo = piece.innerWidth / 2 + spec.wall;
        const dir = [Math.cos(piece.entry.h), Math.sin(piece.entry.h)];
        const right = [-Math.sin(piece.entry.h), Math.cos(piece.entry.h)];
        const c40 = [piece.entry.x + dir[0] * 40, piece.entry.z + dir[1] * 40];
        const c110 = [piece.entry.x + dir[0] * 110, piece.entry.z + dir[1] * 110];
        const housingPoly = [
            [c40[0] - right[0] * Wo, c40[1] - right[1] * Wo],
            [c40[0] + right[0] * Wo, c40[1] + right[1] * Wo],
            [c110[0] + right[0] * Wo, c110[1] + right[1] * Wo],
            [c110[0] - right[0] * Wo, c110[1] - right[1] * Wo]
        ];
        const housingSolid = toBufferGeometry(extrudePolygonY(housingPoly, piece.rimY, piece.exitDeck - spec.floorThk + 0.5));
        ops.push({ op: ADDITION, geometry: housingSolid });
        
        const W_slot = 12;
        const c15 = [piece.entry.x + dir[0] * 15, piece.entry.z + dir[1] * 15];
        const c135 = [piece.entry.x + dir[0] * 135, piece.entry.z + dir[1] * 135];
        const slotPoly = [
            [c15[0] - right[0] * (W_slot/2), c15[1] - right[1] * (W_slot/2)],
            [c15[0] + right[0] * (W_slot/2), c15[1] + right[1] * (W_slot/2)],
            [c135[0] + right[0] * (W_slot/2), c135[1] + right[1] * (W_slot/2)],
            [c135[0] - right[0] * (W_slot/2), c135[1] - right[1] * (W_slot/2)]
        ];
        const slotSolid = toBufferGeometry(extrudePolygonY(slotPoly, piece.rimY - 5, piece.exitDeck + 15));
        ops.push({ op: SUBTRACTION, geometry: slotSolid });
    }

    const Wi = piece.innerWidth / 2;
    if (piece.type === 'start') {
        const bump = planToWorld(
            [[-Wi - 1, 2], [Wi + 1, 2], [Wi + 1, 10], [-Wi - 1, 10]],
            { ...piece.entry }
        );
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(bump, piece.entryDeck - 4, piece.entryDeck + spec.railHeight + 14))
        });
    }

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

    return toBufferGeometry(csgChain(shell, ops));
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
    const h0 = spec.ridge.height + 0.05;   // spare this route's own washboard
    const h1 = spec.railHeight + 8;
    // Follows the seam taper. Cutting at the body width all the way to the
    // mouth would eat into the other route's rails where the channel has
    // already narrowed back to the mating face.
    const profiles = stations.map(st => {
        const w = innerWidthAt(piece, st.s) / 2 - 0.05;
        return [[-w, h0], [w, h0], [w, h1], [-w, h1]];
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
    const AF = afOverride ?? spec.socket.hexAF;
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
            // bored out below the seat so the spacer's body tucks up inside it
            ops.push({
                op: SUBTRACTION,
                geometry: slantedCylinder(bx, bz, bossHeading, collarBoreR,
                    (ds, lat) => planeAt(ds, lat) - 0.5, mouthY)
            });
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
        // the track's socket alone is cut undersize — see socket.trackShrinkAF
        geometry: hexSocketSolid(bx, bz, mouthY - 0.5, socketTop, spec,
            spec.socket.hexAF - (spec.socket.trackShrinkAF ?? 0), spec.socket.gripTaperAF ?? 0,
            roofY)
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
    if (piece.type === 'elevator' || piece.isElevator) {
        const Wo = piece.innerWidth / 2 + spec.wall;
        const dir = [Math.cos(piece.entry.h), Math.sin(piece.entry.h)];
        const right = [-Math.sin(piece.entry.h), Math.cos(piece.entry.h)];
        const c40 = [piece.entry.x + dir[0] * 40, piece.entry.z + dir[1] * 40];
        const c110 = [piece.entry.x + dir[0] * 110, piece.entry.z + dir[1] * 110];
        const housingPoly = [
            [c40[0] - right[0] * Wo, c40[1] - right[1] * Wo],
            [c40[0] + right[0] * Wo, c40[1] + right[1] * Wo],
            [c110[0] + right[0] * Wo, c110[1] + right[1] * Wo],
            [c110[0] - right[0] * Wo, c110[1] - right[1] * Wo]
        ];
        const housingSolid = toBufferGeometry(extrudePolygonY(housingPoly, piece.rimY, piece.exitDeck - spec.floorThk + 0.5));
        ops.push({ op: ADDITION, geometry: housingSolid });

        const W_slot = 12;
        const c15 = [piece.entry.x + dir[0] * 15, piece.entry.z + dir[1] * 15];
        const c135 = [piece.entry.x + dir[0] * 135, piece.entry.z + dir[1] * 135];
        const slotPoly = [
            [c15[0] - right[0] * (W_slot/2), c15[1] - right[1] * (W_slot/2)],
            [c15[0] + right[0] * (W_slot/2), c15[1] + right[1] * (W_slot/2)],
            [c135[0] + right[0] * (W_slot/2), c135[1] + right[1] * (W_slot/2)],
            [c135[0] - right[0] * (W_slot/2), c135[1] - right[1] * (W_slot/2)]
        ];
        const slotSolid = toBufferGeometry(extrudePolygonY(slotPoly, piece.rimY - 5, piece.exitDeck + 15));
        ops.push({ op: SUBTRACTION, geometry: slotSolid });
    }
    const Wi = piece.innerWidth / 2;

    if (piece.type === 'start') {
        const bump = planToWorld(
            [[-Wi - 1, 2], [Wi + 1, 2], [Wi + 1, 10], [-Wi - 1, 10]],
            { ...piece.entry }
        );
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(bump, piece.entryDeck - 4, piece.entryDeck + spec.railHeight + 14))
        });
    }

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
    const solid = csgChain(shell, ops, opts.simplifyTol);
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

    const solid = csgChain(shell, ops);
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
    // branch curls toward −right for switchL → hinge on +right wall (and vice versa)
    const hingeSide = mainPiece.switchType === 'switchL' ? 1 : -1;
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
    const comp = K.printComp ?? { neckMm: 0, tipMm: 0 };
    const shape = {
        neckHalf: K.neckHalf - comp.neckMm, tipHalf: K.tipHalf + comp.tipMm,
        depth: K.depth, tipChamfer: K.tipChamfer
    };
    const full = bowtieKeyPlan(shape).map(([x, z]) => [x, -z]);
    // a TRUE inward offset, so the chamfer band's quads stay planar and the
    // chamfer is the same 0.5 mm on every edge — see insetPolygon
    const inset = insetPolygon(full, 0.5);
    // 0.5 mm chamfers top and bottom: elephant-foot proof and drops into
    // its pockets without snagging a sharp corner
    return sweepSolid(
        [inset, full, full, inset],
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

const TENON_AF = SPEC.socket.hexAF - 2 * SPEC.jointClearanceMm; // 8.6

/** Hex support pillar with base flare and top tenon. Zero CSG. */
export function buildPillarGeometry(heightMm, spec = SPEC) {
    return toBufferGeometry(stackedHex([
        { y: 0, af: 24.8 },                                   // elephant-foot chamfer
        { y: 0.6, af: 26 },
        { y: 4, af: 26 },
        { y: 4, af: 15 },
        { y: heightMm, af: 15 },
        { y: heightMm, af: TENON_AF },
        { y: heightMm + spec.socket.depth - 2, af: TENON_AF },
        { y: heightMm + spec.socket.depth - 1, af: TENON_AF - 1.4 }  // insertion lead-in
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
         hexPlan(TENON_AF).map(([x, z]) => [x, -z]),
         hexPlan(TENON_AF - 1.4).map(([x, z]) => [x, -z])],
        [at(H), at(H + spec.socket.depth - 2), at(H + spec.socket.depth - 1)]));
    return csgChain(ends[0], [
        { op: ADDITION, geometry: bar },
        { op: ADDITION, geometry: ends[1] },
        { op: ADDITION, geometry: tenon },
        { op: SUBTRACTION, geometry: hexSocketSolid(arm, 0, -0.5, spec.socket.depth, spec) },
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
    const body = toBufferGeometry(stackedHex([
        { y: 0, af: 34.8 },                                  // elephant-foot chamfer
        { y: 0.6, af: 36 },
        { y: 4, af: 36 },
        { y: 4, af: 15 },
        { y: STANDARD.footHeight, af: 15 },
        { y: STANDARD.footHeight, af: TENON_AF },
        { y: STANDARD.footHeight + spec.socket.depth - 2, af: TENON_AF },
        { y: STANDARD.footHeight + spec.socket.depth - 1, af: TENON_AF - 1.4 }
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
    return marks.length ? toBufferGeometry(csgChain(body, marks)) : body;
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
         hexRingPlan(TENON_AF, n), hexRingPlan(TENON_AF, n),
         hexRingPlan(TENON_AF - 1.4, n)
        ].map(pl => pl.map(([x, z]) => [x, -z])),
        [0, heightMm, heightMm,
         heightMm + spec.socket.depth - 2,
         heightMm + spec.socket.depth - 1
        ].map(y => ({ origin: [0, y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
    ));
    const ops = [
        // the socket the riser stack plugs into, opening downward
        { op: SUBTRACTION, geometry: hexSocketSolid(0, 0, -0.5, spec.socket.depth, spec) },
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
    const body = toBufferGeometry(stackedHex([
        { y: 0, af: 15 },
        { y: sizeMm, af: 15 },
        { y: sizeMm, af: TENON_AF },
        { y: sizeMm + spec.socket.depth - 2, af: TENON_AF },
        { y: sizeMm + spec.socket.depth - 1, af: TENON_AF - 1.4 }
    ]));
    return csgChain(body, [
        { op: SUBTRACTION, geometry: hexSocketSolid(0, 0, -0.5, spec.socket.depth, spec) },
        ...gridMarks(sizeMm, spec),
        // BETWEEN two grid marks, not across one. hexFlatEngraveOps centres the
        // block on the span it is given, and given the whole shaft that centre
        // is sizeMm/2 — which on a 30 and a 60 is exactly where a groove runs,
        // so the code came out bisected. It gets the band above the last mark
        // instead: 14 mm on any marked riser, against a 5.9 mm block.
        ...hexFlatEngraveOps(opts.code ?? null, 15, lastGridMark(sizeMm) + 1, sizeMm, spec)
    ]);
}

/**
 * A shallow groove at every 15 mm line up a riser.
 *
 * They are not decoration and they are not the spacer's ring count either.
 * The ladder is built out of ONE unit and a riser is a whole number of them,
 * so cutting the unit into the part makes the part say how tall it is: a 60
 * carries three grooves, a 30 carries one, and the eye reads "four units"
 * rather than "the long one". It also teaches 15 mm — pick up any riser and
 * the spacing between two grooves IS the grid, which is the number every
 * height in the system is made of.
 *
 * 0.4 mm deep on the flats. Deep enough to catch the light and a fingernail,
 * shallow enough to leave the 15 AF section that mates a socket untouched
 * — the groove sits between joints, never at one.
 *
 * THE CUTTER IS A TUBE. Sweeping closed profiles makes a solid of REVOLUTION
 * that contains the axis, so subtracting one straight would core the riser out
 * rather than groove it; that is exactly what it did to the spacer, and left a
 * 0.76 mm shell where the part looked severed. So the bicone has its own bore
 * taken out first and only the annular V is subtracted.
 */
/** Height of the topmost grid mark on a riser, or 0 if it carries none. */
function lastGridMark(sizeMm) {
    const G = STANDARD.gridMm;
    return Math.max(0, Math.floor((sizeMm - 1) / G) * G);
}

function gridMarks(sizeMm, spec = SPEC) {
    const G = STANDARD.gridMm, AF = 15, waist = AF - 0.8, n = 24;
    const ops = [];
    for (let y = G; y <= sizeMm - 1; y += G) {
        const band = 1.2;
        const lvl = (af, yy) => ({ plan: hexRingPlan(af, n).map(([x, z]) => [x, -z]), y: yy });
        const cone = [lvl(AF + 3, y - band / 2), lvl(waist, y), lvl(AF + 3, y + band / 2)];
        const bore = [lvl(waist, y - band), lvl(waist, y + band)];
        const sweep = (levels) => toBufferGeometry(sweepSolid(
            levels.map(l => l.plan),
            levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }))
        ));
        ops.push({
            op: SUBTRACTION,
            geometry: toBufferGeometry(csgChain(sweep(cone),
                [{ op: SUBTRACTION, geometry: sweep(bore) }]))
        });
    }
    return ops;
}

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
        { y: heightMm + 6 + spec.socket.depth - 2, af: TENON_AF },
        { y: heightMm + 6 + spec.socket.depth - 1, af: TENON_AF - 1.4 }
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
        { y: -8, af: TENON_AF - 1.4 },   // insertion lead-in
        { y: -7, af: TENON_AF },
        { y: 0.5, af: TENON_AF }
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
