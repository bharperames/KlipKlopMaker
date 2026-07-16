/**
 * export_3mf.js
 * Generates the core `3dmodel.model` XML for a 3MF container.
 * Proven pipeline carried over from the sphere-stand-generator project.
 */

import { deduplicateGeometry } from './mesh_utils.js';

/**
 * Validates, deduplicates, and generates the `model.model` XML string for 3MF.
 * @param {Float32Array|Array} positions - Flat [x,y,z,...] vertex coordinates (Y-up, mm).
 * @param {Uint16Array|Uint32Array|Array} indices - Triangle index buffer.
 * @param {string} exportUnit
 * @returns {string} XML string.
 */
export function generate3MFXML(positions, indices, exportUnit = 'millimeter') {
    if (!positions || !indices || positions.length === 0 || indices.length === 0) {
        throw new Error('Invalid geometry arrays provided for 3MF export.');
    }

    const { uniqueVertices, indexRemap } = deduplicateGeometry(positions, indices);

    let v = '';
    for (let i = 0; i < uniqueVertices.length; i++) {
        // 3MF expects Z-up right-handed; Three.js is Y-up right-handed.
        // Apply +90° rotation about X: X=x, Y=-z, Z=y (preserves CCW winding).
        const px = uniqueVertices[i].x;
        const py = uniqueVertices[i].z === 0 ? 0 : -uniqueVertices[i].z;
        const pz = uniqueVertices[i].y;
        v += `<vertex x="${px.toFixed(6)}" y="${py.toFixed(6)}" z="${pz.toFixed(6)}" />`;
    }

    let t = '';
    for (let i = 0; i < indices.length; i += 3) {
        const map1 = indexRemap[indices[i]];
        const map2 = indexRemap[indices[i + 1]];
        const map3 = indexRemap[indices[i + 2]];
        // 3MF spec §4.1.4: degenerate (collapsed) triangles must be omitted.
        if (map1 === map2 || map2 === map3 || map1 === map3) continue;
        t += `<triangle v1="${map1}" v2="${map2}" v3="${map3}" />`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?><model unit="${exportUnit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object></resources><build><item objectid="1" /></build></model>`;
}

/**
 * Binary STL writer. Applies the same +90° X rotation as the 3MF path
 * (X=x, Y=-z, Z=y) — a proper rotation, NOT an axis swap, so chiral parts
 * (left vs right curves, dovetail flare) are never mirrored and the CCW
 * winding is preserved without reordering.
 * @returns {ArrayBuffer}
 */
export function generateBinarySTL(positions, indices) {
    const tf = indices.length / 3;
    const bu = new ArrayBuffer(84 + tf * 50);
    const vi = new DataView(bu);
    vi.setUint32(80, tf, true);
    let o = 84;
    for (let i = 0; i < indices.length; i += 3) {
        [0, 0, 0].forEach(n => { vi.setFloat32(o, n, true); o += 4; });
        for (let j = 0; j < 3; j++) {
            const k = indices[i + j] * 3;
            vi.setFloat32(o, positions[k], true); o += 4;
            vi.setFloat32(o, positions[k + 2] === 0 ? 0 : -positions[k + 2], true); o += 4;
            vi.setFloat32(o, positions[k + 1], true); o += 4;
        }
        vi.setUint16(o, 0, true); o += 2;
    }
    return bu;
}
