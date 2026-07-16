/**
 * pieces.js
 * Three.js + CSG assembly of printable parts. Two fidelity levels:
 *  - display geometry: coarse sweep, no ridges/joints — fast scene rebuilds
 *  - export geometry: fine washboard sweep + CSG dovetails, waterfall-safe
 *    joints, pillar-socket bosses — the watertight meshes users print
 */

import * as THREE from 'three';
import Module from 'manifold-3d';
import { SPEC, stationsForPiece } from './track.js';
import {
    sweepSolid, extrudePolygonY, extrudeOutlineX, pieceProfiles,
    dovetailTabPlan, dovetailSlotPlan, hexPlan, circlePlan,
    bodySideOutline, pendulumSideOutline, FIGURE
} from './geometry.js';
import { deduplicateGeometry } from './mesh_utils.js';

// --- Manifold WASM boolean kernel: guarantees watertight boolean results ---
let wasm = null;

/** Must be awaited once before any export-geometry builder runs. */
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

/** Accepts {positions, indices} arrays or a THREE.BufferGeometry. */
function toArrays(g) {
    if (g.positions) return { positions: g.positions, indices: g.indices };
    const pos = g.attributes.position.array;
    const idx = g.index
        ? g.index.array
        : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Welds seams (procedural geometry has duplicated UV-seam verts) → Manifold. */
function toManifold(g) {
    if (!wasm) throw new Error('initCSG() must be awaited before building export geometry');
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
    const mesh = new wasm.Mesh({
        numProp: 3,
        vertProperties,
        triVerts: new Uint32Array(clean)
    });
    mesh.merge();
    const m = new wasm.Manifold(mesh);
    return m;
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

/** Plan-local (lateral px, forward pz) → world XZ at a joint face. */
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
export function buildPieceDisplayGeometry(piece, spec = SPEC) {
    const stations = stationsForPiece(piece, 10);
    const profiles = pieceProfiles(piece, stations, spec, false);
    return toBufferGeometry(sweepSolid(profiles, stations));
}

/**
 * Full watertight export mesh: washboard floor, waterfall dovetail joints,
 * start bumper, pillar-socket boss. Heavy — run on demand with progress UI.
 */
export function buildPieceExportGeometry(piece, opts = {}) {
    const spec = opts.spec ?? SPEC;
    const isFirst = opts.isFirst ?? piece.index === 0;
    const isLast = opts.isLast ?? false;
    // ≥6 stations per ridge period keeps the sine ridges smooth
    const stations = stationsForPiece(piece, piece.ridgePitch / 6);
    const profiles = pieceProfiles(piece, stations, spec, true);
    const shell = toBufferGeometry(sweepSolid(profiles, stations));

    const ops = [];
    const Wi = piece.innerWidth / 2;
    const jointCl = spec.jointClearanceMm;

    // Start bumper: wall across the channel at the uphill end of the platform.
    if (piece.type === 'start') {
        // overlap 1 mm into each rail so the union never leaves a coplanar sliver
        const bump = planToWorld(
            [[-Wi - 1, 2], [Wi + 1, 2], [Wi + 1, 10], [-Wi - 1, 10]],
            { ...piece.entry, x: piece.entry.x, z: piece.entry.z }
        );
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(bump, piece.entryDeck - 4, piece.entryDeck + spec.railHeight + 14))
        });
    }

    // Exit dovetail tab: hangs 0.5 mm below this piece's own drumhead so that,
    // after the 0.25 mm waterfall drop, it still clears the next piece's floor.
    if (!isLast) {
        const ceilExit = piece.exitDeck - spec.floorThk;
        const tab = planToWorld(dovetailTabPlan({}), { ...piece.exit });
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(tab, ceilExit - 6.5, ceilExit - 0.5))
        });
    }

    // Entry receiver: thickened under-floor block with a clearance-offset
    // dovetail slot. The slot floor shelf carries the uphill piece's tab.
    if (!isFirst) {
        const ceilEntry = piece.entryDeck - spec.floorThk;
        const block = planToWorld(
            [[-19, -0.25], [19, -0.25], [19, 14], [-19, 14]],
            { ...piece.entry }
        );
        ops.push({
            op: ADDITION,
            geometry: toBufferGeometry(extrudePolygonY(block, ceilEntry - 8, ceilEntry + 0.5))
        });
        // Uphill tab spans [ceil−6.25, ceil−0.25] in THIS piece's frame (waterfall).
        const slot = planToWorld(dovetailSlotPlan({ clearance: jointCl }), { ...piece.entry });
        ops.push({
            op: SUBTRACTION,
            geometry: toBufferGeometry(extrudePolygonY(slot, ceilEntry - 6.25 - jointCl, ceilEntry - 0.25 + jointCl))
        });
    }

    // Pillar-socket boss at mid-piece: hollow hex socket opening at the rim.
    const mid = midStation(piece);
    const bossPlan = circlePlan(spec.socket.bossR, 24).map(([px, pz]) => [mid.x + px, mid.z + pz]);
    ops.push({
        op: ADDITION,
        geometry: toBufferGeometry(extrudePolygonY(bossPlan, piece.rimY, mid.ceilY + 0.5))
    });
    const hex = hexPlan(spec.socket.hexAF).map(([px, pz]) => [mid.x + px, mid.z + pz]);
    ops.push({
        op: SUBTRACTION,
        geometry: toBufferGeometry(extrudePolygonY(hex, piece.rimY - 0.5, piece.rimY + spec.socket.depth))
    });

    return csgChain(shell, ops);
}

function midStation(piece) {
    const stations = stationsForPiece(piece, piece.planLen / 2);
    const m = stations[Math.floor(stations.length / 2)];
    return { x: m.origin[0], z: m.origin[2], ceilY: m.origin[1] - SPEC.floorThk };
}

// ---------------------------------------------------------------------------
// Support pillars ("tree trunks")
// ---------------------------------------------------------------------------

/**
 * Hex support pillar with a base flare and a tenon that plugs into the track's
 * underside socket. Single stacked sweep — manifold with zero CSG.
 * @param {number} heightMm - ground to skirt-rim distance
 */
export function buildPillarGeometry(heightMm, spec = SPEC) {
    const tenonAF = spec.socket.hexAF - 2 * spec.jointClearanceMm;
    const levels = [
        { y: 0, af: 26 },
        { y: 4, af: 26 },
        { y: 4, af: 15 },
        { y: heightMm, af: 15 },
        { y: heightMm, af: tenonAF },
        { y: heightMm + spec.socket.depth - 1, af: tenonAF }
    ];
    const profiles = levels.map(l => hexPlan(l.af).map(([x, z]) => [x, -z]));
    const stations = levels.map(l => ({ origin: [0, l.y, 0], right: [1, 0, 0], up: [0, 0, -1] }));
    return toBufferGeometry(sweepSolid(profiles, stations));
}

// ---------------------------------------------------------------------------
// Walker figure (Phase-5 calibration test figure)
// ---------------------------------------------------------------------------

function cylinderX(r, x0, x1, cz, cy, segments = 24) {
    const g = new THREE.CylinderGeometry(r, r, x1 - x0, segments);
    g.rotateZ(Math.PI / 2); // cylinder axis Y → X
    g.translate((x0 + x1) / 2, cy, cz);
    return g;
}

/**
 * Builds all printable figure parts. Width defaults to trackInnerWidth − 4 mm
 * (stance clearance rule). Returns Y-up geometries in assembly position.
 */
export function buildFigureGeometries(trackInnerWidth = SPEC.innerWidth.default, opts = {}) {
    const W = (opts.widthMm ?? trackInnerWidth - 4);
    const F = FIGURE;

    // --- Body: silhouette extrusion minus pendulum slot, axle bore, ballast bore
    const bodyBase = toBufferGeometry(extrudeOutlineX(bodySideOutline(), -W / 2, W / 2));
    const slot = new THREE.BoxGeometry(F.slot.halfW * 2, F.slot.yMax - F.slot.yMin, F.slot.zMax - F.slot.zMin);
    slot.translate(0, (F.slot.yMax + F.slot.yMin) / 2, (F.slot.zMax + F.slot.zMin) / 2);
    const body = csgChain(bodyBase, [
        { op: SUBTRACTION, geometry: slot },
        { op: SUBTRACTION, geometry: cylinderX(F.axle.holeBodyR, -W / 2 - 1, W / 2 + 1, F.axle.z, F.axle.y) },
        { op: SUBTRACTION, geometry: cylinderX(F.bodyBallast.r, -W / 2 - 1, W / 2 + 1, F.bodyBallast.z, F.bodyBallast.y) }
    ]);

    // --- Pendulum: rear-leg swing arm with loose axle bore and its own ballast
    const pw = F.pendulumW / 2;
    const pendBase = toBufferGeometry(extrudeOutlineX(pendulumSideOutline(), -pw, pw));
    const pendulum = csgChain(pendBase, [
        { op: SUBTRACTION, geometry: cylinderX(F.axle.holePendR, -pw - 1, pw + 1, F.axle.z, F.axle.y) },
        { op: SUBTRACTION, geometry: cylinderX(F.pendBallast.r, -pw - 1, pw + 1, F.pendBallast.z, F.pendBallast.y) }
    ]);

    // --- Safety plugs (choke-hazard covers, glued at assembly): stacked-disc
    //     sweeps, one flanged plug per bore end. Merged into one print plate.
    const plugSet = mergeSolids([
        ...plugPair(F.bodyBallast.r - 0.15, 0, 0),
        ...plugPair(F.pendBallast.r - 0.15, 26, 0),
        ...plugPair(F.axle.holeBodyR - 0.18, 52, 0)
    ]);

    return { body, pendulum, plugSet, widthMm: W };
}

/** Flanged plug as a stacked-radius sweep (flange + stem), duplicated. */
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
function mergeSolids(solids) {
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
