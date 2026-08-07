/**
 * Engraved part codes. The rings are pure geometry and tested here; that they
 * survive CSG and come out watertight is tests/pieces.test.js's job.
 */
import {
    GLYPHS, GLYPH_COLS, GLYPH_ROWS, ADVANCE_PX, ENGRAVE_DEFAULTS, pixelMm,
    isEngravable, textWidthMm, textHeightMm, textCells, textRings, ringArea,
    blockRings, blockSizeMm, codeVersion, pieceCode, partCode
} from '../js/engrave.js';
import { layoutTrack, SPEC, GEOMETRY_VERSION, STANDARD } from '../js/track.js';

describe('the pixel font', () => {
    test('covers everything the codes are written in', () => {
        const alphabet = ['STR', 'CURVEL', 'CURVER', 'LIFT', 'ELEV', 'PWR', 'SWITCH', 'PLAT',
            'GATE', 'KEY', 'FOOT', 'R15', 'R30', 'R60', 'R120', 'IN', 'OUT', 'MID', '0123456789.'];
        for (const word of alphabet) expect(isEngravable(word)).toBe(true);
        expect(isEngravable('caret^')).toBe(false);
    });

    test('every glyph is exactly the matrix, and no glyph is blank by accident', () => {
        for (const [ch, rows] of Object.entries(GLYPHS)) {
            expect(`${ch}: ${rows.length} rows`).toBe(`${ch}: ${GLYPH_ROWS} rows`);
            for (const row of rows) {
                expect(row.length).toBe(GLYPH_COLS);
                expect(/^[#.]+$/.test(row)).toBe(true);
            }
            if (ch !== ' ') expect(rows.join('')).toContain('#');
        }
    });

    test('no two glyphs share a bitmap — H/M/N/W are the ones at risk', () => {
        const seen = new Map();
        for (const [ch, rows] of Object.entries(GLYPHS)) {
            if (ch === ' ') continue;
            const key = rows.join('/');
            expect(`${ch} vs ${seen.get(key) ?? '-'}`).toBe(`${ch} vs -`);
            seen.set(key, ch);
        }
    });

    test('an unknown character is an error, not a silent blank', () => {
        expect(() => textCells('A^B')).toThrow(/no glyph/);
    });

    test('one pixel is the smallest feature, and cap height sets it', () => {
        // the whole reason for a pixel font: nothing on the part is ever
        // narrower than a pixel, in any direction, by construction
        expect(pixelMm({ capHeight: 3.5 })).toBeCloseTo(0.5, 9);
        expect(pixelMm(SPEC.engrave)).toBeGreaterThanOrEqual(SPEC.engrave.minFeature);
    });

    test('cells are laid out left to right with a one-pixel gap', () => {
        // 'M' is the glyph that fills its cell edge to edge
        const cols = [...new Set(textCells('MM').map(c => c.col))].sort((a, b) => a - b);
        expect(Math.min(...cols)).toBe(0);
        expect(Math.max(...cols)).toBe(ADVANCE_PX + GLYPH_COLS - 1);
        expect(cols).not.toContain(GLYPH_COLS);      // the gap column is never lit
    });
});

describe('rings', () => {
    test('one rectangle per horizontal run, closed and CCW', () => {
        for (const ring of textRings('CURVEL 1.1')) {
            expect(ring.length).toBe(4);
            expect(ringArea(ring)).toBeGreaterThan(0);
        }
    });

    test('no ring is ever thinner than a pixel', () => {
        const px = pixelMm();
        for (const ring of textRings('SWITCH MID 1.1')) {
            const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
            const thin = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
            expect(thin).toBeGreaterThanOrEqual(px - 1e-6);
        }
    });

    test('runs are merged, so a solid row is one ring and not five', () => {
        // 'I' is a serif top, a stem and a serif foot: one run per row, so
        // seven rings for the eleven lit pixels
        expect(textRings('I').length).toBe(GLYPH_ROWS);
        expect(textCells('I').length).toBe(3 + 1 + 1 + 1 + 1 + 1 + 3);
    });

    test('ink fills exactly the box the layout reserved', () => {
        const opts = { capHeight: 3.5 };
        const rings = textRings('R120 1.1', opts);
        const xs = rings.flat().map(p => p[0]), ys = rings.flat().map(p => p[1]);
        const bleed = ENGRAVE_DEFAULTS.bleedMm;
        expect(Math.min(...xs)).toBeCloseTo(-bleed, 6);
        expect(Math.max(...xs)).toBeLessThanOrEqual(textWidthMm('R120 1.1', opts) + bleed + 1e-9);
        expect(Math.min(...ys)).toBeCloseTo(-bleed, 6);
        expect(Math.max(...ys)).toBeCloseTo(textHeightMm(opts) + bleed, 6);
    });

    test('a block stacks its first line on top, with a blank row between', () => {
        const lines = ['R120', '1.1'];
        const size = blockSizeMm(lines, { capHeight: 3.5 });
        expect(size.widthMm).toBeCloseTo(textWidthMm('R120', { capHeight: 3.5 }), 6);
        expect(size.heightMm).toBeCloseTo((2 * GLYPH_ROWS + 1) * pixelMm({ capHeight: 3.5 }), 6);
        const ys = blockRings(lines, { capHeight: 3.5 }).flat().map(p => p[1]);
        expect(Math.max(...ys)).toBeCloseTo(size.heightMm + ENGRAVE_DEFAULTS.bleedMm, 6);
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
            expect(pieceCode(pc, GEOMETRY_VERSION)).toBe(`CURVEL ${codeVersion(GEOMETRY_VERSION)}`);
        }
    });

    test('every code that can occur fits the surface it is cut into', () => {
        const font = { capHeight: SPEC.engrave.capHeight };
        // the longest a track code can get: a flared switch or lift
        const longest = `SWITCH MID ${codeVersion(GEOMETRY_VERSION)}`;
        expect(textWidthMm(longest, font) + 2 * SPEC.engrave.marginMm)
            .toBeLessThanOrEqual(SPEC.platformLen);
        // the band under the deck runs from the boss's edge out to the skirt
        expect(textHeightMm(font))
            .toBeLessThanOrEqual(STANDARD.innerWidth / 2 - SPEC.socket.bossR - 2);

        // a hex flat takes the WHOLE code, both lines, turned on its side:
        // the block's width runs up the part, its height across the face
        const faceWidth = 15 / Math.sqrt(3);
        for (const r of STANDARD.riserSizes) {
            const block = blockSizeMm(partCode(`R${r}`, GEOMETRY_VERSION).split(' '), font);
            expect(block.widthMm).toBeLessThanOrEqual(r - 2);
            expect(block.heightMm).toBeLessThanOrEqual(faceWidth - 1);
        }
        // the foot's shaft is 11 mm and its block needs 11.5 — which is why
        // its code is on the base, where an across-flats-24.8 disc has room
        const foot = blockSizeMm(partCode('FOOT', GEOMETRY_VERSION).split(' '), font);
        expect(foot.widthMm).toBeGreaterThan(STANDARD.footHeight - 4 - 2);
        expect(Math.hypot(foot.widthMm, foot.heightMm) / 2).toBeLessThan(24.8 / 2 - 1);
    });

    test('engrave depth never eats more than a third of the wall', () => {
        expect(SPEC.engrave.depth).toBeLessThanOrEqual(SPEC.wall / 3);
        expect(SPEC.engrave.minFeature).toBeGreaterThanOrEqual(0.4);  // one nozzle width
    });
});
