/**
 * Engraved part codes. The rings are pure geometry and tested here; that they
 * survive CSG and come out watertight is tests/pieces.test.js's job.
 */
import {
    GLYPHS, ADVANCE, ENGRAVE_DEFAULTS, isEngravable, textWidthMm, textHeightMm,
    textStrokes, textRings, stadiumRing, ringArea, blockRings, blockSizeMm,
    codeVersion, pieceCode, partCode
} from '../js/engrave.js';
import { layoutTrack, SPEC, GEOMETRY_VERSION, STANDARD } from '../js/track.js';

describe('the stroke font', () => {
    test('covers everything the codes are written in', () => {
        const alphabet = ['STR', 'CURVEL', 'CURVER', 'LIFT', 'ELEV', 'PWR', 'SWITCH', 'PLAT',
            'GATE', 'KEY', 'FOOT', 'R15', 'R30', 'R60', 'R120', 'IN', 'OUT', 'MID', '0123456789.'];
        for (const word of alphabet) expect(isEngravable(word)).toBe(true);
        expect(isEngravable('caret^')).toBe(false);
    });

    test('every glyph stays inside its advance box and its cap height', () => {
        for (const [ch, lines] of Object.entries(GLYPHS)) {
            for (const line of lines) {
                expect(line.length).toBeGreaterThanOrEqual(1);
                for (const [x, y] of line) {
                    expect(`${ch} x=${x}`).toBe(`${ch} x=${Math.min(ADVANCE, Math.max(0, x))}`);
                    expect(`${ch} y=${y}`).toBe(`${ch} y=${Math.min(1, Math.max(0, y))}`);
                }
            }
        }
    });

    test('an unknown character is an error, not a silent blank', () => {
        expect(() => textStrokes('a^b')).toThrow(/no glyph/);
    });

    test('strokes are laid out left to right on the baseline', () => {
        const one = textStrokes('I');
        const two = textStrokes('II');
        expect(two.length).toBe(2 * one.length);
        const leftOf = (lines) => Math.min(...lines.flat().map(p => p[0]));
        expect(leftOf(two.slice(0, one.length))).toBeLessThan(leftOf(two.slice(one.length)));
        // baseline: the lowest ink sits half a stroke above y = 0
        const low = Math.min(...one.flat().map(p => p[1]));
        expect(low).toBeCloseTo(ENGRAVE_DEFAULTS.strokeMm / 2, 6);
    });
});

describe('stroke outlines', () => {
    test('a stadium is closed, CCW and the width it was asked for', () => {
        const ring = stadiumRing([0, 0], [10, 0], 0.8);
        expect(ring.length).toBeGreaterThan(8);
        expect(ringArea(ring)).toBeGreaterThan(0);
        const ys = ring.map(p => p[1]);
        expect(Math.max(...ys)).toBeCloseTo(0.4, 6);
        expect(Math.min(...ys)).toBeCloseTo(-0.4, 6);
        // caps bulge PAST the ends rather than folding back over the stroke —
        // fold them inward and the polygon self-intersects and the glyph
        // vanishes in the 2D union
        const xs = ring.map(p => p[0]);
        expect(Math.max(...xs)).toBeCloseTo(10.4, 6);
        expect(Math.min(...xs)).toBeCloseTo(-0.4, 6);
    });

    test('a zero-length stroke is a disc, so a full stop is round', () => {
        const ring = stadiumRing([1, 1], [1, 1], 0.8);
        expect(ringArea(ring)).toBeGreaterThan(0);
        for (const [x, y] of ring) expect(Math.hypot(x - 1, y - 1)).toBeCloseTo(0.4, 6);
    });

    test('no stroke is ever thinner than minStroke', () => {
        // the whole reason for a stroke font: a slicer does not thin a stem
        // below two extrusion widths, it drops it
        for (const ring of textRings('CURVEL 1.1')) {
            expect(ringArea(ring)).toBeGreaterThan(0);
            const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
            const thin = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
            expect(thin).toBeGreaterThanOrEqual(ENGRAVE_DEFAULTS.strokeMm - 1e-9);
        }
    });

    test('rings cover the size the layout claims', () => {
        const opts = { capHeight: 4, tracking: 0.6, strokeMm: 0.8 };
        const rings = textRings('R120 1.1', opts);
        const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
        // ink never leaves the box the layout reserved (it can fall short of
        // it: '1' and '.' do not fill their advance, which is what makes them
        // read as narrow letters rather than as gaps)
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1e-9);
        expect(Math.max(...xs)).toBeLessThanOrEqual(textWidthMm('R120 1.1', opts) + 1e-9);
        expect(Math.max(...xs)).toBeGreaterThan(textWidthMm('R120 1.1', opts) - 1);
        expect(Math.max(...ys)).toBeLessThanOrEqual(textHeightMm(opts) + 1e-9);
    });

    test('a block stacks its first line on top', () => {
        const lines = ['R120', '1.1'];
        const size = blockSizeMm(lines, { capHeight: 2 });
        const rings = blockRings(lines, { capHeight: 2 });
        expect(size.widthMm).toBeCloseTo(textWidthMm('R120', { capHeight: 2 }), 6);
        expect(size.heightMm).toBeGreaterThan(textHeightMm({ capHeight: 2 }));
        const ys = rings.flat().map(p => p[1]);
        expect(Math.max(...ys)).toBeCloseTo(size.heightMm, 6);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-9);
    });
});

describe('what the code says', () => {
    test('it is a compatibility claim, so PATCH is not in it', () => {
        expect(codeVersion('1.1.0')).toBe('1.1');
        expect(codeVersion('1.1.7')).toBe('1.1');
        expect(codeVersion('2.0.0')).toBe('2.0');
        // ...and a real bump does change every part's marking
        expect(partCode('KEY', '1.1.0')).not.toBe(partCode('KEY', '2.0.0'));
    });

    test('it derives from GEOMETRY_VERSION, never from a literal', () => {
        const { pieces } = layoutTrack(['straight', 'curveL', 'straight']);
        for (const pc of pieces) {
            expect(pieceCode(pc, GEOMETRY_VERSION).endsWith(codeVersion(GEOMETRY_VERSION))).toBe(true);
            expect(isEngravable(pieceCode(pc, GEOMETRY_VERSION))).toBe(true);
        }
    });

    test('two solids that differ never wear the same mark', () => {
        const { pieces } = layoutTrack(['curveL', 'straight', 'curveL', 'straight', 'straight']);
        const straights = pieces.filter(pc => pc.type === 'straight');
        const codes = straights.map(pc => pieceCode(pc, GEOMETRY_VERSION));
        // a straight between two curves, one leaving a curve, one plain
        expect(new Set(codes).size).toBeGreaterThan(1);
        expect(codes).toContain(`STR MID ${codeVersion(GEOMETRY_VERSION)}`);
        expect(codes).toContain(`STR OUT ${codeVersion(GEOMETRY_VERSION)}`);
        // ...while every curve is one part and takes the plain code
        for (const pc of pieces.filter(p => p.radius)) {
            expect(pieceCode(pc, GEOMETRY_VERSION)).toBe(`CURVEL ${codeVersion(GEOMETRY_VERSION)}`);
        }
    });

    test('a code fits the surface it is cut into', () => {
        const font = { capHeight: SPEC.engrave.capHeight, tracking: SPEC.engrave.tracking, strokeMm: SPEC.engrave.minStroke };
        const { pieces } = layoutTrack(['curveL', 'straight', 'curveL']);
        for (const pc of pieces) {
            const w = textWidthMm(pieceCode(pc, GEOMETRY_VERSION), font);
            expect(w + 2 * SPEC.engrave.marginMm).toBeLessThanOrEqual(pc.planLen);
        }
        expect(textHeightMm(font) + 2).toBeLessThanOrEqual(SPEC.railHeight);
        // the two-line form used on hex flats fits an across-flats-15 face
        for (const r of STANDARD.riserSizes) {
            const size = blockSizeMm(partCode(`R${r}`, GEOMETRY_VERSION).split(' '), { capHeight: 2, ...font, capHeight: 2 });
            expect(size.widthMm).toBeLessThan(15 / Math.sqrt(3) - 1);
            expect(size.heightMm).toBeLessThan(r - 1);
        }
    });

    test('engrave depth never eats more than a third of the wall', () => {
        expect(SPEC.engrave.depth).toBeLessThanOrEqual(SPEC.wall / 3);
        expect(SPEC.engrave.minStroke).toBeGreaterThanOrEqual(0.8);  // two line widths
    });
});
