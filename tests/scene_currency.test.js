/**
 * A STOCK SCENE CANNOT SHIP AGAINST OLD GEOMETRY.
 *
 * The scenes in `scenes/` are not saved models — they are DESIGNS: a sequence
 * of track nodes that `layoutTrack` re-lays every time one is opened. Nothing
 * geometric is stored in them and nothing needs to be. But each one carries a
 * `geometry` stamp, and the app compares that stamp against GEOMETRY_VERSION
 * and warns that "parts printed from the old file will not mate" — so a stamp
 * left behind makes every shipped example open with a warning about itself.
 *
 * That is what happened: eleven scenes sat at 1.0.0 against a canonical 2.0.0
 * for a whole major version. Fixing them once fixes nothing, because the next
 * geometry change puts them right back. So the currency is asserted here:
 * change GEOMETRY_VERSION and this fails until the scenes are re-stamped.
 *
 * The parameters are checked for the same reason. A stock scene must be built
 * on the Standard — if it pins its own slope or radius and the Standard moves,
 * it silently becomes a fork of the part library rather than an example of it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { GEOMETRY_VERSION, STANDARD, isStandardParams, layoutTrack } from '../js/track.js';

const DIR = new URL('../scenes/', import.meta.url);
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

describe('stock scenes are current by construction', () => {
    test('there are scenes to check', () => {
        expect(files.length).toBeGreaterThan(5);
    });

    test.each(files)('%s is stamped with the canonical geometry', (f) => {
        const s = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
        expect(`${f} geometry ${s.geometry ?? '(none)'}`)
            .toBe(`${f} geometry ${GEOMETRY_VERSION}`);
    });

    test.each(files)('%s pins no parameters, so it inherits the Standard', (f) => {
        const s = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
        // They used to pin slopeDeg: 11.2167 against a Standard of
        // 11.2180829542503 — inside isStandardParams' tolerance, so nothing
        // complained, but a rounded fork of the library all the same. A stock
        // scene carries no parameters at all now: it IS the Standard, and a
        // change to STANDARD reaches it without anyone editing a file.
        const pinned = Object.keys(s.params ?? {});
        expect(`${f} pins ${pinned.join(',') || 'nothing'}`).toBe(`${f} pins nothing`);
        expect(isStandardParams(s.params ?? {})).toBe(true);
    });

    test.each(files)('%s is a sequence of track nodes, carrying no geometry', (f) => {
        const s = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
        expect(Array.isArray(s.sequence)).toBe(true);
        expect(s.sequence.length).toBeGreaterThan(0);
        // it must lay out from the sequence alone
        const { pieces } = layoutTrack(s.sequence, s.params ?? {});
        expect(pieces.length).toBeGreaterThan(s.sequence.length - 1);
    });
});
