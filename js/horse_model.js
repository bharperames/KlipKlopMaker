/**
 * horse_model.js — high-detail display model of "Galahad", the Mike the
 * Knight klip klop steed (Fisher-Price Little People), with Mike astride.
 *
 * Display-only Three.js module (impure layer, like pieces.js) — never used
 * for export or physics. The physics chassis is untouched and exact:
 *   - front leg skirt bottom rides the rocker cam circle (4, 30) R=30
 *   - rear leg skirt (the pendulum) rides cam circle (−10, 30) R=30
 *   - the pendulum group's local origin is the axle; app.js positions it at
 *     FIGURE.axle and drives .rotation.x, same contract as the old red arm.
 *
 * Everything else is cosmetic sculpting matched to reference photos of the
 * toy: two-leg skirt blocks with center crease + hoof lip, high belly line,
 * arched neck, big head (muzzle, nostrils, ears, forelock), blue chanfron,
 * brown bridle + reins, red scalloped caparison, chainmail pad, blue
 * saddle, saddlebag, swoosh tail, and Mike (armor, pauldrons, helmet,
 * red plume, yellow feather, face + fringe).
 *
 * Coordinates: body frame, z forward / y up / x left-right, mm.
 */

import * as THREE from 'three';
import { camY, FIGURE } from './geometry.js';

// Toy-matched palette (from reference photos)
const C = {
    tan: 0xc9924f,        // caramel body plastic
    tanDark: 0xb87f40,    // saddlebag / mouth line
    mane: 0x5d3a1f,       // forelock, tail, Mike's hair
    bridle: 0x74492a,     // straps and reins
    blue: 0x2d5ec9,       // armor, saddle, chanfron, helmet
    blueDeep: 0x2350ad,   // straps that read as separate pieces
    red: 0xd94a2c,        // caparison (orange-red)
    plume: 0xc73227,      // helmet plume
    slate: 0x3e4652,      // chainmail
    skin: 0xf4d6ae,
    yellow: 0xe0b23a,     // back feather
    black: 0x201d1a
};

/** Scallop-row bump texture that makes flat panels read as chainmail. */
function chainmailBump() {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#7a7a7a';
    g.fillRect(0, 0, 64, 64);
    for (let row = -1; row < 9; row++) {
        for (let col = -1; col < 9; col++) {
            const x = col * 8 + (row % 2 ? 4 : 0), y = row * 8;
            const grad = g.createRadialGradient(x, y - 2, 1, x, y - 2, 6);
            grad.addColorStop(0, '#b4b4b4');
            grad.addColorStop(1, '#5a5a5a');
            g.fillStyle = grad;
            g.beginPath();
            g.arc(x, y, 4.6, 0, Math.PI);
            g.fill();
        }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 3);
    return t;
}

export function buildKnightHorseModel({ halfWidth = 22, opacity = 1 } = {}) {
    const ghost = opacity < 0.999;
    const mats = {};
    const mat = (color, extra = {}) => {
        const key = color + JSON.stringify(Object.keys(extra));
        if (!mats[key]) {
            mats[key] = new THREE.MeshPhongMaterial({
                color,
                shininess: 55,
                specular: 0x404040,
                transparent: ghost,
                opacity,
                depthWrite: !ghost,
                ...extra
            });
        }
        return mats[key];
    };
    const bump = chainmailBump();
    const chainmailMat = bump
        ? mat(C.slate, { bumpMap: bump, bumpScale: 0.4 })
        : mat(C.slate);

    const W2 = halfWidth;
    const sphereGeo = new THREE.SphereGeometry(1, 22, 15);

    /** Ellipsoid blob — the workhorse of soft toy sculpting. */
    const ell = (parent, m, x, y, z, rx, ry, rz, shadow = false) => {
        const mesh = new THREE.Mesh(sphereGeo, m);
        mesh.position.set(x, y, z);
        mesh.scale.set(rx, ry, rz);
        mesh.castShadow = shadow;
        mesh.renderOrder = 2;
        parent.add(mesh);
        return mesh;
    };

    /** Cylinder strap between two points. */
    const strap = (parent, m, p1, p2, r) => {
        const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
        const len = a.distanceTo(b);
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), m);
        mesh.position.copy(a).lerp(b, 0.5);
        mesh.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            b.clone().sub(a).normalize());
        mesh.renderOrder = 2;
        parent.add(mesh);
        return mesh;
    };

    /** Smooth tube along control points. */
    const tube = (parent, m, pts, r, shadow = false, closed = false) => {
        const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), closed);
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, closed ? 40 : 24, r, 10), m);
        mesh.castShadow = shadow;
        mesh.renderOrder = 2;
        parent.add(mesh);
        return mesh;
    };

    /**
     * A klip klop leg block: left+right legs (rounded extrusions of a side
     * profile whose bottom edge IS the physics rocker cam), a center crease
     * gap, and a recessed filler slab so the crease doesn't see through.
     */
    const legSkirt = (profile, w2, m) => {
        const group = new THREE.Group();
        const shape = new THREE.Shape();
        profile.forEach(([z, y], i) => (i ? shape.lineTo(-z, y) : shape.moveTo(-z, y)));
        const gap = 0.9, bevel = 0.9;
        const depth = (w2 - gap) - 2 * bevel;
        const geo = new THREE.ExtrudeGeometry(shape, {
            depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
            bevelOffset: -bevel, bevelSegments: 2, curveSegments: 4
        });
        geo.rotateY(Math.PI / 2);
        for (const side of [1, -1]) {
            const leg = new THREE.Mesh(geo, m);
            leg.position.x = side === 1 ? gap + bevel : -(gap + bevel + depth);
            leg.castShadow = true;
            leg.renderOrder = 2;
            group.add(leg);
        }
        // crease filler: same profile, slightly recessed, spanning the gap
        const zs = profile.map(p => -p[0]);
        const zMid = (Math.min(...zs) + Math.max(...zs)) / 2;
        const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: gap * 2 + 0.2, bevelEnabled: false });
        slabGeo.rotateY(Math.PI / 2);
        slabGeo.translate(0, 0, zMid);
        const slab = new THREE.Mesh(slabGeo, m);
        slab.scale.set(1, 0.995, 0.93);
        slab.position.set(-(gap + 0.1), 0, -zMid * 0.93);
        slab.renderOrder = 2;
        group.add(slab);
        return group;
    };

    // -----------------------------------------------------------------------
    // BODY group (fixed to the rocking pivot). Toy proportions: tall legs
    // (belly line ~y18), compact barrel, thick arched neck, big high head.
    // -----------------------------------------------------------------------
    const body = new THREE.Group();
    const tanM = mat(C.tan);

    // Front leg skirt — bottom edge is the exact front rocker cam (4,30) R30.
    // The front face doubles as the chest face, sloping up into the chest lobe.
    const frontCam = [23, 21, 19, 17, 15, 13, 11, 9, 7, 5, 4, 3, 1, 0]
        .map(z => [z, camY(z, 4, 30, 30)]);
    body.add(legSkirt([
        [-2, 20], [21.5, 20], [23.6, 10], [23.6, 7.6],     // top edge + chest face
        [24.6, 7.2], [24.4, 6.1],                          // hoof lip step
        ...frontCam,                                        // rocker bottom
        [-2, 6], [-2, 20]                                   // belly arch + rear face
    ], W2, tanM));

    // Barrel + chest + rump (belly line ~y18)
    ell(body, tanM, 0, 29, -1, W2 * 0.82, 11, 21, true);
    ell(body, tanM, 0, 26, 13, W2 * 0.72, 9.5, 9.5);        // chest roundness
    ell(body, tanM, 0, 29, -16, W2 * 0.74, 11, 9);          // rump roundness

    // Neck: three blended lobes climbing steeply off the withers
    ell(body, tanM, 0, 31, 7, W2 * 0.41, 8, 8, true);
    ell(body, tanM, 0, 38, 11, W2 * 0.38, 8, 7.5);
    ell(body, tanM, 0, 44, 14.5, W2 * 0.35, 7, 6.5);

    // Head: big cranium with wide cheeks, muzzle carried forward-down
    const head = new THREE.Group();
    body.add(head);
    ell(head, tanM, 0, 48, 17, W2 * 0.46, 7.5, 8, true);    // cranium + cheeks
    ell(head, tanM, 0, 40, 22.4, W2 * 0.34, 5.8, 5.2);      // muzzle
    ell(head, tanM, 0, 36.5, 19.5, W2 * 0.3, 4.2, 4.8);     // jaw/chin
    ell(head, tanM, 3, 40.5, 26.6, 1.1, 1.5, 1.1);          // nostrils
    ell(head, tanM, -3, 40.5, 26.6, 1.1, 1.5, 1.1);
    for (const s of [1, -1]) {                               // ears
        const ear = new THREE.Mesh(new THREE.ConeGeometry(2.8, 7, 10), tanM);
        ear.position.set(s * 4.6, 55, 12);
        ear.rotation.set(-0.22, 0, s * -0.3);
        ear.renderOrder = 2;
        head.add(ear);
    }
    const eyeM = mat(C.black);
    ell(head, eyeM, 6.6, 47.5, 23, 1.8, 2.2, 0.9);          // big friendly dot eyes
    ell(head, eyeM, -6.6, 47.5, 23, 1.8, 2.2, 0.9);

    // Forelock swept across the brow, under the chanfron's front edge
    const maneM = mat(C.mane);
    ell(head, maneM, 0, 52.3, 17.2, 6.6, 3, 4.4);
    ell(head, maneM, 3.4, 50.8, 19, 3.6, 2.3, 2.8);

    // Blue chanfron plate on the crown, between the ears
    const chanfron = new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(C.blue, { side: THREE.DoubleSide }));
    chanfron.position.set(0, 51.3, 12);
    chanfron.scale.set(W2 * 0.38, 7, 8);
    chanfron.rotation.x = 0.35;
    chanfron.renderOrder = 2;
    head.add(chanfron);
    const crestFin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.4, 7), mat(C.blue));
    crestFin.position.set(0, 57.4, 10.4);
    crestFin.rotation.x = 0.35;
    crestFin.renderOrder = 2;
    head.add(crestFin);

    // Bridle: noseband, cheek straps, reins back to the rider's hands
    const bridleM = mat(C.bridle);
    const noseband = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.85, 8, 20), bridleM);
    noseband.position.set(0, 40.5, 21.3);
    noseband.scale.set(1.15, 1, 1);
    noseband.rotation.x = Math.PI / 2 - 0.42;
    noseband.renderOrder = 2;
    head.add(noseband);
    for (const s of [1, -1]) {
        strap(head, bridleM, [s * 7, 41.5, 20.4], [s * 5.8, 51, 13.5], 0.8);
        tube(body, bridleM, [
            [s * 7.2, 40.5, 21], [s * 8, 42.5, 13], [s * 6.8, 43, 6.5], [s * 5.2, 42.8, 5]
        ], 0.7);
    }

    // Red scalloped caparison collar hugging the neck base
    const capM = mat(C.red, { side: THREE.DoubleSide });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(8, 13, 8, 22, 1, true), capM);
    cap.position.set(0, 33.5, 8.5);
    cap.scale.set(0.9, 1, 0.85);
    cap.rotation.x = -0.4;
    cap.renderOrder = 2;
    body.add(cap);
    for (let i = 0; i < 11; i++) {                           // scallop dots along the hem
        const a = (i / 11) * Math.PI * 2;
        // children of the collar inherit its tilt + squash, so they hug the hem
        const dot = new THREE.Mesh(sphereGeo, capM);
        dot.position.set(12.6 * Math.sin(a), -4, 12.6 * Math.cos(a));
        dot.scale.set(1.6 / 0.9, 1.7, 1.6 / 0.85);
        dot.renderOrder = 2;
        cap.add(dot);
    }

    // Chainmail pad wrapping the flanks under the saddle
    ell(body, chainmailMat, 0, 31, -4, W2 * 0.86, 8.5, 10, true);

    // Blue saddle: seat + tall cantle behind the rider + pommel, girth, breast band
    const blueM = mat(C.blue);
    const deepM = mat(C.blueDeep);
    ell(body, blueM, 0, 41, -6.5, W2 * 0.46, 3, 7.5);
    const cantle = ell(body, blueM, 0, 44.5, -13, W2 * 0.44, 5.5, 2.4, true);
    cantle.rotation.x = 0.3;
    ell(body, blueM, 0, 42.5, 0.5, W2 * 0.28, 2.8, 2.2);
    const girthPts = [];                                     // ring around the barrel
    for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        girthPts.push([Math.sin(a) * W2 * 0.92, 28.5 + Math.cos(a) * 13, 1]);
    }
    tube(body, deepM, girthPts, 1.4, false, true);
    tube(body, deepM, [                                      // breast band around the chest
        [W2 * 0.8, 31, 0], [W2 * 0.66, 28, 12], [0, 26, 20.8], [-W2 * 0.66, 28, 12], [-W2 * 0.8, 31, 0]
    ], 1.4);
    ell(body, deepM, W2 * 0.82, 30.5, 1.5, 2.3, 2.3, 2.3);   // rosettes at the strap joins
    ell(body, deepM, -W2 * 0.82, 30.5, 1.5, 2.3, 2.3, 2.3);

    // Tan saddlebag on the left flank
    const bagM = mat(C.tanDark);
    const bag = ell(body, bagM, -W2 * 0.78, 30.5, -13, 2.8, 5.5, 4.8);
    bag.rotation.z = 0.1;
    ell(body, bagM, -W2 * 0.78 - 1.2, 33.5, -13, 2.2, 3, 4.2);   // flap

    // Tail: thick chocolate swoosh off the rump, curling toward the ground
    const tail = new THREE.Group();
    body.add(tail);
    ell(tail, maneM, 0, 35, -19.5, 4.5, 4.5, 4, true);
    tube(tail, maneM, [
        [0, 36, -19], [0, 33, -26.5], [0, 24, -30], [0, 14, -29], [2, 9, -24]
    ], 3.8, true);
    tube(tail, maneM, [
        [2, 34, -20], [2.6, 28, -28], [2.2, 18, -29.5], [3.2, 11, -25]
    ], 1.9);
    tube(tail, maneM, [
        [-2, 34, -20], [-2.6, 27, -28.5], [-2.2, 17, -30], [-1.2, 10, -25.5]
    ], 1.9);
    tail.scale.x = 1.5;                                      // wide, flat swoosh like the toy

    // -----------------------------------------------------------------------
    // MIKE (fixed astride the saddle): squat torso, big head, hugging helmet
    // -----------------------------------------------------------------------
    const mike = new THREE.Group();
    body.add(mike);
    ell(mike, blueM, W2 * 0.5, 34, -2, 3.4, 6.5, 5);         // thighs on the flanks
    ell(mike, blueM, -W2 * 0.5, 34, -2, 3.4, 6.5, 5);
    ell(mike, blueM, 0, 47.5, -6, W2 * 0.44, 8.5, 7, true);  // armored torso
    ell(mike, chainmailMat, 0, 47.5, -1.2, 6, 6.5, 3);       // chainmail chest
    for (const s of [1, -1]) {                               // arms reaching the reins
        tube(mike, blueM, [
            [s * 8.2, 52, -4.5], [s * 7.8, 46.5, 0.5], [s * 5.2, 42.8, 4.8]
        ], 2.5, true);
        ell(mike, chainmailMat, s * 8.4, 52.5, -4.5, 3.3, 3.3, 3.3); // pauldrons
        ell(mike, blueM, s * 5, 42.5, 5.2, 2.7, 2.7, 2.7);   // gauntlet mitts
    }
    // Head: face, fringe, dot eyes, smile
    const skinM = mat(C.skin);
    ell(mike, skinM, 0, 57.5, -3.5, 7, 7.2, 6.5, true);
    ell(mike, eyeM, 2.8, 58.3, 2.6, 1.1, 1.4, 0.7);
    ell(mike, eyeM, -2.8, 58.3, 2.6, 1.1, 1.4, 0.7);
    const smile = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.35, 6, 12, Math.PI * 0.8), mat(C.tanDark));
    smile.position.set(0, 55.4, 2.8);
    smile.rotation.set(0.35, 0, Math.PI + Math.PI * 0.1);
    smile.renderOrder = 2;
    mike.add(smile);
    ell(mike, maneM, 0, 60.9, 0.7, 6.2, 2.7, 4.7);           // brown fringe
    ell(mike, maneM, 5.5, 58, -0.2, 1.4, 3, 2.2);            // sideburns
    ell(mike, maneM, -5.5, 58, -0.2, 1.4, 3, 2.2);

    // Helmet: dome shell with a real face opening, cheek guards, red plume
    const helmGeo = new THREE.SphereGeometry(9.6, 30, 18, Math.PI * 0.18, Math.PI * 1.64, 0, Math.PI * 0.8);
    helmGeo.rotateY(Math.PI / 2);                            // face the opening forward
    const helm = new THREE.Mesh(helmGeo, mat(C.blue, { side: THREE.DoubleSide }));
    helm.position.set(0, 60, -4.5);
    helm.scale.set(1, 1.05, 1);
    helm.rotation.x = -0.12;
    helm.castShadow = true;
    helm.renderOrder = 2;
    mike.add(helm);
    ell(mike, blueM, 6.6, 55.6, 1, 2, 3.6, 2.6);             // cheek guards
    ell(mike, blueM, -6.6, 55.6, 1, 2, 3.6, 2.6);
    const plumeShape = new THREE.Shape();
    for (let i = 0; i <= 10; i++) {                          // outer arc, swept back
        const t = -Math.PI * 0.45 + (i / 10) * Math.PI * 0.87;
        const r = 13 + 2.5 * Math.max(0, -t);
        const p = [-r * Math.sin(t), r * Math.cos(t)];
        i ? plumeShape.lineTo(...p) : plumeShape.moveTo(...p);
    }
    for (let i = 10; i >= 0; i--) {                          // inner arc hugging the dome
        const t = -Math.PI * 0.45 + (i / 10) * Math.PI * 0.87;
        plumeShape.lineTo(-9 * Math.sin(t), 9 * Math.cos(t));
    }
    const plumeGeo = new THREE.ExtrudeGeometry(plumeShape, {
        depth: 2.2, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.4, bevelOffset: -0.4, bevelSegments: 1
    });
    plumeGeo.rotateY(Math.PI / 2);
    const plume = new THREE.Mesh(plumeGeo, mat(C.plume));
    plume.position.set(-1.1, 60, -4.5);
    plume.rotation.x = -0.12;
    plume.castShadow = true;
    plume.renderOrder = 2;
    mike.add(plume);

    // Curled yellow feather tucked at Mike's back (toy detail)
    const featherShape = new THREE.Shape();
    [[0, 0], [1.8, 2.2], [2.3, 5.5], [1.4, 8.6], [0, 10], [-1.1, 7.6], [-0.6, 4], [-0.8, 1]]
        .forEach(([x, y], i) => (i ? featherShape.lineTo(x, y) : featherShape.moveTo(x, y)));
    const featherGeo = new THREE.ExtrudeGeometry(featherShape, { depth: 1.2, bevelEnabled: false });
    const feather = new THREE.Mesh(featherGeo, mat(C.yellow, { side: THREE.DoubleSide }));
    feather.position.set(3, 50.5, -11.5);
    feather.rotation.set(0.45, 0.35, -0.15);
    feather.renderOrder = 2;
    mike.add(feather);

    // -----------------------------------------------------------------------
    // PENDULUM group (rear leg skirt) — local origin at the axle; app.js
    // positions it at FIGURE.axle and drives .rotation.x
    // -----------------------------------------------------------------------
    const pend = new THREE.Group();
    const rearCam = [0, -1, -3, -5, -7, -9, -10, -11, -13, -15, -17, -18]
        .map(z => [z, camY(z, -10, 30, 30)]);
    const rearSkirt = legSkirt([
        [-21, 20], [0.8, 20], [1.1, 10], [1.1, 7.4],        // top edge + front face
        [1.9, 7.0], [1.7, 5.8],                             // hoof lip step
        ...rearCam,                                          // rocker bottom (exact cam)
        [-19.8, 4], [-21, 10], [-21, 20]                    // rear face up to the rump
    ], W2 - 0.4, tanM);
    // shift into pendulum-local coords (origin at the axle)
    rearSkirt.position.set(0, -FIGURE.axle.y, -FIGURE.axle.z);
    pend.add(rearSkirt);

    return { body, pend };
}
