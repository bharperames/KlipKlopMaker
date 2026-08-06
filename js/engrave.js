/**
 * engrave.js
 * Text → closed polygon rings, for cutting a part code into a printed surface.
 * Pure — no DOM, no Three.js, no CSG — so Jest tests the rings directly.
 *
 * WHY A STROKE FONT AND NOT A REAL ONE. The obvious route is opentype.js plus
 * an OFL font, flattening each glyph's contours. It was the plan, and it is
 * wrong for this job for a reason the plan itself names: `minStroke`. These
 * codes are cut 4 mm tall into a 1.6 mm wall on a 0.4 mm nozzle, and an outline
 * font at 4 mm cap height has stems well under two extrusion widths. A slicer
 * does not render a thin stem faintly — it drops it, and the part comes off the
 * bed with half its code missing. A stroke font makes the constraint structural
 * instead of advisory: the glyph IS a centreline, the stroke width is a
 * parameter, and it cannot be thinner than you ask for. It also costs no
 * dependency and no bundled font file, which for a client-side app that already
 * vendors three, manifold and fflate by hand is not nothing.
 *
 * The trade is honest: this is engineering lettering, not typography. At 4 mm
 * on a toy ramp that is the right register anyway.
 *
 * Geometry: glyphs are polylines in a unit box — x ∈ [0, ADVANCE], y ∈ [0, 1],
 * baseline at y = 0, cap height 1. `textRings` scales them, gives every stroke
 * a stadium outline (rectangle plus round caps) and returns those as closed
 * CCW rings. Rings of adjacent strokes OVERLAP on purpose: they are unioned in
 * 2D before extrusion, which is what turns a skeleton into a letter.
 */

/** Glyph advance in cap heights, before tracking. */
export const ADVANCE = 0.6;

/**
 * Uppercase only. Small engraved lowercase is a legibility trap — 'l' and '1'
 * and 'i' stop being distinguishable once a 0.8 mm stroke is most of the
 * letter — and it halves the glyph table.
 */
export const GLYPHS = {
    ' ': [],
    'A': [[[0, 0], [0.3, 1], [0.6, 0]], [[0.12, 0.4], [0.48, 0.4]]],
    'B': [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]],
          [[0.45, 0.5], [0.6, 0.35], [0.6, 0.15], [0.45, 0], [0, 0]]],
    'C': [[[0.6, 0.8], [0.45, 1], [0.15, 1], [0, 0.8], [0, 0.2], [0.15, 0], [0.45, 0], [0.6, 0.2]]],
    'D': [[[0, 0], [0, 1], [0.4, 1], [0.6, 0.8], [0.6, 0.2], [0.4, 0], [0, 0]]],
    'E': [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.5], [0.45, 0.5]]],
    'F': [[[0.6, 1], [0, 1], [0, 0]], [[0, 0.5], [0.45, 0.5]]],
    'G': [[[0.6, 0.8], [0.45, 1], [0.15, 1], [0, 0.8], [0, 0.2], [0.15, 0], [0.45, 0],
           [0.6, 0.2], [0.6, 0.45], [0.35, 0.45]]],
    'H': [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]],
    'I': [[[0.3, 0], [0.3, 1]], [[0.1, 1], [0.5, 1]], [[0.1, 0], [0.5, 0]]],
    'J': [[[0.6, 1], [0.6, 0.2], [0.45, 0], [0.15, 0], [0, 0.2]]],
    'K': [[[0, 0], [0, 1]], [[0.6, 1], [0, 0.45]], [[0.18, 0.6], [0.6, 0]]],
    'L': [[[0, 1], [0, 0], [0.6, 0]]],
    'M': [[[0, 0], [0, 1], [0.3, 0.5], [0.6, 1], [0.6, 0]]],
    'N': [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
    'O': [[[0.15, 0], [0.45, 0], [0.6, 0.2], [0.6, 0.8], [0.45, 1], [0.15, 1], [0, 0.8], [0, 0.2], [0.15, 0]]],
    'P': [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]]],
    'Q': [[[0.15, 0], [0.45, 0], [0.6, 0.2], [0.6, 0.8], [0.45, 1], [0.15, 1], [0, 0.8], [0, 0.2], [0.15, 0]],
          [[0.35, 0.25], [0.6, 0]]],
    'R': [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]],
          [[0.3, 0.5], [0.6, 0]]],
    'S': [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.65], [0.15, 0.5],
           [0.45, 0.5], [0.6, 0.35], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
    'T': [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
    'U': [[[0, 1], [0, 0.2], [0.15, 0], [0.45, 0], [0.6, 0.2], [0.6, 1]]],
    'V': [[[0, 1], [0.3, 0], [0.6, 1]]],
    'W': [[[0, 1], [0.15, 0], [0.3, 0.6], [0.45, 0], [0.6, 1]]],
    'X': [[[0, 0], [0.6, 1]], [[0, 1], [0.6, 0]]],
    'Y': [[[0, 1], [0.3, 0.5], [0.6, 1]], [[0.3, 0.5], [0.3, 0]]],
    'Z': [[[0, 1], [0.6, 1], [0, 0], [0.6, 0]]],
    '0': [[[0.15, 0], [0.45, 0], [0.6, 0.2], [0.6, 0.8], [0.45, 1], [0.15, 1], [0, 0.8], [0, 0.2], [0.15, 0]],
          [[0.15, 0.25], [0.45, 0.75]]],
    '1': [[[0.08, 0.78], [0.3, 1], [0.3, 0]], [[0.08, 0], [0.52, 0]]],
    '2': [[[0, 0.8], [0.15, 1], [0.45, 1], [0.6, 0.8], [0.6, 0.62], [0, 0], [0.6, 0]]],
    '3': [[[0, 1], [0.6, 1], [0.28, 0.56]], [[0.28, 0.56], [0.5, 0.56], [0.6, 0.42],
           [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
    '4': [[[0.45, 0], [0.45, 1], [0, 0.3], [0.6, 0.3]]],
    '5': [[[0.6, 1], [0, 1], [0, 0.56], [0.45, 0.56], [0.6, 0.42], [0.6, 0.15],
           [0.45, 0], [0.15, 0], [0, 0.15]]],
    '6': [[[0.52, 1], [0.2, 1], [0, 0.75], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15],
           [0.6, 0.35], [0.45, 0.5], [0.15, 0.5], [0, 0.35]]],
    '7': [[[0, 1], [0.6, 1], [0.2, 0]]],
    '8': [[[0.15, 0.5], [0, 0.65], [0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65],
           [0.45, 0.5], [0.15, 0.5], [0, 0.35], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15],
           [0.6, 0.35], [0.45, 0.5]]],
    '9': [[[0.08, 0], [0.4, 0], [0.6, 0.25], [0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85],
           [0, 0.65], [0.15, 0.5], [0.45, 0.5], [0.6, 0.65]]],
    '.': [[[0.28, 0], [0.32, 0]]],
    '-': [[[0.1, 0.5], [0.5, 0.5]]],
    '/': [[[0.05, 0], [0.55, 1]]]
};

export const ENGRAVE_DEFAULTS = {
    capHeight: 4,
    tracking: 0.6,
    strokeMm: 0.8,
    capSegs: 4      // quarter-circle segments per stroke end
};

const settings = (opts = {}) => ({ ...ENGRAVE_DEFAULTS, ...opts });

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
    // advance box by half a stroke at each end
    return n * (ADVANCE * o.capHeight + o.tracking) - o.tracking + o.strokeMm;
}

export function textHeightMm(opts = {}) {
    const o = settings(opts);
    return o.capHeight + o.strokeMm;
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
            out.push(line.map(([x, y]) => [x0 + x * o.capHeight, o.strokeMm / 2 + y * o.capHeight]));
        }
    }
    return out;
}

/**
 * A stroke's outline: rectangle plus a round cap at each end. Returned CCW.
 *
 * Round rather than square caps because the cut is read by a hoof-height eye at
 * arm's length, and because a square cap on a diagonal stroke leaves a spur
 * that reads as a serif nobody asked for. A zero-length stroke (the full stop)
 * degenerates to a disc, which is what a full stop should be.
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
 * One ring per stroke segment; they overlap at joins and the union is what
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
 * short, and one line of `R120 1.1` does not fit across an 8.7 mm hex flat.
 */
export function blockRings(lines, opts = {}) {
    const o = settings(opts);
    const step = o.capHeight + o.strokeMm + (o.leading ?? o.capHeight * 0.4);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const dy = (lines.length - 1 - i) * step;
        for (const ring of textRings(lines[i], o)) out.push(ring.map(([x, y]) => [x, y + dy]));
    }
    return out;
}

export function blockSizeMm(lines, opts = {}) {
    const o = settings(opts);
    const step = o.capHeight + o.strokeMm + (o.leading ?? o.capHeight * 0.4);
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
    start: 'PLAT', end: 'PLAT', straight: 'STR', curveL: 'CURVEL', curveR: 'CURVER',
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
