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
 * back-mounted red plume holder, face + fringe).
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
    ell(body, tanM, 0, 31.5, 6.5, W2 * 0.44, 8, 8, true);
    ell(body, tanM, 0, 39, 10.5, W2 * 0.4, 7.5, 7);
    ell(body, tanM, 0, 45, 13.5, W2 * 0.36, 6.5, 6);

    // Head: big cranium with wide cheeks, muzzle carried forward-down
    const head = new THREE.Group();
    body.add(head);
    ell(head, tanM, 0, 47.5, 16, W2 * 0.44, 7, 7.8, true);  // cranium + cheeks
    ell(head, tanM, 0, 38.6, 23.4, W2 * 0.32, 5.4, 4.8);    // muzzle, long and low
    ell(head, tanM, 0, 35, 20.4, W2 * 0.27, 4, 4.6);        // jaw/chin
    ell(head, tanM, 0, 38, 17, W2 * 0.26, 5, 5.5);          // throat fill
    ell(head, tanM, 2.8, 38.4, 27.7, 1.1, 1.5, 1.1);        // nostrils
    ell(head, tanM, -2.8, 38.4, 27.7, 1.1, 1.5, 1.1);
    ell(head, mat(C.tanDark), 0, 34.9, 27, 2.6, 0.35, 0.9); // molded mouth slit
    for (const s of [1, -1]) {                               // ears splayed beside the chanfron
        const ear = new THREE.Mesh(new THREE.ConeGeometry(2.8, 6.5, 10), tanM);
        ear.position.set(s * 6.2, 53.5, 12);
        ear.rotation.set(-0.25, 0, s * -0.45);
        ear.renderOrder = 2;
        head.add(ear);
    }
    const eyeM = mat(C.black);
    ell(head, eyeM, 4.2, 48, 23.6, 1.6, 2, 0.8);            // front-facing dot eyes
    ell(head, eyeM, -4.2, 48, 23.6, 1.6, 2, 0.8);

    // Forelock swept across the brow, under the chanfron's front edge
    const maneM = mat(C.mane);
    ell(head, maneM, 0, 51.5, 16.8, 6.2, 2.8, 4);
    ell(head, maneM, 3.2, 50.2, 18.4, 3.2, 2.1, 2.6);

    // Blue chanfron plate on the crown, between the ears
    const chanfron = new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(C.blue, { side: THREE.DoubleSide }));
    chanfron.position.set(0, 50.8, 13.8);
    chanfron.scale.set(W2 * 0.34, 6, 7);
    chanfron.rotation.x = 0.42;
    chanfron.renderOrder = 2;
    head.add(chanfron);
    const crestFin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3, 6.5), mat(C.blue));
    crestFin.position.set(0, 55.2, 12.4);
    crestFin.rotation.x = 0.42;
    crestFin.renderOrder = 2;
    head.add(crestFin);

    // Bridle: noseband, cheek straps, reins back to the rider's hands
    const bridleM = mat(C.bridle);
    // ring plane perpendicular to the muzzle axis (nose pitches down ~20°)
    const noseband = new THREE.Mesh(new THREE.TorusGeometry(5.8, 0.8, 8, 20), bridleM);
    noseband.position.set(0, 38.2, 23.6);
    noseband.scale.set(1.25, 1, 1);
    noseband.rotation.x = -0.35;
    noseband.renderOrder = 2;
    head.add(noseband);
    for (const s of [1, -1]) {
        strap(head, bridleM, [s * 6.6, 40.5, 22], [s * 5.4, 50.5, 14], 0.8);
        tube(body, bridleM, [                                // reins from the bit, slack under the cheeks
            [s * 6.4, 36.5, 19.5], [s * 7, 36.5, 13], [s * 6.6, 38.5, 8], [s * 7.3, 41.4, 5]
        ], 0.7);
    }

    // Red scalloped caparison collar hugging the neck base
    const capM = mat(C.red, { side: THREE.DoubleSide });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(9, 15, 9, 22, 1, true), capM);
    cap.position.set(0, 34, 9.5);
    cap.scale.set(1.1, 1, 0.9);
    cap.rotation.x = -0.42;
    cap.renderOrder = 2;
    body.add(cap);
    for (let i = 0; i < 11; i++) {                           // scallop dots along the hem
        const a = (i / 11) * Math.PI * 2;
        // children of the collar inherit its tilt + squash, so they hug the hem
        const dot = new THREE.Mesh(sphereGeo, capM);
        dot.position.set(14.6 * Math.sin(a), -4.5, 14.6 * Math.cos(a));
        dot.scale.set(1.6 / 1.1, 1.7, 1.6 / 0.9);
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
    for (const s of [1, -1]) {                               // girth straps on the flanks
        strap(body, deepM, [s * W2 * 0.8, 33, -2], [s * W2 * 0.84, 22, -1.5], 1.3);
    }
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
            [s * 7.4, 51, -3.5], [s * 8.2, 46, 0], [s * 7.5, 41.8, 4.2]
        ], 2.6, true);
        ell(mike, chainmailMat, s * 7.4, 50.5, -3.8, 3.2, 3.2, 3.2); // pauldrons
        ell(mike, blueM, s * 7.4, 41.5, 4.6, 2.7, 2.7, 2.7); // mitts resting on the neck
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
    const helmGeo = new THREE.SphereGeometry(9.6, 30, 18, Math.PI * 0.3, Math.PI * 1.4, 0, Math.PI * 0.8);
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
    // Red trumpet-style plume holder mounted at the helmet's back (this toy
    // variant carries its plume behind the dome, not as a comb along the top)
    const plumeM = mat(C.plume);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 20, 12), plumeM);
    shaft.position.set(0, 62, -11.8);
    shaft.rotation.x = 0.12;                                 // leans back with the dome
    shaft.castShadow = true;
    shaft.renderOrder = 2;
    mike.add(shaft);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 1.5, 4.5, 14), plumeM);
    cup.position.set(0, 72.5, -13);
    cup.rotation.x = 0.12;
    cup.castShadow = true;
    cup.renderOrder = 2;
    mike.add(cup);
    ell(mike, plumeM, 0, 75.8, -13.4, 2, 3, 2, true);        // plume tuft
    ell(mike, plumeM, 0, 52, -10.2, 2.4, 2.2, 1.8);          // socket collar at Mike's back

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
