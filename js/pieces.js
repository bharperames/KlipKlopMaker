/**
 * pieces.js
 * Three.js + Manifold-CSG assembly of printable parts. Two fidelity levels:
 *  - display geometry: coarse sweep, no ridges/joints — fast scene rebuilds
 *  - export geometry: fine washboard sweep + print-friendly joints
 *
 * Joint system (v2, slicer-verified friendly): every mating end face gets a
 * full-height internal END RIB (bed → drumhead ceiling — prints as a plain
 * wall and seals the acoustic chamber) with a BOWTIE POCKET recessed into it.
 * A separate print-flat bowtie key bridges each seam, Hot-Wheels style.
 * No geometry ever overhangs: the old protruding dovetail tab was a floating
 * cantilever on the build plate.
 *
 * Interlock standard (used by everything): hex tenon AF 8.6 ↔ hex socket
 * AF 9 × 10 deep. Pillars, towers, palm trunks and track sockets all share it.
 */

import * as THREE from 'three';
import Module from 'manifold-3d';
import { SPEC, stationsForPiece } from './track.js';
import {
    sweepSolid, extrudePolygonY, extrudeOutlineX, pieceProfiles,
    bowtieKeyPlan, bowtiePocketPlan, hexPlan, circlePlan,
    bodySideOutline, pendulumSideOutline, FIGURE
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

export function toBufferGeometry({ positions, indices }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    return g;
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

export const ADDITION = 'add';
export const SUBTRACTION = 'subtract';

/** Runs a chain of boolean operations; the result is manifold by construction. */
function csgChain(baseGeometry, ops) {
    let acc = toManifold(baseGeometry);
    for (const { op, geometry } of ops) {
        const other = toManifold(geometry);
        const next = op === SUBTRACTION ? acc.subtract(other) : acc.add(other);
        acc.delete();
        other.delete();
        acc = next;
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

/** Fast, ridgeless shell for the interactive scene. */
export function buildPieceDisplayGeometry(piece, spec = SPEC, padCenters) {
    const stations = stationsForPiece(piece, 6);
    const profiles = pieceProfiles(piece, stations, spec, false, padCenters ?? [piece.planLen / 2]);
    return toBufferGeometry(sweepSolid(profiles, stations));
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
    const w = piece.innerWidth / 2 - 0.05;
    const h0 = spec.ridge.height + 0.05;   // spare this route's own washboard
    const h1 = spec.railHeight + 8;
    const profile = [[-w, h0], [w, h0], [w, h1], [-w, h1]];
    // extend past both faces so the cut runs cleanly through the mouth
    const ext = [...stations];
    return sweepSolid(ext.map(() => profile), ext);
}

/** Display union of a switch's two route shells with an open frog. */
export function buildSwitchDisplayGeometry(mainPiece, branchPiece, spec = SPEC, padCenters) {
    const mk = (piece) => {
        const stations = stationsForPiece(piece, 8);
        return toBufferGeometry(sweepSolid(
            pieceProfiles(piece, stations, spec, false, padCenters ?? [piece.planLen / 2]), stations));
    };
    return toBufferGeometry(csgChain(mk(mainPiece), [
        { op: ADDITION, geometry: mk(branchPiece) },
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(mainPiece, spec, 12)) },
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(branchPiece, spec, 12)) }
    ]));
}

/** Fine washboard shell (positions/indices) for one piece. */
function fineShell(piece, spec, padCenters) {
    const stations = stationsForPiece(piece, piece.ridgePitch / 6);
    const profiles = pieceProfiles(piece, stations, spec, true, padCenters ?? [piece.planLen / 2]);
    return toBufferGeometry(sweepSolid(profiles, stations));
}

/**
 * End rib + bowtie pocket at a joint face.
 * @param face - {x,z,h} where h points INWARD (into the piece body)
 * @param deckY - world deck-line height at this face
 * @param seamDeckY - world deck height of the UPHILL side of this seam
 *                    (pocket bands anchor here so both sides align absolutely)
 * @param rimY - piece rim (bed) height
 */
function jointOps(face, deckY, seamDeckY, rimY, innerWidth, spec) {
    const Wi = innerWidth / 2;
    const K = spec.key;
    const rib = planToWorld(
        [[-Wi - 1, 0], [Wi + 1, 0], [Wi + 1, K.ribThk], [-Wi - 1, K.ribThk]],
        face
    );
    const pocket = planToWorld(bowtiePocketPlan({
        neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth,
        clearance: spec.jointClearanceMm + 0.05
    }), face);
    return [
        { op: ADDITION, geometry: toBufferGeometry(extrudePolygonY(rib, rimY, deckY - spec.floorThk + 0.5)) },
        { op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(pocket, seamDeckY - 3 - K.height, seamDeckY - 3)) }
    ];
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
    let bx, bz;

    if (!support || support.mode === 'center') {
        const s = support?.s ?? piece.planLen / 2;
        const f = s / piece.planLen;
        if (support) {
            bx = support.x; bz = support.z;
        } else {
            const stations = stationsForPiece(piece, piece.planLen / 2);
            const m = stations[Math.floor(stations.length / 2)];
            bx = m.origin[0]; bz = m.origin[2];
        }
        const ceilY = (piece.entryDeck - piece.drop * f) - spec.floorThk;
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(
                circlePlan(spec.socket.bossR, 24).map(([px, pz]) => [bx + px, bz + pz]),
                piece.rimY, ceilY + 0.5))
        });
    } else {
        // outrigger: printable arm at rim level (sits on the bed) carrying the
        // socket boss outboard, clear of whatever runs beneath this piece
        bx = support.x; bz = support.z;
        const right = [Math.sin(support.h), -Math.cos(support.h)];
        const dirV = [Math.cos(support.h), Math.sin(support.h)];
        const armEnd = piece.innerWidth / 2 + spec.wall + spec.socket.bossR + 4;
        const armStart = piece.innerWidth / 2 - 2; // overlap 2 mm into the skirt
        const centerline = [bx - right[0] * armEnd * support.side, bz - right[1] * armEnd * support.side];
        const armPts = [
            [armStart * support.side, -11], [armEnd * support.side, -11],
            [armEnd * support.side, 11], [armStart * support.side, 11]
        ].map(([lat, lon]) => [
            centerline[0] + right[0] * lat + dirV[0] * lon,
            centerline[1] + right[1] * lat + dirV[1] * lon
        ]);
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(armPts, piece.rimY, piece.rimY + 11))
        });
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(
                circlePlan(spec.socket.bossR, 24).map(([px, pz]) => [bx + px, bz + pz]),
                piece.rimY, piece.rimY + 11))
        });
    }
    ops.push({
        op: SUBTRACTION,
        geometry: toBufferGeometry(extrudePolygonY(
            hexPlan(spec.socket.hexAF).map(([px, pz]) => [bx + px, bz + pz]),
            piece.rimY - 0.5, piece.rimY + spec.socket.depth))
    });
    return ops;
}

/**
 * Full watertight export mesh for a NON-SWITCH piece: washboard floor,
 * end ribs with bowtie pockets, start bumper, pillar-socket boss.
 */
export function buildPieceExportGeometry(piece, opts = {}) {
    const spec = opts.spec ?? SPEC;
    const hasEntryJoint = opts.hasEntryJoint ?? !piece.isImplicitStart;
    const hasExitJoint = opts.hasExitJoint ?? piece.type !== 'end';
    const shell = fineShell(piece, spec, opts.support ? [opts.support.s] : undefined);
    const ops = [];
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
            piece.entryDeck + spec.waterfallStepMm, piece.rimY, piece.innerWidth, spec
        ));
    }
    if (hasExitJoint) {
        ops.push(...jointOps(
            { x: piece.exit.x, z: piece.exit.z, h: piece.exit.h + Math.PI },
            piece.exitDeck, piece.exitDeck, piece.rimY, piece.innerWidth, spec
        ));
    }
    ops.push(...bossOps(piece, spec, opts.support));
    return csgChain(shell, ops);
}

/**
 * Switch part: union of the straight-through and diverging shells, one entry
 * joint, two exit joints, a boss, and a vertical gate-pin bore at the fork.
 */
export function buildSwitchExportGeometry(mainPiece, branchPiece, opts = {}) {
    const spec = opts.spec ?? SPEC;
    const shell = fineShell(mainPiece, spec, opts.support ? [opts.support.s] : undefined);
    const ops = [{ op: ADDITION, geometry: fineShell(branchPiece, spec) }];

    // open the frog: neither route's rails may cross the other's channel
    ops.push(
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(mainPiece, spec, 4)) },
        { op: SUBTRACTION, geometry: toBufferGeometry(routeClearanceEnvelope(branchPiece, spec, 4)) }
    );

    ops.push(...jointOps(
        { ...mainPiece.entry }, mainPiece.entryDeck,
        mainPiece.entryDeck + spec.waterfallStepMm, mainPiece.rimY, mainPiece.innerWidth, spec
    ));
    for (const pc of [mainPiece, branchPiece]) {
        ops.push(...jointOps(
            { x: pc.exit.x, z: pc.exit.z, h: pc.exit.h + Math.PI },
            pc.exitDeck, pc.exitDeck, pc.rimY, pc.innerWidth, spec
        ));
    }
    ops.push(...bossOps(mainPiece, spec, opts.support));

    // gate pivot bore: vertical Ø3.3 through the deck at the divergence point
    const pinPos = gatePinPosition(mainPiece);
    const pin = new THREE.CylinderGeometry(1.65, 1.65, spec.railHeight + spec.floorThk + 10, 20);
    pin.translate(pinPos.x, pinPos.deckY + spec.railHeight / 2, pinPos.z);
    ops.push({ op: SUBTRACTION, geometry: pin });

    return csgChain(shell, ops);
}

/**
 * Gate pivot: the blade hinges on the wall OPPOSITE the branch, just before
 * the mouth. Parked flat along that wall → figure runs straight through;
 * swung inward → it sweeps across the channel and deflects the figure into
 * the diverging route (how the original playset gates work).
 */
export function gatePinPosition(mainPiece) {
    const h = mainPiece.entry.h;
    const dir = [Math.cos(h), Math.sin(h)];
    const right = [Math.sin(h), -Math.cos(h)];
    // branch curls toward −right for switchL → hinge on +right wall (and vice versa)
    const hingeSide = mainPiece.switchType === 'switchL' ? 1 : -1;
    const s = 16;
    const lat = (mainPiece.innerWidth / 2 - 4) * hingeSide;
    return {
        x: mainPiece.entry.x + dir[0] * s + right[0] * lat,
        z: mainPiece.entry.z + dir[1] * s + right[1] * lat,
        deckY: mainPiece.entryDeck - (s / mainPiece.planLen) * mainPiece.drop,
        hingeSide,
        // yaw of the blade (which extends forward from the hinge):
        // parked along the wall vs swung ~33° across the channel toward the branch
        yawParked: h,
        yawDiverting: h + (mainPiece.switchType === 'switchL' ? 1 : -1) * 0.58
    };
}

/** Printable connector key — one per seam, prints flat in stacks. */
export function buildKeyGeometry(spec = SPEC) {
    const K = spec.key;
    return extrudePolygonY(
        bowtieKeyPlan({ neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth }),
        0, K.height - 2 * spec.jointClearanceMm
    );
}

/**
 * Printable switch gate: pivot hub + vane that deflects the figure into the
 * selected route, with a pin that drops into the deck bore. Prints on its side.
 */
export function buildGateGeometry(spec = SPEC) {
    // hub + pin as a stacked-radius sweep along Y (vane added via CSG)
    const levels = [
        { y: -8, r: 1.45 },                    // pin (Ø2.9 into the Ø3.3 bore)
        { y: 0, r: 1.45 },
        { y: 0, r: 5 },                        // hub
        { y: spec.railHeight - 2, r: 5 }
    ];
    const profiles = levels.map(l => circlePlan(l.r, 24).map(([x, z]) => [x, -z]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    const hub = toBufferGeometry(sweepSolid(profiles, stations));
    const vane = new THREE.BoxGeometry(2.6, spec.railHeight - 2, 52);
    vane.translate(0, (spec.railHeight - 2) / 2, 24);
    return csgChain(hub, [{ op: ADDITION, geometry: vane }]);
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
        { y: 0, af: 26 },
        { y: 4, af: 26 },
        { y: 4, af: 15 },
        { y: heightMm, af: 15 },
        { y: heightMm, af: TENON_AF },
        { y: heightMm + spec.socket.depth - 1, af: TENON_AF }
    ]));
}

/**
 * Scenery tower: fat hex trunk, top tenon (supports track like a pillar),
 * bottom socket (stacks on another tower or a patio). Needs initCSG.
 */
export function buildTowerGeometry(heightMm = 100, spec = SPEC) {
    const body = toBufferGeometry(stackedHex([
        { y: 0, af: 44 },
        { y: 6, af: 44 },
        { y: 6, af: 34 },
        { y: heightMm, af: 34 },
        { y: heightMm, af: 44 },
        { y: heightMm + 6, af: 44 },
        { y: heightMm + 6, af: TENON_AF },
        { y: heightMm + 6 + spec.socket.depth - 1, af: TENON_AF }
    ]));
    const socket = toBufferGeometry(extrudePolygonY(hexPlan(spec.socket.hexAF), -0.5, spec.socket.depth));
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
    const socket = toBufferGeometry(extrudePolygonY(hexPlan(spec.socket.hexAF), 2, 10.5));
    const island = csgChain(plate, [{ op: SUBTRACTION, geometry: socket }]);

    // palm: tenon → tapered trunk → crown of fronds (8-point star)
    const trunkLevels = [
        { y: -8, r: (TENON_AF / 2) / Math.cos(Math.PI / 6) },
        { y: 0, r: (TENON_AF / 2) / Math.cos(Math.PI / 6) },
        { y: 0, r: 6 },
        { y: 66, r: 4 }
    ];
    const profiles = trunkLevels.map(l => circlePlan(l.r, 18).map(([x, z]) => [x, -z]));
    const stations = trunkLevels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    const trunk = toBufferGeometry(sweepSolid(profiles, stations));
    const star = [];
    for (let i = 0; i < 16; i++) {
        const r = i % 2 === 0 ? 30 : 9;
        const a = (i / 16) * 2 * Math.PI;
        star.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    const crown = toBufferGeometry(extrudePolygonY(star, 63, 67));
    const palm = csgChain(trunk, [{ op: ADDITION, geometry: crown }]);
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
        const hex = hexPlan(spec.socket.hexAF).map(([x, z]) => [cx + x, cz + z]);
        ops.push({ op: SUBTRACTION, geometry: toBufferGeometry(extrudePolygonY(hex, 1.5, 8.5)) });
    }
    return csgChain(plate, ops);
}

// ---------------------------------------------------------------------------
// Walker figure
// ---------------------------------------------------------------------------

function cylinderX(r, x0, x1, cz, cy, segments = 24) {
    const g = new THREE.CylinderGeometry(r, r, x1 - x0, segments);
    g.rotateZ(Math.PI / 2); // cylinder axis Y → X
    g.translate((x0 + x1) / 2, cy, cz);
    return g;
}

/** Builds all printable figure parts (width = trackInnerWidth − 4 mm). */
export function buildFigureGeometries(trackInnerWidth = SPEC.innerWidth.default, opts = {}) {
    const W = (opts.widthMm ?? trackInnerWidth - 4);
    const F = FIGURE;

    const bodyBase = toBufferGeometry(extrudeOutlineX(bodySideOutline(), -W / 2, W / 2));
    const slot = new THREE.BoxGeometry(F.slot.halfW * 2, F.slot.yMax - F.slot.yMin, F.slot.zMax - F.slot.zMin);
    slot.translate(0, (F.slot.yMax + F.slot.yMin) / 2, (F.slot.zMax + F.slot.zMin) / 2);
    const body = csgChain(bodyBase, [
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
        const profiles = levels.map(l => circlePlan(l.r, 24).map(([x, z]) => [x, -z]));
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
