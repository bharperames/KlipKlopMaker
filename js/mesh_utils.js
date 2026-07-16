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
