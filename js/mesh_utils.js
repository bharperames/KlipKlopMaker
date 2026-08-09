/**
 * mesh_utils.js
 * Pure mesh validation and repair utilities (no DOM / Three.js dependencies).
 * Adapted from the sphere-stand-generator project's proven watertight-export pipeline.
 */

/**
 * Welds spatially identical vertices (rounded to 6 decimal places) so procedurally
 * generated or CSG-produced meshes become globally manifold for strict 3MF/STL validation.
 * @returns {{ uniqueVertices: Array<{x,y,z}>, indexRemap: number[], remappedIndices: Uint32Array }}
 */
export function deduplicateGeometry(positions, indices) {
    const uniqueVertices = [];
    const posMap = new Map();
    const indexRemap = [];
    let vCount = 0;

    const cleanCoord = (val) => {
        let r = Math.round(val * 1000000) / 1000000;
        if (r === -0) return 0;
        return r;
    };

    for (let i = 0; i < positions.length; i += 3) {
        const x = cleanCoord(positions[i]);
        const y = cleanCoord(positions[i + 1]);
        const z = cleanCoord(positions[i + 2]);
        const key = `${x},${y},${z}`;

        if (posMap.has(key)) {
            indexRemap.push(posMap.get(key));
        } else {
            posMap.set(key, vCount);
            indexRemap.push(vCount);
            uniqueVertices.push({ x, y, z });
            vCount++;
        }
    }

    const remappedIndices = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
        remappedIndices[i] = indexRemap[indices[i]];
    }

    return { uniqueVertices, indexRemap, remappedIndices };
}

/** Converts a flat index buffer into a list of [v1, v2, v3] triangles. */
export function buildTopologyFromIndices(indices) {
    const triangles = [];
    for (let i = 0; i < indices.length; i += 3) {
        triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
    }
    return triangles;
}

/**
 * Validates that triangles form a closed 2-manifold: every non-degenerate edge
 * must be shared by exactly two triangles (0 open holes, 0 non-manifold fans).
 */
export function verifyManifold(triangles) {
    const edgeCounts = new Map();
    const getEdgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

    for (const tri of triangles) {
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
        const edges = [
            getEdgeKey(tri[0], tri[1]),
            getEdgeKey(tri[1], tri[2]),
            getEdgeKey(tri[2], tri[0])
        ];
        for (const edge of edges) {
            edgeCounts.set(edge, (edgeCounts.get(edge) || 0) + 1);
        }
    }

    let openEdges = 0;
    let nonManifoldEdges = 0;
    for (const count of edgeCounts.values()) {
        if (count === 1) openEdges++;
        else if (count > 2) nonManifoldEdges++;
    }

    return {
        isManifold: openEdges === 0 && nonManifoldEdges === 0,
        openEdges,
        nonManifoldEdges
    };
}

/**
 * Validates consistent outward orientation: in a correctly wound closed mesh
 * every directed edge (a→b) appears exactly once, paired with its reverse (b→a).
 * Edge-count manifoldness alone cannot catch flipped patches; this can.
 */
export function verifyOrientation(triangles) {
    const directed = new Map();
    for (const tri of triangles) {
        if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
        const edges = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
        for (const [a, b] of edges) {
            const key = `${a}>${b}`;
            directed.set(key, (directed.get(key) || 0) + 1);
        }
    }
    let inconsistent = 0;
    for (const [key, count] of directed.entries()) {
        const [a, b] = key.split('>');
        const revCount = directed.get(`${b}>${a}`) || 0;
        if (count !== 1 || revCount !== 1) inconsistent++;
    }
    return { isConsistent: inconsistent === 0, inconsistentEdges: inconsistent };
}

/**
 * Signed volume of a closed mesh via the divergence theorem (signed tetrahedra).
 * Positive when triangles wind outward (CCW seen from outside). Units: mm³.
 */
export function signedMeshVolumeMm3(positions, indices) {
    let volume = 0;
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
        const x0 = positions[i0], y0 = positions[i0 + 1], z0 = positions[i0 + 2];
        const x1 = positions[i1], y1 = positions[i1 + 1], z1 = positions[i1 + 2];
        const x2 = positions[i2], y2 = positions[i2 + 1], z2 = positions[i2 + 2];
        volume += (1 / 6) * (
            x0 * (y1 * z2 - y2 * z1) -
            x1 * (y0 * z2 - y2 * z0) +
            x2 * (y0 * z1 - y1 * z0)
        );
    }
    return volume;
}

/** Absolute mesh volume in mm³. */
export function computeMeshVolumeMm3(positions, indices) {
    return Math.abs(signedMeshVolumeMm3(positions, indices));
}

/** Total triangle surface area in mm². */
export function computeMeshSurfaceAreaMm2(positions, indices) {
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
        const ax = positions[i1] - positions[i0], ay = positions[i1 + 1] - positions[i0 + 1], az = positions[i1 + 2] - positions[i0 + 2];
        const bx = positions[i2] - positions[i0], by = positions[i2 + 1] - positions[i0 + 1], bz = positions[i2 + 2] - positions[i0 + 2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
    return area;
}

/**
 * Full watertightness report for an export candidate mesh: welds vertices,
 * then checks edge-manifoldness, winding consistency, and signed volume.
 */
/**
 * How a part meets the build plate, in the orientation it is about to be
 * exported in.
 *
 * The plate packer only ever asked two questions — does the footprint fit,
 * and is the part shorter than the machine. Neither notices a part that is
 * the right size and simply cannot be printed, and one got out: the gate
 * paddle went to the slicer resting on the TIP OF ITS PIN, 3.4 mm² of
 * contact under a blade cantilevered in mid-air, because the exporter drops
 * a part's lowest point to the bed and its lowest point was a spike.
 *
 * `contactMm2` is the area of the triangles lying within `tolMm` of the
 * lowest point — the first layer, near enough — and it is the ABSOLUTE
 * number that matters. Comparing it to the part's bounding footprint seems
 * more principled and is not: a curve's bounding box is mostly empty air, so
 * it scores 3% while sitting on 929 mm² of piers and end pads. The gate on
 * its pin had 3.4 mm². Across the whole library the smallest honest part is a
 * riser at 117, so anything in single figures is a different kind of thing.
 *
 * `contactFraction` and `slenderness` are reported for context, not judged.
 * A 120 mm riser is 8:1 slender by design.
 */
export function bedStability(positions, indices, tolMm = 0.15) {
    let lo = Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, hi = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        lo = Math.min(lo, positions[i + 1]); hi = Math.max(hi, positions[i + 1]);
        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
        minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
    }
    let contactMm2 = 0;
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        if (Math.max(positions[a + 1], positions[b + 1], positions[c + 1]) > lo + tolMm) continue;
        // area of the triangle projected onto the bed
        contactMm2 += Math.abs(
            (positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]) -
            (positions[c] - positions[a]) * (positions[b + 2] - positions[a + 2])) / 2;
    }
    const widthMm = maxX - minX, depthMm = maxZ - minZ, heightMm = hi - lo;
    const footprintMm2 = widthMm * depthMm;
    return {
        contactMm2, footprintMm2, widthMm, depthMm, heightMm,
        contactFraction: footprintMm2 > 0 ? contactMm2 / footprintMm2 : 0,
        slenderness: Math.min(widthMm, depthMm) > 0 ? heightMm / Math.min(widthMm, depthMm) : Infinity
    };
}

export function analyzeMesh(positions, indices) {
    const { uniqueVertices, remappedIndices } = deduplicateGeometry(positions, indices);
    const triangles = buildTopologyFromIndices(remappedIndices);
    const manifold = verifyManifold(triangles);
    const orientation = verifyOrientation(triangles);
    const signedVol = signedMeshVolumeMm3(positions, indices);
    return {
        vertexCount: uniqueVertices.length,
        triangleCount: triangles.length,
        ...manifold,
        ...orientation,
        volumeMm3: Math.abs(signedVol),
        windsOutward: signedVol > 0
    };
}
