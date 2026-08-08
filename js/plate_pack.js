/**
 * plate_pack.js
 * Pure 2D bin packing for build plates — no DOM, no Three.js.
 *
 * A design exports as a set of DISTINCT parts, each needed some number of
 * times. Printing them one file per part wastes most of a 256 mm plate on a
 * 51 mm wide ramp and costs a print job per part. This lays them out into as
 * many full plates as the design needs, so the output is a handful of plate
 * files rather than a pile of single-part ones.
 *
 * Footprints only. Parts are already oriented for printing by the time they
 * get here (rim-down, deck-up) and none of them may be stacked, so the plate
 * is a rectangle-packing problem in the printer's XY.
 */

/**
 * Bambu X1 / X1C / P1S / P2S all share a 256 x 256 x 256 mm build volume.
 *
 * `margin` keeps parts off the plate edge, where first-layer adhesion is
 * least reliable and the wiper runs. `gap` is the clearance BETWEEN parts:
 * enough that their brims (if any) do not merge and that the toolhead is not
 * threading a needle, without giving away plate area.
 */
export const PLATE = {
    name: 'Bambu 256',
    width: 256,
    depth: 256,
    height: 256,
    margin: 5,
    gap: 3
};

/**
 * MaxRects with Best-Short-Side-Fit.
 *
 * The free area is kept as a list of overlapping maximal rectangles. Placing
 * a part splits every free rectangle it touches into the (up to four) maximal
 * rectangles that remain, and any rectangle wholly inside another is dropped.
 * It beats shelf packing badly on a mixed set — and this set IS mixed: 150 mm
 * ramps next to 12 mm bowtie keys — because a shelf's height is set by its
 * tallest member and every shorter one below it wastes the difference.
 */
class MaxRects {
    constructor(width, depth) {
        this.free = [{ x: 0, y: 0, w: width, d: depth }];
        this.used = [];
    }

    /** Best free rect for w x d, considering a 90 degree turn. Null if none. */
    find(w, d, allowRotate) {
        let best = null;
        for (const f of this.free) {
            for (const [pw, pd, rot] of allowRotate ? [[w, d, 0], [d, w, 90]] : [[w, d, 0]]) {
                if (pw > f.w + 1e-9 || pd > f.d + 1e-9) continue;
                // short-side leftover first, long-side as the tiebreak: it
                // leaves the squarest remainder, which is what later (smaller)
                // parts can actually use
                const short = Math.min(f.w - pw, f.d - pd);
                const long = Math.max(f.w - pw, f.d - pd);
                if (!best || short < best.short - 1e-9 ||
                    (Math.abs(short - best.short) < 1e-9 && long < best.long - 1e-9)) {
                    best = { x: f.x, y: f.y, w: pw, d: pd, rot, short, long };
                }
            }
        }
        return best;
    }

    place(r) {
        const next = [];
        for (const f of this.free) {
            if (r.x >= f.x + f.w - 1e-9 || r.x + r.w <= f.x + 1e-9 ||
                r.y >= f.y + f.d - 1e-9 || r.y + r.d <= f.y + 1e-9) {
                next.push(f);
                continue;
            }
            // the four maximal strips left around the placed rectangle
            if (r.x > f.x + 1e-9) next.push({ x: f.x, y: f.y, w: r.x - f.x, d: f.d });
            if (r.x + r.w < f.x + f.w - 1e-9)
                next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), d: f.d });
            if (r.y > f.y + 1e-9) next.push({ x: f.x, y: f.y, w: f.w, d: r.y - f.y });
            if (r.y + r.d < f.y + f.d - 1e-9)
                next.push({ x: f.x, y: r.y + r.d, w: f.w, d: f.y + f.d - (r.y + r.d) });
        }
        // drop any rectangle contained in another; without this the list grows
        // without bound and the search slows to a crawl
        this.free = next.filter((a, i) => !next.some((b, j) =>
            i !== j && a.x >= b.x - 1e-9 && a.y >= b.y - 1e-9 &&
            a.x + a.w <= b.x + b.w + 1e-9 && a.y + a.d <= b.y + b.d + 1e-9 &&
            (a.w < b.w - 1e-9 || a.d < b.d - 1e-9 || i > j)));
        this.used.push(r);
        return r;
    }
}

/**
 * Lay parts out over as many plates as they need.
 *
 * `group` KEEPS PARTS APART. An item only ever shares a plate with items
 * carrying the same group, and that is not a packing nicety — it is how you
 * get usable information back from a print. Bambu Studio raises its cantilever
 * warning on the curve pieces whatever their geometry, and on a mixed plate
 * the warning names the plate, so it says nothing about which part is at risk
 * and a failure on the curve takes eleven risers down with it. On their own
 * plate the warning is attributable and the blast radius is one part type.
 * Packing efficiency is the thing being traded away, deliberately.
 *
 * @param {Array<{name: string, w: number, d: number, h?: number, count?: number,
 *                group?: string}>} items
 *        footprints in mm, already in the printer's XY. `count` defaults to 1.
 * @param {object} [opts] - { plate, allowRotate }
 * @returns {{plates: Array<{index: number, items: Array<{name, x, y, w, d, rot, copy}>,
 *            used: number, utilisation: number}>, oversized: Array<object>}}
 *
 * Coordinates come back CENTRED on the plate origin — x and y run from
 * -width/2 to +width/2 — because that is what a 3MF build item wants when the
 * mesh has been recentred on its own footprint. A slicer that re-centres the
 * whole set on load then moves nothing.
 */
export function packPlates(items, opts = {}) {
    const plate = { ...PLATE, ...(opts.plate ?? {}) };
    const allowRotate = opts.allowRotate ?? true;
    const usableW = plate.width - 2 * plate.margin;
    const usableD = plate.depth - 2 * plate.margin;

    // one entry per physical copy, biggest first: a large part placed late
    // has nowhere to go, and the whole point of packing is that the big ones
    // dictate the layout
    const queue = [];
    const oversized = [];
    for (const it of items) {
        const w = it.w + plate.gap, d = it.d + plate.gap;
        const fits = (w <= usableW + 1e-9 && d <= usableD + 1e-9) ||
            (allowRotate && d <= usableW + 1e-9 && w <= usableD + 1e-9);
        const tallEnough = (it.h ?? 0) <= plate.height + 1e-9;
        if (!fits || !tallEnough) {
            oversized.push({ ...it, reason: !fits ? 'footprint' : 'height' });
            continue;
        }
        for (let c = 0; c < (it.count ?? 1); c++) queue.push({ ...it, w, d, copy: c + 1 });
    }
    queue.sort((a, b) =>
        (b.w * b.d) - (a.w * a.d) ||
        Math.max(b.w, b.d) - Math.max(a.w, a.d) ||
        String(a.name).localeCompare(String(b.name)));

    // Groups pack independently. Order follows first appearance in `items`, so
    // the same design always produces the same plate numbering.
    const order = [];
    const byGroup = new Map();
    for (const it of items) {
        const key = it.group ?? '';
        if (!byGroup.has(key)) { byGroup.set(key, []); order.push(key); }
    }
    for (const it of queue) byGroup.get(it.group ?? '').push(it);

    const plates = [];
    for (const key of order) {
        let remaining = byGroup.get(key) ?? [];
        while (remaining.length) {
            const bin = new MaxRects(usableW, usableD);
            const placed = [], leftover = [];
            for (const it of remaining) {
                const spot = bin.find(it.w, it.d, allowRotate);
                if (!spot) { leftover.push(it); continue; }
                bin.place(spot);
                placed.push({
                    name: it.name, copy: it.copy, rot: spot.rot,
                    // back to the part's true size, and to plate-centred coords
                    w: it.w - plate.gap, d: it.d - plate.gap,
                    x: spot.x + spot.w / 2 - usableW / 2,
                    y: spot.y + spot.d / 2 - usableD / 2
                });
            }
            if (!placed.length) break;  // nothing fits an empty plate: give up
            const used = placed.reduce((s, p) => s + p.w * p.d, 0);
            plates.push({
                index: plates.length + 1,
                group: key,
                items: placed,
                used,
                utilisation: used / (usableW * usableD)
            });
            remaining = leftover;
        }
    }
    return { plates, oversized };
}

/** Human-readable plate manifest for the export README. */
export function describePlates(plates, oversized = []) {
    const lines = [];
    for (const p of plates) {
        const tally = new Map();
        for (const it of p.items) tally.set(it.name, (tally.get(it.name) ?? 0) + 1);
        lines.push(`Plate ${p.index}${p.group ? ` (${p.group} only)` : ''} — ` +
            `${p.items.length} parts, ${(p.utilisation * 100).toFixed(0)}% of the usable area`);
        for (const [name, n] of [...tally].sort((a, b) => a[0].localeCompare(b[0]))) {
            lines.push(`    ${n} x ${name}`);
        }
    }
    for (const o of oversized) {
        lines.push(`! ${o.name} does not fit the plate (${o.reason}) — print it alone`);
    }
    return lines.join('\n');
}
