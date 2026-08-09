import {
    deduplicateGeometry, buildTopologyFromIndices, verifyManifold,
    verifyOrientation, signedMeshVolumeMm3, analyzeMesh, bedStability
} from '../js/mesh_utils.js';
import { generate3MFXML, generateBinarySTL } from '../js/export_3mf.js';

// Unit tetrahedron with outward winding
const TET_POS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const TET_IDX = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);

describe('verifyManifold / verifyOrientation', () => {
    test('closed tetrahedron passes both checks', () => {
        const tris = buildTopologyFromIndices(TET_IDX);
        expect(verifyManifold(tris).isManifold).toBe(true);
        expect(verifyOrientation(tris).isConsistent).toBe(true);
    });

    test('a missing face is caught as open edges', () => {
        const tris = buildTopologyFromIndices(TET_IDX.slice(0, 9));
        const r = verifyManifold(tris);
        expect(r.isManifold).toBe(false);
        expect(r.openEdges).toBe(3);
    });

    test('a flipped face passes edge counting but fails orientation', () => {
        const idx = new Uint32Array(TET_IDX);
        [idx[1], idx[2]] = [idx[2], idx[1]]; // flip first triangle
        const tris = buildTopologyFromIndices(idx);
        expect(verifyManifold(tris).isManifold).toBe(true);
        expect(verifyOrientation(tris).isConsistent).toBe(false);
    });
});

describe('signed volume', () => {
    test('outward tetrahedron has positive volume 1/6', () => {
        expect(signedMeshVolumeMm3(TET_POS, TET_IDX)).toBeCloseTo(1 / 6, 9);
    });
});

describe('deduplicateGeometry', () => {
    test('welds duplicated seam vertices', () => {
        const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1e-9, -0, 0]);
        const { uniqueVertices } = deduplicateGeometry(pos, new Uint32Array([0, 1, 2]));
        expect(uniqueVertices).toHaveLength(2);
    });
});

describe('analyzeMesh', () => {
    test('full report on the tetrahedron', () => {
        const r = analyzeMesh(TET_POS, TET_IDX);
        expect(r.isManifold).toBe(true);
        expect(r.isConsistent).toBe(true);
        expect(r.windsOutward).toBe(true);
        expect(r.volumeMm3).toBeCloseTo(1 / 6, 9);
        expect(r.triangleCount).toBe(4);
    });
});

describe('exporters', () => {
    test('3MF XML contains rotated vertices and all triangles', () => {
        const xml = generate3MFXML(TET_POS, TET_IDX);
        expect(xml).toContain('<model unit="millimeter"');
        expect((xml.match(/<triangle /g) || []).length).toBe(4);
        expect((xml.match(/<vertex /g) || []).length).toBe(4);
    });

    test('binary STL has the correct size and triangle count', () => {
        const stl = generateBinarySTL(TET_POS, TET_IDX);
        expect(stl.byteLength).toBe(84 + 4 * 50);
        expect(new DataView(stl).getUint32(80, true)).toBe(4);
    });

    test('STL applies a proper rotation (no mirroring): x stays, y=-z, z=y', () => {
        const stl = new DataView(generateBinarySTL(TET_POS, TET_IDX));
        // first triangle, first vertex = TET vertex 0 = (0,0,0); second tri first vertex etc.
        // check vertex (0,0,1) → (0,-1,0): appears in triangle 2 (indices 0,1,3), vertex 3
        // triangle records: 84 + t*50, normal 12 bytes, then 3 verts * 12
        const v = (t, j, c) => stl.getFloat32(84 + t * 50 + 12 + j * 12 + c * 4, true);
        // tri 1 = [0,1,3], vertex j=2 is TET vertex 3 = (0,0,1)
        expect(v(1, 2, 0)).toBeCloseTo(0, 6);
        expect(v(1, 2, 1)).toBeCloseTo(-1, 6);
        expect(v(1, 2, 2)).toBeCloseTo(0, 6);
    });
});

describe('bedStability', () => {
    /** A box w x h x d sitting on the bed, plus an optional spike under it. */
    const box = (w, h, d, y0 = 0) => {
        const P = [], I = [];
        const c = [[0,0,0],[w,0,0],[w,0,d],[0,0,d],[0,h,0],[w,h,0],[w,h,d],[0,h,d]];
        for (const [x, y, z] of c) P.push(x - w / 2, y + y0, z - d / 2);
        const F = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
                   [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
        for (const f of F) I.push(...f);
        return { positions: Float32Array.from(P), indices: Uint32Array.from(I) };
    };
    const merge = (a, b) => ({
        positions: Float32Array.from([...a.positions, ...b.positions]),
        indices: Uint32Array.from([...a.indices,
            ...Array.from(b.indices, i => i + a.positions.length / 3)])
    });

    test('a flat-bottomed part reports its true first-layer area', () => {
        const s = bedStability(box(10, 4, 6).positions, box(10, 4, 6).indices);
        expect(s.contactMm2).toBeCloseTo(60, 3);
        expect(s.heightMm).toBeCloseTo(4, 6);
        expect(s.contactFraction).toBeCloseTo(1, 3);
    });

    test('a part balanced on a spike reports the SPIKE, not the body', () => {
        // this is the gate paddle's failure in miniature: a big body sitting
        // 8 mm up in the air on a small stub
        const part = merge(box(2, 8, 2), box(50, 12, 10, 8));
        const s = bedStability(part.positions, part.indices);
        expect(s.contactMm2).toBeCloseTo(4, 3);          // the stub alone
        expect(s.heightMm).toBeCloseTo(20, 6);
        expect(s.contactMm2).toBeLessThan(25);           // caught by MIN_BED_MM2
    });

    test('a bounding-box fraction would flag a curve, absolute area does not', () => {
        // A curve's box is mostly empty air. Two pads at opposite corners of a
        // 150 mm box carry 900 mm2 between them and are perfectly stable, but
        // they fill only a few percent of the box — which is why the export
        // check reads the absolute number.
        const part = merge(box(30, 40, 30), box(30, 40, 30));
        for (let i = 0; i < part.positions.length; i += 3) {
            if (i >= part.positions.length / 2) { part.positions[i] += 120; part.positions[i + 2] += 120; }
        }
        const s = bedStability(part.positions, part.indices);
        expect(s.contactMm2).toBeCloseTo(1800, 3);
        expect(s.contactFraction).toBeLessThan(0.1);     // the fraction lies
        expect(s.contactMm2).toBeGreaterThan(25);        // the area does not
    });
});
