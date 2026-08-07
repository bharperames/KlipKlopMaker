/**
 * Engraved part codes. The rings are pure geometry and tested here; that they
 * survive CSG and come out watertight is tests/pieces.test.js's job.
 */
import {
    GLYPHS, ADVANCE, ENGRAVE_DEFAULTS, minFeatureMm, isEngravable,
    textWidthMm, textHeightMm, textStrokes, textRings, stadiumRing, ringArea,
    blockRings, blockSizeMm, codeVersion, pieceCode, partCode
} from '../js/engrave.js';
import { layoutTrack, SPEC, GEOMETRY_VERSION, STANDARD } from '../js/track.js';

const FONT = { capHeight: SPEC.engrave.capHeight, strokeMm: SPEC.engrave.minFeature };
const HEX_FONT = { capHeight: 2.4, strokeMm: SPEC.engrave.minFeature };

describe('the stroke font', () => {
    test('covers everything the codes are written in', () => {
        const alphabet = ['STR', 'CURVEL', 'CURVER', 'LIFT', 'ELEV', 'PWR', 'SWITCH', 'PLAT',
            'GATE', 'KEY', 'FOOT', 'R15', 'R30', 'R60', 'R120', 'IN', 'OUT', 'MID', '0123456789.'];
        for (const word of alphabet) expect(isEngravable(word)).toBe(true);
        expect(isEngravable('caret^')).toBe(false);
    });

    test('every glyph sits in its box, round ones overshooting only a little', () => {
        // Round letters bulge past the nominal box on purpose — a spline through
        // points on a curve does, and so does every real typeface. The layout
        // measures the true extent, so the only thing to police is that the
        // overshoot stays optical rather than becoming a layout problem.
        const SLOP = 0.04;
        for (const [ch, lines] of Object.entries(GLYPHS)) {
            for (const line of lines) {
                expect(line.length).toBeGreaterThanOrEqual(1);
                for (const [x, y] of line) {
                    expect(`${ch} x=${x >= -SLOP && x <= ADVANCE + SLOP}`).toBe(`${ch} x=true`);
                    expect(`${ch} y=${y >= -SLOP && y <= 1 + SLOP}`).toBe(`${ch} y=true`);
                }
            }
        }
    });

    test('the round letters are actually round, not chords', () => {
        // the whole reason for the spline: an 'O' drawn from its eight skeleton
        // points is a visible octagon, and this is what says it is not one
        const turn = (pts) => {
            let worst = 0;
            for (let i = 1; i + 1 < pts.length; i++) {
                const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
                const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
                let d = Math.abs(b - a);
                if (d > Math.PI) d = 2 * Math.PI - d;
                worst = Math.max(worst, d);
            }
            return worst * 180 / Math.PI;
        };
        for (const ch of ['O', 'C', 'S', 'G', 'U', 'D', '0', '8', 'B', 'P', 'R', 'J']) {
            const bowl = GLYPHS[ch].reduce((a, b) => (b.length > a.length ? b : a));
            expect(`${ch} kink ${turn(bowl) < 22}`).toBe(`${ch} kink true`);
            expect(bowl.length).toBeGreaterThan(20);            // sampled, not sparse
        }
        // ...while the straight ones stay sparse and crisp
        for (const ch of ['E', 'H', 'T', 'X', 'Z', '4', '7']) {
            expect(GLYPHS[ch].flat().length).toBeLessThan(8);
        }
    });

    test('an unknown character is an error, not a silent blank', () => {
        expect(() => textStrokes('a^b')).toThrow(/no glyph/);
    });

    test('strokes are laid out left to right on the baseline', () => {
        const one = textStrokes('I', FONT);
        const two = textStrokes('II', FONT);
        expect(two.length).toBe(2 * one.length);
        const leftOf = (lines) => Math.min(...lines.flat().map(p => p[0]));
        expect(leftOf(two.slice(0, one.length))).toBeLessThan(leftOf(two.slice(one.length)));
        // the whole set is placed so the lowest ink IN THE FONT sits half a
        // stroke above y = 0 — one shared baseline, not a per-string one, or
        // two codes would sit at different heights on the same part
        const every = Object.keys(GLYPHS).join('');
        expect(Math.min(...textStrokes(every, FONT).flat().map(p => p[1])))
            .toBeCloseTo(FONT.strokeMm / 2, 6);
    });
});

describe('stroke outlines', () => {
    test('a stadium is closed, CCW and the width it was asked for', () => {
        const ring = stadiumRing([0, 0], [10, 0], 0.5);
        expect(ring.length).toBeGreaterThan(8);
        expect(ringArea(ring)).toBeGreaterThan(0);
        const ys = ring.map(p => p[1]);
        expect(Math.max(...ys)).toBeCloseTo(0.25, 6);
        expect(Math.min(...ys)).toBeCloseTo(-0.25, 6);
        // caps bulge PAST the ends rather than folding back over the stroke —
        // fold them inward and the polygon self-intersects and the glyph
        // vanishes in the 2D union
        const xs = ring.map(p => p[0]);
        expect(Math.max(...xs)).toBeCloseTo(10.25, 6);
        expect(Math.min(...xs)).toBeCloseTo(-0.25, 6);
    });

    test('a zero-length stroke is a disc, so a full stop is round', () => {
        const ring = stadiumRing([1, 1], [1, 1], 0.5);
        expect(ringArea(ring)).toBeGreaterThan(0);
        for (const [x, y] of ring) expect(Math.hypot(x - 1, y - 1)).toBeCloseTo(0.25, 6);
    });

    test('no part of a letter is ever thinner than the pen', () => {
        // the whole reason for a stroke font: a slicer does not shrink a
        // feature below one extrusion width, it drops it
        for (const ring of textRings('CURVEL 1.1', FONT)) {
            expect(ringArea(ring)).toBeGreaterThan(0);
            const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
            const thin = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
            expect(thin).toBeGreaterThanOrEqual(minFeatureMm(FONT) - 1e-9);
        }
    });

    test('ink stays inside the box the layout reserved', () => {
        const rings = textRings('R120 1.1', FONT);
        const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
        expect(Math.min(...xs)).toBeGreaterThan(-1e-6);
        expect(Math.max(...xs)).toBeLessThanOrEqual(textWidthMm('R120 1.1', FONT) + 1e-6);
        expect(Math.max(...ys)).toBeLessThanOrEqual(textHeightMm(FONT) + 1e-6);
    });

    test('a block stacks its first line on top', () => {
        const lines = ['R120', '1.1'];
        const size = blockSizeMm(lines, HEX_FONT);
        expect(size.widthMm).toBeCloseTo(textWidthMm('R120', HEX_FONT), 6);
        expect(size.heightMm).toBeGreaterThan(1.9 * textHeightMm(HEX_FONT));
        // a string only reaches the font's full height if it contains a glyph
        // that does, so the block is what is RESERVED, never less than the ink
        const ys = blockRings(lines, HEX_FONT).flat().map(p => p[1]);
        expect(Math.max(...ys)).toBeLessThanOrEqual(size.heightMm + 1e-9);
        expect(Math.max(...ys)).toBeGreaterThan(size.heightMm - HEX_FONT.strokeMm);
        expect(Math.min(...ys)).toBeGreaterThan(-1e-6);
    });
});

describe('what the code says', () => {
    test('it is a compatibility claim, so PATCH is not in it', () => {
        expect(codeVersion('1.1.0')).toBe('1.1');
        expect(codeVersion('1.1.7')).toBe('1.1');
        expect(codeVersion('2.0.0')).toBe('2.0');
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
        const codes = pieces.filter(pc => pc.type === 'straight').map(pc => pieceCode(pc, GEOMETRY_VERSION));
        expect(new Set(codes).size).toBeGreaterThan(1);
        expect(codes).toContain(`STR MID ${codeVersion(GEOMETRY_VERSION)}`);
        expect(codes).toContain(`STR OUT ${codeVersion(GEOMETRY_VERSION)}`);
        // ...while every curve is one part and takes the plain code
        for (const pc of pieces.filter(p => p.radius)) {
            expect(pieceCode(pc, GEOMETRY_VERSION)).toBe(`LEFT CURVE ${codeVersion(GEOMETRY_VERSION)}`);
        }
    });

    test('every code that can occur fits the surface it is cut into', () => {
        // the longest a track code can get. A curve spells itself out, so it
        // is the long one now — and a curve tile is 225 mm, which is why it can
        // afford to; the check is against the SHORTEST tile all the same.
        const longest = `RIGHT CURVE ${codeVersion(GEOMETRY_VERSION)}`;
        expect(textWidthMm(longest, FONT) + 2 * SPEC.engrave.marginMm)
            .toBeLessThanOrEqual(SPEC.platformLen);
        // the band is the rail, less the floor fillet below and the crest above
        expect(textHeightMm(FONT) + SPEC.filletR + 1).toBeLessThanOrEqual(SPEC.railHeight);

        // a hex flat takes the WHOLE code, both lines, turned on its side: the
        // block's width runs up the part, its height across the face
        const faceWidth = 15 / Math.sqrt(3);
        for (const r of STANDARD.riserSizes) {
            const block = blockSizeMm(partCode(`R${r}`, GEOMETRY_VERSION).split(' '), HEX_FONT);
            expect(block.widthMm).toBeLessThanOrEqual(r - 2);
            expect(block.heightMm).toBeLessThanOrEqual(faceWidth - 1);
        }
        // ...which is why the hex cap height is smaller than the track one: at
        // the full 3.5 mm a two-line block is taller than the face is wide
        expect(blockSizeMm(['R120', '1.1'], FONT).heightMm).toBeGreaterThan(faceWidth);

        // the foot's shaft is 11 mm and its block is wider than that, so its
        // code goes on the base, where an across-flats-24.8 disc has room
        const foot = blockSizeMm(partCode('FOOT', GEOMETRY_VERSION).split(' '), FONT);
        expect(foot.widthMm).toBeGreaterThan(STANDARD.footHeight - 4 - 2);
        expect(Math.hypot(foot.widthMm, foot.heightMm) / 2).toBeLessThan(24.8 / 2 - 1);
    });

    test('the pen and the depth stay inside what the wall can give', () => {
        expect(SPEC.engrave.depth).toBeLessThanOrEqual(SPEC.wall / 3);
        expect(SPEC.engrave.minFeature).toBeGreaterThanOrEqual(0.4);  // one nozzle width
        expect(minFeatureMm(FONT)).toBe(SPEC.engrave.minFeature);
    });
});
