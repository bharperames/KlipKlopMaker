/**
 * geometry.js
 * Pure watertight mesh construction — no DOM or Three.js dependencies.
 * All builders return { positions: Float32Array, indices: Uint32Array } closed
 * solids with consistent outward winding, verified by tests via mesh_utils.
 *
 * Coordinate system: Y-up (Three.js convention). Exporters convert to Z-up.
 */

import { signedMeshVolumeMm3 } from './mesh_utils.js';
import { ridgeOffset, deckYAt, innerWidthAt, planPosAt, undersidePlane, collarFits, laysOnUnderside } from './track.js';

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
 * open underside, and skirt walls down to a flat rim. (The underside used to
 * be described as a sealed acoustic chamber; the arcade opens it to the air
 * and the end ribs are windowed through, so it is not sealed and does not
 * need to be.)
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
        deckY, rimY, rimL = rimY, rimR = rimY, ridge = 0, bank = 0
    } = o;
    const Wi = innerWidth / 2;
    const Wo = Wi + wall;
    // The underside is a PLANE, and under a curve that plane is at a different
    // height on the two walls at the same station. `rimL`/`rimR` are its values
    // at ∓Wo; every other point on the bottom edge is a linear interpolation
    // between them, which is exact because the surface is a plane. Given one
    // `rimY` (a viaduct's flat rim) this is the profile it always was.
    const rimAt = (u) => rimL + ((u + Wo) / (2 * Wo)) * (rimR - rimL);
    const dS = deckY + ridge;          // floor surface rides the washboard
    const railTop = deckY + railH;     // rail crest follows the deck line, not the ridges
    const ceilY = deckY - floorThk;    // flat drumhead underside

    // Edge treatment: rail crests get 0.8 mm chamfers (touch-safe, no sharp
    // plastic ridge for small hands); outer rim corners get 0.5 mm chamfers
    // (elephant-foot compensation where the part meets the bed).
    // The crest chamfers eat into the wall from BOTH sides, so the flat left on
    // top of a rail is wall - 2*cr. At wall 1.6 with cr fixed at 0.8 that is
    // exactly zero: the profile gets two zero-length edges, ear-clipping cannot
    // triangulate it, and the end cap came out as a single triangle spanning
    // the whole channel — a flap at every seam. Below 1.6 it goes negative and
    // the profile self-intersects. Clamp so a rail always keeps at least one
    // nozzle width of flat crest.
    const cr = Math.min(0.8, Math.max(0.2, (wall - 0.4) / 2));  // rail crest chamfer
    const ce = 0.5;  // bed-edge chamfer

    // THE DECK CAN BANK; THE RIM NEVER DOES. Across a switch's frog the two
    // routes' deck planes cannot both be level (see frogBankKnots) and the
    // branch has to take the cross-slope. Tilting the whole STATION was tried
    // and it takes the rim with it: the underside stops being planar, the part
    // will not lie down, and the worst unsupported span went 10 mm to 70. So
    // the tilt lives HERE, in the section, applied to everything that hangs off
    // the deck line — floor, fillets, rail crests, drumhead ceiling — while
    // `rimAt` is left exactly where it was. The rim plane is untouched, the
    // part still prints flat, and only the walking surface leans.
    //
    // `bank` is 0 for every piece but a switch's two halves, so this is the
    // profile it has always been everywhere else.
    const tb = Math.tan(bank);
    const pts = [];
    /** deck-borne point (tilts), or `rim` for one that must stay put */
    const P = (u, y, rim = false) => pts.push([u, rim ? y : y + u * tb]);

    P(-Wo + ce, rimAt(-Wo + ce), true);
    P(-Wo, rimAt(-Wo) + ce, true);
    P(-Wo, railTop - cr);
    P(-Wo + cr, railTop);
    P(-Wi - cr, railTop);
    P(-Wi, railTop - cr);
    P(-Wi, dS + filletR);
    // left fillet: quarter arc from wall down onto the floor
    for (let i = 1; i <= filletSegs; i++) {
        const t = Math.PI + (i / filletSegs) * (Math.PI / 2);
        P((-Wi + filletR) + filletR * Math.cos(t), (dS + filletR) + filletR * Math.sin(t));
    }
    // right fillet: floor back up the wall
    for (let i = 1; i <= filletSegs; i++) {
        const t = (3 * Math.PI) / 2 + (i / filletSegs) * (Math.PI / 2);
        P((Wi - filletR) + filletR * Math.cos(t), (dS + filletR) + filletR * Math.sin(t));
    }
    P(Wi, railTop - cr);
    P(Wi + cr, railTop);
    P(Wo - cr, railTop);
    P(Wo, railTop - cr);
    P(Wo, rimAt(Wo) + ce, true);
    P(Wo - ce, rimAt(Wo - ce), true);
    P(Wi, rimAt(Wi), true);
    P(Wi, ceilY);
    P(-Wi, ceilY);
    P(-Wi, rimAt(-Wi), true);
    return pts;
}

/**
 * The skirt is a VIADUCT: piers standing on the bed with segmental arches
 * between them. It carries no load — this is a light toy — it is print
 * scaffold. The deck falls at 11.2 deg, which as an overhang is 79 deg off
 * vertical, so it cannot carry itself: it needs a continuous lintel under each
 * edge and that lintel needs periodic contact with the bed. End pads, `band`
 * of lintel, and piers in between is that structure and nothing more.
 *
 * The arch shape is a real one, not a printing compromise. A circle springing
 * vertically off a pier is the friendliest opening there is: vertical at the
 * springing, and inside 45 deg of vertical until sqrt(2)/2 of the way up.
 * Above that the crown is a short bridge anchored on its own haunches, which
 * in a 1.6 mm wall is just the top of a round hole. (An earlier note here
 * called the Roman arch unprintable for exactly that horizontal crown tangent.
 * That was wrong in the same way as calling a bridge an overhang.)
 *
 * Where the deck is too low for the full semicircle, the crown is clipped flat
 * — a segmental arch, which is what most masonry bridges actually are.
 */
export const ARCH = {
    // 14 mm clears the 12 mm end rib, which is what the pad is actually for —
    // the rib and its bowtie pocket must sit on the bed. 20 mm was arbitrary.
    pad: 14,
    margin: 4,      // set-back from a pad edge to the springing of its window
    // Width of a PIER between two arches — the skirt wall carried straight down
    // to the bed. This is the old foot with its 45 deg flanks removed: vertical
    // faces waste nothing and print just as well, and 8 mm is the same column
    // the foot always was, so it is no more slender.
    pier: 8,
    maxRise: 100,   // crown height cap
    // Lintel kept under the deck over an arch, measured from the deck LINE.
    // The floor takes 2 mm of it, so 3.6 leaves exactly one wall thickness of
    // skirt above every crown — the thinnest thing that is still a wall, and
    // 8 layers is plenty to pull a sagged crown flat again. This is not a
    // rigidity number; the skirt carries nothing. It is simply what the deck
    // stands on while it prints.
    band: 3.6,
    // Longest run of FLAT crown before the arcade adds a pier. The flat is a
    // bridge: a 1.6 mm strand printed across open air with the lintel and floor
    // built on top. It sags a little and then self-corrects, and it is on a
    // hidden face carrying no load — but a shorter one is better, and this is
    // the dial. Weight barely moves across its useful range.
    // Lowered from 70. Whatever has not closed by the crown is laid down in a
    // single layer, and 70 let a shallow window leave 52.9 mm of it — past the
    // ~52 mm where a flat-crowned test part was rejected. 50 holds the worst
    // case to 47.6 mm, which sliced clean.
    //
    // This is the loosest value that keeps a straight to TWO arches, which is
    // the point: 45 would give more margin but adds a third pier, and the
    // arcade is meant to look like a viaduct rather than a centipede. The
    // measured band is narrow — 47.6 passes, 51.9 does not — so treat this as
    // pinned by experiment, not as a number with room in it.
    maxBridge: 50,
    // Haunch radius as a fraction of the half-span, for the three-centred
    // arch. Bigger = rounder shoulders and a tighter crown; smaller = a
    // sharper spring off the pier and a flatter span.
    //
    // Retained for archArcs, which capAbove still consults; archCurve is a
    // corbel now and does not use it.
    haunch: 0.38,
    // Steepest the arch soffit may lean from vertical, in degrees. This is the
    // print limit, not a style choice: past it a layer oversteps the one below
    // by more than the extrusion can bridge to, and the slicer demands
    // supports. 55 leaves margin under the 58.6 deg that measured clean.
    maxOverhangDeg: 55,
    // Fraction of the span given a FLAT crown. 0 is a pure arch; 1 is the
    // flat-topped opening the arcade used to have.
    //
    // This is the dial between the two, and it is the one that moves a
    // slicer's support decision. A flat ceiling is a clean span with an anchor
    // at each end, which slicers class as a BRIDGE and print unsupported. A
    // curve instead sweeps through every angle, and the 10-30 deg part of that
    // sweep is neither flat enough to bridge nor steep enough to hold itself
    // up — so it gets measured against the overhang threshold and flagged.
    crownFlat: 0
};

/**
 * THREE-CENTRED ARCH for a half-span `a` and rise `cap`: a small haunch circle
 * springing vertically off each pier, and one large crown circle between them.
 *
 * The two are TANGENT, which is the whole point. The previous version drew a
 * big circle, cut it where it met the lintel, and started a crown arc from the
 * cut — the two merely met, so every shallow opening had a visible notch at
 * the shoulder. Tangency needs the junction to lie on the line joining the two
 * centres, i.e. |HC| = R - rh, which fixes R once rh is chosen.
 *
 * Returns null when `cap` is large enough that the opening is just a
 * semicircle, or when the geometry degenerates.
 */
function archArcs(a, cap) {
    if (!(a > 0) || !(cap > 0) || cap >= a) return null;
    const rh = Math.min(ARCH.haunch * a, 0.7 * cap);
    if (!(rh > 0) || rh >= cap) return null;
    const R = ((a - rh) ** 2 + cap * cap - rh * rh) / (2 * (cap - rh));
    if (!(R > a)) return null;
    return { rh, R, Hx: a - rh, Cy: cap - R, Jx: R * (a - rh) / (R - rh) };
}

/** The three-centred curve alone, no flat crown. */
function archCurve(a, cap, x) {
    // CORBELLED SEGMENTAL ARCH: a circle of radius `a` off the springing, and
    // where its tangent reaches ARCH.maxOverhangDeg from vertical, a straight
    // run at exactly that angle up to the crown. Tangent at the junction by
    // construction, and it never leans past the limit anywhere.
    //
    // Two constraints bound this shape and only one of them is obvious:
    //
    //   overhang  — each layer may only overstep the one below so far before
    //               the extrusion has nothing to sit on. The three-centred arch
    //               this replaces reached 75.6 deg from vertical approaching
    //               its crown and Bambu Studio called it a floating cantilever.
    //   flat span — whatever has NOT closed by the crown is bridged in one
    //               layer. A pure circle clipped flat (the pre-arcade shape)
    //               stayed at 58.6 deg but left a 47.5 mm span, and a fully
    //               flat crown left 51.9 mm and was rejected too.
    //
    // Optimising either one alone drives the other over its limit, which is
    // what made this so slow to find: three separate "fixes" each moved one
    // number the right way and the other the wrong way. The corbel satisfies
    // both — the straight run closes the opening far faster than a circle
    // while holding the angle fixed. See tests/geometry.test.js.
    const t = Math.tan(Math.min(75, Math.max(30, ARCH.maxOverhangDeg)) * Math.PI / 180);
    const ax = Math.abs(x);
    const xt = a / Math.sqrt(1 + t * t);          // circle tangent hits the limit
    const yt = a * t / Math.sqrt(1 + t * t);
    const y = ax >= xt
        ? Math.sqrt(Math.max(0, a * a - ax * ax))
        : yt + (xt - ax) / t;
    return Math.min(cap, y);
}

/** Height of the arch above the rim at offset x from the opening's centre. */
function archHeight(a, cap, x) {
    if (cap <= 0) return 0;
    // A flat crown over the middle `crownFlat` of the span; the curve springs
    // from the piers into it.
    const f = Math.min(0.98, Math.max(0, ARCH.crownFlat));
    if (f <= 0) return archCurve(a, cap, x);
    const flatHalf = a * f;
    if (Math.abs(x) <= flatHalf) return cap;
    return archCurve(a - flatHalf, cap, Math.abs(x) - flatHalf);
}

/**
 * Both capAbove and windowBounds are sampled/iterative and both are called
 * once per sweep station — hundreds of times per piece, always with the same
 * few arguments. Memoised per piece, stamped with the ARCH values so tests and
 * scripts that tune them are not served stale answers. Pieces are rebuilt on
 * every layout, so a WeakMap keeps nothing alive.
 */
const memo = new WeakMap();
function cached(piece, key, compute) {
    const stamp = `${ARCH.pad}|${ARCH.margin}|${ARCH.pier}|${ARCH.band}|${ARCH.maxRise}|${ARCH.maxBridge}|${ARCH.haunch}`;
    let m = memo.get(piece);
    if (!m || m.stamp !== stamp) { m = { stamp, v: new Map() }; memo.set(piece, m); }
    if (!m.v.has(key)) m.v.set(key, compute());
    return m.v.get(key);
}

/**
 * Crown height for an arch spanning [w0, w1]: as high as it can go while
 * keeping `band` of lintel under the deck EVERYWHERE across it. Sampled and
 * relaxed rather than solved, because the arch's shape depends on the very
 * rise being solved for.
 */
function capAbove(piece, w0, w1) {
    return cached(piece, `cap:${w0.toFixed(4)},${w1.toFixed(4)}`, () => capSolve(piece, w0, w1));
}

function capSolve(piece, w0, w1) {
    const a = (w1 - w0) / 2, c = (w0 + w1) / 2;
    let cap = Math.min(deckYAt(piece, w0), deckYAt(piece, w1)) - ARCH.band - piece.rimY;
    for (let i = 0; i < 8 && cap > 0; i++) {
        let over = 0;
        for (let k = 0; k <= 24; k++) {
            const x = -a + (2 * a * k) / 24;
            over = Math.max(over,
                archHeight(a, cap, x) + piece.rimY + ARCH.band - deckYAt(piece, c + x));
        }
        if (over <= 0.005) break;
        cap -= over;
    }
    return piece.rimY + Math.max(0, cap);
}

/**
 * Horizontal run of arch that has to be BRIDGED — the part whose tangent has
 * gone shallower than 45 deg and so cannot hold itself up. Sampled, since the
 * arch is two arcs and the changeover is not where either alone would put it.
 */
function unsupportedRun(piece, w0, w1) {
    const a = (w1 - w0) / 2;
    const cap = capAbove(piece, w0, w1) - piece.rimY;
    if (cap <= 0) return 0;
    const N = 200, step = (2 * a) / N;
    let run = 0;
    for (let k = 0; k < N; k++) {
        const x0 = -a + k * step;
        const slope = (archHeight(a, cap, x0 + step) - archHeight(a, cap, x0)) / step;
        if (Math.abs(slope) < 1) run += step;
    }
    return run;
}

/**
 * Window boundaries for one piece, in arc length: the two end pads bracket the
 * arcade, and every interior boundary is a PIER.
 *
 * The skirt is a VIADUCT — piers standing on the bed with segmental arches
 * between them — and nothing else. No mullions, no bulkheads, no internal
 * webs: those were all attempts to hold up a boundary too thin to hold itself,
 * and an 8 mm pier holds itself.
 *
 * Divisions are not free (a pier is plastic and a visible interruption), so
 * the count comes from the one thing that argues for one: the fewest arches
 * that keep every flat crown under ARCH.maxBridge.
 *
 * A support station is used to NUDGE a division that is happening anyway, so a
 * pier lands on the boss rather than a few millimetres off it. An OUTRIGGER
 * station forces one: its arm lands 2 mm inboard of the wall and is only 11 mm
 * tall, so it needs solid skirt under it or the piece exports in two parts.
 */
export function windowBounds(piece, spec, supportStations = [], forced = null) {
    return cached(piece, `bounds:${supportStations.join(',')}|${forced}`,
        () => boundsSolve(piece, spec, supportStations, forced));
}

function boundsSolve(piece, spec, supportStations, forced) {
    const { pad: PAD, margin: MARGIN, pier: PIER } = ARCH;
    if (piece.type === 'start' || piece.type === 'end' || piece.planLen < 2.5 * PAD) return [];
    const s0 = PAD, s1 = piece.planLen - PAD;
    const edges = (lo, hi, n, k) => [
        lo + (k === 0 ? MARGIN : PIER / 2),
        hi - (k === n - 1 ? MARGIN : PIER / 2)
    ];

    /**
     * A support station is a STOP, not a hint.
     *
     * This used to divide the skirt into even bays, pick the bay count that
     * kept every arch inside the bridge limit, and only then slide a boundary
     * sideways onto a nearby boss — without re-checking. That is fine while
     * the boss sits at mid-length, because the even boundary is already there
     * and the snap moves nothing. Once the boss moved to the piece's centre of
     * mass the snap started dragging a pier 14 mm uphill and leaving a 62 mm
     * arch behind it, past the 48 mm this skirt can bridge.
     *
     * Taking the stations as stops instead makes each side of a pier its own
     * span with its own bay count, which is both correct and simpler: a pier
     * lands under the boss because that is where the load is, and the arches
     * either side are sized for the gaps that actually result.
     */
    const inside = (s) => s > s0 + PIER && s < s1 - PIER;
    const stops = [...new Set([
        s0,
        ...(forced != null && inside(forced) ? [forced] : []),
        ...supportStations.filter(inside),
        s1
    ])].sort((x, y) => x - y);

    const bounds = [s0];
    for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i], b = stops[i + 1];
        let n = 1;
        for (; n < 6; n++) {
            const unit = (b - a) / n;
            let worst = 0;
            for (let k = 0; k < n; k++) {
                const [w0, w1] = edges(a + k * unit, a + (k + 1) * unit, n, k);
                worst = Math.max(worst, unsupportedRun(piece, w0, w1));
            }
            if (worst <= ARCH.maxBridge) break;
        }
        const unit = (b - a) / n;
        for (let k = 1; k <= n; k++) bounds.push(a + k * unit);
    }
    return bounds;
}

/**
 * Arc lengths where the sweep should take a station so the arches come out
 * smooth: each one sampled at equal ANGLE rather than equal arc length, which
 * clusters them at the springings where the curve is steep and spends none on
 * the crown where it is nearly flat. Uniform sampling is what left the builder
 * view visibly faceted while the export — 10x finer for the washboard's sake —
 * looked fine.
 */
export function archStations(piece, spec, supportStations = [], forced = null, perQuadrant = 12) {
    const { pad: PAD, margin: MARGIN, pier: PIER } = ARCH;
    const bounds = windowBounds(piece, spec, supportStations, forced);
    const out = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
        const w0 = bounds[i] + (i === 0 ? MARGIN : PIER / 2);
        const w1 = bounds[i + 1] - (i + 2 === bounds.length ? MARGIN : PIER / 2);
        const a = (w1 - w0) / 2, c = (w0 + w1) / 2;
        if (a <= 0) continue;
        for (let k = 0; k <= perQuadrant; k++) {
            const phi = (Math.PI / 2) * (k / perQuadrant);
            const dx = a * Math.cos(phi);
            out.push(c - dx, c + dx);
        }
        // and just inside each pier face, so the springing lands crisply
        out.push(w0 + 0.01, w1 - 0.01);
    }
    return out.sort((a, b) => a - b);
}

/**
 * The underside of a piece, at arc-length `s`.
 *
 * TWO SHAPES, and they answer different questions.
 *
 * `viaduct` (the default) puts the underside on a FLAT rim at a 15 mm grid
 * height and carves an arcade into the wall between. The rim is flat because
 * that is what lets the part sit on a bed and on a pier: a curve's deck is a
 * helicoid, and the skirt is the transformation from that helicoid to a plane.
 * The price is that the skirt is as deep as the piece's drop — 57 mm at the
 * top of a curve — and 26-31% of the part's volume is below anything useful.
 *
 * `minimal` keeps a constant `SPEC.skirt.minimalDepthMm` under the deck and
 * deletes the rest. The depth comes from the features that must survive: the
 * bowtie pocket's ceiling is 3 mm under the deck, the key band is 5.6, and a
 * throat to actually insert the key wants about that again — 14.2 mm — while
 * the hex socket needs 12. The socket keeps its own pad down to the grid,
 * because bossOps already builds the boss from `piece.rimY` upward.
 *
 * What `minimal` costs is the ability to print unsupported. A straight's
 * underside is planar, so the part can be laid on it and printed tilted. A
 * curve's is a helicoid — measured 5.15 mm from the best-fit plane — so no
 * orientation puts it on the bed, and a minimal curve needs print supports
 * under it. That is the trade, and it is why `viaduct` stays the default.
 */
export function archedRimY(piece, s, spec, supportStations = [], forced = null, u = 0) {
    const { pad: PAD, margin: MARGIN, pier: PIER, maxRise: ARCH_MAX_RISE } = ARCH;
    const flat = piece.rimY;
    // A `block` piece is the simplest answer this function can give: vertical
    // walls straight down to the flat rim, everywhere, no plane and no arches.
    // Printed and held exactly as assembled — see normaliseSkirtStyle.
    if (piece.skirtStyle === 'block') return flat;
    if (piece.skirtStyle === 'minimal') {
        // ONE PLANE, and `u` is why it takes a lateral offset: under a curve the
        // plane is at a different height on each wall at the same station, which
        // is exactly what a constant-depth cut cannot express. See
        // undersidePlane — for a straight this returns deck − D as before.
        const pl = undersidePlane(piece, spec);
        const pos = planPosAt(piece, s);
        const r = [Math.sin(pos.h), -Math.cos(pos.h)];
        const deckPlane = pl.at(pos.x + r[0] * u, pos.z + r[1] * u);
        // CLAMPED AT THE RIM ONLY FOR A PIECE THAT PRINTS RIM-DOWN, because
        // then the rim IS its bed contact. A piece that is laid on its own
        // underside wants the opposite: the clamp flattens the last 17 mm, the
        // plane runs away below it, and the end of the part lifts off the bed
        // and keeps the 78.8 deg overhang the rest of it just lost. It does not
        // matter that the underside then hangs below the piece's grid datum —
        // Brett: "the bottom doesn't have to end up level" — because nothing
        // stands on it. The spacer does that.
        return laysOnUnderside(piece, spec) ? deckPlane : Math.max(flat, deckPlane);
    }
    const bounds = windowBounds(piece, spec, supportStations, forced);
    if (!bounds.length) return flat;
    if (s <= PAD || s >= piece.planLen - PAD) return flat;   // end pads

    let lo = bounds[0], hi = bounds[bounds.length - 1];
    for (let i = 0; i + 1 < bounds.length; i++) {
        if (s >= bounds[i] && s <= bounds[i + 1]) { lo = bounds[i]; hi = bounds[i + 1]; break; }
    }
    const w0 = lo + (lo === bounds[0] ? MARGIN : PIER / 2);
    const w1 = hi - (hi === bounds[bounds.length - 1] ? MARGIN : PIER / 2);
    if (s <= w0 || s >= w1) return flat;                     // standing on a pier

    // Segmental arch: a circle springing vertically off the pier, clipped flat
    // where it meets the lintel. Vertical at the springing is the friendliest
    // thing an opening can do to a printer, and it stays inside 45 deg of
    // vertical until sqrt(2)/2 of the way up. Above that the crown is a short
    // bridge anchored on its own haunches — the top of a round hole in a thin
    // wall, which every printer does without being asked.
    const a = (w1 - w0) / 2, x = s - (w0 + w1) / 2;
    const cap = Math.min(capAbove(piece, w0, w1) - flat, ARCH_MAX_RISE);
    return flat + Math.min(archHeight(a, cap, x), Math.max(0, cap));
}

/**
 * 0 inside a switch branch's frog, 1 once it is clear, smoothly between.
 * Any other piece is unaffected and returns 1.
 */
export function frogRidgeFade(piece, s) {
    const end = piece.frogEndS;
    if (!(end > 0)) return 1;
    const fade = piece.ridgeFadeMm ?? 20;
    // KEEP THE RIDGES AT THE MOUTH. The two routes leave the same entry face on
    // the same heading, so for the first stretch their washboards are the same
    // washboard — identical phase, identical direction, nothing to interfere
    // with. Only as the headings diverge do the two fields start crossing.
    //
    // Fading from s=0 also flattened the entry, where the pitch is snapped so
    // the SEAM lands in a ridge valley, and that is where the switch picked up
    // its single non-manifold edge. Start the fade after the mouth and the
    // joint keeps the geometry it was designed against.
    const start = piece.frogStartS ?? 0;
    if (s <= start) return 1;
    if (s < start + fade) { const t = 1 - (s - start) / fade; return t * t * (3 - 2 * t); }
    if (s <= end) return 0;
    if (s >= end + fade) return 1;
    const t = (s - end) / fade;
    return t * t * (3 - 2 * t);              // smoothstep, so no crease at either end
}

/**
 * Builds all sweep profiles for a piece at the given stations, applying the
 * washboard ridge as a function of arc length (seams always land in valleys
 * because the pitch was snapped to the piece length) and the arched skirt rim.
 */
export function pieceProfiles(piece, stations, spec, withRidges, supportStations = [], forced = null) {
    return stations.map(st => channelProfile({
        innerWidth: innerWidthAt(piece, st.s),
        wall: spec.wall,
        railH: spec.railHeight,
        floorThk: spec.floorThk,
        filletR: spec.filletR,
        deckY: 0, // origins already carry the deck elevation
        rimL: archedRimY(piece, st.s, spec, supportStations, forced, -(innerWidthAt(piece, st.s) / 2 + spec.wall)) - deckYOffset(piece, st),
        rimR: archedRimY(piece, st.s, spec, supportStations, forced, innerWidthAt(piece, st.s) / 2 + spec.wall) - deckYOffset(piece, st),
        // ONE RIDGE FIELD IN A FROG. A switch's branch runs inside the main's
        // channel until it separates, and two washboards crossing at an angle
        // is the chevron interference Brett saw in the render. Matching the two
        // decks (see frogDeckKnots) would have made it worse by bringing both
        // fields into the same plane, so the branch carries NO ridges while it
        // is inside the frog and fades its own in once clear. The main owns
        // that surface; the walker meets one field, whichever route it takes.
        ridge: withRidges
            ? ridgeOffset(st.s, piece.ridgePitch, spec.ridge.height) * frogRidgeFade(piece, st.s)
            : 0,
        // cross-slope, carried on the station so this module needs nothing from
        // track.js — see channelProfile for why the rim is spared
        bank: st.bank ?? 0
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
export function bowtieKeyPlan({ neckHalf = 8, tipHalf = 12, depth = 9, clearance = 0, tipChamfer = 0 }) {
    const n = neckHalf + clearance, t = tipHalf + clearance, d = depth + clearance;
    const corners = [
        [-t, -d], [t, -d],
        [n, 0],
        [t, d], [-t, d],
        [-n, 0]
    ];
    if (!(tipChamfer > 0)) return corners;
    // Cut the four TIP corners back. They are the only convex vertices that
    // meet an internal corner of the pocket, and an internal corner has a
    // nozzle radius in it — so a sharp tip lands on that radius and holds the
    // key off its own flanks. The neck vertices are concave and meet open air.
    const out = [];
    for (let i = 0; i < corners.length; i++) {
        const p = corners[i];
        if (Math.abs(Math.abs(p[0]) - t) > 1e-9) { out.push(p); continue; }
        const prev = corners[(i + corners.length - 1) % corners.length];
        const next = corners[(i + 1) % corners.length];
        out.push(towards(p, prev, tipChamfer), towards(p, next, tipChamfer));
    }
    return out;
}

/**
 * A polygon offset INWARD by `d` — every edge moved `d` along its own inward
 * normal, corners resolved by intersecting the moved edges.
 *
 * This exists because the obvious shortcut is wrong. The key's 0.5 mm chamfer
 * band used to be drawn as `bowtieKeyPlan({..., clearance: -0.5})`, which
 * subtracts 0.5 from the neck, the tip and the depth INDEPENDENTLY. On a
 * bowtie the flanks are raked 24°, so that moves the two ends of a flank by
 * different amounts: the inset flank is not parallel to the flank it is
 * supposed to shadow. Every quad in the chamfer band is then non-planar, and
 * a non-planar quad has no single normal — the triangulator picks a diagonal
 * and you see it, as a crease running across a face that ought to be flat.
 * (It is also a chamfer that varies around the perimeter, which is a fit
 * problem as well as a rendering one.)
 *
 * Offsetting the polygon instead keeps corresponding edges parallel, so every
 * band quad is planar by construction. Vertex count is preserved, which the
 * sweep relies on.
 */
export function insetPolygon(poly, d) {
    const n = poly.length;
    const lines = poly.map((a, i) => {
        const b = poly[(i + 1) % n];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L = Math.hypot(dx, dz) || 1;
        // CCW polygons in this module have their interior on the left, so the
        // inward normal is (-dz, dx)/L. Sign is checked against the signed area
        // below rather than assumed.
        return { px: a[0], pz: a[1], dx: dx / L, dz: dz / L, nx: -dz / L, nz: dx / L };
    });
    let area2 = 0;
    for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        area2 += a[0] * b[1] - b[0] * a[1];
    }
    const sgn = area2 >= 0 ? 1 : -1;
    const out = [];
    for (let i = 0; i < n; i++) {
        const prev = lines[(i + n - 1) % n], cur = lines[i];
        const p0x = prev.px + sgn * prev.nx * d, p0z = prev.pz + sgn * prev.nz * d;
        const p1x = cur.px + sgn * cur.nx * d, p1z = cur.pz + sgn * cur.nz * d;
        const cross = prev.dx * cur.dz - prev.dz * cur.dx;
        if (Math.abs(cross) < 1e-9) { out.push([p1x, p1z]); continue; }   // collinear
        const t = ((p1x - p0x) * cur.dz - (p1z - p0z) * cur.dx) / cross;
        out.push([p0x + prev.dx * t, p0z + prev.dz * t]);
    }
    return out;
}

/** `dist` along the segment from `a` to `b`. */
function towards(a, b, dist) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const f = Math.min(0.45, dist / L);
    return [a[0] + dx * f, a[1] + dz * f];
}

/**
 * Does a printed key actually fit its printed pocket?
 *
 * The joint has two independent ways to fail and the printed set found both.
 * The FLANKS are what should carry the wedging load, and a horizontal
 * clearance only buys 91% of itself there because they are raked. The far
 * CORNERS of the pocket are internal, so a nozzle leaves a radius in them; a
 * sharp key tip cannot enter that radius, and if the interference there
 * exceeds the flank gap the key rides on its corners and rattles everywhere
 * else. At the shipped 0.2 mm clearance it did exactly that: 0.20 mm of corner
 * bind against 0.18 mm of flank gap.
 *
 * Returns millimetres, per side. `cornerBindMm > 0` means the key cannot seat.
 */
export function bowtieFit({ neckHalf = 8, tipHalf = 12, depth = 9,
                            clearance = 0.1, tipChamfer = 0, cornerRadius = 0.3 } = {}) {
    const flare = (tipHalf - neckHalf) / depth;
    const flankGapMm = clearance / Math.sqrt(1 + flare * flare);
    // pocket's far corner, and the arc a nozzle leaves in it
    const zFar = depth + clearance;
    const px = neckHalf + clearance + flare * zFar;
    const cx = px - cornerRadius, cz = zFar - cornerRadius;
    // the nearest point of the key to that arc centre
    const key = bowtieKeyPlan({ neckHalf, tipHalf, depth, tipChamfer });
    let nearest = Infinity;
    for (let i = 0; i < key.length; i++) {
        const a = key[i], b = key[(i + 1) % key.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L2 = dx * dx + dz * dz || 1;
        let t = ((cx - a[0]) * dx + (cz - a[1]) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        nearest = Math.min(nearest, Math.hypot(cx - (a[0] + dx * t), cz - (a[1] + dz * t)));
    }
    return { flankGapMm, cornerBindMm: cornerRadius - nearest, seats: cornerRadius - nearest <= 0 };
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
export function bowtiePocketPlan({ neckHalf = 8, tipHalf = 12, depth = 9, clearance = 0.25,
                                   depthClearance = null }) {
    const flare = (tipHalf - neckHalf) / depth;
    const wall = (z) => neckHalf + clearance + flare * z;   // key flank, offset
    // The FAR wall carries its OWN clearance, so that closing the flanks up
    // the key's travel — which is how this joint grips, see SPEC.key.seatGripMm
    // — never drags the far wall in with them. It must not move: the key
    // reaches into two pockets at once, so a far wall pressing on its tips has
    // nowhere to send that force except into driving the two pieces apart.
    const zFar = depth + (depthClearance ?? clearance);
    return [
        [-wall(-0.5), -0.5], [wall(-0.5), -0.5],
        [wall(zFar), zFar],
        [-wall(zFar), zFar]
    ];
}

/**
 * How a printed feature differs from the model it was cut from — MEASURED.
 *
 * Everything here is calipers on one printed set. `devMm` is printed minus
 * drawn, ACROSS the feature (not per side), so a negative deviation on a hole
 * means the hole came out small.
 *
 *   feature measured             drawn    printed          deviation
 *   ---------------------------------------------------------------
 *   hex tenon AF (riser)          8.60    8.60              0.000
 *   hex tenon AF (foot pier)      8.60    8.60-8.70         0.00 .. +0.10
 *   socket boss OD               19.00    18.90            -0.100
 *   key thickness                 5.60    5.645            +0.045
 *   key front-to-back            18.00    18.07            +0.070
 *   track socket AF (x3)          9.00    8.95/8.90/8.85   -0.05 .. -0.15
 *   riser socket AF (x2)          9.00    8.62, 8.65       -0.35 .. -0.38
 *
 * THE ONE ROBUST STATEMENT: every hole came out under, by 0.05 to 0.38, and
 * every external feature came out within 0.10 either way. Not one hole
 * printed over. Anything that only needs that much — and a joint drawn so
 * that shrinkage HELPS it only needs that much — stands on eleven readings
 * with no theory in between.
 *
 * THE PART THAT IS NOT ESTABLISHED: the two socket rows are the same drawing
 * (hexSocketSolid at AF 9) and land 0.25 apart, and the cause is unknown.
 * A previous version of this comment blamed thermal mass — a "slender" riser
 * tube against a "massive" track boss — and that does not survive checking:
 * the riser body is 15 AF around a 9 AF socket, so it carries 3.0 mm of wall,
 * against the boss's 5.0. Both are thick. Live alternatives, none excluded:
 *
 *  - MEASUREMENT. hexSocketSolid opens with a 0.8 mm flare from AF+1.2 down
 *    to AF. Caliper jaws sitting anywhere in that flare read up to 1.2 mm
 *    over, and a socket recessed inside a Ø19 boss is harder to reach into
 *    than one in the end of a 15 mm hex tube — which predicts exactly the
 *    sign observed. This alone could be the whole 0.25.
 *  - Different plates, different layer times, different heights in the print.
 *  - Blind (capped by the cored boss) against through.
 *
 * What IS independent of all that is how the joints behave: the same tenon is
 * snug in a riser socket and falls out of a track socket. A caliper artefact
 * cannot make a joint feel loose. So the DIRECTION is real and the MAGNITUDE
 * is the uncertain part — which is why SPEC.socket.socketShrinkAF rests on the
 * fit reports and treats 0.25 as its best available estimate, not as a fact.
 *
 * Corner rounding is tracked separately (cornerRadiusMm): a shape error, not
 * a size error, and on a 66° bowtie tip it dwarfs everything here. Two
 * readings that look wildly off — a key waist at 16.4 where 16.0 was drawn,
 * its slot at 16.85 where 16.4 was — are neither: a flat caliper jaw cannot
 * enter a CONCAVE vertex, so it rides up the flanks and reads a bowtie waist
 * wide. Both parts read wide by the same amount, which is why the pair still
 * fits and why pre-shrinking the key on that number was a mistake.
 */
export const PRINT_DEVIATION = {
    /** material — outer surfaces of tenons, keys, walls. n=5, range ±0.10 */
    external: { devMm: 0.00, sigmaMm: 0.07, n: 5 },
    /** every hole, pooled: the statement that needs no classification */
    hole: { devMm: -0.21, sigmaMm: 0.14, n: 5 },
    /** the three track-piece sockets on their own */
    holeMassive: { devMm: -0.10, sigmaMm: 0.05, n: 3 },
    /** the two riser sockets on their own — same drawing, 0.25 apart, cause unknown */
    holeSlender: { devMm: -0.37, sigmaMm: 0.05, n: 2 }
};

/**
 * What a drawn dimension is expected to measure once printed, and the band it
 * lands in (±2σ ≈ 95%). `klass` is a key of PRINT_DEVIATION.
 *
 * σ for holeSlender is borrowed from holeMassive: two samples 0.03 apart
 * cannot establish a spread, and pretending they can would publish a
 * confidence the data does not support.
 */
export function printedSize(drawnMm, klass = 'external') {
    const d = PRINT_DEVIATION[klass] ?? PRINT_DEVIATION.external;
    const nominal = drawnMm + d.devMm;
    return { nominal, sigmaMm: d.sigmaMm, lo: nominal - 2 * d.sigmaMm, hi: nominal + 2 * d.sigmaMm, n: d.n };
}

export const PROCESS = {
    biasMm: 0,          // systematic; swept over ±0.1 rather than trusted
    sigmaMm: 0.05,      // run to run, per side
    /**
     * MEASURED, and by the one dimension that reads it directly. The key's
     * two diagonals run tip to opposite tip, drawn 30.00 exactly, and came off
     * the plate at 29.28 and 29.16. That diagonal lies almost along the tip's
     * own bisector, so the deficit is twice the amount a fillet pulls the
     * vertex in — 0.43 and 0.50 mm of radius. The tip-to-tip width implies
     * 0.39 independently. A tip is a 66° corner; a nozzle simply cannot hold
     * one that sharp.
     *
     * The old 0.30 was a guess, and it was low enough to size the chamfer
     * wrong. The POCKET's internal corners are what actually bind and nothing
     * has measured those — an inside corner collects material rather than
     * losing it, so if anything 0.45 is the optimistic end.
     */
    cornerRadiusMm: 0.45,
    cornerSigmaMm: 0.06,
    /** interference a hand can push a key past, per side */
    maxPressMm: 0.05,
    /** gap above which the joint rattles, per side */
    looseMm: 0.12
};

/** Deterministic PRNG — a test that moves when nobody changed anything is noise. */
function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Monte Carlo over the printing variation: what fraction of printed keys both
 * GO IN and come out snug?
 *
 * A single nominal fit tells you little here, because the two failure modes
 * pull opposite ways — tighten it and more keys bind, loosen it and more
 * rattle — and the printed set managed BOTH at once by riding on its corners
 * while its flanks floated. So the thing to maximise is the fraction of runs
 * landing in between, and the thing to choose is the clearance whose good
 * fraction survives the bias being unknown.
 */
export function bowtieFitTrials({
    neckHalf = 8, tipHalf = 12, depth = 9, clearance = 0.1, tipChamfer = 0,
    process = PROCESS, bias = null, measured = false, trials = 4000, seed = 12345
} = {}) {
    const rnd = mulberry32(seed);
    const normal = () => {
        const u = Math.max(1e-9, rnd()), v = rnd();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const b = bias ?? process.biasMm;
    // `measured` draws the two parts from their own populations instead of one
    // swept bias: the key is an external feature (PRINT_DEVIATION.external,
    // 0.00 across) and its pocket is a hole in a track piece (holeMassive,
    // −0.10 across, so each wall stands 0.05 proud and eats that much
    // clearance). The swept form is still the honest default while nothing has
    // measured a POCKET directly — the classes are calibrated on hex sockets,
    // and a bowtie slot is a different shape in the same body.
    const K = PRINT_DEVIATION.external, P = PRINT_DEVIATION.holeMassive;
    let assembles = 0, snug = 0, good = 0;
    const gaps = [];
    for (let i = 0; i < trials; i++) {
        // key proud by one draw, pocket wall proud by another: both eat clearance
        const eaten = measured
            ? (K.devMm + normal() * K.sigmaMm) / 2 + (-P.devMm + normal() * P.sigmaMm) / 2
            : (b + normal() * process.sigmaMm) + (b + normal() * process.sigmaMm);
        const r = Math.max(0, process.cornerRadiusMm + normal() * process.cornerSigmaMm);
        const f = bowtieFit({ neckHalf, tipHalf, depth, clearance: clearance - eaten, tipChamfer, cornerRadius: r });
        gaps.push(f.flankGapMm);
        const goesIn = f.cornerBindMm <= process.maxPressMm && f.flankGapMm >= -process.maxPressMm;
        const isSnug = f.flankGapMm <= process.looseMm;
        if (goesIn) assembles++;
        if (isSnug) snug++;
        if (goesIn && isSnug) good++;
    }
    gaps.sort((x, y) => x - y);
    return {
        pAssembles: assembles / trials, pSnug: snug / trials, pGood: good / trials,
        medianFlankGapMm: gaps[gaps.length >> 1]
    };
}

/**
 * What "snug" means on the hex joint, in millimetres per side.
 *
 * These are not preferences. They are read off two printed joints that were
 * assembled by hand and judged by hand: a riser tenon in a riser socket
 * (8.60 in 8.62-8.65 → 0.010-0.025/side) is "snug but not too tight", and the
 * same tenon in a track socket (8.60 in 8.85-8.95 → 0.125-0.175/side) "falls
 * out too easily". The band between them is where the joint has to land, and
 * everything below sits inside it rather than straddling either report.
 */
export const HEX_FIT = {
    targetClearMm: 0.02,   // the joint that works, measured
    maxPressMm: 0.04,      // interference a hand can still seat
    looseMm: 0.09          // above this it drops apart; 0.125 demonstrably does
};

/**
 * Hex tenon in hex socket. The FLATS decide it.
 *
 * A hex corner is 120°, and both parts have one there: the socket's internal
 * corner fills in by r·(1/sin60° − 1) = 0.155r, and the tenon's external
 * corner is pulled back by 0.155 of ITS radius. At equal radii those cancel
 * exactly, so the corners drop out and the fit is just the flats. That
 * cancellation is the whole reason this joint has never bound the way the
 * bowtie did: a 66° tip has a factor of 0.836 — five times as sensitive — and
 * nothing on the other side to cancel against.
 *
 * All returns are per side. Negative clearance is interference.
 */
export function hexFit({ socketAF, tenonAF, socketCornerR = 0, tenonCornerR = 0 }) {
    const clearPerSideMm = (socketAF - tenonAF) / 2;
    // along a corner bisector the flat clearance opens up by 1/cos30°
    const cornerClear = clearPerSideMm / Math.cos(Math.PI / 6)
        + 0.1547 * (tenonCornerR - socketCornerR);
    return {
        clearPerSideMm,
        cornerBindMm: Math.max(0, -cornerClear),
        seats: clearPerSideMm >= -HEX_FIT.maxPressMm && cornerClear >= -HEX_FIT.maxPressMm
    };
}

/**
 * Monte Carlo over the hex joint, drawing the socket and the tenon from their
 * own MEASURED populations (PRINT_DEVIATION) rather than from one shared
 * guess. That separation is the point: the socket's class is what makes a
 * track socket and a riser socket different joints from the same drawing.
 */
export function hexFitTrials({
    socketAF = 9, tenonAF = 8.6, socketClass = 'holeMassive', tenonClass = 'external',
    process = PROCESS, trials = 8000, seed = 60606
} = {}) {
    const rnd = mulberry32(seed);
    const normal = () => {
        const u = Math.max(1e-9, rnd()), v = rnd();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const S = PRINT_DEVIATION[socketClass], T = PRINT_DEVIATION[tenonClass];
    let seats = 0, snug = 0, good = 0;
    const clears = [];
    for (let i = 0; i < trials; i++) {
        const s = socketAF + S.devMm + normal() * S.sigmaMm;
        const t = tenonAF + T.devMm + normal() * T.sigmaMm;
        const f = hexFit({
            socketAF: s, tenonAF: t,
            socketCornerR: Math.max(0, process.cornerRadiusMm + normal() * process.cornerSigmaMm),
            tenonCornerR: Math.max(0, process.cornerRadiusMm + normal() * process.cornerSigmaMm)
        });
        clears.push(f.clearPerSideMm);
        const isSnug = f.clearPerSideMm <= HEX_FIT.looseMm;
        if (f.seats) seats++;
        if (isSnug) snug++;
        if (f.seats && isSnug) good++;
    }
    clears.sort((a, b) => a - b);
    const q = (p) => clears[Math.min(clears.length - 1, Math.floor(p * clears.length))];
    return {
        pSeats: seats / trials, pSnug: snug / trials, pGood: good / trials,
        medianClearMm: q(0.5), p05ClearMm: q(0.05), p95ClearMm: q(0.95)
    };
}

/** Regular polygon (plan) for hex sockets / tenons. acrossFlats in mm. */
/**
 * The hex boundary sampled at `n` evenly spaced angles, so it can be LOFTED
 * into a circle of the same point count. Stepping straight from a 6-point hex
 * to a round bore leaves a ledge whichever radius you pick — match the
 * inradius and the hex corners overhang, match the circumradius and the flats
 * do — and that ledge sits inside a blind socket where support cannot be got
 * out again.
 */
export function hexRingPlan(acrossFlats, n, rotation = 0) {
    const a = acrossFlats / 2;                 // inradius
    const pts = [];
    for (let i = 0; i < n; i++) {
        const th = rotation + (i / n) * 2 * Math.PI;
        // distance to the hex boundary at this angle
        const k = ((th - rotation) % (Math.PI / 3) + Math.PI / 3) % (Math.PI / 3);
        const r = a / Math.cos(k - Math.PI / 6);
        pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    return pts;
}

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
    alphaDeg: 18,   // swing angle allowed by the slot walls
    /**
     * MEASURED off a real Klip Klop figure, not derived from the track.
     *
     * It used to be `trackInnerWidth − 4`, which made it 44 — six millimetres
     * wider than the toy it is meant to stand in for, and wide enough that it
     * could not run in the 39.5 mm groove of the community sets PHYSICS.md §7
     * claims figures interoperate with. It was also the sole reason curves had
     * to be widened, and therefore the sole reason a straight next to a curve
     * was a different part. One wrong number, three problems.
     */
    widthMm: 38
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
