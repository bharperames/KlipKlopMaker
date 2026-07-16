/**
 * geometry.js
 * Pure watertight mesh construction — no DOM or Three.js dependencies.
 * All builders return { positions: Float32Array, indices: Uint32Array } closed
 * solids with consistent outward winding, verified by tests via mesh_utils.
 *
 * Coordinate system: Y-up (Three.js convention). Exporters convert to Z-up.
 */

import { signedMeshVolumeMm3 } from './mesh_utils.js';
import { ridgeOffset } from './track.js';

/** Shoelace signed area of a 2D polygon [[x,y],...]. Positive = CCW. */
export function signedArea2D(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

const cross2 = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = cross2(ax, ay, bx, by, px, py);
    const d2 = cross2(bx, by, cx, cy, px, py);
    const d3 = cross2(cx, cy, ax, ay, px, py);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon (any winding).
 * Returns triangles as index triples into `pts`, wound CCW.
 */
export function earClipTriangulate(pts) {
    const n = pts.length;
    if (n < 3) return [];
    let idx = [...Array(n).keys()];
    if (signedArea2D(pts) < 0) idx.reverse();

    const tris = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 100000) {
        let clipped = false;
        for (let vi = 0; vi < idx.length; vi++) {
            const ia = idx[(vi + idx.length - 1) % idx.length];
            const ib = idx[vi];
            const ic = idx[(vi + 1) % idx.length];
            const [ax, ay] = pts[ia], [bx, by] = pts[ib], [cx, cy] = pts[ic];
            if (cross2(ax, ay, bx, by, cx, cy) <= 1e-9) continue; // reflex or degenerate
            let contains = false;
            for (const io of idx) {
                if (io === ia || io === ib || io === ic) continue;
                const [px, py] = pts[io];
                if (pointInTri(px, py, ax, ay, bx, by, cx, cy)) { contains = true; break; }
            }
            if (contains) continue;
            tris.push([ia, ib, ic]);
            idx.splice(vi, 1);
            clipped = true;
            break;
        }
        if (!clipped) { // numerical fallback: clip the first vertex regardless
            tris.push([idx[0], idx[1], idx[2]]);
            idx.splice(1, 1);
        }
    }
    tris.push([idx[0], idx[1], idx[2]]);
    return tris;
}

/**
 * Sweeps a per-station 2D profile along stations to a closed solid.
 * Every station: { origin: [x,y,z], right: [x,y,z], up?: [x,y,z] }.
 * World point = origin + right*u + up*v for profile point (u, v).
 * `up` defaults to world Y — combined with a horizontal `right` this enforces
 * the zero-bank rule: cross-sections never roll into a curve.
 *
 * @param {Array<Array<[number,number]>>} profiles - one profile per station (equal point counts)
 * @param {Array<object>} stations
 */
export function sweepSolid(profiles, stations) {
    if (profiles.length !== stations.length) throw new Error('profiles/stations length mismatch');
    const K = profiles[0].length;
    for (const pr of profiles) if (pr.length !== K) throw new Error('inconsistent profile point counts');

    // Normalize winding to CCW in the (right, up) frame so sides + caps agree.
    const ccw = signedArea2D(profiles[0]) >= 0;
    const P = ccw ? profiles : profiles.map(pr => [...pr].reverse());

    const nS = stations.length;
    const positions = new Float32Array(nS * K * 3);
    let w = 0;
    for (let i = 0; i < nS; i++) {
        const { origin, right } = stations[i];
        const up = stations[i].up || [0, 1, 0];
        for (let k = 0; k < K; k++) {
            const [u, v] = P[i][k];
            positions[w++] = origin[0] + right[0] * u + up[0] * v;
            positions[w++] = origin[1] + right[1] * u + up[1] * v;
            positions[w++] = origin[2] + right[2] * u + up[2] * v;
        }
    }

    const indices = [];
    const vid = (i, k) => i * K + k;
    // Side walls: outward for CCW profiles when travel = right × up.
    for (let i = 0; i < nS - 1; i++) {
        for (let k = 0; k < K; k++) {
            const k2 = (k + 1) % K;
            const a = vid(i, k), b = vid(i, k2), c = vid(i + 1, k2), d = vid(i + 1, k);
            indices.push(a, b, c, a, c, d);
        }
    }
    // Caps: ear clip returns CCW (normal +travel); start cap faces −travel → reversed.
    const capTris = earClipTriangulate(P[0]);
    for (const [a, b, c] of capTris) indices.push(vid(0, c), vid(0, b), vid(0, a));
    const endTris = earClipTriangulate(P[nS - 1]);
    for (const [a, b, c] of endTris) indices.push(vid(nS - 1, a), vid(nS - 1, b), vid(nS - 1, c));

    const idxArr = new Uint32Array(indices);
    // Safety: if winding came out inward, flip every triangle.
    if (signedMeshVolumeMm3(positions, idxArr) < 0) {
        for (let i = 0; i < idxArr.length; i += 3) {
            const t = idxArr[i + 1];
            idxArr[i + 1] = idxArr[i + 2];
            idxArr[i + 2] = t;
        }
    }
    return { positions, indices: idxArr };
}

/**
 * Extrudes a plan polygon [[x,z],...] vertically from y0 to y1 (a prism).
 */
export function extrudePolygonY(pts, y0, y1) {
    // Map plan (x,z) into sweep frame (u,v) with right=+X, up=−Z so travel=+Y.
    const profile = pts.map(([x, z]) => [x, -z]);
    return sweepSolid(
        [profile, profile],
        [
            { origin: [0, y0, 0], right: [1, 0, 0], up: [0, 0, -1] },
            { origin: [0, y1, 0], right: [1, 0, 0], up: [0, 0, -1] }
        ]
    );
}

/**
 * Extrudes a side outline [[z,y],...] along the X axis from x0 to x1.
 * Used for the walker figure body/pendulum silhouettes.
 */
export function extrudeOutlineX(pts, x0, x1) {
    // (u,v) = (z,y) with right=+Z, up=+Y → travel = right×up = ... choose right=[0,0,1].
    const profile = pts.map(([z, y]) => [z, y]);
    return sweepSolid(
        [profile, profile],
        [
            { origin: [x0, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
            { origin: [x1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] }
        ]
    );
}

/**
 * The Klip-Klop U-channel cross-section — a closed "staple" outline giving a
 * constant-thickness shell: guide rails, floor with hoof-recentering fillets,
 * hollow acoustic chamber below, and skirt walls down to a flat rim.
 *
 *          railTop ┌t┐               ┌t┐
 *                  │ │  fillet    fillet│ │
 *                  │ └────—floor(dS)——┘ │
 *                  │ ┌───—ceiling———──┐ │
 *                  │ │    (hollow)    │ │
 *           rimY   └─┘               └─┘
 *
 * @param {object} o - { innerWidth, wall, railH, floorThk, filletR, filletSegs,
 *                       deckY (centerline deck line), rimY, ridge (washboard lift) }
 * @returns {Array<[u,y]>} closed polygon, left-to-right = −u to +u
 */
export function channelProfile(o) {
    const {
        innerWidth, wall, railH, floorThk,
        filletR = 2, filletSegs = 4,
        deckY, rimY, ridge = 0
    } = o;
    const Wi = innerWidth / 2;
    const Wo = Wi + wall;
    const dS = deckY + ridge;          // floor surface rides the washboard
    const railTop = deckY + railH;     // rail crest follows the deck line, not the ridges
    const ceilY = deckY - floorThk;    // flat drumhead underside

    const pts = [];
    pts.push([-Wo, rimY]);
    pts.push([-Wo, railTop]);
    pts.push([-Wi, railTop]);
    pts.push([-Wi, dS + filletR]);
    // left fillet: quarter arc from wall down onto the floor
    for (let i = 1; i <= filletSegs; i++) {
        const t = Math.PI + (i / filletSegs) * (Math.PI / 2);
        pts.push([(-Wi + filletR) + filletR * Math.cos(t), (dS + filletR) + filletR * Math.sin(t)]);
    }
    // right fillet: floor back up the wall
    for (let i = 1; i <= filletSegs; i++) {
        const t = (3 * Math.PI) / 2 + (i / filletSegs) * (Math.PI / 2);
        pts.push([(Wi - filletR) + filletR * Math.cos(t), (dS + filletR) + filletR * Math.sin(t)]);
    }
    pts.push([Wi, railTop]);
    pts.push([Wo, railTop]);
    pts.push([Wo, rimY]);
    pts.push([Wi, rimY]);
    pts.push([Wi, ceilY]);
    pts.push([-Wi, ceilY]);
    pts.push([-Wi, rimY]);
    return pts;
}

/**
 * Builds all sweep profiles for a piece at the given stations, applying the
 * washboard ridge as a function of arc length (seams always land in valleys
 * because the pitch was snapped to the piece length).
 */
export function pieceProfiles(piece, stations, spec, withRidges) {
    return stations.map(st => channelProfile({
        innerWidth: piece.innerWidth,
        wall: spec.wall,
        railH: spec.railHeight,
        floorThk: spec.floorThk,
        filletR: spec.filletR,
        deckY: 0, // origins already carry the deck elevation
        rimY: piece.rimY - deckYOffset(piece, st),
        ridge: withRidges ? ridgeOffset(st.s, piece.ridgePitch, spec.ridge.height) : 0
    }));
}

// Profile coordinates are relative to the station origin (which sits on the
// deck line); the rim however is at a constant WORLD height per piece.
function deckYOffset(piece, station) {
    return station.origin[1];
}

/** Dovetail tab plan outline in joint-local coords (x lateral, z outward). */
export function dovetailTabPlan({ rootHalf = 11, tipHalf = 15, depth = 10, inset = 1 }) {
    return [
        [-rootHalf, -inset],
        [rootHalf, -inset],
        [tipHalf, depth],
        [-tipHalf, depth]
    ];
}

/** Dovetail slot plan (clearance-offset female) in joint-local coords. */
export function dovetailSlotPlan({ rootHalf = 11, tipHalf = 15, depth = 10, inset = 1, clearance = 0.2 }) {
    const flare = (tipHalf - rootHalf) / (depth + inset);
    const z0 = -0.5, z1 = depth + 0.5;
    const w0 = rootHalf + flare * (z0 + inset) + clearance;
    const w1 = rootHalf + flare * (z1 + inset) + clearance;
    return [
        [-w0, z0],
        [w0, z0],
        [w1, z1],
        [-w1, z1]
    ];
}

/** Regular polygon (plan) for hex sockets / tenons. acrossFlats in mm. */
export function hexPlan(acrossFlats, rotation = 0) {
    const R = (acrossFlats / 2) / Math.cos(Math.PI / 6);
    const pts = [];
    for (let i = 0; i < 6; i++) {
        const a = rotation + (i / 6) * 2 * Math.PI;
        pts.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    return pts;
}

/** Circle plan polygon. */
export function circlePlan(r, segments = 32) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * 2 * Math.PI;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return pts;
}

// ---------------------------------------------------------------------------
// Walker figure silhouettes (side view, coords [z forward, y up], mm)
// ---------------------------------------------------------------------------

/** Samples y on a rocker-cam circle: center (cz, cy), radius R. */
const camY = (z, cz, cy, R) => cy - Math.sqrt(Math.max(0, R * R - (z - cz) ** 2));

/**
 * Outer body silhouette: blocky horse with head, front-hoof rocker cam
 * (continuous tangent arc, radius 30 mm), and a raised rear arch so only the
 * swinging pendulum's rear hoof contacts the ramp behind the pivot.
 */
export function bodySideOutline() {
    const pts = [
        [-23, 8],    // rear bottom (arch, clears ground while rocking)
        [-23, 36],   // rear top
        [12, 36],    // wither
        [15, 46],    // neck
        [22, 46],    // head top
        [23, 40],    // nose
        [23, 6]      // chest down to hoof cam start
    ];
    // front hoof rocker cam: circle center (4, 30) R=30, lowest point at z=4
    for (const z of [22, 19, 16, 13, 10, 7, 4, 2, 0]) {
        pts.push([z, camY(z, 4, 30, 30)]);
    }
    pts.push([-2, 6]); // arch face rising behind the front hoof
    return pts;
}

/**
 * Rear-leg pendulum silhouette: axle boss (pivot at z=6, y=26), trailing leg,
 * rocker-cam hoof (circle center (−10, 30) R=30 → neutral contact at z=−10).
 */
export function pendulumSideOutline() {
    const pts = [
        [10, 26],            // boss front
        [8.8, 29],
        [6, 30],             // boss top (clears the body slot web)
        [3.2, 29],
        [2, 26],             // boss rear
        [-18, 8]             // leg rear edge
    ];
    for (const z of [-18, -14, -10, -6, -2]) {
        pts.push([z, camY(z, -10, 30, 30)]);
    }
    pts.push([0, 8]);        // leg front edge
    return pts;
}

/** Key figure dimensions shared by mesh builder, physics and UI. */
export const FIGURE = {
    axle: { z: 6, y: 26, holeBodyR: 1.6, holePendR: 1.75, rodDiaMm: 3 },
    slot: { halfW: 4.5, zMin: -24, zMax: 13, yMin: -2, yMax: 31 },
    bodyBallast: { z: 18, y: 10, r: 4 },
    pendBallast: { z: -9, y: 6, r: 3.5 },
    pendulumW: 8,
    legLenMm: 26,   // axle height above hoof contact
    alphaDeg: 18    // swing angle allowed by the slot walls
};

/** Approximate polygon area × width solid volume for ballast planning (mm³). */
export function figureVolumeEstimate(bodyWidthMm) {
    const bodyArea = Math.abs(signedArea2D(bodySideOutline()));
    const pendArea = Math.abs(signedArea2D(pendulumSideOutline()));
    const slotArea = (FIGURE.slot.zMax - FIGURE.slot.zMin) * (FIGURE.slot.yMax - 6); // rough
    return bodyArea * bodyWidthMm - slotArea * (FIGURE.slot.halfW * 2) + pendArea * FIGURE.pendulumW;
}
