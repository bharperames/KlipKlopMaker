/**
 * engrave.js
 * Text → closed polygon rings, for cutting a part code into a printed surface.
 * Pure — no DOM, no Three.js, no CSG — so Jest tests the rings directly.
 *
 * WHY A STROKE FONT. The obvious route is opentype.js plus an OFL face,
 * flattening each glyph's contours. It is wrong for this job, for a reason that
 * has nothing to do with taste: these codes are a few millimetres tall cut with
 * a 0.4 mm nozzle, and an outline font at that size has stems thinner than one
 * extrusion. A slicer does not render a thin stem faintly — it drops it, and
 * the part comes off the bed with holes in its code.
 *
 * A stroke font makes the constraint structural instead of advisory: a glyph is
 * a CENTRELINE, the stroke width is a parameter, and no part of a letter can
 * come out thinner than you ask for. `SPEC.engrave.minFeature` is not something
 * to check for afterwards; it is the pen.
 *
 * WHY IT LOOKS SMOOTH. The skeletons are sparse — eight points describe an 'O' —
 * and the round ones are run through a Catmull-Rom spline before they are
 * inked, so a curve is a curve rather than a chain of chords. Letters that are
 * genuinely straight (E, H, K, M, N, T, V, W, X, Y, Z, 1, 4, 7) skip that and
 * stay crisp.
 *
 * A pixel-matrix version came first and was rejected for looking coarse: at
 * 3.5 mm cap height a 5 × 7 grid is 0.5 mm per pixel, and every curve in the
 * alphabet turns into a staircase you can see from across the room.
 *
 * Geometry: every stroke segment becomes a STADIUM — a rectangle with a round
 * cap at each end. Adjacent stadiums overlap at the joins on purpose; the 2D
 * union downstream fuses them into one letter, and the caps are what round the
 * corners off.
 */

/** Glyph advance in cap heights, before tracking. */
export const ADVANCE = 0.6;

/**
 * Catmull-Rom through `pts`, `perSeg` samples per span. Used at module load to
 * turn a sparse skeleton into a smooth one; `closed` wraps the ends, which is
 * what lets an 'O' meet itself without a corner.
 */
function smooth(pts, perSeg = 6, closed = false) {
    const p = closed ? pts.slice(0, -1) : pts;      // drop the repeated endpoint
    const n = p.length;
    if (n < 3) return pts;
    const at = (i) => p[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
    const out = [];
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        for (let k = 0; k < perSeg; k++) {
            const t = k / perSeg, t2 = t * t, t3 = t2 * t;
            out.push([0, 1].map(d => 0.5 * (
                2 * p1[d] +
                (-p0[d] + p2[d]) * t +
                (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
                (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
        }
    }
    out.push(closed ? out[0] : p[n - 1]);
    return out;
}

/**
 * Uppercase only. Small engraved lowercase is a legibility trap — 'l', '1' and
 * 'i' stop being distinguishable at a couple of millimetres — and it halves the
 * table. Skeletons live in a unit box: x ∈ [0, ADVANCE], y ∈ [0, 1], baseline
 * at y = 0, cap height 1.
 */
export const GLYPHS = {
    ' ': [],
    'A': [[[0, 0], [0.3, 1], [0.6, 0]], [[0.12, 0.4], [0.48, 0.4]]],
    'B': [[[0, 0], [0, 1]],
          smooth([[0, 1], [0.42, 1], [0.6, 0.86], [0.6, 0.64], [0.42, 0.5], [0, 0.5]]),
          smooth([[0, 0.5], [0.44, 0.5], [0.6, 0.36], [0.6, 0.14], [0.44, 0], [0, 0]])],
    'C': [smooth([[0.6, 0.79], [0.46, 0.98], [0.16, 1], [0, 0.78], [0, 0.22], [0.16, 0], [0.46, 0.02], [0.6, 0.21]])],
    'D': [[[0, 0], [0, 1]],
          smooth([[0, 1], [0.3, 1], [0.6, 0.76], [0.6, 0.24], [0.3, 0], [0, 0]])],
    'E': [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.5], [0.45, 0.5]]],
    'F': [[[0.6, 1], [0, 1], [0, 0]], [[0, 0.5], [0.45, 0.5]]],
    'G': [smooth([[0.6, 0.79], [0.46, 0.98], [0.16, 1], [0, 0.78], [0, 0.22], [0.16, 0], [0.46, 0.02], [0.6, 0.22], [0.6, 0.44]]),
          [[0.6, 0.44], [0.34, 0.44]]],
    'H': [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]],
    'I': [[[0.3, 0], [0.3, 1]], [[0.1, 1], [0.5, 1]], [[0.1, 0], [0.5, 0]]],
    'J': [smooth([[0.6, 1], [0.6, 0.26], [0.46, 0.02], [0.18, 0.02], [0.02, 0.2]])],
    'K': [[[0, 0], [0, 1]], [[0.6, 1], [0, 0.45]], [[0.18, 0.6], [0.6, 0]]],
    'L': [[[0, 1], [0, 0], [0.6, 0]]],
    'M': [[[0, 0], [0, 1], [0.3, 0.48], [0.6, 1], [0.6, 0]]],
    'N': [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
    'O': [smooth([[0.3, 1], [0.6, 0.78], [0.6, 0.22], [0.3, 0], [0, 0.22], [0, 0.78], [0.3, 1]], 6, true)],
    'P': [[[0, 0], [0, 1]],
          smooth([[0, 1], [0.42, 1], [0.6, 0.85], [0.6, 0.63], [0.42, 0.48], [0, 0.48]])],
    'Q': [smooth([[0.3, 1], [0.6, 0.78], [0.6, 0.22], [0.3, 0], [0, 0.22], [0, 0.78], [0.3, 1]], 6, true),
          [[0.36, 0.24], [0.6, 0]]],
    'R': [[[0, 0], [0, 1]],
          smooth([[0, 1], [0.42, 1], [0.6, 0.85], [0.6, 0.63], [0.42, 0.48], [0, 0.48]]),
          [[0.3, 0.48], [0.6, 0]]],
    'S': [smooth([[0.6, 0.84], [0.44, 1], [0.16, 1], [0, 0.82], [0.08, 0.6], [0.3, 0.52],
                  [0.52, 0.44], [0.6, 0.22], [0.44, 0.02], [0.16, 0.02], [0, 0.18]])],
    'T': [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
    'U': [smooth([[0, 1], [0, 0.24], [0.16, 0.01], [0.44, 0.01], [0.6, 0.24], [0.6, 1]])],
    'V': [[[0, 1], [0.3, 0], [0.6, 1]]],
    'W': [[[0, 1], [0.15, 0], [0.3, 0.6], [0.45, 0], [0.6, 1]]],
    'X': [[[0, 0], [0.6, 1]], [[0, 1], [0.6, 0]]],
    'Y': [[[0, 1], [0.3, 0.5], [0.6, 1]], [[0.3, 0.5], [0.3, 0]]],
    'Z': [[[0, 1], [0.6, 1], [0, 0], [0.6, 0]]],
    // the slashed nought, so a bin of R30s never reads as R3O
    '0': [smooth([[0.3, 1], [0.6, 0.78], [0.6, 0.22], [0.3, 0], [0, 0.22], [0, 0.78], [0.3, 1]], 6, true),
          [[0.12, 0.22], [0.48, 0.78]]],
    '1': [[[0.08, 0.78], [0.3, 1], [0.3, 0]], [[0.08, 0], [0.52, 0]]],
    '2': [smooth([[0.02, 0.76], [0.14, 0.98], [0.44, 1], [0.6, 0.82], [0.54, 0.58], [0, 0]]),
          [[0, 0], [0.6, 0]]],
    '3': [[[0.04, 1], [0.6, 1], [0.3, 0.56]],
          smooth([[0.3, 0.56], [0.52, 0.54], [0.6, 0.34], [0.5, 0.06], [0.2, 0.02], [0.02, 0.16]])],
    '4': [[[0.45, 0], [0.45, 1], [0, 0.3], [0.6, 0.3]]],
    '5': [[[0.6, 1], [0.08, 1], [0.05, 0.6]],
          smooth([[0.05, 0.6], [0.34, 0.62], [0.6, 0.46], [0.58, 0.18], [0.34, 0.01], [0.04, 0.12]])],
    '6': [smooth([[0.52, 1], [0.22, 1], [0.02, 0.72], [0, 0.28], [0.2, 0.02], [0.48, 0.06],
                  [0.6, 0.28], [0.46, 0.5], [0.16, 0.5], [0.03, 0.36]])],
    '7': [[[0, 1], [0.6, 1], [0.2, 0]]],
    '8': [smooth([[0.3, 0.52], [0.06, 0.66], [0.08, 0.9], [0.3, 1], [0.52, 0.9], [0.54, 0.66],
                  [0.3, 0.52], [0.04, 0.36], [0.06, 0.1], [0.3, 0], [0.54, 0.1], [0.56, 0.36], [0.3, 0.52]], 6, true)],
    '9': [smooth([[0.08, 0], [0.38, 0.02], [0.58, 0.3], [0.6, 0.74], [0.4, 0.99], [0.12, 0.94],
                  [0, 0.72], [0.14, 0.5], [0.44, 0.5], [0.57, 0.64]])],
    '.': [[[0.28, 0], [0.32, 0]]],
    '-': [[[0.1, 0.5], [0.5, 0.5]]],
    '/': [[[0.05, 0], [0.55, 1]]]
};

/**
 * The font's true unit-box extent, measured from the glyphs themselves.
 *
 * A Catmull-Rom through points ON a curve bulges a little past them, so an 'O'
 * really is a hair taller and wider than an 'H'. That is not a defect — every
 * typeface overshoots its round letters for the same optical reason — and
 * clamping it back was worse than the disease: the flat spot it left is a
 * corner in the middle of a curve, which is exactly what the spline exists to
 * remove. So the metrics measure what is actually drawn instead of assuming
 * the nominal box, and the layout reserves that.
 */
const EXTENT = (() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const lines of Object.values(GLYPHS)) {
        for (const [x, y] of lines.flat()) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    }
    return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
})();

export const ENGRAVE_DEFAULTS = {
    capHeight: 3.5,
    tracking: 0.45,
    strokeMm: 0.5,      // the pen: nothing on the part is ever thinner
    capSegs: 5          // quarter-circle segments per stroke end
};

/**
 * Options over defaults, ignoring keys explicitly set to `undefined` — callers
 * forward optional settings straight through, and a plain spread would let one
 * of those overwrite a default with nothing.
 */
const settings = (opts = {}) => {
    const o = { ...ENGRAVE_DEFAULTS };
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) o[k] = v;
    return o;
};

/** The smallest feature the font will draw, in mm. */
export function minFeatureMm(opts = {}) {
    return settings(opts).strokeMm;
}

/** Characters this font can cut. Anything else is a hard error, not a blank. */
export function isEngravable(str) {
    return [...String(str).toUpperCase()].every(ch => GLYPHS[ch] !== undefined);
}

/** Width in mm of `str` set at these settings. */
export function textWidthMm(str, opts = {}) {
    const o = settings(opts);
    const n = String(str).length;
    if (!n) return 0;
    // the stroke straddles the skeleton, so the inked width overhangs the
    // drawn extent by half a stroke at each end
    return (n - 1) * (ADVANCE * o.capHeight + o.tracking) + EXTENT.w * o.capHeight + o.strokeMm;
}

export function textHeightMm(opts = {}) {
    const o = settings(opts);
    return EXTENT.h * o.capHeight + o.strokeMm;
}

/**
 * Glyph skeletons for `str`, in mm, baseline at y = 0 and the left edge of the
 * inked area at x = 0.
 */
export function textStrokes(str, opts = {}) {
    const o = settings(opts);
    const text = String(str).toUpperCase();
    const step = ADVANCE * o.capHeight + o.tracking;
    const out = [];
    for (let i = 0; i < text.length; i++) {
        const glyph = GLYPHS[text[i]];
        if (glyph === undefined) throw new Error(`engrave: no glyph for ${JSON.stringify(text[i])}`);
        const x0 = o.strokeMm / 2 + i * step;
        for (const line of glyph) {
            out.push(line.map(([x, y]) => [
                x0 + (x - EXTENT.x0) * o.capHeight,
                o.strokeMm / 2 + (y - EXTENT.y0) * o.capHeight]));
        }
    }
    return out;
}

/**
 * A stroke's outline: a rectangle plus a round cap at each end. Returned CCW.
 *
 * Round rather than square caps because a square cap on a diagonal leaves a
 * spur that reads as a serif nobody asked for, and because the caps are what
 * round every join once the stadiums are unioned. A zero-length stroke (the
 * full stop) degenerates to a disc, which is what a full stop should be.
 */
export function stadiumRing(a, b, width, capSegs = ENGRAVE_DEFAULTS.capSegs) {
    const r = width / 2;
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
    const nx = -dz, nz = dx;                       // left normal
    const seg = Math.max(1, capSegs);
    const ring = [];
    // Both caps sweep the same way round, so each bulges AWAY from the segment
    // instead of folding back over it. Fold them inward and the polygon
    // self-intersects — which does not throw, it just quietly loses the glyph
    // in the 2D union later. CCW, so the ring needs no fixing up.
    const arc = (cx, cz, startAng) => {
        for (let k = 0; k <= 2 * seg; k++) {
            const t = startAng + (k / (2 * seg)) * Math.PI;
            const p = [cx + r * Math.cos(t), cz + r * Math.sin(t)];
            const last = ring[ring.length - 1];
            if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-9) continue;
            ring.push(p);
        }
    };
    const angN = Math.atan2(nz, nx);
    arc(b[0], b[1], angN + Math.PI);                // round the far end
    arc(a[0], a[1], angN);                          // and back round the near one
    return ring;
}

/** Shoelace area; used to force a consistent winding and to test rings. */
export function ringArea(ring) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

/**
 * Closed CCW rings for `str`, in mm, ready to be unioned in 2D and extruded.
 * One ring per stroke segment; they overlap at the joins and the union is what
 * makes a letter out of them.
 */
export function textRings(str, opts = {}) {
    const o = settings(opts);
    const rings = [];
    for (const line of textStrokes(str, o)) {
        if (line.length === 1) rings.push(stadiumRing(line[0], line[0], o.strokeMm, o.capSegs));
        for (let i = 0; i + 1 < line.length; i++) {
            rings.push(stadiumRing(line[i], line[i + 1], o.strokeMm, o.capSegs));
        }
    }
    return rings.map(r => (ringArea(r) < 0 ? [...r].reverse() : r));
}

/**
 * Several lines, stacked with the FIRST line on top and the block's baseline at
 * y = 0. Small parts have a face that is tall and narrow rather than long and
 * short, so their codes are set as a block and often turned on their side.
 */
export function blockRings(lines, opts = {}) {
    const o = settings(opts);
    const step = textHeightMm(o) + (o.leadingMm ?? o.capHeight * 0.35);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const dy = (lines.length - 1 - i) * step;
        for (const ring of textRings(lines[i], o)) out.push(ring.map(([x, y]) => [x, y + dy]));
    }
    return out;
}

export function blockSizeMm(lines, opts = {}) {
    const o = settings(opts);
    const step = textHeightMm(o) + (o.leadingMm ?? o.capHeight * 0.35);
    return {
        widthMm: Math.max(0, ...lines.map(l => textWidthMm(l, o))),
        heightMm: lines.length ? (lines.length - 1) * step + textHeightMm(o) : 0
    };
}

// ---------------------------------------------------------------------------
// What a part is called
// ---------------------------------------------------------------------------

/**
 * The code is a COMPATIBILITY CLAIM, not a serial number: `CURVEL 1.1` mates
 * with `STR 1.1`, and a major bump tells you the bin of old parts no longer
 * fits. So it carries MAJOR.MINOR of GEOMETRY_VERSION and drops PATCH, which
 * is defined as cosmetic-only and would otherwise churn every part's marking
 * for a change that mates identically.
 */
export function codeVersion(geometryVersion) {
    const [maj, min] = String(geometryVersion).split('.');
    return `${maj}.${min ?? 0}`;
}

const TYPE_CODE = {
    start: 'PLAT', end: 'PLAT', straight: 'STR',
    // spelled out: a bin of chiral parts is exactly where an abbreviation
    // costs you, and a curve tile is long enough to carry the words
    curveL: 'LEFT CURVE', curveR: 'RIGHT CURVE',
    lift: 'LIFT', elevator: 'ELEV', powered: 'PWR',
    switchMain: 'SWITCH', switchBranch: 'SWITCH'
};

/**
 * A straight that flanks a turn carries the turn's width at that face and is
 * genuinely a different solid (see resolveSeamWidths). Same compatibility
 * claim, different shape — so the code says which one it is rather than
 * leaving two different parts wearing the same mark.
 */
function flareSuffix(piece) {
    if (!piece || piece.radius) return '';
    const body = piece.innerWidth;
    const e = piece.entryWidth ?? body, x = piece.exitWidth ?? body;
    if (e > body && x > body) return ' MID';
    if (e > body) return ' OUT';
    if (x > body) return ' IN';
    return '';
}

/** Engraved code for a laid-out track piece, e.g. `STR IN 1.1`. */
export function pieceCode(piece, geometryVersion) {
    const base = TYPE_CODE[piece.switchType ? 'switchMain' : piece.type] ?? String(piece.type).toUpperCase();
    return `${base}${flareSuffix(piece)} ${codeVersion(geometryVersion)}`;
}

/** Engraved code for a non-track part, e.g. `R120 1.1`, `KEY 1.1`. */
export function partCode(name, geometryVersion) {
    return `${String(name).toUpperCase()} ${codeVersion(geometryVersion)}`;
}
