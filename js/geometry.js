/**
 * geometry.js
 * Pure watertight mesh construction — no DOM or Three.js dependencies.
 * All builders return { positions: Float32Array, indices: Uint32Array } closed
 * solids with consistent outward winding, verified by tests via mesh_utils.
 *
 * Coordinate system: Y-up (Three.js convention). Exporters convert to Z-up.
 */

import { signedMeshVolumeMm3 } from './mesh_utils.js';
import { ridgeOffset, deckYAt } from './track.js';

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

    // Edge treatment: rail crests get 0.8 mm chamfers (touch-safe, no sharp
    // plastic ridge for small hands); outer rim corners get 0.5 mm chamfers
    // (elephant-foot compensation where the part meets the bed).
    const cr = 0.8;  // rail crest chamfer
    const ce = 0.5;  // bed-edge chamfer
    const pts = [];
    pts.push([-Wo + ce, rimY]);
    pts.push([-Wo, rimY + ce]);
    pts.push([-Wo, railTop - cr]);
    pts.push([-Wo + cr, railTop]);
    pts.push([-Wi - cr, railTop]);
    pts.push([-Wi, railTop - cr]);
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
    pts.push([Wi, railTop - cr]);
    pts.push([Wi + cr, railTop]);
    pts.push([Wo - cr, railTop]);
    pts.push([Wo, railTop - cr]);
    pts.push([Wo, rimY + ce]);
    pts.push([Wo - ce, rimY]);
    pts.push([Wi, rimY]);
    pts.push([Wi, ceilY]);
    pts.push([-Wi, ceilY]);
    pts.push([-Wi, rimY]);
    return pts;
}

/**
 * Skirt-rim height at arc length s, carving arch windows between support pads
 * on running pieces. Pads (ends + the pillar-boss station) keep the flat rim so
 * the piece prints on them and joints/bosses stay anchored.
 *
 * The window shape is dictated by printing, not taste. The part prints rim-down,
 * so raising the rim carves a void whose CEILING FACES DOWN — every tangent
 * must stay within 45° of vertical or it needs support. That rules out the
 * obvious shapes:
 *
 *   Roman semicircle   crown tangent is horizontal            unprintable
 *   circular gothic    self-supporting only up to h = 0.414a  removes LESS
 *                      — i.e. shallower than a plain 45° tent
 *
 * The one direction that curves AND stays printable is concave: flanks that
 * start at exactly 45° where they spring off the foot and get STEEPER toward a
 * pointed apex. That is a lancet arch — genuinely arched, self-supporting, and
 * it removes more material than the straight tent it replaces, because the
 * extra steepness buys extra rise for the same span.
 *
 * slope(t) = 1 + ARCH_CURVE·t/half  ≥ 1 everywhere, so the overhang limit holds
 * by construction. ARCH_CURVE = 0 recovers the old straight 45° tent.
 *
 * A flat top, where the rise is clipped by the cap, is fine: that is a bridge
 * between two flanks, which FDM handles.
 */
export const ARCH = {
    // 14 mm clears the 12 mm end rib, which is what the pad is actually for —
    // the rib and its bowtie pocket must sit on the bed. 20 mm was arbitrary.
    pad: 14,
    // 0 = no pad under a socket boss. The boss is a Ø19 cylinder that already
    // runs from the rim to the drumhead on its own, so it prints as a pier with
    // the arcade passing over it. It never needed the surrounding skirt dropped
    // to the bed with it — that was 24 mm of flat rim per piece doing nothing.
    bossPad: 0,
    foot: 8,        // mini-pad between adjacent windows
    maxRise: 100,   // window height cap
    band: 8,        // material kept under the deck above a window
    targetW: 75,    // preferred window width; spans subdivide evenly
    curve: 1.0      // 0 = straight 45° tent; >0 curves the flanks steeper (lancet)
};

export function archedRimY(piece, s, spec, padCenters = []) {
    const { pad: PAD, foot: FOOT, maxRise: ARCH_MAX_RISE,
            targetW: ARCH_TARGET_W, curve: ARCH_CURVE } = ARCH;
    const flat = piece.rimY;
    if (piece.type === 'start' || piece.type === 'end' || piece.planLen < 2.5 * PAD) return flat;
    const pads = [[0, PAD], [piece.planLen - PAD, piece.planLen]];
    if (ARCH.bossPad > 0) {
        for (const c of padCenters) pads.push([Math.max(0, c - ARCH.bossPad), Math.min(piece.planLen, c + ARCH.bossPad)]);
    }
    pads.sort((a, b) => a[0] - b[0]);
    for (const [a, b] of pads) if (s >= a - 1e-9 && s <= b + 1e-9) return flat;
    // span between the surrounding pads
    let s0 = 0, s1 = piece.planLen;
    for (const [a, b] of pads) {
        if (b <= s && b > s0) s0 = b;
        if (a >= s && a < s1) s1 = a;
    }
    // subdivide the span into an even ARCADE of lancet windows separated by
    // small feet — regular and calm, instead of one giant sawtooth per span
    const span = s1 - s0;
    const n = Math.max(1, Math.round(span / ARCH_TARGET_W));
    const unit = span / n;
    const local = (s - s0) % unit;
    const w0 = FOOT / 2, w1 = unit - FOOT / 2;
    if (local <= w0 || local >= w1) return flat; // on a foot
    const t = Math.min(local - w0, w1 - local);      // distance from the nearer foot
    const half = (w1 - w0) / 2;
    const rise = half > 0 ? t + ARCH_CURVE * t * t / (2 * half) : t;
    // Cap from the deck at THIS WINDOW's centre, not at s. Taken per-station the
    // cap follows the ramp, so a clipped window top came out as a 11.2° ceiling
    // — roughly 1 mm of horizontal overhang per 0.2 mm layer, which droops.
    // Held constant across the window it is a true horizontal bridge.
    const winCentre = s0 + (Math.floor((s - s0) / unit) + 0.5) * unit;
    const deckCap = deckYAt(piece, winCentre) - ARCH.band;
    return Math.min(flat + Math.min(rise, ARCH_MAX_RISE), Math.max(flat, deckCap));
}

/**
 * Builds all sweep profiles for a piece at the given stations, applying the
 * washboard ridge as a function of arc length (seams always land in valleys
 * because the pitch was snapped to the piece length) and the arched skirt rim.
 */
export function pieceProfiles(piece, stations, spec, withRidges, padCenters = []) {
    return stations.map(st => channelProfile({
        innerWidth: piece.innerWidth,
        wall: spec.wall,
        railH: spec.railHeight,
        floorThk: spec.floorThk,
        filletR: spec.filletR,
        deckY: 0, // origins already carry the deck elevation
        rimY: archedRimY(piece, st.s, spec, padCenters) - deckYOffset(piece, st),
        ridge: withRidges ? ridgeOffset(st.s, piece.ridgePitch, spec.ridge.height) : 0
    }));
}

// Profile coordinates are relative to the station origin (which sits on the
// deck line); the rim however is at a constant WORLD height per piece.
function deckYOffset(piece, station) {
    return station.origin[1];
}

/**
 * Bowtie connector key (butterfly key): a separate print-flat part that drops
 * into matching pockets recessed in the end ribs of two mating pieces —
 * the Hot-Wheels-connector approach, chosen because it prints with ZERO
 * overhangs on both the key and the track (pockets are voids in bed-supported
 * ribs; the old protruding tab was a floating cantilever in the slicer).
 * Plan coords: z along the track (seam at z=0), x lateral.
 */
export function bowtieKeyPlan({ neckHalf = 8, tipHalf = 12, depth = 9, clearance = 0 }) {
    const n = neckHalf + clearance, t = tipHalf + clearance, d = depth + clearance;
    return [
        [-t, -d], [t, -d],
        [n, 0],
        [t, d], [-t, d],
        [-n, 0]
    ];
}

/**
 * One half of the bowtie pocket, opening at the end face (z=0 → z=depth
 * inward), with assembly clearance. Extended 0.5 mm past the face so the
 * boolean cuts cleanly through the rib's outer skin.
 *
 * Both vertices come off ONE line offset from the key's flank, so the gap is a
 * constant `clearance` per side over the whole engagement. It used to build the
 * two ends independently — the mouth was pushed OUT by half a flare instead of
 * pulled in — which tilted the wall to slope 0.3875 against the key's 0.4444:
 *
 *     z      gap/side (before)   (now)
 *     0        0.666 mm          0.20 mm
 *     4.5      0.410 mm          0.20 mm
 *     9        0.153 mm          0.20 mm
 *
 * That is the wrong way round on both counts. 0.153 mm at the tips is tighter
 * than the 0.20 mm/side the printed hex joints are proven at, so the key binds
 * on the taper before it seats; and 0.666 mm at the neck let the seam open
 * ~0.8 mm before the taper caught, over three times the waterfall step. Contact
 * was a line at the tip rather than a bearing surface, so the wedging action the
 * joint is named for could not happen.
 */
export function bowtiePocketPlan({ neckHalf = 8, tipHalf = 12, depth = 9, clearance = 0.25 }) {
    const flare = (tipHalf - neckHalf) / depth;
    const wall = (z) => neckHalf + clearance + flare * z;   // key flank, offset
    const zFar = depth + clearance;
    return [
        [-wall(-0.5), -0.5], [wall(-0.5), -0.5],
        [wall(zFar), zFar],
        [-wall(zFar), zFar]
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

/**
 * Facet tolerance: segment count for a circle of radius r such that the
 * chord sagitta (max deviation of the flat facet from the true arc) stays
 * under `tol` mm. 0.1 mm default — well inside FDM accuracy and a 0.4 mm
 * nozzle, and stricter than the 0.25 mm print-quality ceiling.
 */
export const FACET_TOL_MM = 0.1;

/**
 * Decimation bound for exported meshes, in mm. `fineShell` samples 6 stations
 * per washboard ridge and applies that rate to the ENTIRE cross-section, so the
 * flat skirt walls and rails carry ~360 subdivisions along a 150 mm tile where
 * two would describe them exactly. Manifold's simplify() removes a vertex only
 * if no surface point moves further than this, so it strips that redundancy
 * without touching anything curved.
 *
 * 0.01 mm is 10x stricter than FACET_TOL_MM above (already shipping), 5% of the
 * 0.20 mm joint clearance the printed hex parts are proven at, and far below
 * what a 0.4 mm nozzle can express. Measured effect on the walking surface:
 * 2 microns worst case over 384 samples along the ride line — the washboard is
 * immune by construction, since every floor vertex sits on a curve and cannot
 * be removed within tolerance.
 */
export const SIMPLIFY_TOL_MM = 0.01;

/**
 * Station spacing for sweeping the washboard, derived from a chord tolerance
 * instead of the bare `pitch / 6` it replaces — the same move segmentsForCircle
 * already makes for circles, so the sampling rate states its own error budget.
 *
 * The catch is that a ridge is periodic, so the achieved peak-to-valley depends
 * on whether a station LANDS on the crest, not on the average sample density.
 * Measured: pitch/6 and pitch/4 both give the full 0.600 mm, while pitch/5
 * gives 0.543 (90%) and pitch/3 gives 0.450 (75%). A non-integer rate is worse
 * still — the phase walks along the piece and ridge height varies tile to tile.
 * So the tolerance picks a rate and this snaps it to an EVEN integer count per
 * ridge, which samples valley (0) and crest (p/2) exactly, every ridge alike.
 *
 * At FACET_TOL_MM this yields 4 per ridge: 33% fewer stations than pitch/6,
 * ridge height still exactly 0.600 mm, chord error 0.093 mm. (pitch/6 itself
 * corresponds to a ~0.05 mm budget, i.e. the old constant was twice as strict
 * as anything else in the part.)
 */
export function ridgeStationSpacing(amplitude, pitch, tol = FACET_TOL_MM) {
    const ideal = (pitch / (2 * Math.PI)) * Math.sqrt((8 * tol) / amplitude);
    const perRidge = Math.max(4, Math.floor(pitch / ideal));
    return pitch / (perRidge % 2 ? perRidge + 1 : perRidge);
}
export function segmentsForCircle(r, tol = FACET_TOL_MM) {
    if (r <= tol) return 12;
    const n = Math.ceil(Math.PI / Math.acos(Math.max(-1, Math.min(1, 1 - tol / r))));
    return Math.min(96, Math.max(12, n));
}

/** Circle plan polygon, tessellated to the facet tolerance by default. */
export function circlePlan(r, segments = segmentsForCircle(r)) {
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
export const camY = (z, cz, cy, R) => cy - Math.sqrt(Math.max(0, R * R - (z - cz) ** 2));

/**
 * Outer body silhouettes. Every style shares the SAME physics chassis —
 * hoof rocker cam (tangent arc R=30 ending at z=0), axle at (6,26), pendulum
 * slot, rear arch and ballast bores — only the cosmetic upper outline varies,
 * so the gait model applies to all of them unchanged.
 */
export const FIGURE_STYLES = ['classic', 'knight'];

export function bodySideOutline(style = 'classic') {
    const pts = style === 'knight'
        ? [
            // "Mike the Knight" steed (horse only — the rider is a separate
            // silhouette so display/print can color match the toy): arched
            // neck, ears, head carried low with the nose near chest height
            [-23, 8],     // rear bottom arch
            [-23, 32],    // rump
            [-16, 36],    // saddle rise
            [-6, 38],     // saddle seat
            [2, 40],      // withers
            [6, 42],      // mane root
            [11, 44],     // ear back
            [13, 48],     // ear tip
            [15, 43],     // ear front
            [20, 38],     // forehead sloping down-forward
            [26, 30],     // nose tip (low, like the toy)
            [24, 25],     // nose underside
            [16, 22],     // throat
            [21, 15],     // chest bulge
            [23, 6]       // down to the hoof cam start
        ]
        : [
            [-23, 8],    // rear bottom (arch, clears ground while rocking)
            [-23, 36],   // rear top
            [12, 36],    // wither
            [15, 46],    // neck
            [22, 46],    // head top
            [23, 40],    // nose
            [23, 6]      // chest down to hoof cam start
        ];
    // shared front hoof rocker cam: circle center (4, 30) R=30, low point z=4
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

/**
 * Knight rider silhouette (blue armor + helmet) — seated astride the saddle,
 * overlapping the horse back so the printed union is one solid. Same (z,y)
 * frame as the body outlines.
 */
export function knightRiderOutline() {
    return [
        [-15, 32],   // seat rear (buried in the saddle)
        [-15, 48],   // back
        [-13, 54],   // shoulders
        [-11, 59],   // helmet rear
        [-4, 61],    // helmet dome
        [3, 58],     // helmet brow
        [4, 51],     // visor
        [3, 45],     // chest
        [5, 40],     // arms reaching the mane
        [2, 33],     // knee
        [-4, 31]     // saddle front (buried)
    ];
}

/** Red plume crest atop the helmet, like the toy's mohawk. */
export function knightCrestOutline() {
    return [
        [-11, 57],
        [-9, 65],
        [-3, 66],
        [-2, 60],
        [-6, 58]
    ];
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
export function figureVolumeEstimate(bodyWidthMm, style = 'classic') {
    const bodyArea = Math.abs(signedArea2D(bodySideOutline(style)));
    const pendArea = Math.abs(signedArea2D(pendulumSideOutline()));
    const slotArea = (FIGURE.slot.zMax - FIGURE.slot.zMin) * (FIGURE.slot.yMax - 6); // rough
    const riderVol = style === 'knight'
        ? Math.abs(signedArea2D(knightRiderOutline())) * 24 + Math.abs(signedArea2D(knightCrestOutline())) * 6
        : 0;
    return bodyArea * bodyWidthMm - slotArea * (FIGURE.slot.halfW * 2) + pendArea * FIGURE.pendulumW + riderVol;
}
