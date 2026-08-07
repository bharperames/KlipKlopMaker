/**
 * engrave.js
 * Text → closed polygon rings, for cutting a part code into a printed surface.
 * Pure — no DOM, no Three.js, no CSG — so Jest tests the rings directly.
 *
 * WHY A PIXEL FONT. The obvious route is opentype.js plus an OFL face,
 * flattening each glyph's contours. It is wrong for this job, for a reason that
 * has nothing to do with taste: these codes are a few millimetres tall cut with
 * a 0.4 mm nozzle, and an outline font at that size has stems thinner than one
 * extrusion. A slicer does not render a thin stem faintly — it drops it, and
 * the part comes off the bed with holes in its code.
 *
 * A pixel matrix makes the constraint structural rather than advisory. One
 * pixel IS the minimum feature: `pixelMm = capHeight / GLYPH_ROWS`, and nothing
 * on the part is ever smaller than that, in any direction, by construction.
 * There is no thin stem to lose because there are no stems — only squares, and
 * axis-aligned ones, which a slicer cuts as clean perimeter steps rather than
 * stair-stepping a diagonal.
 *
 * WHY 5 × 7 AND NOT 3 × 5. A 3 × 5 matrix satisfies all of the above and reads
 * as crude — at any size the letterforms are visibly coarse, and three columns
 * genuinely cannot tell H, M, N and W apart. 5 × 7 is the smallest grid with
 * room for a real bowl, a real diagonal and a slashed zero. It costs pixel
 * size: seven rows in a 3.5 mm cap is a 0.5 mm pixel, so the marks are smaller
 * as well as finer, which is what you want on a toy.
 *
 * Geometry: `textRings` emits one rectangle per horizontal RUN of lit pixels,
 * not one per pixel — a third of the rings for the same shape. They abut, and
 * the 2D union downstream fuses them into letterforms.
 */

/** The matrix. Rows are top-first; a glyph is 5 wide and 7 tall. */
export const GLYPH_COLS = 5;
export const GLYPH_ROWS = 7;
/** Glyph cell including its trailing gap, in pixels. */
export const ADVANCE_PX = GLYPH_COLS + 1;

/**
 * Uppercase only. Small engraved lowercase is a legibility trap — 'l', '1' and
 * 'i' stop being distinguishable the moment a glyph is three pixels wide — and
 * it halves the table.
 */
export const GLYPHS = {
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
    'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
    'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    'J': ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
    'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
    'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
    'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    'S': ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
    'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    'W': ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
    'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    // the slashed nought, so a bin of R30s never reads as R3O
    '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....']
};

export const ENGRAVE_DEFAULTS = {
    capHeight: 3.5,     // → 0.5 mm pixels
    leadingPx: 1,       // blank rows between stacked lines
    /** Rectangles abut on the pixel grid; a hair of overlap keeps the 2D
     *  union off coincident edges, and 0.8 µm is not a feature. */
    bleedMm: 0.0008
};

/**
 * Options over defaults, ignoring keys explicitly set to `undefined` — callers
 * forward optional settings straight through, and a spread would let one of
 * those overwrite a default with nothing. `leadingPx: undefined` doing that
 * turned every line offset into NaN and quietly produced no engraving at all.
 */
const settings = (opts = {}) => {
    const o = { ...ENGRAVE_DEFAULTS };
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) o[k] = v;
    return o;
};

/** Side of one pixel, in mm. This is the smallest feature on the part. */
export function pixelMm(opts = {}) {
    return settings(opts).capHeight / GLYPH_ROWS;
}

/** Characters this font can cut. Anything else is a hard error, not a blank. */
export function isEngravable(str) {
    return [...String(str).toUpperCase()].every(ch => GLYPHS[ch] !== undefined);
}

export function textWidthMm(str, opts = {}) {
    const n = String(str).length;
    return n ? (n * ADVANCE_PX - 1) * pixelMm(opts) : 0;
}

export function textHeightMm(opts = {}) {
    return GLYPH_ROWS * pixelMm(opts);
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

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/**
 * Lit pixels of `str` as grid cells `{ col, row }`, row 0 being the TOP. The
 * layout in units, before anything is scaled to millimetres — handy for tests
 * and for reasoning about fit without carrying a cap height around.
 */
export function textCells(str, offsetPx = 0) {
    const text = String(str).toUpperCase();
    const cells = [];
    for (let i = 0; i < text.length; i++) {
        const glyph = GLYPHS[text[i]];
        if (glyph === undefined) throw new Error(`engrave: no glyph for ${JSON.stringify(text[i])}`);
        for (let row = 0; row < GLYPH_ROWS; row++) {
            for (let col = 0; col < GLYPH_COLS; col++) {
                if (glyph[row][col] === '#') cells.push({ col: offsetPx + i * ADVANCE_PX + col, row });
            }
        }
    }
    return cells;
}

/**
 * Closed CCW rings for `str`, in mm, baseline at y = 0 and the left edge at
 * x = 0. One ring per horizontal run of lit pixels; runs abut and are fused by
 * the 2D union before extrusion.
 */
export function textRings(str, opts = {}) {
    const o = settings(opts);
    const px = pixelMm(o);
    const b = o.bleedMm;
    const lit = new Set(textCells(str).map(c => `${c.col},${c.row}`));
    const cols = String(str).length * ADVANCE_PX;
    const rings = [];
    for (let row = 0; row < GLYPH_ROWS; row++) {
        let run = -1;
        for (let col = 0; col <= cols; col++) {
            const on = lit.has(`${col},${row}`);
            if (on && run < 0) run = col;
            if (!on && run >= 0) {
                const y0 = (GLYPH_ROWS - 1 - row) * px;
                rings.push(rect(run * px - b, y0 - b, col * px + b, y0 + px + b));
                run = -1;
            }
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
    const step = (GLYPH_ROWS + o.leadingPx) * pixelMm(o);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const dy = (lines.length - 1 - i) * step;
        for (const ring of textRings(lines[i], o)) out.push(ring.map(([x, y]) => [x, y + dy]));
    }
    return out;
}

export function blockSizeMm(lines, opts = {}) {
    const o = settings(opts);
    const step = (GLYPH_ROWS + o.leadingPx) * pixelMm(o);
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
