import { packPlates, describePlates, PLATE } from '../js/plate_pack.js';

/** Do any two placed footprints overlap? Gap is already excluded from w/d. */
function overlaps(plate, gap) {
    const it = plate.items;
    for (let i = 0; i < it.length; i++) {
        for (let j = i + 1; j < it.length; j++) {
            const a = box(it[i]), b = box(it[j]);
            const apart =
                a.x1 <= b.x0 + gap - 1e-6 || b.x1 <= a.x0 + gap - 1e-6 ||
                a.y1 <= b.y0 + gap - 1e-6 || b.y1 <= a.y0 + gap - 1e-6;
            if (!apart) return [it[i], it[j]];
        }
    }
    return null;
}

/** Placed footprint as an axis-aligned box, honouring the 90 degree turn. */
function box(p) {
    const w = p.rot === 90 ? p.d : p.w;
    const d = p.rot === 90 ? p.w : p.d;
    return { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - d / 2, y1: p.y + d / 2 };
}

describe('packPlates', () => {
    test('a single small part lands on one plate, centred coordinates', () => {
        const { plates, oversized } = packPlates([{ name: 'key', w: 12, d: 8 }]);
        expect(oversized).toHaveLength(0);
        expect(plates).toHaveLength(1);
        expect(plates[0].items).toHaveLength(1);
        const b = box(plates[0].items[0]);
        const half = PLATE.width / 2 - PLATE.margin;
        expect(b.x0).toBeGreaterThanOrEqual(-half - 1e-6);
        expect(b.x1).toBeLessThanOrEqual(half + 1e-6);
    });

    test('every part stays inside the usable area on every plate', () => {
        const { plates } = packPlates([
            { name: 'straight', w: 150, d: 51, count: 6 },
            { name: 'curve', w: 130, d: 130, count: 4 },
            { name: 'key', w: 12, d: 8, count: 40 },
            { name: 'pillar', w: 22, d: 22, count: 12 }
        ]);
        expect(plates.length).toBeGreaterThan(0);
        const halfW = (PLATE.width - 2 * PLATE.margin) / 2;
        const halfD = (PLATE.depth - 2 * PLATE.margin) / 2;
        for (const p of plates) {
            for (const it of p.items) {
                const b = box(it);
                expect(b.x0).toBeGreaterThanOrEqual(-halfW - 1e-6);
                expect(b.x1).toBeLessThanOrEqual(halfW + 1e-6);
                expect(b.y0).toBeGreaterThanOrEqual(-halfD - 1e-6);
                expect(b.y1).toBeLessThanOrEqual(halfD + 1e-6);
            }
        }
    });

    test('nothing ever overlaps, and the gap is respected', () => {
        const { plates } = packPlates([
            { name: 'straight', w: 150, d: 51, count: 5 },
            { name: 'switch', w: 150, d: 96, count: 2 },
            { name: 'key', w: 12, d: 8, count: 25 },
            { name: 'gate', w: 52, d: 6, count: 2 }
        ]);
        for (const p of plates) {
            const bad = overlaps(p, PLATE.gap);
            expect(bad ? `${bad[0].name}#${bad[0].copy} hits ${bad[1].name}#${bad[1].copy}` : 'clear')
                .toBe('clear');
        }
    });

    test('every requested copy is placed exactly once', () => {
        const items = [
            { name: 'straight', w: 150, d: 51, count: 7 },
            { name: 'curve', w: 130, d: 130, count: 3 },
            { name: 'key', w: 12, d: 8, count: 31 }
        ];
        const { plates } = packPlates(items);
        const tally = new Map();
        for (const p of plates) for (const it of p.items) {
            const k = `${it.name}#${it.copy}`;
            tally.set(k, (tally.get(k) ?? 0) + 1);
        }
        for (const [k, n] of tally) expect(`${k}:${n}`).toBe(`${k}:1`);
        const want = items.reduce((s, i) => s + i.count, 0);
        expect(tally.size).toBe(want);
    });

    test('a part too big for the plate is reported, not silently dropped', () => {
        const { plates, oversized } = packPlates([
            { name: 'monolith', w: 400, d: 400 },
            { name: 'tower', w: 30, d: 30, h: 900 },
            { name: 'straight', w: 150, d: 51 }
        ]);
        expect(oversized.map(o => `${o.name}:${o.reason}`).sort())
            .toEqual(['monolith:footprint', 'tower:height']);
        expect(plates.flatMap(p => p.items).map(i => i.name)).toEqual(['straight']);
    });

    test('rotation is used when it is the only way something fits', () => {
        // 240 long only fits across a 246 usable span one way round
        const { plates, oversized } = packPlates(
            [{ name: 'long', w: 40, d: 240, count: 1 }],
            { plate: { ...PLATE, width: 256, depth: 100 } }
        );
        expect(oversized).toHaveLength(0);
        expect(plates[0].items[0].rot).toBe(90);
    });

    test('turning rotation off makes an unfittable part oversized', () => {
        const { oversized } = packPlates(
            [{ name: 'long', w: 40, d: 240 }],
            { plate: { ...PLATE, width: 256, depth: 100 }, allowRotate: false }
        );
        expect(oversized).toHaveLength(1);
    });

    test('packing is deterministic — same input, same layout', () => {
        const items = [
            { name: 'a', w: 90, d: 40, count: 5 },
            { name: 'b', w: 33, d: 77, count: 6 },
            { name: 'c', w: 15, d: 15, count: 20 }
        ];
        expect(JSON.stringify(packPlates(items))).toBe(JSON.stringify(packPlates(items)));
    });

    test('packing beats one-part-per-plate by a wide margin', () => {
        const items = [{ name: 'straight', w: 150, d: 51, count: 12 }];
        const { plates } = packPlates(items);
        expect(plates.length).toBeLessThanOrEqual(3);
    });

    test('the manifest names every plate and flags what did not fit', () => {
        const { plates, oversized } = packPlates([
            { name: 'straight', w: 150, d: 51, count: 3 },
            { name: 'monolith', w: 400, d: 400 }
        ]);
        const text = describePlates(plates, oversized);
        expect(text).toContain('Plate 1');
        expect(text).toContain('3 x straight');
        expect(text).toContain('monolith');
    });
});
