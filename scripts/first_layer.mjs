/**
 * IS THE FIRST LAYER ONE THING?
 *
 * The bed-contact check that already existed sums the area of every downward
 * face and passes if the total is big enough. It never asks whether that area
 * is CONNECTED, and a part whose first layer is three separate crescents passes
 * it easily — the collet test article scored 122 mm2 and was three unbraced
 * 35 mm2 islands, 10.5 mm tall. Brett got spaghetti off exactly that part.
 *
 * So area is the wrong question on its own. What a slicer sees at layer 1 is a
 * set of ISLANDS, and each island has to hold its own tower down by itself.
 *
 * The slab is rasterised by ray casting rather than by chasing the section
 * outline: parity of the triangle crossings above the plane says inside or out,
 * which is robust to the coincident faces CSG leaves behind and needs no
 * polygon stitching. Then a flood fill counts the islands.
 */

/**
 * Islands in a horizontal slice of a Y-UP mesh (the app's frame, before the
 * exporter's rotation to Z-up).
 *
 * @param {ArrayLike<number>} P  flat xyz positions
 * @param {ArrayLike<number>} I  triangle indices
 * @param {number} y             height of the slice, e.g. half a layer up
 * @param {number} pitch         raster pitch in mm
 * @returns {{islands:number, areas:number[]}} areas descending, mm2
 */
export function slabIslands(P, I, y, pitch = 0.15) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
        x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]);
        z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]);
    }
    x0 -= pitch; x1 += pitch; z0 -= pitch; z1 += pitch;
    const nx = Math.ceil((x1 - x0) / pitch), nz = Math.ceil((z1 - z0) / pitch);
    const cross = new Int16Array(nx * nz);
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const cx = P[c], cy = P[c + 1], cz = P[c + 2];
        if (Math.max(ay, by, cy) <= y) continue;          // wholly below the plane
        const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        if (d === 0) continue;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / pitch));
        const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / pitch));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / pitch));
        const j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / pitch));
        for (let j = j0; j <= j1; j++) {
            const pz = z0 + (j + 0.5) * pitch;
            for (let i = i0; i <= i1; i++) {
                const px = x0 + (i + 0.5) * pitch;
                const w0 = ((px - ax) * (cz - az) - (pz - az) * (cx - ax)) / d;
                const w1 = ((bx - ax) * (pz - az) - (bz - az) * (px - ax)) / d;
                if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
                if (ay + w0 * (by - ay) + w1 * (cy - ay) > y) cross[j * nx + i]++;
            }
        }
    }
    const seen = new Uint8Array(nx * nz), areas = [];
    const stack = [];
    for (let k = 0; k < cross.length; k++) {
        if (!(cross[k] & 1) || seen[k]) continue;
        seen[k] = 1; stack.length = 0; stack.push(k); let cells = 0;
        while (stack.length) {
            const q = stack.pop(); cells++;
            const qi = q % nx, qj = (q - qi) / nx;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ni = qi + di, nj = qj + dj;
                if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
                const nk = nj * nx + ni;
                if ((cross[nk] & 1) && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
            }
        }
        areas.push(cells * pitch * pitch);
    }
    areas.sort((a, b) => b - a);
    return { islands: areas.length, areas };
}
