import { EXPORT_SETS, PART_KINDS, applyExportSet, getExportSet, describeExportSet } from '../js/export_sets.js';

/** A stand-in for what assembleParts produces. */
const INVENTORY = [
    { name: '01_straight', kind: 'track', count: 4 },
    { name: '02_curveL', kind: 'track', count: 3 },
    { name: 'switch_03', kind: 'track', count: 1 },
    { name: 'gate_paddle', kind: 'gate', count: 1 },
    { name: 'bowtie_key', kind: 'key', count: 12 },
    { name: 'support_foot', kind: 'support', count: 5 },
    { name: 'support_riser_60mm', kind: 'support', count: 3 },
    { name: 'scenery_tower', kind: 'scenery', count: 2 }
];

describe('export sets', () => {
    test('every set has a distinct id, a label and a hint', () => {
        expect(new Set(EXPORT_SETS.map(s => s.id)).size).toBe(EXPORT_SETS.length);
        for (const s of EXPORT_SETS) {
            expect(typeof s.label).toBe('string');
            expect(s.label.length).toBeGreaterThan(0);
            expect(s.hint.length).toBeGreaterThan(20);
        }
    });

    test('an unknown id falls back to the full set rather than exporting nothing', () => {
        expect(getExportSet('nonsense').id).toBe('all');
        expect(applyExportSet('nonsense', INVENTORY).parts).toHaveLength(INVENTORY.length);
    });

    test('"everything" is the inventory untouched', () => {
        const { parts } = applyExportSet('all', INVENTORY);
        expect(parts).toEqual(INVENTORY);
    });

    test('a sample run is one of each, with spare keys', () => {
        const { parts } = applyExportSet('sample', INVENTORY);
        expect(parts).toHaveLength(INVENTORY.length);
        for (const p of parts) {
            expect(`${p.name}:${p.count}`).toBe(`${p.name}:${p.kind === 'key' ? 4 : 1}`);
        }
    });

    test('a sample run never asks for more of a part than the design needs', () => {
        const scarce = [{ name: 'bowtie_key', kind: 'key', count: 2 }];
        expect(applyExportSet('sample', scarce).parts[0].count).toBe(2);
    });

    test('filtered sets keep only their kinds and drop the rest', () => {
        const cases = {
            track: ['track', 'gate', 'key'],
            supports: ['support'],
            keys: ['key'],
            scenery: ['scenery']
        };
        for (const [id, kinds] of Object.entries(cases)) {
            const { parts, dropped } = applyExportSet(id, INVENTORY);
            expect(parts.length).toBeGreaterThan(0);
            for (const p of parts) expect(`${id}/${p.kind}`).toBe(`${id}/${kinds.find(k => k === p.kind)}`);
            expect(dropped).toBe(INVENTORY.length - parts.length);
        }
    });

    test('sets never invent parts and never mutate the inventory', () => {
        const snapshot = JSON.stringify(INVENTORY);
        for (const s of EXPORT_SETS) {
            const { parts } = applyExportSet(s.id, INVENTORY);
            for (const p of parts) {
                expect(INVENTORY.some(q => q.name === p.name)).toBe(true);
            }
        }
        expect(JSON.stringify(INVENTORY)).toBe(snapshot);
    });

    test('a set that matches nothing yields no parts rather than throwing', () => {
        const onlyTrack = [{ name: '01_straight', kind: 'track', count: 1 }];
        expect(applyExportSet('scenery', onlyTrack).parts).toHaveLength(0);
    });

    test('every kind a set filters on is a declared kind', () => {
        for (const p of INVENTORY) expect(PART_KINDS).toContain(p.kind);
        // each declared kind must survive at least one set, or it can never ship
        for (const kind of PART_KINDS) {
            const reachable = EXPORT_SETS.some(s =>
                applyExportSet(s.id, INVENTORY).parts.some(p => p.kind === kind));
            expect(`${kind} reachable: ${reachable}`).toBe(`${kind} reachable: true`);
        }
    });

    test('the description names the set and counts the pieces', () => {
        const text = describeExportSet('supports', INVENTORY);
        expect(text).toContain('Supports only');
        expect(text).toContain('2 distinct parts');
        expect(text).toContain('8 pieces');
    });
});

/**
 * A plate exported as STL and the same plate exported as 3MF must put the parts
 * in the same places. They take different routes there — 3MF carries a
 * transform per build item, applied AFTER the exporter's X=x, Y=−z, Z=y
 * rotation, while STL bakes the placement into one merged mesh — and the
 * obvious app-space version of the merge mirrors the whole plate in Y. It still
 * fits the bed, so it prints; it just is not the layout the preview drew.
 */
import { placeForPlate } from '../js/export_3mf.js';

describe('plate placement is the same in both formats', () => {
    // one triangle, off-origin and asymmetric, so a mirror cannot hide
    const app = new Float32Array([10, 0, 4, 30, 0, 4, 10, 0, 9]);
    /** What 3MF does: convert to printer space, then apply the item transform. */
    const viaTransform = (rotDeg, x, y) => {
        const th = (rotDeg ?? 0) * Math.PI / 180;
        const c = Math.cos(th), s = Math.sin(th);
        const out = [];
        for (let i = 0; i < app.length; i += 3) {
            const X0 = app[i], Y0 = -app[i + 2];          // exporter's rotation
            out.push(c * X0 - s * Y0 + x, s * X0 + c * Y0 + y);   // row-vector form
        }
        return out;
    };
    /** What the STL writer does: place in app space, then convert. */
    const viaMerge = (rotDeg, x, y) => {
        const placed = placeForPlate(app, rotDeg, x, y);
        const out = [];
        for (let i = 0; i < placed.length; i += 3) out.push(placed[i], -placed[i + 2]);
        return out;
    };

    test.each([[0, 0, 0], [0, 40, -25], [90, 0, 0], [90, -60, 15], [180, 12, 12], [270, 5, -70]])(
        'rot %i° at (%i, %i)', (rot, x, y) => {
            const a = viaTransform(rot, x, y), b = viaMerge(rot, x, y);
            for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 6);
        });

    test('an app-space placement would mirror the plate — the trap this guards', () => {
        const naive = [];
        const th = Math.PI / 2, c = Math.cos(th), s = Math.sin(th);
        for (let i = 0; i < app.length; i += 3) {
            const px = c * app[i] - s * app[i + 2] + 40;
            const pz = s * app[i] + c * app[i + 2] + 25;
            naive.push(px, -pz);
        }
        const right = viaTransform(90, 40, 25);
        expect(naive.some((v, i) => Math.abs(v - right[i]) > 1)).toBe(true);
    });
});
