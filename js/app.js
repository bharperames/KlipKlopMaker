/**
 * app.js — Klip Klop Konstructor main application.
 *
 * RCT-style editor paradigm: construction arrows mark every open track end
 * (click one to make it the active build point), palette buttons append there
 * with hover ghost previews, and any placed piece can be selected and
 * modified in place — the downstream track re-lays out automatically.
 * Switches fork the track into gated branches; lifts power the figure back up.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
// LineBasicMaterial.linewidth is ignored by every WebGL renderer — lines are
// always 1 px. Line2 draws them as camera-facing quads, which is the only way
// to get a hidden-line pass thick enough to read against the part.
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as fflate from 'fflate';

import {
    SPEC, STANDARD, GEOMETRY_VERSION, isStandardParams, decomposeSupport,
    layoutTrack, stationsForPiece, appendSpiralTier, resolveRidePath,
    getContainer, nodeAt, isSwitchNode, pathKey, openContainers, planPillarPositions, supportsPillar, needsPier, SIMPLE_TYPES,
    planPosAt, deckYAt, stackHeightMm, supportBossPos, pieceFrame, innerWidthAt,
    spacerHeightMm, spacerVariant, SPACER_VARIANTS, normaliseSkirtStyle
} from './track.js';
import { FRICTION_PRESETS, DEFAULT_WALKER, assessSlope, goldilocksRange, ballastPlan, trackVerdict, printedWeightG } from './physics.js';
import { checkChannelFit, walkerFootprint, CLEARANCE } from './clearance.js';
import { partCode } from './engrave.js';
import { computeMeshVolumeMm3 } from './mesh_utils.js';
import { simulateRun, makePathSampler } from './simulate.js';
import { serializeScene, deserializeScene } from './scene_format.js';
import { createHistory } from './history.js';
import { createClosureSolver, chainEnds, describeGap } from './connect.js';
import {
    initCSG, toBufferGeometry, buildPieceDisplayGeometry, buildSwitchDisplayGeometry,
    buildPieceExportGeometry, buildSwitchExportGeometry, gatePinPosition,
    buildPillarGeometry, buildSupportFootGeometry, buildRiserGeometry, buildJogGeometry,
    buildSpacerGeometry,
    buildFigureGeometries, buildKeyGeometry, buildGateGeometry,
    buildTowerGeometry, buildPalmIslandGeometries, buildPatioGeometry, mergeSolids,
    sectionGeometry, supportStations, GATE, buildCalibrationCoupons, CALIBRATION, buildCalibrationSection, SECTION
} from './pieces.js';
import {
    extrudeOutlineX, bodySideOutline, pendulumSideOutline, FIGURE, figureVolumeEstimate,
    bowtieKeyPlan, bowtiePocketPlan, printedSize
} from './geometry.js';
import { buildKnightHorseModel } from './horse_model.js';
import { generate3MFXML, generateBinarySTL, generateMultiObject3MFXML, placeForPlate } from './export_3mf.js';
import { analyzeMesh, bedStability } from './mesh_utils.js';
import { packPlates, describePlates, PLATE } from './plate_pack.js';
import { EXPORT_SETS, getExportSet, describeExportSet } from './export_sets.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    sequence: [],
    scenery: [],
    figureStyle: 'knight',
    knightVariant: 'trumpet', // helmet crest of the mirrored toy: trumpet | comb
    figureOpacity: 1,
    simSpeed: 1.0,
    slopeDeg: +STANDARD.slopeDeg.toFixed(4),
    innerWidth: STANDARD.innerWidth,
    curveRadius: +STANDARD.curveRadius.toFixed(2),
    muKey: 'washboard',
    skirtStyle: SPEC.skirt.style,
    walker: { ...DEFAULT_WALKER },
    soundOn: true,
    renderMode: localStorage.getItem('klipklop-render-mode') || 'solid',
    selected: -1,           // piece index
    selectedScenery: -1,    // scenery index
    activeEndKey: '[]',     // container path key of the active build end
    layout: null,
    name: 'My Klip Klop track'
};

const DEMO = ['straight', ...appendSpiralTier([], 'L'), ...appendSpiralTier([], 'L'), 'straight', 'straight'];

// ---------------------------------------------------------------------------
// Edit stack: EVERY design mutation calls recordEdit() (optionally with an
// opKey so drag/slider gestures coalesce) BEFORE it applies. Undo/redo swap
// whole design snapshots — new operation types are undoable automatically.
// ---------------------------------------------------------------------------

const history = createHistory({ limit: 100 });

function designSnapshot() {
    return {
        sequence: JSON.parse(JSON.stringify(state.sequence)),
        scenery: state.scenery.map(s => ({ ...s })),
        figureStyle: state.figureStyle,
        knightVariant: state.knightVariant,
        figureOpacity: state.figureOpacity,
        slopeDeg: state.slopeDeg,
        innerWidth: state.innerWidth,
        curveRadius: state.curveRadius,
        muKey: state.muKey,
        walker: { ...state.walker },
        name: state.name,
        activeEndKey: state.activeEndKey
    };
}

let designDirty = false;

function recordEdit(opKey = null) {
    history.push(designSnapshot(), opKey);
    designDirty = true;
    refreshHistoryButtons();
}

function restoreSnapshot(s) {
    state.sequence = s.sequence;
    state.scenery = s.scenery;
    state.figureStyle = s.figureStyle ?? 'knight';
    state.knightVariant = s.knightVariant === 'comb' ? 'comb' : 'trumpet';
    state.figureOpacity = s.figureOpacity ?? state.figureOpacity ?? 1;
    state.slopeDeg = s.slopeDeg;
    state.innerWidth = s.innerWidth;
    state.curveRadius = s.curveRadius;
    state.muKey = s.muKey;
    state.skirtStyle = normaliseSkirtStyle(s.skirtStyle);
    state.walker = s.walker;
    state.name = s.name;
    state.activeEndKey = s.activeEndKey ?? '[]';
    state.selected = -1;
    state.selectedScenery = -1;
    syncControls();
    rebuild();
}

function doUndo() {
    const s = history.undo(designSnapshot());
    if (s) { restoreSnapshot(s); toast('↩ Undone'); }
    refreshHistoryButtons();
}
function doRedo() {
    const s = history.redo(designSnapshot());
    if (s) { restoreSnapshot(s); toast('↪ Redone'); }
    refreshHistoryButtons();
}
function refreshHistoryButtons() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = !history.canUndo();
    if (r) r.disabled = !history.canRedo();
}

function saveState() {
    localStorage.setItem('klipklop-scene-v1', JSON.stringify(serializeScene(state)));
}
function applyScene(scene) {
    const s = deserializeScene(scene);
    if (s.nonStandard) {
        showDialog({
            title: '⚠️ Non-standard geometry in this file',
            html: `This design was authored with <b>${s.geometryOfFile ? 'geometry v' + s.geometryOfFile : 'pre-standard custom parameters'}</b>. ` +
                `It has been re-laid on the canonical geometry <b>v${GEOMETRY_VERSION}</b> — the layout may shift slightly, ` +
                `and parts printed from the old file will <b>not</b> mate with canonical prints.`
        });
    }
    state.sequence = s.sequence;
    state.scenery = s.scenery;
    state.figureStyle = s.figureStyle ?? 'knight';
    state.knightVariant = s.knightVariant === 'comb' ? 'comb' : 'trumpet';
    state.slopeDeg = s.slopeDeg;
    state.innerWidth = s.innerWidth;
    state.curveRadius = s.curveRadius;
    state.muKey = s.muKey;
    state.skirtStyle = normaliseSkirtStyle(s.skirtStyle);
    state.walker = s.walker;
    state.name = s.name;
    state.activeEndKey = '[]';
    designDirty = false;
}
async function loadState() {
    const sceneName = new URLSearchParams(location.search).get('scene');
    if (sceneName && /^[\w.-]+$/.test(sceneName)) {
        try {
            const res = await fetch(`./scenes/${sceneName}.json`);
            if (res.ok) { applyScene(await res.json()); return; }
        } catch { /* fall through */ }
    }
    try {
        const raw = localStorage.getItem('klipklop-scene-v1');
        if (!raw) { state.sequence = [...DEMO]; return; }
        applyScene(JSON.parse(raw));
    } catch { state.sequence = [...DEMO]; }
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------

const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe6f5);
scene.fog = new THREE.Fog(0xcfe6f5, 2200, 4200);

const camera = new THREE.PerspectiveCamera(48, 1, 1, 8000);
camera.position.set(620, 520, 620);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(150, 120, 60);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI;
controls.zoomSpeed = 3; // touchpad pinch/scroll deltas are tiny — boost gain

scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x8a7a55, 0.85));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.7);
sun.position.set(500, 900, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -900; sun.shadow.camera.right = 900;
sun.shadow.camera.top = 900; sun.shadow.camera.bottom = -900;
sun.shadow.camera.far = 3000;
// The shadow camera spans 1800 mm across 2048 texels — 0.88 mm per texel — and
// track pieces both cast AND receive. With no bias (the default is 0) a wall
// thinner than a couple of texels has its front and back face land in the same
// depth sample, so the lit face shadows itself: the diagonal checkering that
// appeared on shaded walls once the wall dropped from 2.4 mm to 1.6.
// normalBias offsets the lookup along the surface normal, which is the right
// tool for thin geometry; ~1.5 texels is enough without detaching contact
// shadows from the pillar feet.
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 1.3;
scene.add(sun);
// a DirectionalLight aims at its target, which has to be in the scene for its
// world matrix to update — see fitSunShadow, which re-aims both at the track
scene.add(sun.target);

const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2000, 64).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x8fbf6f })
);
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(2000, 40, 0x7aa85d, 0x7fae62);
grid.position.y = 0.3;
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);

const trackGroup = new THREE.Group();
const arrowGroup = new THREE.Group();
const sceneryGroup = new THREE.Group();
const ghostGroup = new THREE.Group();
scene.add(trackGroup, arrowGroup, sceneryGroup, ghostGroup);

// One filament, one colour. Any two track pieces shaded differently only make
// the seam between them read as a defect — that is what the near-identical
// gold on curves and on switches was doing. The exceptions below are not
// materials pretending to differ: powered sections are flagged red because
// they are the one place gravity is not doing the work, and the start/end
// corrals are translucent so they read as markers rather than as parts.
const TRACK_GOLD = 0xe8b23a;
const MAT = {
    ramp: new THREE.MeshLambertMaterial({ color: TRACK_GOLD }),
    curve: new THREE.MeshLambertMaterial({ color: TRACK_GOLD }),
    switch: new THREE.MeshLambertMaterial({ color: TRACK_GOLD }),
    lift: new THREE.MeshLambertMaterial({ color: 0xc95a3c }),
    // Opaque, like everything else. These were half-transparent from when the
    // platforms were a UI affordance — a hint that the app added them for you
    // rather than something you placed. They are printed parts with codes
    // engraved on them and plates reserved for them, so drawing them as
    // ghosts said the opposite of the truth. Their own colours still mark
    // which end is which.
    start: new THREE.MeshLambertMaterial({ color: 0x74b06c }),
    end: new THREE.MeshLambertMaterial({ color: 0xb9b3a4 }),
    pillar: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
    issue: new THREE.MeshLambertMaterial({ color: 0xd03b3b }),
    ghost: new THREE.MeshLambertMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.45, depthWrite: false }),
    arrow: new THREE.MeshLambertMaterial({ color: 0xf07818, emissive: 0x904400 }),
    arrowIdle: new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }),
    gate: new THREE.MeshLambertMaterial({ color: 0xd03b3b }),
    horseBody: new THREE.MeshLambertMaterial({ color: 0xf5f0e8 }),
    horseLegs: new THREE.MeshLambertMaterial({ color: 0x574a3a }),
    tower: new THREE.MeshLambertMaterial({ color: 0x8a6a45 }),
    palmTrunk: new THREE.MeshLambertMaterial({ color: 0x9b7347 }),
    palmCrown: new THREE.MeshLambertMaterial({ color: 0x4d9e45 }),
    sand: new THREE.MeshLambertMaterial({ color: 0xe4cf90 }),
    patio: new THREE.MeshLambertMaterial({ color: 0xc9b8a0 }),
    key: new THREE.MeshLambertMaterial({ color: 0xff6b00 })
};

function materialFor(piece, hasIssue) {
    if (hasIssue) return MAT.issue;
    if (piece.type === 'start') return MAT.start;
    if (piece.type === 'end') return MAT.end;
    if (piece.isLift) return MAT.lift;
    if (piece.role) return MAT.switch;
    return piece.radius ? MAT.curve : MAT.ramp;
}

// ---------------------------------------------------------------------------
// Track rebuild
// ---------------------------------------------------------------------------

let pieceMeshes = [];   // one mesh per piece index (switch roles share a mesh)
let arrowMeshes = [];
let elevatorProngs = [];

function issueSet() {
    const s = new Set();
    for (const iss of state.layout.issues) {
        if (iss.code === 'clearance') { s.add(iss.i); s.add(iss.j); }
    }
    return s;
}

function rebuild() {
    state.layout = layoutTrack(state.sequence, {
        slopeDeg: state.slopeDeg,
        innerWidth: state.innerWidth,
        skirtStyle: state.skirtStyle,
        curveRadius: state.curveRadius
    });
    // The lateral half of the physics. It lives outside layoutTrack because
    // clearance.js reads track.js and the cycle would be a real one — so the
    // app is where the two halves get composed. Only bites in custom-parameter
    // mode: the Standard clears it everywhere with room to spare.
    state.layout.issues.push(...checkChannelFit(resolveRidePath(state.layout.pieces), {
        footprint: walkerFootprint({ channelWidthMm: state.innerWidth, walker: state.walker })
    }).issues);
    const { pieces, switches, openEnds } = state.layout;
    const issues = issueSet();

    trackGroup.clear();
    arrowGroup.clear();
    if (!placementKind) ghostGroup.clear(); // any rebuild invalidates a hover ghost
    pieceMeshes = new Array(pieces.length).fill(null);
    arrowMeshes = [];
    elevatorProngs = [];

    // switch parts render as one merged mesh shared by both role pieces
    const switchPairs = new Map();
    for (const pc of pieces) {
        if (pc.switchKey) {
            const pair = switchPairs.get(pc.switchKey) ?? {};
            pair[pc.role] = pc;
            switchPairs.set(pc.switchKey, pair);
        }
    }

    // collision-aware supports first: arch pads and pillars depend on them
    state.supports = planPillarPositions(pieces);
    const supportOf = (idx) => state.supports.find(s => s.pieceIndex === idx);

    for (const pc of pieces) {
        if (pc.role === 'branch') continue; // rendered with its main sibling
        const sup = supportOf(pc.index);
        const pads = supportStations(sup, pc);
        let mesh;
        if (pc.role === 'main') {
            const pair = switchPairs.get(pc.switchKey);
            mesh = new THREE.Mesh(
                buildSwitchDisplayGeometry(pair.main, pair.branch, SPEC, pads, sup),
                materialFor(pc, issues.has(pc.index) || issues.has(pair.branch.index))
            );
            mesh.userData.pieceIndex = pc.index;
            mesh.userData.switchKey = pc.switchKey;
            pieceMeshes[pair.branch.index] = mesh;
        } else {
            mesh = new THREE.Mesh(buildPieceDisplayGeometry(pc, SPEC, pads, sup), materialFor(pc, issues.has(pc.index)));
            mesh.userData.pieceIndex = pc.index;
        }
        mesh.castShadow = mesh.receiveShadow = true;
        addOutline(mesh, 20);
        pieceMeshes[pc.index] = mesh;
        trackGroup.add(mesh);

        if (pc.isElevator) {
            const numProngs = 4;
            const spacing = 240 / numProngs;
            const prongMaterial = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.5 });
            for (let k = 0; k < numProngs; k++) {
                const prong = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 6), prongMaterial);
                prong.castShadow = true;
                trackGroup.add(prong);
                elevatorProngs.push({
                    mesh: prong,
                    piece: pc,
                    offset: k * spacing
                });
            }
        }
    }

    // Add physical bowtie keys at all track joints
    const keyMaterial = MAT.key;
    const keyGeo = toBufferGeometry(buildKeyGeometry(SPEC));
    for (const pc of pieces) {
        if (pc.type !== 'end') {
            const lockedKeyY = pc.exitDeck - 3 - SPEC.key.height + SPEC.jointClearanceMm;
            const keyMesh = new THREE.Mesh(keyGeo, keyMaterial);
            keyMesh.position.set(pc.exit.x, lockedKeyY, pc.exit.z);
            keyMesh.rotation.y = pc.exit.h + Math.PI / 2;
            keyMesh.castShadow = true;
            addOutline(keyMesh, 20);
            trackGroup.add(keyMesh);
        }
    }
    for (const sup of state.supports) {
        const pc = pieces[sup.pieceIndex];
        if (sup.mode === 'none') {
            state.layout.issues.push({
                level: 'warn', code: 'no-support',
                msg: `No clear pillar column under ${pc.name} — it will need a scenery tower or manual support.`
            });
            continue;
        }
        // A piece whose rim IS the ground stands on its own skirt. It still
        // carries the socket boss — every piece does, so there is one straight
        // and one curve, not two of each — but there is nothing for a pier to
        // span, and buildPillarGeometry(0) drew a stub foot under it anyway.
        if (!needsPier(pc)) continue;
        // Ground to mouth, in the order the parts stack: risers, then the jog
        // that steps the column across, then the spacer that makes up whatever
        // the 15 mm grid could not. A grounded minimal piece has no stack at
        // all — its spacer stands on the bed.
        let y = stackHeightMm(pc, sup);
        if (y > 1) trackGroup.add(buildSupportObject(y, sup.x, sup.z));
        const boss = supportBossPos(pc, sup);
        const ringAt = (rx, ry, rz) => {
            const ring = seamRing(0);
            ring.position.set(rx, ry, rz);
            trackGroup.add(ring);
        };
        if (sup.mode === 'jog') {
            if (y > 1) ringAt(sup.x, y, sup.z);       // stack top -> jog
            const jog = makeStackedSupportMesh(supportGeom('jog'), MAT.pillar);
            jog.position.set(sup.x, y, sup.z);
            jog.rotation.y = -Math.atan2(boss.z - sup.z, boss.x - sup.x);
            trackGroup.add(jog);
            y += SPEC.jog.heightMm;
        }
        const spacer = spacerHeightMm(pc);
        if (spacer > 0) {
            if (y > 1) ringAt(boss.x, y, boss.z);     // stack/jog top -> spacer
            const mesh = makeStackedSupportMesh(supportGeom(`spacer:${spacer}`), MAT.pillar);
            mesh.position.set(boss.x, y, boss.z);
            trackGroup.add(mesh);
        }
    }

    // gate blades: hinged on the wall opposite the branch — parked flat along
    // the wall (straight through) or swung in to deflect into the branch
    for (const sw of switches) {
        const pair = switchPairs.get(sw.key);
        const pin = gatePinPosition(pair.main, pair.branch);
        const vane = new THREE.BoxGeometry(GATE.vaneThk, SPEC.railHeight - 2, GATE.len);
        vane.translate(0, (SPEC.railHeight - 2) / 2, GATE.len / 2 - 2); // hinge at one end
        const paddle = new THREE.Mesh(vane, MAT.gate);
        const yaw = sw.gate === 'branch' ? pin.yawDiverting : pin.yawParked;
        paddle.position.set(pin.x, pin.deckY, pin.z);
        paddle.rotation.y = Math.PI / 2 - yaw;
        // `isGate` is what the hit test looks for, NOT switchKey — the switch
        // piece's own mesh carries switchKey too (it needs it to know which
        // pair it belongs to), so a paddle test written against that key
        // matched every click anywhere on the Y and toggled the gate instead
        // of selecting the piece. The paddle is the only thing that is a gate.
        paddle.userData.isGate = true;
        paddle.userData.switchKey = sw.key;
        paddle.userData.pieceIndex = pair.main.index;
        addOutline(paddle, 20);
        trackGroup.add(paddle);
    }

    // construction arrows at every open end (RCT-style)
    const endKeys = openEnds.map(oe => pathKey(oe.containerPath));
    if (!endKeys.includes(state.activeEndKey)) state.activeEndKey = endKeys[0] ?? '[]';
    for (const oe of openEnds) {
        const key = pathKey(oe.containerPath);
        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(14, 30, 4),
            key === state.activeEndKey ? MAT.arrow : MAT.arrowIdle
        );
        cone.position.set(oe.cursor.x, oe.deck + 55, oe.cursor.z);
        cone.rotation.x = Math.PI;
        cone.userData.endKey = key;
        cone.userData.baseY = oe.deck + 55;
        arrowGroup.add(cone);
        arrowMeshes.push(cone);
    }
    document.getElementById('active-end-label').textContent =
        openEnds.length > 1 ? `· building on end ${endKeys.indexOf(state.activeEndKey) + 1}/${endKeys.length}` : '';

    rebuildScenery();
    fitSunShadow();

    refreshSelectionHighlight();
    refreshPieceList();
    refreshPhysicsPanel();
    refreshFooter();
    refreshEditorCard();
    refreshIdleHorse();
    refreshParamsMode();
    refreshSkirtMode();
    refreshPrintPartsList();
    $('btn-connect').disabled = state.layout.isCircuit || !state.sequence.length || state.sequence.some(n => typeof n !== 'string');
    applyRenderMode();
    saveState();
}

function usingStandard() {
    return isStandardParams({ slopeDeg: state.slopeDeg, curveRadius: state.curveRadius, innerWidth: state.innerWidth });
}

// standard support stacks (foot + risers) — cached geometries, one design each
const supportGeomCache = new Map();
function supportGeom(kind) {
    if (!supportGeomCache.has(kind)) {
        // WITH the stamped code, unlike every other display build. Engraving is
        // export-only as a rule because a track rebuild is per-piece and codes
        // would be re-CSG'd on every edit — but support kinds are cached once
        // per session right here, so the scene can show the same mark the
        // printed part carries. That is the point: a stack on screen should
        // read as the parts you will actually pick up, code and all.
        supportGeomCache.set(kind,
            kind === 'foot'
                ? buildSupportFootGeometry(SPEC, { code: partCode('FOOT', GEOMETRY_VERSION) })
                : kind === 'jog'
                    ? toBufferGeometry(buildJogGeometry(SPEC, { code: partCode('JOG', GEOMETRY_VERSION) }))
                    : String(kind).startsWith('spacer:')
                        ? toBufferGeometry(spacerGeometryFor(Number(String(kind).slice(7)), true))
                        : toBufferGeometry(buildRiserGeometry(Number(kind), SPEC,
                            { code: partCode(`R${Number(kind)}`, GEOMETRY_VERSION) })));
    }
    return supportGeomCache.get(kind);
}

/** One spacer, rings and all. `code` is export-only — see buildRiserGeometry. */
function spacerGeometryFor(heightMm, withCode = false, brim = false) {
    const v = spacerVariant(heightMm);
    return buildSpacerGeometry(v.heightMm, SPEC,
        { rings: v.rings, brim, code: withCode ? partCode(v.code, GEOMETRY_VERSION) : null });
}

function makeStackedSupportMesh(geometry, material) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const edges = new THREE.EdgesGeometry(geometry, 20); // 20 degrees threshold
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3d2716, linewidth: 1.5 });
    const lines = new THREE.LineSegments(edges, lineMat);
    group.add(lines);

    return group;
}

/**
 * A SEAM RING where two real parts meet in a stack.
 *
 * Each segment already gets its own EdgesGeometry, but two 15 AF hexes stacked
 * flush share a silhouette, the rim loops coincide, and in the pillar's own
 * dark line colour the boundary vanishes — the stack reads as one extrusion.
 * Brett asked for the opposite: the scene should show WHERE the printed parts
 * are, because that is what you assemble. This is display-only and it marks
 * REAL boundaries; the 15 mm grid marks that were deleted were fake seams
 * inside one part, which is the difference that makes this not a regression.
 *
 * A hex LineLoop a hair outset so it cannot z-fight the faces it sits on, in
 * the light tone the track's HLR lines use — visible against the dark shaft.
 */
function seamRing(y, af = 15) {
    const r = (af / 2) / Math.cos(Math.PI / 6) + 0.3;
    const pts = [];
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xd9c6a5 }));
}

/** A support at (x,z): stacked standard parts on-grid, legacy pillar otherwise. */
function buildSupportObject(heightMm, x, z) {
    const dec = usingStandard() ? decomposeSupport(heightMm) : null;
    if (!dec) {
        const pillarGeo = buildPillarGeometry(heightMm);
        const group = makeStackedSupportMesh(pillarGeo, MAT.pillar);
        group.position.set(x, 0, z);
        return group;
    }
    const g = new THREE.Group();
    const footGroup = makeStackedSupportMesh(supportGeom('foot'), MAT.pillar);
    g.add(footGroup);
    let y = STANDARD.footHeight;
    g.add(seamRing(y));                    // foot-to-riser is a real joint too
    const risers = [...dec.risers].sort((a, b) => b - a);
    for (let i = 0; i < risers.length; i++) {
        const r = risers[i];
        const mGroup = makeStackedSupportMesh(supportGeom(String(r)), MAT.pillar);
        mGroup.position.y = y;
        g.add(mGroup);
        y += r;
        if (i < risers.length - 1) g.add(seamRing(y));
    }
    g.position.set(x, 0, z);
    return g;
}

/**
 * Fit the sun's shadow frustum to what is actually built.
 *
 * It was fixed at ±900 mm, which is 1800 mm across 2048 texels — 0.88 mm per
 * texel, on a part whose thinnest walls are 2.4. A recess like the key slot
 * then has its facing wall and its far wall inside one depth sample and
 * shadows itself, which shows up as diagonal hatching along the top inside
 * edge of the slot: not geometry, and not a material, just the depth map
 * running out of resolution. A four-piece track lives inside ~400 mm, so
 * fitting the frustum buys back 4x of texel density for free, and the bias
 * numbers below stop having to paper over it.
 */
function fitSunShadow() {
    const pieces = state.layout?.pieces ?? [];
    let r = 200, cx = 0, cz = 0;
    if (pieces.length) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const pc of pieces) {
            for (const p of [pc.entry, pc.exit]) {
                x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
                z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
            }
        }
        cx = (x0 + x1) / 2; cz = (z0 + z1) / 2;
        r = Math.max(150, Math.max(x1 - x0, z1 - z0) / 2 + 120);
    }
    const cam = sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.updateProjectionMatrix();
    // keep the light's own direction, just re-aim it at the built track
    sun.position.set(cx + 500, 900, cz + 300);
    sun.target.position.set(cx, 0, cz);
    sun.target.updateMatrixWorld();
}

function refreshSelectionHighlight() {
    const issues = issueSet();
    pieceMeshes.forEach((m, i) => {
        if (!m || m.userData.pieceIndex !== i) return; // branch alias
        const pc = state.layout.pieces[i];
        const base = materialFor(pc, issues.has(i));
        if (i === state.selected || (pc.switchKey && pieceIsSelectedSwitch(pc))) {
            m.material = base.clone();
            m.material.emissive = new THREE.Color(0x118833);
        } else {
            m.material = base;
        }
    });
    updateElevatorProngs(0);
}
const pieceIsSelectedSwitch = (pc) =>
    state.selected >= 0 && state.layout.pieces[state.selected]?.switchKey === pc.switchKey && pc.switchKey;

// ---------------------------------------------------------------------------
// Scenery
// ---------------------------------------------------------------------------

const sceneryCache = new Map();
function sceneryMeshFor(kind) {
    if (!sceneryCache.has(kind)) {
        if (kind === 'tower') {
            sceneryCache.set(kind, () => new THREE.Mesh(toBufferGeometry(buildTowerGeometry(100)), MAT.tower));
        } else if (kind === 'palm') {
            const { island, palm } = buildPalmIslandGeometries();
            sceneryCache.set(kind, () => {
                const g = new THREE.Group();
                g.add(new THREE.Mesh(toBufferGeometry(island), MAT.sand));
                const trunk = new THREE.Mesh(toBufferGeometry(palm), MAT.palmTrunk);
                trunk.position.y = 8;
                g.add(trunk);
                const crownTint = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 1.5, 16), MAT.palmCrown);
                crownTint.position.y = 8 + 67.5;
                g.add(crownTint);
                return g;
            });
        } else {
            sceneryCache.set(kind, () => new THREE.Mesh(toBufferGeometry(buildPatioGeometry()), MAT.patio));
        }
    }
    return sceneryCache.get(kind)();
}

let sceneryMeshes = [];
function rebuildScenery() {
    sceneryGroup.clear();
    sceneryMeshes = [];
    state.scenery.forEach((item, i) => {
        const obj = sceneryMeshFor(item.kind);
        obj.position.set(item.x, 0, item.z);
        obj.rotation.y = item.rot ?? 0;
        obj.traverse(o => {
            if (o.isMesh) {
                o.castShadow = true;
                o.userData.sceneryIndex = i;
                addOutline(o, 20);
            }
        });
        obj.userData.sceneryIndex = i;
        sceneryGroup.add(obj);
        sceneryMeshes.push(obj);
        if (i === state.selectedScenery) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(60, 2, 8, 32).rotateX(Math.PI / 2),
                MAT.arrow
            );
            ring.position.set(item.x, 2, item.z);
            sceneryGroup.add(ring);
        }
    });
    applyRenderMode();
}

let placementKind = null; // scenery kind being placed
let ghostScenery = null;

for (const btn of document.querySelectorAll('[data-scenery]')) {
    btn.addEventListener('click', () => {
        placementKind = btn.dataset.scenery;
        if (ghostScenery) ghostGroup.remove(ghostScenery);
        ghostScenery = sceneryMeshFor(placementKind);
        ghostScenery.traverse(o => { if (o.isMesh) { o.material = MAT.ghost; } });
        ghostGroup.add(ghostScenery);
        toast(`Click the ground to place the ${placementKind} · Esc to cancel`);
    });
}

// ---------------------------------------------------------------------------
// Build palette (appends at the active construction arrow)
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const isHeadEnd = () => state.activeEndKey === '"head"';

function activeContainer() {
    return getContainer(state.sequence, isHeadEnd() ? [] : JSON.parse(state.activeEndKey));
}

/** Appends at the active arrow — or PREPENDS when the loop's head is active. */
function addNodes(...nodes) {
    if (isHeadEnd()) activeContainer().unshift(...nodes);
    else activeContainer().push(...nodes);
}

for (const btn of document.querySelectorAll('[data-add]')) {
    btn.addEventListener('click', () => {
        recordEdit();
        addNodes(btn.dataset.add);
        state.selected = -1;
        rebuild();
    });
    btn.addEventListener('mouseenter', () => showGhostFor(btn.dataset.add));
    btn.addEventListener('mouseleave', clearGhost);
}
for (const btn of document.querySelectorAll('[data-switch]')) {
    btn.addEventListener('click', () => {
        if (isHeadEnd()) { toast('A switch must be the last piece of its branch — build it at a tail arrow.'); return; }
        recordEdit();
        activeContainer().push({ type: btn.dataset.switch, gate: 'main', main: [], branch: [] });
        state.selected = -1;
        rebuild();
        toast('⑂ Switch added — two new build arrows opened. Click a switch to flip its gate.');
    });
}
for (const btn of document.querySelectorAll('[data-spiral]')) {
    btn.addEventListener('click', () => {
        recordEdit();
        const t = btn.dataset.spiral === 'L' ? 'curveL' : 'curveR';
        addNodes(t, t, t, t);
        state.selected = -1;
        rebuild();
    });
}
$('btn-undo').addEventListener('click', doUndo);
$('btn-redo').addEventListener('click', doRedo);
$('btn-clear').addEventListener('click', async () => {
    if (designDirty && state.sequence.length) {
        const ok = await showDialog({
            title: '🗑 Clear the whole design?',
            html: 'You have <b>unsaved changes</b> — the canvas will be wiped.<br>Undo can bring it back afterwards, and <b>Save design</b> exports it first.',
            buttons: [
                { label: 'Cancel', value: false },
                { label: 'Clear design', value: true, danger: true }
            ]
        });
        if (!ok) return;
    }
    recordEdit();
    state.sequence = []; state.scenery = [];
    state.selected = -1; state.selectedScenery = -1; state.activeEndKey = '[]';
    resetSceneSelection();
    rebuild();
});
$('btn-connect').addEventListener('click', async () => {
    if (state.layout.isCircuit) { toast('🔁 Already a closed circuit.'); return; }
    const ends = chainEnds(state.layout);
    if (!ends) { toast('🧲 Nothing to connect — root chains with switches cannot auto-close.'); return; }
    $('btn-connect').disabled = true;
    const solver = createClosureSolver(ends.tail, ends.head, state.layout.params ?? {});
    let r;
    // chunked search: yield to the event loop between batches so the page
    // never freezes, with live progress in the toast
    for (;;) {
        r = solver.step(4000);
        if (r.done) break;
        toast(`🧲 Searching standard tiles… ${(r.expanded / 1000).toFixed(0)}k layouts considered`);
        await new Promise(res => setTimeout(res));
    }
    $('btn-connect').disabled = false;
    const sol = r.result;
    if (!sol) {
        const gap = describeGap(state.layout);
        let hintHtml = '';
        if (gap) {
            hintHtml = `<br><br><span style="font-size:12.5px;color:var(--ink-2);display:block;line-height:1.4">` +
                `💡 <b>Grid alignment tip:</b> Each straight ramp or powered lift drops/climbs 30 mm, and each curve drops 45 mm. ` +
                `If your height is off, try swapping curves for straights (or vice-versa) to shift the height in 15 mm increments, ` +
                `or click on your elevator to adjust its climbing height in the left panel.</span>`;
        }
        await showDialog({
            title: '🧲 No closing path found',
            html: gap
                ? `The gap measures <b>${gap.distMm.toFixed(0)} mm</b> with a <b>${gap.turnQuarters * 90}°</b> heading difference, ` +
                  `ending <b>${Math.abs(gap.deckMm).toFixed(0)} mm ${gap.deckMm >= 0 ? 'above' : 'below'}</b> the start. ` +
                  `No combination of up to 26 canonical tiles lands on a legal seam — try removing a piece near the tail and reconnecting.${hintHtml}`
                : 'This chain has no open ends to connect.'
        });
        return;
    }
    recordEdit();
    state.sequence.push(...sol.moves);
    state.selected = -1;
    rebuild();
    fitView();
    const partsTxt = Object.entries(sol.summary).map(([k, v]) => `${v}× ${k}`).join(', ');
    toast(`🧲 Ends connected with ${sol.moves.length} standard tiles (${partsTxt}) — the design is now a circuit`);
});

/** RCT ghost preview: hypothetical next piece rendered translucent. */
function showGhostFor(type) {
    clearGhost();
    try {
        // only ghost when the active arrow actually exists (a closed loop has
        // no open ends — appending there would overlap the closure seam)
        const endKeys = (state.layout?.openEnds ?? []).map(oe => pathKey(oe.containerPath));
        if (!endKeys.includes(state.activeEndKey)) return;
        const clone = JSON.parse(JSON.stringify(state.sequence));
        let addr;
        if (isHeadEnd()) {
            clone.unshift(type);
            addr = pathKey([0]);
        } else {
            const path = JSON.parse(state.activeEndKey);
            const c = getContainer(clone, path);
            c.push(type);
            addr = pathKey([...path, c.length - 1]);
        }
        const { pieces } = layoutTrack(clone, {
            slopeDeg: state.slopeDeg, innerWidth: state.innerWidth, curveRadius: state.curveRadius
        });
        const pc = pieces.find(p => pathKey(p.address ?? []) === addr);
        if (pc) {
            const m = new THREE.Mesh(buildPieceDisplayGeometry(pc), MAT.ghost);
            if (isHeadEnd()) {
                // prepends re-anchor the hypothetical ring at origin — map the
                // ghost back so its EXIT lands on the current ring's head
                const h = pc.exit.h;
                const ex = pc.exit.x * Math.cos(-h) - pc.exit.z * Math.sin(-h);
                const ez = pc.exit.x * Math.sin(-h) + pc.exit.z * Math.cos(-h);
                m.rotation.y = h;
                m.position.set(-ex, (state.layout.pieces[0]?.entryDeck ?? 0) + SPEC.waterfallStepMm - pc.exitDeck, -ez);
            }
            ghostGroup.add(m);
        }
    } catch { /* ghost is best-effort */ }
}
function clearGhost() {
    if (placementKind) return; // scenery ghost owns the group
    ghostGroup.clear();
}

// --- design persistence -----------------------------------------------------
$('btn-save').addEventListener('click', () => {
    const scene = serializeScene(state, { name: state.name });
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(scene.name || 'track').replace(/\W+/g, '_').toLowerCase()}.klipklop.json`;
    a.click();
    designDirty = false;
    toast('💾 Design saved as a portable scene file');
});
$('btn-open').addEventListener('click', () => $('file-open').click());
$('file-open').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        recordEdit();
        applyScene(JSON.parse(await file.text()));
        syncControls();
        state.selected = -1;
        resetSceneSelection();
        rebuild();
        fitView();
        toast(`📂 Loaded "${state.name}"`);
    } catch (err) {
        toast(`Could not load design: ${err.message}`);
    }
    e.target.value = '';
});
function generateTrackSvg(pieces) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    // Isometric projection angle constants (30 degrees tilt, 45 degrees Y-rotation)
    const cos45 = Math.cos(Math.PI / 4);
    const sin45 = Math.sin(Math.PI / 4);
    const sin30 = Math.sin(Math.PI / 6);

    function project3D(x, y, z) {
        const rotX = (x - z) * cos45;
        const rotZ = (x + z) * sin45;
        // In 3D, y is height (goes up).
        // In SVG, y axis goes down, so we subtract height to move points UP.
        const px = rotX;
        const py = rotZ * sin30 - y * 0.8;
        return { x: px, y: py };
    }

    function updateBounds(px, py) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
    }

    let pathD = '';

    for (const pc of pieces) {
        if (pc.radius) {
            const steps = 16;
            for (let i = 0; i <= steps; i++) {
                const s = (pc.planLen * i) / steps;
                const pos = planPosAt(pc, s);
                const height = pc.entryDeck + (s / pc.planLen) * (pc.exitDeck - pc.entryDeck);
                const proj = project3D(pos.x, height, pos.z);
                updateBounds(proj.x, proj.y);
                if (i === 0) {
                    pathD += ` M ${proj.x.toFixed(1)} ${proj.y.toFixed(1)}`;
                } else {
                    pathD += ` L ${proj.x.toFixed(1)} ${proj.y.toFixed(1)}`;
                }
            }
        } else {
            const projEntry = project3D(pc.entry.x, pc.entryDeck, pc.entry.z);
            const projExit = project3D(pc.exit.x, pc.exitDeck, pc.exit.z);
            updateBounds(projEntry.x, projEntry.y);
            updateBounds(projExit.x, projExit.y);
            pathD += ` M ${projEntry.x.toFixed(1)} ${projEntry.y.toFixed(1)} L ${projExit.x.toFixed(1)} ${projExit.y.toFixed(1)}`;
        }
    }

    if (pieces.length === 0) {
        return `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="10" stroke="var(--ink-3)" stroke-width="2"/></svg>`;
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const size = Math.max(w, h, 10);
    const margin = size * 0.15 + 10;
    const cx = minX + w / 2;
    const cy = minY + h / 2;

    const boxSize = size + 2 * margin;
    const vx = cx - boxSize / 2;
    const vy = cy - boxSize / 2;

    return `<svg viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${boxSize.toFixed(1)} ${boxSize.toFixed(1)}" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="${pathD}" stroke="#ffd76b" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="${pathD}" stroke="#ffffff" stroke-width="1.6" stroke-dasharray="3,3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function resetSceneSelection() {
    const btn = $('btn-scene-picker');
    if (btn) btn.textContent = '📚 Select example scene…';
    const grid = $('scene-grid');
    if (grid) {
        for (const child of grid.children) {
            child.classList.remove('selected');
        }
    }
}

const sceneGrid = $('scene-grid');
const btnScenePicker = $('btn-scene-picker');
const sceneGridDropdown = $('scene-grid-dropdown');

if (sceneGrid && btnScenePicker && sceneGridDropdown) {
    const repositionDropdown = () => {
        if (sceneGridDropdown.style.display === 'block') {
            const rect = btnScenePicker.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom - 12;
            const spaceAbove = rect.top - 12;
            
            if (spaceBelow >= 250 || spaceBelow >= spaceAbove) {
                sceneGridDropdown.style.top = `${rect.bottom + 4}px`;
                sceneGridDropdown.style.bottom = '';
                sceneGridDropdown.style.maxHeight = `${Math.min(400, spaceBelow - 4)}px`;
            } else {
                sceneGridDropdown.style.top = '';
                sceneGridDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
                sceneGridDropdown.style.maxHeight = `${Math.min(400, spaceAbove - 4)}px`;
            }
            
            let left = rect.left;
            if (left + 480 > window.innerWidth) {
                left = Math.max(8, window.innerWidth - 488);
            }
            sceneGridDropdown.style.left = `${left}px`;
        }
    };

    btnScenePicker.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = sceneGridDropdown.style.display === 'block';
        if (isOpen) {
            sceneGridDropdown.style.display = 'none';
        } else {
            sceneGridDropdown.style.display = 'block';
            repositionDropdown();
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.scene-picker-container') && !e.target.closest('#scene-grid-dropdown')) {
            sceneGridDropdown.style.display = 'none';
        }
    });

    window.addEventListener('resize', repositionDropdown);
    const buildPanel = $('build-panel');
    if (buildPanel) {
        buildPanel.addEventListener('scroll', repositionDropdown);
    }

    const sceneFiles = [
        '01-first-ramp', '02-demo-tower', '03-grand-helix',
        '09-switchyard', '10-lift-and-return', '11-palm-resort', '12-perpetual-motion', '15-elevator-showcase'
    ];

    Promise.all(sceneFiles.map(async (filename) => {
        try {
            const res = await fetch(`./scenes/${filename}.json`);
            const json = await res.json();
            return { filename, json };
        } catch (err) {
            console.error(`Failed to load scene ${filename}:`, err);
            return null;
        }
    })).then((results) => {
        const validResults = results.filter(r => r !== null);
        sceneGrid.innerHTML = '';
        for (const { filename, json } of validResults) {
            const card = document.createElement('div');
            card.className = 'scene-card';
            card.dataset.filename = filename;

            const layout = layoutTrack(json.sequence, json.params);
            const svgMarkup = generateTrackSvg(layout.pieces);

            const title = json.name ?? filename.replace(/^\d+-/, '').replace(/-/g, ' ');
            const desc = json.description ?? '';

            card.innerHTML = `
                <div class="scene-thumb">${svgMarkup}</div>
                <div class="scene-info">
                    <div class="scene-title">${title}</div>
                    <div class="scene-desc" title="${desc}">${desc}</div>
                </div>
            `;

            card.addEventListener('click', async () => {
                if (designDirty && state.sequence.length) {
                    const ok = await showDialog({
                        title: '📚 Load example scene?',
                        html: 'You have <b>unsaved changes</b> — the current canvas will be cleared and replaced.<br>Undo can bring it back afterwards.',
                        buttons: [
                            { label: 'Cancel', value: false },
                            { label: 'Load scene', value: true, danger: true }
                        ]
                    });
                    if (!ok) return;
                }

                for (const other of sceneGrid.children) {
                    other.classList.remove('selected');
                }
                card.classList.add('selected');
                btnScenePicker.textContent = `📚 Scene: ${title}`;
                sceneGridDropdown.style.display = 'none';

                try {
                    recordEdit();
                    applyScene(json);
                    syncControls();
                    state.selected = -1;
                    rebuild();
                    fitView();
                    toast(`📚 Loaded scene "${state.name}"`);
                } catch (err) {
                    toast(`Could not load scene: ${err.message}`);
                }
            });

            sceneGrid.appendChild(card);
        }
    });
}

function bindSlider(id, outId, key, fmt, isWalker = false) {
    const el = $(id);
    const target = () => (isWalker ? state.walker : state);
    el.value = target()[key];
    $(outId).textContent = fmt(target()[key]);
    el.addEventListener('input', () => {
        recordEdit(`slider:${id}`); // coalesced: one drag = one undo step
        target()[key] = parseFloat(el.value);
        $(outId).textContent = fmt(target()[key]);
        rebuild();
    });
    el.addEventListener('change', () => history.endGesture());
}
// Parameters are CONSTANT (canonical geometry, semver-stamped) — no sliders.
function refreshSkirtMode() {
    // THE UNDERSIDE PICKER IS GONE. `viaduct` was never a look anyone chose —
    // it was an attempt at the under-deck problem that the cavity fill has
    // since solved, and it audits far worse than what it competed with (56 and
    // 66 mm worst unsupported span against 10 and 10). Every piece is minimal
    // now, so there is nothing to pick and nothing to explain.
}

function refreshParamsMode() {
    $('params-mode').textContent = `STANDARD v${GEOMETRY_VERSION} 🔒`;
}
bindSlider('in-eff', 'out-eff', 'efficiency', v => v.toFixed(2), true);
bindSlider('in-alpha', 'out-alpha', 'alphaDeg', v => `${v}°`, true);
bindSlider('in-leg', 'out-leg', 'legLenMm', v => `${v} mm`, true);
bindSlider('in-mass', 'out-mass', 'massG', v => `${v} g`, true);

const muSel = $('in-mu');
for (const [key, p] of Object.entries(FRICTION_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${p.label} (μs≈${p.mu})`;
    muSel.appendChild(opt);
}
muSel.value = state.muKey;
muSel.addEventListener('change', () => { recordEdit(); state.muKey = muSel.value; rebuild(); });

// Part shape: z-up block vs tilted slab — see normaliseSkirtStyle for the
// styles themselves. A change re-lays the whole track (every piece carries the
// style) and the Print shop's catalogue keys on it, so the next open rebuilds.
const skirtSel = $('in-skirt-style');
if (skirtSel) {
    skirtSel.value = state.skirtStyle;
    skirtSel.addEventListener('change', () => {
        recordEdit();
        state.skirtStyle = normaliseSkirtStyle(skirtSel.value);
        rebuild();
        saveState();
    });
}

$('in-opacity').addEventListener('input', () => {
    state.figureOpacity = parseFloat($('in-opacity').value);
    $('out-opacity').textContent = `${Math.round(state.figureOpacity * 100)}%`;
    if (sim.horse) {
        // swap the ridden figure live; its pose is re-driven from the trace
        scene.remove(sim.horse);
        sim.horse = buildHorse();
        scene.add(sim.horse);
    }
    refreshIdleHorse();
    applyRenderMode();
    saveState();
});

for (const btn of document.querySelectorAll('[data-figstyle]')) {
    btn.addEventListener('click', () => {
        if (sim.running) return;
        if (state.figureStyle === btn.dataset.figstyle) {
            // re-clicking the knight cycles the real-toy helmet variant:
            // back-mounted trumpet plume (owner's) ↔ comb crest + feather (eBay)
            if (state.figureStyle !== 'knight') return;
            recordEdit();
            state.knightVariant = state.knightVariant === 'comb' ? 'trumpet' : 'comb';
        } else {
            recordEdit();
            state.figureStyle = btn.dataset.figstyle;
        }
        syncControls();
        rebuild();
        toast(state.figureStyle === 'knight'
            ? (state.knightVariant === 'comb'
                ? '⚔️ Mike the Knight — comb-crest helmet (click again for trumpet plume)'
                : '⚔️ Mike the Knight — trumpet-plume helmet (click again for comb crest)')
            : '🐴 Classic pony selected');
    });
}

// ---------------------------------------------------------------------------
// Piece list, selection, in-place editing
// ---------------------------------------------------------------------------

/** Per-mesh print-weight estimates from the display geometry (≈ export ±2%). */
function pieceWeightsG() {
    const weights = new Map();
    for (const m of pieceMeshes) {
        if (!m || weights.has(m.userData.pieceIndex)) continue;
        const pos = m.geometry.attributes.position.array;
        const idx = m.geometry.index
            ? m.geometry.index.array
            : Uint32Array.from({ length: m.geometry.attributes.position.count }, (_, i) => i);
        weights.set(m.userData.pieceIndex, printedWeightG(computeMeshVolumeMm3(pos, idx), 'track'));
    }
    return weights;
}

function printJobTotalG(weights) {
    let total = [...weights.values()].reduce((s, g) => s + g, 0);
    for (const sup of state.supports ?? []) {
        if (!supportsPillar(sup)) continue;
        const pc = state.layout.pieces[sup.pieceIndex];
        if (!needsPier(pc)) continue;    // sits on the ground: boss but no pillar
        // pillar ≈ hex shaft AF15 + base/tenon
        total += printedWeightG(195 * pc.rimY + 4200, 'pillar');
    }
    const sceneryG = { tower: 165, palm: 95, patio: 130 }; // per-kind printed grams
    for (const s of state.scenery) total += sceneryG[s.kind] ?? 0;
    total += 2; // connector keys
    return total;
}

function refreshPieceList() {
    const ul = $('piece-list');
    ul.innerHTML = '';
    const issues = issueSet();
    state.layout.pieces.forEach((piece, i) => {
        if (piece.role === 'branch') return; // listed with its switch
        const li = document.createElement('li');
        if (i === state.selected) li.classList.add('selected');
        const depth = (piece.address ?? []).filter(a => typeof a === 'string').length;
        li.style.paddingLeft = `${6 + depth * 14}px`;
        const icon = {
            start: '🏁', end: '🎪', straight: '⬆', curveL: '⟲', curveR: '⟳',
            lift: '⛓', elevator: '🛗', powered: '⚡', switchMain: '⑂'
        }[piece.type] ?? '·';
        const label = piece.type === 'switchMain'
            ? `${piece.name} (gate→${piece.gateOpen ? 'main' : 'branch'})`
            : piece.name;
        li.innerHTML = `<span>${icon}</span><span>${label}</span>` +
            (issues.has(i) ? '<span class="flag" title="clearance conflict">⚠️</span>' : '') +
            (piece.active ? '' : '<span class="flag" title="not on the current ride path">◌</span>');
        li.addEventListener('click', () => selectPiece(i));
        ul.appendChild(li);
    });
    $('parts-heading').innerHTML = 'Parts list';
}

function selectPiece(i) {
    state.selected = state.selected === i ? -1 : i;
    state.selectedScenery = -1;
    refreshSelectionHighlight();
    refreshPieceList();
    refreshEditorCard();
    rebuildScenery();
    if (state.selected >= 0) {
        const pc = state.layout.pieces[state.selected];
        if (!pc.isImplicitStart && !pc.isImplicitEnd) {
            toast(pc.switchKey
                ? `✎ ${pc.name} — G or click again to flip the gate · ⌫ remove · more in the left panel`
                : `✎ ${pc.name} — R cycles its type · ⌫ delete · more tools in the left panel`);
            $('editor-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}

/** R on a selected piece: cycle its type (RCT-style quick edit). */
const TYPE_CYCLE = ['straight', 'curveL', 'curveR', 'lift'];
function cycleSelectedPieceType() {
    const pc = state.layout?.pieces[state.selected];
    if (!pc || pc.isImplicitStart || pc.isImplicitEnd) return false;
    const node = nodeAt(state.sequence, pc.address);
    if (isSwitchNode(node)) { toggleGate(pc.address); return true; }
    recordEdit();
    const container = getContainer(state.sequence, pc.address.slice(0, -1));
    const next = TYPE_CYCLE[(TYPE_CYCLE.indexOf(node) + 1) % TYPE_CYCLE.length];
    container[pc.address[pc.address.length - 1]] = next;
    rebuild();
    toast(`⇄ ${pc.name} → ${next}`);
    return true;
}

/** In-place piece editor (the RCT "modify highlighted piece" panel). */
function refreshEditorCard() {
    const card = $('editor-card');
    const pc = state.layout?.pieces[state.selected];
    if (!pc || pc.isImplicitStart || pc.isImplicitEnd) { card.style.display = 'none'; return; }
    card.style.display = '';
    const node = nodeAt(state.sequence, pc.address);
    if (isSwitchNode(node)) {
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <b>Editing: ${pc.name}</b>
                <button id="ed-close" style="font-size: 11px; padding: 2px 6px; border: none; background: transparent; color: var(--ink-2); cursor: pointer;" title="Stop editing (deselect)">✖</button>
            </div>
            <span style="color:var(--ink-2)">gate feeds the <b>${node.gate}</b> route</span>
            <div class="btn-grid" style="margin-top:8px">
                <button id="ed-gate">⇄ Flip gate</button>
                <button id="ed-del" style="color:var(--critical)">🗑 Remove</button>
            </div>
            <div style="color:var(--ink-2);margin-top:6px;font-size:11.5px">
                Removing keeps the main route's pieces; the branch is discarded.</div>`;
        $('ed-close').onclick = () => {
            state.selected = -1;
            state.selectedScenery = -1;
            refreshSelectionHighlight();
            refreshPieceList();
            refreshEditorCard();
            rebuildScenery();
        };
        $('ed-gate').onclick = () => { toggleGate(pc.address); };
        $('ed-del').onclick = () => {
            recordEdit();
            const container = getContainer(state.sequence, pc.address.slice(0, -1));
            const idx = pc.address[pc.address.length - 1];
            container.splice(idx, 1, ...(node.main ?? []));
            state.selected = -1;
            rebuild();
        };
        return;
    }
    const nodeType = typeof node === 'string' ? node : node.type;
    const types = [
        ['straight', '⬆ Straight'],
        ['curveL', '⟲ Left'],
        ['curveR', '⟳ Right'],
        ['lift', '⛓ Lift'],
        ['elevator', '⛶ Elevator']
    ];
    const loopOrigin = state.layout?.isCircuit && pc.address.length === 1;
    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <b>Editing: ${pc.name}</b>
            <button id="ed-close" style="font-size: 11px; padding: 2px 6px; border: none; background: transparent; color: var(--ink-2); cursor: pointer;" title="Stop editing (deselect)">✖</button>
        </div>
        <div class="btn-grid" style="margin-top:8px">
            ${types.map(([t, l]) =>
                `<button data-ed-type="${t}" ${t === nodeType ? 'disabled' : ''}>${l}</button>`).join('')}
            <button id="ed-ins">＋ Insert straight before</button>
            <button id="ed-del" style="color:var(--critical)">🗑 Delete</button>
            ${loopOrigin ? '<button id="ed-origin" class="wide" title="Rotate the ring so this piece anchors at the world origin">🔁 Set as loop origin</button>' : ''}
        </div>
        ${nodeType === 'elevator' ? `
        <div style="margin-top: 10px; display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 12px; color: var(--ink-2)">Climb height:</span>
            <select id="ed-elevator-height" style="font-size: 12px; padding: 4px; border-radius: 4px; border: 1px solid var(--line); background: var(--bg); color: var(--ink);">
                <option value="60">60 mm</option>
                <option value="75">75 mm</option>
                <option value="90">90 mm (Default)</option>
                <option value="105">105 mm</option>
                <option value="120">120 mm</option>
                <option value="135">135 mm</option>
                <option value="150">150 mm</option>
            </select>
        </div>` : ''}
        <div style="color:var(--ink-2);margin-top:6px;font-size:11.5px">
            Changes re-lay the downstream track automatically (Auto-Z).</div>`;

    $('ed-close').onclick = () => {
        state.selected = -1;
        state.selectedScenery = -1;
        refreshSelectionHighlight();
        refreshPieceList();
        refreshEditorCard();
        rebuildScenery();
    };

    if (nodeType === 'elevator') {
        const heightVal = node.height ?? 90;
        $('ed-elevator-height').value = String(heightVal);
        $('ed-elevator-height').onchange = (e) => {
            recordEdit();
            const container = getContainer(state.sequence, pc.address.slice(0, -1));
            const idx = pc.address[pc.address.length - 1];
            const currentVal = container[idx];
            if (typeof currentVal === 'string') {
                container[idx] = { type: 'elevator', height: parseInt(e.target.value) };
            } else {
                container[idx].height = parseInt(e.target.value);
            }
            rebuild();
        };
    }

    if (loopOrigin) {
        $('ed-origin').onclick = () => {
            recordEdit();
            const i = pc.address[0];
            state.sequence = [...state.sequence.slice(i), ...state.sequence.slice(0, i)];
            state.selected = -1;
            rebuild();
            fitView();
            toast('🔁 Ring re-anchored — this piece is now the loop origin');
        };
    }
    for (const b of card.querySelectorAll('[data-ed-type]')) {
        b.onclick = () => {
            recordEdit();
            const container = getContainer(state.sequence, pc.address.slice(0, -1));
            const val = b.dataset.edType === 'elevator' ? { type: 'elevator', height: 90 } : b.dataset.edType;
            container[pc.address[pc.address.length - 1]] = val;
            rebuild();
        };
    }
    $('ed-ins').onclick = () => {
        recordEdit();
        const container = getContainer(state.sequence, pc.address.slice(0, -1));
        container.splice(pc.address[pc.address.length - 1], 0, 'straight');
        state.selected = -1;
        rebuild();
    };
    $('ed-del').onclick = () => {
        recordEdit();
        const container = getContainer(state.sequence, pc.address.slice(0, -1));
        container.splice(pc.address[pc.address.length - 1], 1);
        state.selected = -1;
        rebuild();
    };
}

function toggleGate(address) {
    recordEdit();
    const node = nodeAt(state.sequence, address);
    node.gate = node.gate === 'branch' ? 'main' : 'branch';
    rebuild();
    toast(`⑂ Gate now feeds the ${node.gate} route`);
}

// ---------------------------------------------------------------------------
// Pointer interaction: select, gates, arrows, scenery place/drag
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let draggingScenery = -1;

function ndcFromEvent(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
}
function groundPointAt(e) {
    raycaster.setFromCamera(ndcFromEvent(e), camera);
    const pt = new THREE.Vector3();
    return raycaster.ray.intersectPlane(groundPlane, pt) ? pt : null;
}

function snapToHexGrid(x, z, D) {
    const c_approx = Math.round(x / (D * Math.sqrt(3) / 2));
    const r_approx = Math.round((z - (Math.abs(c_approx) % 2 === 1 ? D / 2 : 0)) / D);
    let bestX = x, bestZ = z, minDist = Infinity;
    for (let dc = -2; dc <= 2; dc++) {
        for (let dr = -2; dr <= 2; dr++) {
            const c = c_approx + dc;
            const r = r_approx + dr;
            const cx = c * D * Math.sqrt(3) / 2;
            const cz = r * D + (Math.abs(c) % 2 === 1 ? D / 2 : 0);
            const dx = x - cx;
            const dz = z - cz;
            const dist2 = dx * dx + dz * dz;
            if (dist2 < minDist) {
                minDist = dist2;
                bestX = cx;
                bestZ = cz;
            }
        }
    }
    return { x: bestX, z: bestZ };
}

function snapScenery(kind, pt) {
    if (!pt) return { x: 0, z: 0 };
    const SNAP_DIST = 15;
    if (state.supports) {
        for (const sup of state.supports) {
            if (!supportsPillar(sup)) continue;
            const dx = pt.x - sup.x;
            const dz = pt.z - sup.z;
            if (dx * dx + dz * dz < SNAP_DIST * SNAP_DIST) {
                return { x: sup.x, z: sup.z };
            }
        }
    }
    if (kind === 'palm') {
        return snapToHexGrid(pt.x, pt.z, 84);
    } else if (kind === 'tower') {
        return snapToHexGrid(pt.x, pt.z, 44);
    } else if (kind === 'patio') {
        return {
            x: Math.round(pt.x / 75) * 75,
            z: Math.round(pt.z / 75) * 75
        };
    }
    return { x: Math.round(pt.x), z: Math.round(pt.z) };
}

renderer.domElement.addEventListener('pointermove', (e) => {
    if (placementKind && ghostScenery) {
        const pt = groundPointAt(e);
        if (pt) {
            const snapped = snapScenery(placementKind, pt);
            ghostScenery.position.set(snapped.x, 0, snapped.z);
        }
    }
    if (draggingScenery >= 0) {
        const pt = groundPointAt(e);
        if (pt) {
            const item = state.scenery[draggingScenery];
            const snapped = snapScenery(item.kind, pt);
            item.x = snapped.x;
            item.z = snapped.z;
            rebuildScenery();
        }
    }
});

renderer.domElement.addEventListener('pointerdown', (e) => {
    // Dynamically update orbit target to the clicked intersection point
    if (!placementKind && draggingScenery === -1) {
        const ndc = ndcFromEvent(e);
        raycaster.setFromCamera(ndc, camera);
        
        const targets = [];
        if (jointGuideState.active && jointGuideState.group) {
            targets.push(jointGuideState.group);
        } else {
            targets.push(trackGroup);
            targets.push(sceneryGroup);
        }
        
        const hits = raycaster.intersectObjects(targets, true);
        let targetPoint = null;
        if (hits.length > 0) {
            targetPoint = hits[0].point;
        } else {
            // Fall back to ground plane intersection
            const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
            const intersection = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(plane, intersection)) {
                if (intersection.distanceTo(camera.position) < 800) {
                    targetPoint = intersection;
                }
            }
        }
        
        if (targetPoint) {
            // Project target point onto camera forward ray to avoid visual jumps
            const cameraDir = new THREE.Vector3();
            camera.getWorldDirection(cameraDir);
            const toTarget = new THREE.Vector3().subVectors(targetPoint, camera.position);
            const depth = toTarget.dot(cameraDir);
            if (depth > 2 && depth < 2000) {
                const newTarget = new THREE.Vector3().copy(camera.position).addScaledVector(cameraDir, depth);
                controls.target.copy(newTarget);
                controls.update();
            }
        }
    }

    if (e.button !== 0) return;
    if (placementKind) {
        const pt = groundPointAt(e);
        if (pt) {
            recordEdit();
            const snapped = snapScenery(placementKind, pt);
            state.scenery.push({ kind: placementKind, x: snapped.x, z: snapped.z, rot: 0 });
            cancelPlacement();
            state.selectedScenery = state.scenery.length - 1;
            rebuildScenery();
            saveState();
        }
        return;
    }
    // begin drag on selected scenery
    raycaster.setFromCamera(ndcFromEvent(e), camera);
    const sceneryHit = raycaster.intersectObjects(sceneryGroup.children, true)
        .find(h => h.object.userData.sceneryIndex !== undefined);
    if (sceneryHit && sceneryHit.object.userData.sceneryIndex === state.selectedScenery) {
        recordEdit(`drag:scenery${state.selectedScenery}`);
        draggingScenery = state.selectedScenery;
        controls.enabled = false;
        return;
    }

    const down = { x: e.clientX, y: e.clientY };
    const up = (e2) => {
        renderer.domElement.removeEventListener('pointerup', up);
        if (Math.hypot(e2.clientX - down.x, e2.clientY - down.y) > 5) return; // orbit drag
        raycaster.setFromCamera(ndcFromEvent(e2), camera);

        const arrowHit = raycaster.intersectObjects(arrowMeshes, false)[0];
        if (arrowHit) {
            state.activeEndKey = arrowHit.object.userData.endKey;
            rebuild();
            toast('🔨 Construction arrow moved — new pieces build here');
            return;
        }
        const scHit = raycaster.intersectObjects(sceneryGroup.children, true)
            .find(h => h.object.userData.sceneryIndex !== undefined);
        if (scHit) {
            state.selectedScenery = scHit.object.userData.sceneryIndex;
            state.selected = -1;
            rebuildScenery(); refreshSelectionHighlight(); refreshEditorCard();
            toast('Drag to move · R rotate · ⌫ remove');
            return;
        }
        const paddleHit = raycaster.intersectObjects(trackGroup.children, true)
            .find(h => h.object.userData.isGate);
        if (paddleHit) {
            const idx = paddleHit.object.userData.pieceIndex;
            const pc = state.layout.pieces[idx];
            toggleGate(pc.address);
            return;
        }

        const hits = raycaster.intersectObjects(pieceMeshes.filter(Boolean), false);
        if (hits.length) {
            const idx = hits[0].object.userData.pieceIndex;
            const pc = state.layout.pieces[idx];
            if (pc.switchKey && state.selected === idx) {
                toggleGate(pc.address);
            } else {
                selectPiece(idx);
            }
        } else {
            if (state.selected >= 0 || state.selectedScenery >= 0) {
                state.selected = -1;
                state.selectedScenery = -1;
                refreshSelectionHighlight();
                refreshPieceList();
                refreshEditorCard();
                rebuildScenery();
            }
        }
    };
    renderer.domElement.addEventListener('pointerup', up);
});

renderer.domElement.addEventListener('pointerup', () => {
    if (draggingScenery >= 0) {
        draggingScenery = -1;
        controls.enabled = true;
        history.endGesture();
        saveState();
    }
});

function cancelPlacement() {
    placementKind = null;
    if (ghostScenery) { ghostGroup.remove(ghostScenery); ghostScenery = null; }
    ghostGroup.clear();
}

document.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.shiftKey ? doRedo() : doUndo();
        return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        e.preventDefault();
        doRedo();
        return;
    }
    if (e.key === 'Escape') {
        if ($('doc-overlay').style.display !== 'none') { $('doc-overlay').style.display = 'none'; return; }
        if ($('refs-overlay').style.display !== 'none') { $('refs-overlay').style.display = 'none'; return; }
        cancelPlacement();
    }
    if (e.key === ' ') {
        e.preventDefault();
        if (sim.running) {
            togglePause();
        } else {
            startSim();
        }
        return;
    }
    if (e.key === 'r' || e.key === 'R') {
        if (state.selectedScenery >= 0) {
            recordEdit(`rot:scenery${state.selectedScenery}`);
            state.scenery[state.selectedScenery].rot =
                ((state.scenery[state.selectedScenery].rot ?? 0) + Math.PI / 6) % (Math.PI * 2);
            rebuildScenery();
            saveState();
        } else if (state.selected >= 0) {
            cycleSelectedPieceType();
        }
    }
    if ((e.key === 'g' || e.key === 'G') && state.selected >= 0) {
        const pc = state.layout.pieces[state.selected];
        if (pc?.switchKey) toggleGate(pc.address);
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
        if (state.selectedScenery >= 0) {
            recordEdit();
            state.scenery.splice(state.selectedScenery, 1);
            state.selectedScenery = -1;
            rebuildScenery();
            saveState();
        } else if (state.selected >= 0) {
            const pc = state.layout.pieces[state.selected];
            if (pc && !pc.isImplicitStart && !pc.isImplicitEnd) {
                recordEdit();
                const node = nodeAt(state.sequence, pc.address);
                const container = getContainer(state.sequence, pc.address.slice(0, -1));
                const idx = pc.address[pc.address.length - 1];
                if (isSwitchNode(node)) container.splice(idx, 1, ...(node.main ?? []));
                else container.splice(idx, 1);
                state.selected = -1;
                rebuild();
            }
        }
    }
});

$('btn-fit').addEventListener('click', fitView);
function fitView() {
    const box = new THREE.Box3().setFromObject(trackGroup);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    controls.target.copy(c);
    const dir = new THREE.Vector3(1, 0.75, 1).normalize();
    camera.position.copy(c).addScaledVector(dir, Math.max(size * 1.1, 400));
}

// ---------------------------------------------------------------------------
// Physics panel
// ---------------------------------------------------------------------------

function physOpts() {
    // The stride ratchet only exists where there are ridges to grip — the
    // washboard preset gets the Standard pitch, the smooth presets none.
    return { mu: FRICTION_PRESETS[state.muKey].mu, walker: state.walker,
             ridgePitchMm: state.muKey === 'washboard' ? SPEC.ridge.pitch : 0 };
}

function refreshPhysicsPanel() {
    const opts = physOpts();
    const zone = goldilocksRange(opts);
    renderGauge(zone);

    const ridePath = resolveRidePath(state.layout.pieces);
    const r = assessSlope(state.slopeDeg, opts);
    const v = trackVerdict(ridePath, opts);
    const chip = r.status === 'walk'
        ? '<span class="chip walk">✔ WALKS</span>'
        : r.status === 'stall'
            ? '<span class="chip warn">⏸ STALLS</span>'
            : `<span class="chip fail">✖ ${r.status.toUpperCase()}S</span>`;
    const liftCount = ridePath.filter(p => p.isLift).length;
    $('verdict-card').innerHTML = `
        <div style="margin-bottom:8px">${chip}${liftCount ? ` <span class="chip warn">⛓ ${liftCount} lift${liftCount > 1 ? 's' : ''}</span>` : ''}</div>
        <div class="statgrid">
            <div><div class="k">Trot speed</div><div class="v">${r.speedMmS.toFixed(0)} mm/s</div></div>
            <div><div class="k">Cadence</div><div class="v">${r.stepHz.toFixed(1)} clacks/s</div></div>
            <div><div class="k">Stride</div><div class="v">${r.strideMm.toFixed(1)} mm</div></div>
            <div><div class="k">Descent time</div><div class="v">${v.descentTimeS ? v.descentTimeS.toFixed(1) + ' s' : '—'}</div></div>
        </div>
        <div style="margin-top:8px;color:var(--ink-2)">${r.detail}</div>`;

    const vol = figureVolumeEstimate(FIGURE.widthMm, state.figureStyle);
    const bp = ballastPlan(vol, 15, state.walker.massG);
    const W = FIGURE.widthMm;
    const capacityG = (Math.PI * 16 * W * 0.6 * 0.0078) + (Math.PI * 12.25 * FIGURE.pendulumW * 0.6 * 0.0078);
    const overCap = bp.ballastG > capacityG;
    $('ballast-card').innerHTML = `
        <div class="statgrid">
            <div><div class="k">Printed plastic</div><div class="v">${bp.plasticG.toFixed(1)} g</div></div>
            <div><div class="k">Target mass</div><div class="v">${state.walker.massG} g</div></div>
            <div><div class="k">Metal ballast</div><div class="v">${bp.ballastG.toFixed(1)} g</div></div>
            <div><div class="k">≈ steel BBs</div><div class="v">${bp.bbCount}</div></div>
        </div>
        <div style="margin-top:8px;color:var(--ink-2)">
            Bore capacity ≈ ${capacityG.toFixed(0)} g of BBs.
            ${overCap ? '<b>Target exceeds bore capacity</b> — use tungsten putty (~2× denser) or lower the target.' :
                'Fill the body bore low and rear-biased, then glue every plug.'}
        </div>`;
}

function renderGauge(zone) {
    const g = $('gauge');
    const MIN = 4, MAX = 18;
    const pct = (d) => ((d - MIN) / (MAX - MIN)) * 100;
    const zones = [
        { from: MIN, to: SPEC.slope.hardMin, color: 'var(--critical)', label: 'stall' },
        { from: SPEC.slope.hardMin, to: SPEC.slope.greenMin, color: 'var(--warning)', label: 'marginal' },
        { from: SPEC.slope.greenMin, to: SPEC.slope.greenMax, color: 'var(--good)', label: 'sweet spot' },
        { from: SPEC.slope.greenMax, to: SPEC.slope.hardMax, color: 'var(--warning)', label: 'marginal' },
        { from: SPEC.slope.hardMax, to: MAX, color: 'var(--critical)', label: 'slide / tumble' }
    ];
    const bandHtml = zones.map(z =>
        `<div class="zone" style="width:${pct(z.to) - pct(z.from)}%;background:${z.color}" title="${z.label}: ${z.from}–${z.to}°"></div>`
    ).join('');
    const status = assessSlope(state.slopeDeg, physOpts()).status;
    const modelTxt = zone.minDeg
        ? `model predicts this figure walks from ${zone.minDeg.toFixed(1)}° to ${zone.maxDeg.toFixed(1)}°`
        : 'model finds no walkable slope for these settings';
    g.innerHTML = `
        <div class="band">${bandHtml}
            <div class="needle" style="left:calc(${pct(state.slopeDeg)}% - 1.5px)"></div>
        </div>
        <div class="scale"><span>4°</span><span>8°</span><span>11°</span><span>14°</span><span>18°</span></div>
        <div class="readout"><b>${state.slopeDeg}°</b> → <b>${status}</b> · ${modelTxt}</div>`;
}

const MATRIX = [
    ['Toy slides without walking', 'Slope too steep, friction too low, or hoof cam too flat', 'Reduce slope 2°. Use the washboard finish. Verify the hoof arcs printed smooth (parts must lie on their sides).'],
    ['Toy stops / stalls mid-ramp', 'Slope too shallow or axle friction too high', 'Increase slope. Ream the axle bores, add dry graphite to the metal pin. Raise axle-quality in the model to see the effect.'],
    ['Toy tips forward and falls', 'Center of mass too high or too far forward', 'Move ballast lower and rearward in the bore. Slightly flatten the front of the hoof cam.'],
    ['Toy turns sideways and jams', 'Figure too wide for the turn, or legs asymmetric', 'The channel is 48 mm and a real Klip Klop measures 38 — that pairing is measured, not tunable, and it clears the tightest legal curve with 3.4 mm to spare. Check the figure is under 41 mm across and that both hooves weigh the same.'],
    ['Swinging leg barely moves', 'Pendulum rubbing inside the slot', 'Sand the pendulum faces; add thin washers on the axle as spacers; confirm 0.5 mm clearance per side.'],
    ['Horse stumbles at a seam', 'Uphill lip at the joint', 'Exports drop each downhill floor 0.25 mm (waterfall rule) — check the printed seam for blobs and re-seat the bowtie key.'],
    ['Horse stops at a switch', 'Gate vane misaligned, or the gate has drifted off its position', 'The vane must clear the selected route completely. Do NOT ream the bore: the pivot is a SPLIT PIN that grips by spring, and the grip is what holds the gate against the figure. If it is stiff, work it back and forth to bed the C in.']
];
$('matrix').innerHTML = MATRIX.map(([sym, cause, fix]) => `
    <details class="matrix"><summary>${sym}</summary>
        <div class="fix"><b style="color: var(--critical);">Cause:</b> ${cause}<br><b style="color: var(--good);">Fix:</b> ${fix}</div>
    </details>`).join('');

function refreshFooter() {
    const { pieces, issues, totalDropMm } = state.layout;
    $('ft-pieces').textContent = `${pieces.length} pieces · ${state.layout.isCircuit ? '🔁 circuit' : '⛰ open run'}`;
    $('ft-drop').textContent = `ride drop ${totalDropMm.toFixed(0)} mm`;
    const rideLen = resolveRidePath(pieces).reduce((s, p) => s + p.planLen, 0);
    $('ft-run').textContent = `ride ${rideLen.toFixed(0)} mm`;
    const errs = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    $('ft-issues').textContent = errs.length
        ? `⛔ ${errs[0].msg}`
        : warns.length ? `⚠️ ${warns[0].msg}` : '✅ layout OK';
}

// tabs (single side panel: Build | Print | Physics; Refs opens from the header toolbar)
const TABS = ['build', 'export', 'physics', 'joint'];
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => setTab(t));

const jointGuideState = { active: false, group: null, leftTrack: null, rightTrack: null, bowtieKey: null, seamGapIndicator: null, t: 0, seamX: 0, seamZ: 0, seamDeckY: 0 };

/**
 * A piece's export geometry, put back where the piece actually sits.
 *
 * `buildPieceExportGeometry` builds in the piece's OWN frame — entry at the
 * origin, heading +X, rim at y = 0 — because running the booleans out at
 * x≈400 in a spiral costs float precision. Everything that EXPORTS a part
 * wants it there. The joint guide and its section views do not: they were
 * written against world coordinates and reason about the seam by its world
 * address, so when the frame moved they quietly lost their track pieces —
 * geometry built, no error, sitting 150 mm from where the seam maths looked
 * for it. Undoing the frame is a proper rotation about Y and a translation;
 * never an axis swap, which would mirror the bowtie flare.
 */
function pieceExportRawInWorld(piece, opts) {
    const f = pieceFrame(piece);
    const raw = buildPieceExportGeometry(piece, opts);
    const p = Float32Array.from(raw.positions);
    const c = Math.cos(f.h), s = Math.sin(f.h);
    for (let i = 0; i < p.length; i += 3) {
        const x = p[i], z = p[i + 2];
        p[i] = f.x + x * c - z * s;
        p[i + 1] += f.y;
        p[i + 2] = f.z + x * s + z * c;
    }
    return { positions: p, indices: raw.indices };
}

/** The same, as a BufferGeometry, for the meshes and edge sets. */
function pieceExportGeometryInWorld(piece, opts) {
    return toBufferGeometry(pieceExportRawInWorld(piece, opts));
}

function initJointGuide() {
    if (jointGuideState.group) return;
    
    const group = new THREE.Group();
    scene.add(group);
    jointGuideState.group = group;
    
    // Generate track pieces for the joint demo - using standard slope to show real ramp pieces
    const { pieces } = layoutTrack(['straight', 'straight'], { slopeDeg: STANDARD.slopeDeg });
    
    // Save seam position and Y deck height dynamically (which accounts for ground shift!)
    const seamX = pieces[1].exit.x;
    const seamZ = pieces[1].exit.z;
    const seamDeckY = pieces[1].exitDeck;
    
    jointGuideState.seamX = seamX;
    jointGuideState.seamZ = seamZ;
    jointGuideState.seamDeckY = seamDeckY;
    // lowest rim of the two mating pieces — the key has to clear this before it
    // can rise into the pockets
    jointGuideState.rimFloor = Math.min(pieces[1].rimY, pieces[2].rimY);
    
    // Ghosted shell, NOT glass. `transmission` refracts and re-lights every
    // surface behind it, which is exactly what buried the pocket: the rib, the
    // floor and the far wall all ended up the same value. A flat low-opacity
    // front-faces-only shell keeps the part readable and lets the hidden-line
    // pass below carry the shape information.
    // depthWrite stays off (the prepass owns the depth buffer), but depthTest
    // is now meaningful because the prepass filled it — so these faces are
    // correctly hidden behind nearer geometry instead of blending through it.
    const trackMaterial = new THREE.MeshLambertMaterial({
        color: 0xe4e9ef,
        opacity: 0.22,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide
    });
    
    // Create solid high-visibility orange/gold plastic for the bowtie key
    const keyMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xff6b00,
        roughness: 0.3,
        metalness: 0.1,
        clearcoat: 0.4
    });

    const leftGeo = pieceExportGeometryInWorld(pieces[1]);
    const rightGeo = pieceExportGeometryInWorld(pieces[2]);
    const keyGeo = toBufferGeometry(buildKeyGeometry(SPEC));
    
    const leftMesh = new THREE.Mesh(leftGeo, trackMaterial);
    const rightMesh = new THREE.Mesh(rightGeo, trackMaterial.clone());
    const keyMesh = new THREE.Mesh(keyGeo, keyMaterial);
    
    // True two-pass hidden-line: the SAME edge set drawn twice. The depth-tested
    // pass yields solid lines only where the edge is actually visible; the
    // depth-ignoring pass fills in the occluded edges faintly. That contrast is
    // what tells you a pocket recedes instead of reading as a painted outline.
    //
    // 32° threshold (was 20°): the washboard ridges meet at ~26°, so a 20°
    // threshold emitted an edge for every ripple — hundreds of lines of noise
    // that swamped the joint. 32° keeps structural edges and drops the ripples.
    // WebGL ignores LineBasicMaterial.linewidth (always 1px), and Line2/
    // LineMaterial isn't vendored — so prominence has to come from CONTRAST,
    // not thickness: near-black visible edges against a 10%-opacity shell, and
    // hidden edges at a mid blue strong enough to trace but clearly secondary.
    // 45°, not 32°: the washboard is sampled 6× per 2.5 mm ridge, so at the
    // crests the facet-to-facet angle reaches ~38° and every ridge was emitting
    // a pair of edges — ~120 lines of comb across the floor, showing straight
    // through the ghost as hidden lines and burying the joint. Structural
    // corners are 90°, so 45° drops the ripples and keeps everything that
    // describes the shape.
    const edgeThreshold = 45;
    // Widths are in pixels; `resolution` must track the canvas or the shader
    // computes the wrong screen-space thickness (see jointLineMats/onResize).
    const res = new THREE.Vector2(viewport.clientWidth, viewport.clientHeight);
    // Charcoal, not blue: the hidden/visible distinction is carried by weight
    // and opacity, so the colour doesn't need to do the work — and a saturated
    // hue on every occluded edge just competes with the orange key.
    // Charcoal, not blue — and the hidden pass is DASHED. Grey-on-grey can't
    // win on colour contrast alone, so it uses the drafting convention
    // instead: solid = visible edge, dashed = edge behind material. That reads
    // instantly and stops the occluded geometry competing with the key.
    const track = (m) => { jointGuideState.lineMats.push(m); return m; };
    const visibleLineMat = () => track(new LineMaterial({ color: 0x14171a, linewidth: 2.4, resolution: res }));
    // Dash lengths are WORLD units (mm), not screen units, so perspective and
    // foreshortening already vary their apparent size — a near-1:1 dash:gap
    // ratio on top of that fragments every short edge into sketchy specks.
    // ~3:1, the drafting convention, gives a much calmer rhythm and keeps the
    // shorter pocket/boss edges reading as continuous lines.
    const hiddenLineMat = () => track(new LineMaterial({
        color: 0x2f3439, linewidth: 1.8, resolution: res,
        transparent: true, opacity: 0.95, depthTest: false,
        dashed: true, dashSize: 4.2, gapSize: 1.5
    }));
    jointGuideState.lineRes = res;
    jointGuideState.lineMats = [];

    /**
     * DEPTH PREPASS — the piece that makes this an actual hidden-line render.
     *
     * The ghost shell must not write depth (transparent surfaces would occlude
     * each other in draw order, not in space). But with NOTHING writing depth,
     * the depth buffer stays empty, so the depth-tested edge pass has nothing
     * to be occluded by and every edge draws as "visible" — no hidden-line
     * separation at all, and the shells pile up as unsorted grey.
     *
     * So: draw the geometry first with colour writes OFF and depth writes ON.
     * The buffer then holds the true front surfaces, and everything after it
     * — ghost faces, visible edges — is occluded correctly. polygonOffset
     * pushes the prepass a hair back so coincident edges win the depth test
     * instead of z-fighting with the surface they sit on.
     */
    const prepassMat = () => new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
    });

    const addTrack = (geo, mesh) => {
        const g = new THREE.Group();
        const place = (o, order) => {
            o.position.set(-seamX, 0, -seamZ);    // offset so seam is at 0 locally
            o.renderOrder = order;
            g.add(o);
        };
        place(new THREE.Mesh(geo, prepassMat()), -10);
        place(mesh, 1);
        const fat = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(geo, edgeThreshold));
        // hidden first so the visible pass paints over it where they coincide
        const hid = new LineSegments2(fat, hiddenLineMat());
        hid.computeLineDistances();          // required before dashes render
        place(hid, 2);
        place(new LineSegments2(fat, visibleLineMat()), 3);
        group.add(g);
        return g;
    };

    jointGuideState.leftTrack = addTrack(leftGeo, leftMesh);
    jointGuideState.rightTrack = addTrack(rightGeo, rightMesh);
    
    const keyGroup = new THREE.Group();
    // The depth prepass writes the TRACK's depth, so an ordinarily depth-tested
    // key gets clipped away behind shells that are meant to be see-through.
    // Same two-pass treatment the edges get: the solid key shows where it is
    // genuinely visible, and a dimmer depthTest-free copy shows the part buried
    // in the pockets — which is the half that matters.
    keyMesh.renderOrder = -1;
    keyGroup.add(keyMesh);

    const keyGhost = new THREE.Mesh(keyGeo, new THREE.MeshBasicMaterial({
        color: 0xd4692a, transparent: true, opacity: 0.5, depthTest: false
    }));
    keyGhost.renderOrder = 4;
    keyGroup.add(keyGhost);

    const keyFat = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(keyGeo, edgeThreshold));
    const keyLines = new LineSegments2(keyFat, track(new LineMaterial({
        color: 0x3a1400, linewidth: 2.2, resolution: res, depthTest: false
    })));
    keyLines.renderOrder = 5;
    keyGroup.add(keyLines);
    
    // Rotate the key to align with the pocket (which is perpendicular to the track running along X)
    keyGroup.rotation.y = pieces[1].exit.h + Math.PI / 2;
    group.add(keyGroup);
    jointGuideState.bowtieKey = keyGroup;
    
    // Lock-state flash at the joint. It is a HUD annotation, not part of the
    // assembly, so it must not be sliced by the depth prepass — a flat ring
    // lying inside the track was getting cut into disconnected crescents by the
    // surfaces it passed through. depthTest off + a renderOrder above every
    // edge pass keeps it whole and always on top.
    const ringGeo = new THREE.RingGeometry(16, 20, 48);
    ringGeo.rotateX(Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x55ff55,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false
    });
    const indicator = new THREE.Mesh(ringGeo, ringMat);
    indicator.position.set(0, seamDeckY - 6, 0); // Position it around the key slot height
    indicator.renderOrder = 20;
    indicator.visible = false;   // stays hidden until the flash actually starts
    group.add(indicator);
    jointGuideState.seamGapIndicator = indicator;

    initJointVignettes(pieces, seamX, seamZ, seamDeckY);
}

/**
 * Fixed-angle solid cutaways of the assembled joint, stacked in the side pane.
 *
 * One WebGL context drives all three via scissored viewports — three separate
 * renderers would burn three of the browser's ~16 context budget for static
 * thumbnails. Each view gets its own scene because each needs a DIFFERENT
 * boolean cut, which is geometry, not a camera setting.
 */
const jointVignettes = { renderer: null, views: [] };

function initJointVignettes(pieces, seamX, seamZ, seamDeckY) {
    if (jointVignettes.renderer) return;
    const holder = $('joint-vignettes');
    if (!holder) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setScissorTest(true);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    holder.appendChild(renderer.domElement);
    jointVignettes.renderer = renderer;

    const lock = SPEC.key.height - 2 * SPEC.jointClearanceMm;
    const keyTopY = seamDeckY - 3;
    const keyY = keyTopY - lock;

    // the key sits seated, so every view shows the assembled end state
    const keyGeo = toBufferGeometry(buildKeyGeometry(SPEC));

    // cut planes are expressed in world coords around the seam
    // Offsets are relative to the seam so the framing survives any layout
    // change; the guide's track always runs along +X with +Z lateral.
    const at = (dx, dy, dz) => [seamX + dx, seamDeckY + dy, seamZ + dz];
    const CUTS = [
        {
            // Cut removes the +Z half, so the camera must sit on +Z to face the
            // capped section — from −Z you'd be looking at the intact outer
            // skirt and see nothing of the joint.
            label: 'Side view · cut along the seam centreline',
            cut: { origin: [0, 0, seamZ], normal: [0, 0, 1] },
            ghostKey: true,
            eye: at(-18, 20, 78), look: at(0, -7, 0)
        },
        {
            // cut 6 mm into the downhill pocket, look back at the capped face
            label: 'End view · cut 6 mm into the pocket',
            cut: { origin: [seamX + 6, 0, 0], normal: [1, 0, 0] },
            ghostKey: true,
            eye: at(62, 18, 30), look: at(2, -6, 0)
        },
        {
            // Horizontal cut through the key's mid-height, looking straight up
            // at it. From outside, the underside is an unreadable mass of grey;
            // a plan section shows the one thing that matters — the bowtie
            // sitting inside the pocket it has to fit, in true cross-section.
            label: 'Bottom view · cut through the seated key',
            cut: { origin: [0, keyY + lock / 2, 0], normal: [0, -1, 0] },
            cutKey: true,
            eye: at(-6, -76, 13), look: at(0, -(seamDeckY - (keyY + lock / 2)), 0)
        }
    ];

    const shellMat = () => new THREE.MeshStandardMaterial({ color: 0xd9dee6, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
    const keyMat = () => new THREE.MeshStandardMaterial({ color: 0xff6b00, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });

    for (const def of CUTS) {
        const sc = new THREE.Scene();
        sc.background = new THREE.Color(0xeef1f5);
        sc.add(new THREE.HemisphereLight(0xffffff, 0x9aa3ae, 0.85));
        // A DirectionalLight aims at its target, which defaults to the world
        // origin — but the seam sits ~300 mm down +X, so every light was
        // raking across the joint at the wrong angle. Aim them all at the seam.
        const aimAt = (light) => {
            light.target.position.set(seamX, seamDeckY, seamZ);
            sc.add(light.target);
            sc.add(light);
        };
        const k = new THREE.DirectionalLight(0xfff4e2, 1.9);
        k.position.set(seamX + 120, seamDeckY + 180, seamZ + 140);
        aimAt(k);
        const f = new THREE.DirectionalLight(0xc9dcff, 0.5);
        f.position.set(seamX - 150, seamDeckY + 40, seamZ - 120);
        aimAt(f);
        // plan/underside views look at faces pointing DOWN, which every
        // overhead source leaves unlit — they need a dedicated bounce
        const up = new THREE.DirectionalLight(0xffffff, 1.15);
        up.position.set(seamX - 40, seamDeckY - 160, seamZ + 90);
        aimAt(up);

        // Crop both pieces to a short stub either side of the seam. Without
        // this each inset is 300 mm of track with a 24 mm joint lost in the
        // middle of it — the cut plane alone doesn't make the view legible.
        const STUB = 38;
        const add = (raw, mat) => {
            let g = raw;
            for (const c of [
                { origin: [seamX + STUB, 0, 0], normal: [1, 0, 0] },
                { origin: [seamX - STUB, 0, 0], normal: [-1, 0, 0] },
                ...(def.cut ? [def.cut] : [])
            ]) g = sectionGeometry(g, c);
            const mesh = new THREE.Mesh(toBufferGeometry(g), mat);
            sc.add(mesh);
            const lines = new THREE.LineSegments(
                new THREE.EdgesGeometry(mesh.geometry, 32),
                new THREE.LineBasicMaterial({ color: 0x24384f })
            );
            sc.add(lines);
        };

        // World space: the stub crops and the cut planes below are all
        // expressed as offsets from the seam's world address.
        add(pieceExportRawInWorld(pieces[1]), shellMat());
        add(pieceExportRawInWorld(pieces[2]), shellMat());

        // The key is modelled at the origin with its own +Z along the track, so
        // it has to be rotated and translated onto the seam. Bake that into the
        // geometry rather than the mesh transform — sectionGeometry cuts in
        // world space and would otherwise slice the key where it isn't.
        const seatedKey = keyGeo.clone()
            .rotateY(pieces[1].exit.h + Math.PI / 2)
            .translate(seamX, keyY, seamZ);

        if (def.cutKey) {
            // plan section: the key is cut on the same plane as the track, so
            // the view is a true cross-section of key-inside-pocket
            const cut = sectionGeometry({
                positions: new Float32Array(seatedKey.attributes.position.array),
                indices: seatedKey.index
                    ? new Uint32Array(seatedKey.index.array)
                    : Uint32Array.from({ length: seatedKey.attributes.position.count }, (_, i) => i)
            }, def.cut);
            const m = new THREE.Mesh(toBufferGeometry(cut), keyMat());
            sc.add(m);
            sc.add(new THREE.LineSegments(
                new THREE.EdgesGeometry(m.geometry, 32),
                new THREE.LineBasicMaterial({ color: 0x7a2f00 })
            ));
        } else {
            sc.add(new THREE.Mesh(seatedKey, keyMat()));
        }

        if (def.ghostKey) {
            // A second, dimmer copy drawn with depthTest off. The solid key
            // above only shows the sliver facing the cut; this reveals the rest
            // of the bowtie still buried in the pocket, which is the part you
            // actually need to see to judge the fit.
            const ghost = new THREE.Mesh(seatedKey, new THREE.MeshBasicMaterial({
                color: 0xc4551a, transparent: true, opacity: 0.42, depthTest: false
            }));
            ghost.renderOrder = 5;
            sc.add(ghost);
            const gl = new THREE.LineSegments(
                new THREE.EdgesGeometry(seatedKey, 32),
                new THREE.LineBasicMaterial({ color: 0x8a3a08, transparent: true, opacity: 0.75, depthTest: false })
            );
            gl.renderOrder = 6;
            sc.add(gl);
        }

        const cam = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);
        cam.position.set(...def.eye);
        cam.lookAt(...def.look);
        jointVignettes.views.push({ scene: sc, camera: cam, label: def.label });
    }
    settleResize(resizeJointVignettes);
}

function resizeJointVignettes() {
    const holder = $('joint-vignettes');
    if (!holder || !jointVignettes.renderer) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    jointVignettes.renderer.setSize(w, h);
    const n = jointVignettes.views.length || 1;
    for (const v of jointVignettes.views) {
        v.camera.aspect = w / (h / n);
        v.camera.updateProjectionMatrix();
    }
}

function renderJointVignettes() {
    const r = jointVignettes.renderer;
    if (!r || !jointVignettes.views.length) return;
    const holder = $('joint-vignettes');
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    const n = jointVignettes.views.length;
    const vh = Math.floor(h / n);
    jointVignettes.views.forEach((v, i) => {
        const y = h - vh * (i + 1);
        r.setViewport(0, y, w, vh);
        r.setScissor(0, y, w, vh);
        r.render(v.scene, v.camera);
    });
}

function tickJointGuideAnimation(dt) {
    if (!jointGuideState.group) return;
    jointGuideState.t += dt;
    const loopDuration = 8.5; // seconds
    const t = jointGuideState.t % loopDuration;
    
    const leftTrack = jointGuideState.leftTrack;
    const rightTrack = jointGuideState.rightTrack;
    const bowtieKey = jointGuideState.bowtieKey;
    const seamGapIndicator = jointGuideState.seamGapIndicator;
    const seamDeckY = jointGuideState.seamDeckY;
    
    const lockedKeyY = seamDeckY - 3 - SPEC.key.height + SPEC.jointClearanceMm;
    // The key must START below BOTH pieces' rims. The old fixed −30 mm put it
    // at y≈3 while the downhill piece's skirt runs down to y=0, so the key
    // began its travel already buried inside that piece — which is why the
    // motion read as the ramp sliding onto a stationary key instead of the key
    // slotting up into both ramps from underneath.
    const rimFloor = jointGuideState.rimFloor ?? (lockedKeyY - 30);
    const startKeyY = Math.min(rimFloor, lockedKeyY) - 22;
    const keyTravel = lockedKeyY - startKeyY;
    
    // Reset defaults
    leftTrack.position.set(0, 0, 0);
    rightTrack.position.set(0, 0, 0);
    rightTrack.rotation.set(0, 0, 0);
    bowtieKey.position.y = startKeyY;
    bowtieKey.scale.set(1, 1, 1);
    
    // UI steps highlight
    const step1El = $('timeline-step-1');
    const step2El = $('timeline-step-2');
    const step3El = $('timeline-step-3');
    if (step1El) { step1El.style.background = ''; step1El.style.fontWeight = ''; }
    if (step2El) { step2El.style.background = ''; step2El.style.fontWeight = ''; }
    if (step3El) { step3El.style.background = ''; step3El.style.fontWeight = ''; }
    
    if (seamGapIndicator) {
        seamGapIndicator.material.opacity = 0;
        seamGapIndicator.material.color.setHex(0x55ff55);
        seamGapIndicator.visible = false;   // re-enabled only by the flash steps
    }

    if (t < 1.5) {
        // Step 1: pieces apart but ALREADY IN LINE. The old start tilted the
        // piece (yaw 0.08, roll 0.04) and offset it in Y and Z, which reads as
        // a jump when the ease snaps it square — and misrepresents the joint,
        // which only ever slides along the track axis.
        if (step1El) { step1El.style.background = 'rgba(242,182,50,0.15)'; step1El.style.fontWeight = 'bold'; }

        rightTrack.position.set(15, 0, 0);   // longitudinal separation only
        bowtieKey.position.y = startKeyY;

    } else if (t < 3.5) {
        // Step 1 -> 2: Alignment Slide
        if (step1El) { step1El.style.background = 'rgba(242,182,50,0.15)'; step1El.style.fontWeight = 'bold'; }
        
        const alpha = (t - 1.5) / 2.0;
        const ease = 1 - Math.pow(1 - alpha, 3); // ease out cubic
        
        rightTrack.position.set(15 - 13 * ease, 0, 0);   // closes to a 2 mm gap along X
        bowtieKey.position.y = startKeyY;
        
    } else if (t < 5.5) {
        // Step 2 -> 3: Key Insertion & Wedging Pull
        if (step2El) { step2El.style.background = 'rgba(242,182,50,0.15)'; step2El.style.fontWeight = 'bold'; }
        
        const alpha = (t - 3.5) / 2.0;
        const keyY = startKeyY + keyTravel * alpha;   // rises into the pockets
        bowtieKey.position.y = keyY;
        
        let gap = 2.0;
        if (alpha > 0.5) {
            if (step3El) { step3El.style.background = 'rgba(242,182,50,0.15)'; step3El.style.fontWeight = 'bold'; }
            const wedgeProgress = (alpha - 0.5) / 0.5; // 0 to 1
            gap = 2.0 * (1 - wedgeProgress);
        }
        
        rightTrack.position.set(gap, 0, 0);
        
    } else if (t < 5.8) {
        // Step 3: The Snap!
        if (step3El) { step3El.style.background = 'rgba(242,182,50,0.15)'; step3El.style.fontWeight = 'bold'; }
        
        bowtieKey.position.y = lockedKeyY;
        rightTrack.position.set(0, 0, 0);
        
        const snapT = t - 5.5; // 0 to 0.3
        const freq = 40;
        const decay = Math.exp(-20 * snapT);
        const amp = 0.8 * Math.sin(freq * snapT) * decay;
        
        rightTrack.position.x += amp; // vibrates along X
        bowtieKey.position.y += amp * 0.5;
        bowtieKey.scale.set(1 + amp*0.1, 1 + amp*0.2, 1 + amp*0.1);
        
        if (seamGapIndicator) {
            seamGapIndicator.material.color.setHex(0x55ff55);
            seamGapIndicator.material.opacity = 0.8 * decay;
            seamGapIndicator.visible = true;
        }
        
    } else if (t < 7.2) {
        // Fully Locked
        if (step3El) { step3El.style.background = 'rgba(242,182,50,0.15)'; step3El.style.fontWeight = 'bold'; }
        
        bowtieKey.position.y = lockedKeyY;
        rightTrack.position.set(0, 0, 0);
        
        if (seamGapIndicator) {
            seamGapIndicator.material.color.setHex(0x55ff55);
            seamGapIndicator.material.opacity = 0.3 + 0.3 * Math.sin((t - 5.8) * 8);
            seamGapIndicator.visible = true;
        }
        
    } else {
        // Fade Out / Reset
        const alpha = (t - 7.2) / 1.3;
        const opacity = 1 - alpha;
        
        leftTrack.traverse(child => {
            if (child.isMesh) child.material.opacity = 0.65 * opacity;
            else if (child.isLine) child.material.opacity = 0.8 * opacity;
        });
        rightTrack.traverse(child => {
            if (child.isMesh) child.material.opacity = 0.65 * opacity;
            else if (child.isLine) child.material.opacity = 0.8 * opacity;
        });
        bowtieKey.traverse(child => {
            if (child.isMesh) child.material.opacity = 0.95 * opacity;
            else if (child.isLine) child.material.opacity = 0.9 * opacity;
        });
        
        if (seamGapIndicator) {
            seamGapIndicator.material.opacity = 0;
        }
        
        if (t > loopDuration - 0.05) {
            leftTrack.traverse(child => {
                if (child.isMesh) child.material.opacity = 0.65;
                else if (child.isLine) child.material.opacity = 0.8;
            });
            rightTrack.traverse(child => {
                if (child.isMesh) child.material.opacity = 0.65;
                else if (child.isLine) child.material.opacity = 0.8;
            });
            bowtieKey.traverse(child => {
                if (child.isMesh) child.material.opacity = 0.95;
                else if (child.isLine) child.material.opacity = 0.9;
            });
        }
    }
}

function setTab(t) {
    // The header's run/view controls all act on the DESIGN scene. On the tabs
    // that replace the viewport with something else — the part inspector and
    // the joint guide — they have nothing to act on, so they go away rather
    // than sitting there inert.
    const designTools = $('hdr-design-tools');
    if (designTools) designTools.style.visibility = (t === 'export' || t === 'joint') ? 'hidden' : '';
    for (const k of TABS) {
        $(`pane-${k}`).style.display = k === t ? '' : 'none';
        $(`tab-${k}`).classList.toggle('active', k === t);
    }
    if (t === 'export') {
        refreshPrintPartsList();
        // The inspector owns the main viewport on this tab — the design itself
        // is irrelevant while you are looking at one printable part.
        trackGroup.visible = false;
        arrowGroup.visible = false;
        ghostGroup.visible = false;
        sceneryGroup.visible = false;
        strikeGroup.visible = false;
        if (sim.horse) sim.horse.visible = false;
        if (idleHorse) idleHorse.visible = false;
        $('parts-stage').style.display = '';
        initGallery();
        gallery.open = true;
        settleResize(galleryResize);
        if (gallery.parts && gallery.parts.length > 0) {
            selectGalleryPart(gallery.selectedIndex ?? 0);
        }
    } else {
        if (gallery.open) {
            gallery.open = false;
            $('parts-stage').style.display = 'none';
            trackGroup.visible = true;
            arrowGroup.visible = true;
            ghostGroup.visible = true;
            sceneryGroup.visible = true;
            strikeGroup.visible = true;
            if (sim.horse) sim.horse.visible = true;
            if (idleHorse) idleHorse.visible = true;
        }
    }
    
    if (t === 'joint') {
        trackGroup.visible = false;
        arrowGroup.visible = false;
        ghostGroup.visible = false;
        sceneryGroup.visible = false;
        strikeGroup.visible = false;
        if (sim.horse) sim.horse.visible = false;
        if (idleHorse) idleHorse.visible = false;
        // The green ground, the grid and the sky-blue background all show
        // straight through the ghosted shells and were most of the visual
        // noise. A flat studio backdrop lets the line work read.
        ground.visible = false;
        grid.visible = false;
        scene.background = new THREE.Color(0xeef1f5);
        const ins = $('joint-insets');
        if (ins) ins.style.display = '';

        initJointGuide();
        jointGuideState.active = true;
        jointGuideState.group.visible = true;
        jointGuideState.t = 0;
        
        controls.maxPolarAngle = Math.PI; // Allow rotating fully underneath the joint
        const seamDeckY = jointGuideState.seamDeckY;
        controls.target.set(0, seamDeckY - 6, 0);
        camera.position.set(0, seamDeckY - 80, 110); // less zoomed in, looking up from the underside to view bottom insertion clearly
        controls.update();
    } else {
        if (jointGuideState.active) {
            jointGuideState.active = false;
            if (jointGuideState.group) {
                jointGuideState.group.visible = false;
            }
            trackGroup.visible = true;
            arrowGroup.visible = true;
            ghostGroup.visible = true;
            sceneryGroup.visible = true;
            strikeGroup.visible = true;
            ground.visible = true;
            grid.visible = true;
            scene.background = new THREE.Color(0xcfe6f5);
            const ins = $('joint-insets');
            if (ins) ins.style.display = 'none';
            if (sim.horse) sim.horse.visible = true;
            if (idleHorse) idleHorse.visible = true;
            controls.maxPolarAngle = Math.PI; // Maintain underneath-view capability
            fitView();
        }
    }
}

const partWeightCache = new Map();

function getPartWeight(part, sig) {
    if (!sig) return 0;
    if (partWeightCache.has(sig)) {
        return partWeightCache.get(sig);
    }
    try {
        const mesh = part.build();
        const report = analyzeMesh(mesh.positions, mesh.indices);
        const cat = /^(pillar|support)/.test(part.name) ? 'pillar'
            : /^scenery/.test(part.name) ? 'scenery'
            : /^figure_body|^figure_pend/.test(part.name) ? 'figure'
            : /^connector|^gate|plugs/.test(part.name) ? 'small' : 'track';
        const wt = printedWeightG(report.volumeMm3, cat);
        partWeightCache.set(sig, wt);
        return wt;
    } catch (e) {
        console.error("Failed to compute weight for", part.name, e);
        return 0;
    }
}

// transformMeshToLocalFrame used to live here: the export builders worked in
// world coordinates and this pulled the finished mesh back to the origin.
// buildPieceExportGeometry now does the whole build in the piece's own frame
// (see pieceInFrame in track.js), so applying it again rotated every piece a
// second time by -entry.h. Deleted rather than kept as a no-op — a transform
// that must not be called is worse than no transform at all.

function refreshPrintPartsList() {
    const list = $('print-parts-list');
    if (!list) return;
    list.innerHTML = '';
    gallery.parts = assembleParts().parts;
    
    let totalWeight = 0;
    gallery.parts.forEach((part, i) => {
        const li = document.createElement('li');
        const countLabel = part.count > 1 ? ` (x${part.count})` : '';
        const wt = getPartWeight(part, part.sig);
        totalWeight += wt * part.count;
        const wtText = wt > 0 ? `${wt.toFixed(0)}g` : '...';
        li.innerHTML = `<span>🧩 ${part.name}${countLabel}</span><span class="wt">${wtText} 🔍</span>`;
        li.title = 'Click to inspect · ⌘/Ctrl-click to add to a scene-position selection';
        li.addEventListener('click', (ev) => {
            selectGalleryPart(i, ev.metaKey || ev.ctrlKey);
        });
        list.appendChild(li);
    });
    gallery.sceneSelection = null;   // the placements were just rebuilt

    // The list was rebuilt from new geometry, so whatever the inspector is
    // showing is stale — changing the underside style rebuilt every piece and
    // the viewport kept the old mesh until you clicked something.
    if (gallery.parts.length && gallery.selectedIndex != null) {
        selectGalleryPart(Math.min(gallery.selectedIndex, gallery.parts.length - 1));
    }

    const spoolPct = (totalWeight / 1000) * 100;
    const heading = $('printable-parts-heading');
    if (heading) {
        heading.innerHTML = `Printable parts <span class="wt" style="color: var(--ink-3); font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 13px;">` +
            `· print job ≈ ${totalWeight.toFixed(0)}g PLA (${spoolPct.toFixed(0)}% of a 1kg spool, ≈$${(totalWeight / 1000 * 20).toFixed(2)} filament)</span>`;
    }
}

// ---------------------------------------------------------------------------
// Klip-klop audio
// ---------------------------------------------------------------------------

let audioCtx = null;
// 48 kHz explicitly: Chrome's MP4/AAC muxer assumes 48 kHz — recording from a
// device-default 44.1 kHz context makes the film's soundtrack play ~9% fast.
const makeAudioCtx = () => new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
function clack(freq) {
    if (!state.soundOn && !film.active) return;
    audioCtx ??= makeAudioCtx();
    const t = audioCtx.currentTime;
    const noise = audioCtx.createBufferSource();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.03, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length / 6));
    noise.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 4;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    noise.connect(bp).connect(gain);
    if (state.soundOn) gain.connect(audioCtx.destination);
    if (film.active && film.audioDest) gain.connect(film.audioDest);
    noise.start(t);
}
$('btn-sound').addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    $('btn-sound').textContent = state.soundOn ? '🔊' : '🔇';
});

const SPEED_FACTORS = [0.75, 1.0, 2.0, 4.0];
const SPEED_NAMES = ['Slow (0.75x)', 'Medium (1.0x)', 'Faster (2.0x)', 'Fastest (4.0x)'];
let speedIdx = 1;

function updateSpeedButton() {
    const factor = SPEED_FACTORS[speedIdx];
    const name = SPEED_NAMES[speedIdx];
    const op1 = 1.0;
    const op2 = speedIdx >= 1 ? 1.0 : 0.25;
    const op3 = speedIdx >= 2 ? 1.0 : 0.25;
    const op4 = speedIdx >= 3 ? 1.0 : 0.25;
    
    const btn = $('btn-speed');
    if (btn) {
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                <rect x="3" y="14" width="3" height="6" rx="0.5" opacity="${op1}"/>
                <rect x="8" y="10" width="3" height="10" rx="0.5" opacity="${op2}"/>
                <rect x="13" y="6" width="3" height="14" rx="0.5" opacity="${op3}"/>
                <rect x="18" y="2" width="3" height="18" rx="0.5" opacity="${op4}"/>
            </svg>
            <span style="font-size: 13px; font-weight: 600; line-height: 1;">${factor}x</span>
        `;
        btn.title = `Speed: ${name}`;
    }
    state.simSpeed = factor;
}

$('btn-speed').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEED_FACTORS.length;
    updateSpeedButton();
});

function updateRenderModeButton() {
    const btn = $('btn-render-mode');
    if (btn) {
        const mode = state.renderMode || 'solid';
        const labels = {
            'solid': '👁 Solid',
            'hidden-line': '👁 Hidden-line',
            'wireframe': '👁 Wireframe'
        };
        btn.textContent = labels[mode] || '👁 Solid';
    }
}

$('btn-render-mode').addEventListener('click', () => {
    const MODES = ['solid', 'hidden-line', 'wireframe'];
    let currentIdx = MODES.indexOf(state.renderMode || 'solid');
    if (currentIdx === -1) currentIdx = 0;
    const nextIdx = (currentIdx + 1) % MODES.length;
    state.renderMode = MODES[nextIdx];
    localStorage.setItem('klipklop-render-mode', state.renderMode);
    updateRenderModeButton();
    applyRenderMode();
});

function addOutline(mesh, thresholdAngle = 20) {
    if (mesh.userData.outline) {
        mesh.remove(mesh.userData.outline);
        mesh.userData.outline = null;
    }
    const edges = new THREE.EdgesGeometry(mesh.geometry, thresholdAngle);
    const lineMat = new THREE.LineBasicMaterial({
        color: 0x111111,
        linewidth: 1.5,
        transparent: true,
        opacity: 0.8
    });
    const line = new THREE.LineSegments(edges, lineMat);
    mesh.add(line);
    mesh.userData.outline = line;
}

function applyRenderMode() {
    const mode = state.renderMode || 'solid';
    const traverseAndStyle = (obj) => {
        obj.traverse(o => {
            if (o.isMesh) {
                if (!o.userData.outline && o.geometry && o.geometry.type !== 'SphereGeometry') {
                    addOutline(o, 20);
                }
                const outline = o.userData.outline;
                if (!o.userData.origMaterial) {
                    o.userData.origMaterial = {
                        transparent: o.material.transparent,
                        opacity: o.material.opacity,
                        depthWrite: o.material.depthWrite,
                        visible: o.material.visible !== false
                    };
                }
                
                if (mode === 'solid') {
                    o.material.transparent = o.userData.origMaterial.transparent;
                    o.material.opacity = o.userData.origMaterial.opacity;
                    o.material.depthWrite = o.userData.origMaterial.depthWrite;
                    o.material.visible = o.userData.origMaterial.visible;
                    if (o.material.needsUpdate) o.material.needsUpdate = true;
                    if (outline) outline.visible = false;
                } else if (mode === 'hidden-line') {
                    o.material.transparent = o.userData.origMaterial.transparent;
                    o.material.opacity = o.userData.origMaterial.opacity;
                    o.material.depthWrite = o.userData.origMaterial.depthWrite;
                    o.material.visible = o.userData.origMaterial.visible;
                    if (o.material.needsUpdate) o.material.needsUpdate = true;
                    if (outline) {
                        outline.visible = true;
                        outline.material.color.setHex(0x111111);
                        outline.material.opacity = 0.85;
                        outline.material.needsUpdate = true;
                    }
                } else if (mode === 'wireframe') {
                    o.material.transparent = true;
                    o.material.opacity = 0.15;
                    o.material.depthWrite = false;
                    o.material.visible = true;
                    if (o.material.needsUpdate) o.material.needsUpdate = true;
                    if (outline) {
                        outline.visible = true;
                        outline.material.color.setHex(0x39ff14); // neon green
                        outline.material.opacity = 0.9;
                        outline.material.needsUpdate = true;
                    }
                }
            }
        });
    };
    traverseAndStyle(trackGroup);
    traverseAndStyle(sceneryGroup);
    if (idleHorse) traverseAndStyle(idleHorse);
    if (sim.horse) traverseAndStyle(sim.horse);
}

// ---------------------------------------------------------------------------
// Simulation (replays the verified simulateRun trace)
// ---------------------------------------------------------------------------

const sim = { running: false, t: 0, phase: 0, horse: null, run: null, sampler: null, cursor: 0 };

function buildHorse() {
    // Test figure with adjustable transparency: ghost (RCT3-style, pendulum
    // engine visible) through fully opaque toy-accurate colors.
    const group = new THREE.Group();
    const pivot = new THREE.Group();
    group.add(pivot);
    const op = state.figureOpacity ?? 1;
    const W2 = FIGURE.widthMm / 2;
    let pend;
    if (state.figureStyle === 'knight') {
        // sculpted Galahad + Mike (see horse_model.js); the rear leg skirt
        // IS the pendulum — same axle, same swing contract as the red arm
        const model = buildKnightHorseModel({ halfWidth: W2, opacity: op, variant: state.knightVariant });
        pivot.add(model.body);
        pend = model.pend;
        pend.position.set(0, FIGURE.axle.y, FIGURE.axle.z);
        pivot.add(pend);
    } else {
        const mat = (color) => new THREE.MeshLambertMaterial({
            color,
            transparent: op < 0.999,
            opacity: op,
            depthWrite: op >= 0.999
        });
        const body = new THREE.Mesh(
            toBufferGeometry(extrudeOutlineX(bodySideOutline(state.figureStyle), -W2, W2)),
            mat(0xf5f0e8)
        );
        body.castShadow = true;
        body.renderOrder = 2;
        pivot.add(body);
        const pendMat = new THREE.MeshLambertMaterial({ color: 0xc0392b }); // pendulum pops through the ghost body
        pend = new THREE.Mesh(toBufferGeometry(extrudeOutlineX(
            pendulumSideOutline().map(([z, y]) => [z - FIGURE.axle.z, y - FIGURE.axle.y]),
            -FIGURE.pendulumW / 2, FIGURE.pendulumW / 2)), pendMat);
        pend.castShadow = true;
        pend.position.set(0, FIGURE.axle.y, FIGURE.axle.z);
        pivot.add(pend);
    }
    // axle marker + CoM bead: ties the animation to the physics story
    const axleDot = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 8), new THREE.MeshBasicMaterial({ color: 0x2a2a2a }));
    axleDot.position.set(0, FIGURE.axle.y, FIGURE.axle.z);
    pivot.add(axleDot);
    const com = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf07818 }));
    com.position.set(0, 14, 6); // low & slightly rear — where the ballast goes
    pivot.add(com);
    group.userData = { pivot, pend };
    group.traverse(o => {
        if (o.isMesh) {
            if (o.geometry.type === 'SphereGeometry') return;
            addOutline(o, 20);
        }
    });
    return group;
}

// fading hoof-strike markers: the klip-klop rhythm left visibly on the deck
const strikeGroup = new THREE.Group();
scene.add(strikeGroup);
function dropStrikeMarker(front) {
    if (!sim.horse) return;
    const dot = new THREE.Mesh(
        new THREE.CircleGeometry(4.5, 12).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: front ? 0xffffff : 0x574a3a, transparent: true, opacity: 0.85 })
    );
    const local = new THREE.Vector3(0, 0.6, front ? 4 : -10); // hoof cam contact points
    dot.position.copy(sim.horse.localToWorld(local));
    dot.userData.born = performance.now();
    strikeGroup.add(dot);
    if (strikeGroup.children.length > 70) strikeGroup.remove(strikeGroup.children[0]);
}
function fadeStrikeMarkers(now) {
    for (const d of [...strikeGroup.children]) {
        const age = (now - d.userData.born) / 4000;
        if (age >= 1) strikeGroup.remove(d);
        else d.material.opacity = 0.85 * (1 - age);
    }
}
function updateElevatorProngs(dt) {
    if (!elevatorProngs.length) return;
    const speed = 110; // mm/s
    for (const p of elevatorProngs) {
        p.offset = (p.offset + speed * dt) % 240;
        const d = p.offset;
        if (d < 120) {
            p.mesh.visible = true;
            const s = 15 + d;
            const pos = planPosAt(p.piece, s);
            const y = deckYAt(p.piece, s);
            p.mesh.position.set(pos.x, y + 1.0, pos.z);
            p.mesh.rotation.set(0, -pos.h, 0);
        } else {
            p.mesh.visible = false;
        }
    }
}

// ---------------------------------------------------------------------------
// Ride film: records the canvas during a cinematic follow-cam run of the full
// ride path. MP4 (H.264) where the browser's MediaRecorder supports it
// (Chrome/Safari on macOS — plays in QuickTime), WebM otherwise. Browsers
// cannot author .mov containers; MP4 is the QuickTime-compatible equivalent.
// ---------------------------------------------------------------------------

const film = { active: false, media: null, chunks: [], mime: '', prevCam: null, t0: 0 };

function pickVideoMime() {
    // prefer audio+video codecs so the klip-klop track records into the film
    const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp9',
        'video/webm'
    ];
    for (const m of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
}

function startFilm() {
    if (film.active) { stopSim(); return; }
    const mime = pickVideoMime();
    if (!mime) { toast('This browser cannot record video (no MediaRecorder codec).'); return; }
    startSim();
    if (!sim.running) return;
    film.prevCam = { pos: camera.position.clone(), target: controls.target.clone() };
    controls.enabled = false;
    arrowGroup.visible = false;
    ghostGroup.visible = false;
    // seed the chase cam right behind the start so the film opens on the horse
    const p0 = sim.sampler.at(sim.run.trace[0]?.dist ?? 0);
    camera.position.set(p0.x - Math.cos(p0.h) * 260, p0.y + 170, p0.z - Math.sin(p0.h) * 260);

    const stream = renderer.domElement.captureStream(30);
    // mix the synthesized klip-klop audio into the recording (even when the
    // speaker toggle is muted, the film still gets its soundtrack)
    audioCtx ??= makeAudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    film.audioDest = audioCtx.createMediaStreamDestination();
    
    // Create a continuous silent audio source to keep the stream active and synchronized
    film.silentOsc = audioCtx.createOscillator();
    film.silentGain = audioCtx.createGain();
    film.silentGain.gain.value = 0;
    film.silentOsc.connect(film.silentGain);
    film.silentGain.connect(film.audioDest);
    film.silentOsc.start(0);

    const audioTrack = film.audioDest.stream.getAudioTracks()[0];
    if (audioTrack) stream.addTrack(audioTrack);
    film.mime = mime;
    film.chunks = [];
    film.media = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    film.media.ondataavailable = (e) => { if (e.data.size) film.chunks.push(e.data); };
    film.media.onstop = saveFilm;
    film.media.start(250);
    film.active = true;
    film.t0 = performance.now();
    $('btn-record').textContent = '⏺ Recording… (click to stop)';
    toast(`🎥 Filming the ride (${mime.includes('mp4') ? 'MP4' : 'WebM'}) — it saves automatically at the corral`);
}

function endFilm() {
    if (!film.active) return;
    film.active = false;
    if (film.media && film.media.state !== 'inactive') film.media.stop(); // finalize before the camera jumps back
    
    // Stop and clean up the silent oscillator
    if (film.silentOsc) {
        try { film.silentOsc.stop(); } catch(e) {}
        film.silentOsc.disconnect();
        film.silentOsc = null;
    }
    if (film.silentGain) {
        film.silentGain.disconnect();
        film.silentGain = null;
    }
    film.audioDest = null;
    
    $('btn-record').textContent = '🎥 Film ride';
    controls.enabled = true;
    arrowGroup.visible = true;
    ghostGroup.visible = true;
    if (film.prevCam) {
        camera.position.copy(film.prevCam.pos);
        controls.target.copy(film.prevCam.target);
        film.prevCam = null;
    }
}

function saveFilm() {
    const blob = new Blob(film.chunks, { type: film.mime });
    film.chunks = [];
    if (blob.size < 1000) { toast('Recording produced no data.'); return; }
    const ext = film.mime.includes('mp4') ? 'mp4' : 'webm';
    const secs = ((performance.now() - film.t0) / 1000).toFixed(0);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `klipklop_ride_${(state.name || 'track').replace(/\W+/g, '_').toLowerCase()}_${state.slopeDeg}deg.${ext}`;
    a.click();
    toast(`🎬 Ride film saved — ${secs}s, ${(blob.size / 1e6).toFixed(1)} MB (${ext.toUpperCase()})` +
        (ext === 'webm' ? ' · this browser cannot encode MP4; the WebM plays in Chrome/VLC' : ''));
}

/** Cinematic chase cam: hovers behind and above the horse, looking ahead. */
function tickFilmCamera(dt) {
    if (!film.active || !sim.horse || !sim.sampler) return;
    const s = traceAt(Math.min(sim.t, sim.run.tEnd - 0.01));
    if (!s) return;
    const here = sim.sampler.at(s.dist);
    const ahead = sim.sampler.at(Math.min(s.dist + 90, sim.sampler.total));
    const back = 240, up = 150, side = 70;
    const want = new THREE.Vector3(
        here.x - Math.cos(here.h) * back + Math.sin(here.h) * side,
        here.y + up,
        here.z - Math.sin(here.h) * back - Math.cos(here.h) * side
    );
    camera.position.lerp(want, Math.min(1, dt * 2.2));
    camera.lookAt(ahead.x, ahead.y + 30, ahead.z);
}

const OUTCOME_TOASTS = {
    arrived: '🎉 The horse arrived at the corral!',
    circuit: '🔁 Perpetual circuit verified — the lifts pay for the descent, lap after lap',
    stalled: '⏸ Stalled — not enough gait energy for this setup (see Physics lab)',
    tumbled: '💥 Tumbled — slope exceeds the swing limiter (see Physics lab)',
    timeout: '⏱ Simulation timed out'
};

$('btn-run').addEventListener('click', () => {
    if (sim.running) {
        togglePause();
    } else {
        startSim();
    }
});
$('btn-stop').addEventListener('click', stopSim);
$('btn-record').addEventListener('click', startFilm);

function togglePause() {
    if (!sim.running) return;
    sim.paused = !sim.paused;
    const btn = $('btn-run');
    if (btn) {
        btn.textContent = sim.paused ? '▶ Resume' : '⏸ Pause';
        btn.classList.toggle('primary', sim.paused);
    }
    toast(sim.paused ? '⏸ Ride paused — orbit around, then resume' : '▶ Resumed');
}

function startSim() {
    stopSim();
    const ridePath = resolveRidePath(state.layout.pieces);
    // guard on what actually matters: something to ride, and (for loops) closure
    if (!ridePath.some(p => p.slopeDeg > 0 || p.isLift)) {
        toast('Add at least one ramp piece first.');
        return;
    }

    sim.run = simulateRun(ridePath, {
        ...physOpts(),
        liftSpeedMmS: SPEC.liftSpeedMmS,
        loop: state.layout.isCircuit,
        maxLaps: 3
    });
    $('sim-hud').style.display = '';
    sim.sampler = makePathSampler(ridePath, 4);
    sim.ridePath = ridePath;
    sim.horse = buildHorse();
    scene.add(sim.horse);
    sim.t = 0;
    sim.phase = 0;
    sim.cursor = 0;
    sim.paused = false;
    sim.running = true;
    for (const btn of document.querySelectorAll('[data-figstyle]')) btn.disabled = true;
    refreshIdleHorse();
    applyRenderMode();
    if (sim.run.events.some(e => e.type === 'mode' && e.detail.includes('slide'))) {
        toast('⛸ Hooves lose grip somewhere on this ride — watch it ski (see Physics lab)');
    }
    const btn = $('btn-run');
    if (btn) {
        btn.textContent = '⏸ Pause';
        btn.classList.remove('primary');
    }
    $('btn-stop').disabled = false;
}

function stopSim() {
    if (film.active) {
        // let the last frames land before tearing the scene down
        setTimeout(endFilm, 400);
        setTimeout(() => reallyStopSim(), 450);
        sim.running = false;
        return;
    }
    reallyStopSim();
}
function reallyStopSim() {
    sim.running = false;
    sim.paused = false;
    if (sim.horse) { scene.remove(sim.horse); sim.horse = null; }
    $('sim-hud').style.display = 'none';
    const btn = $('btn-run');
    if (btn) {
        btn.textContent = '▶ Test ride';
        btn.classList.add('primary');
        btn.disabled = false;
    }
    $('btn-stop').disabled = true;
    refreshIdleHorse();
    for (const btn of document.querySelectorAll('[data-figstyle]')) btn.disabled = false;
}

/** Live telemetry: the numbers the physics engine is actually producing. */
const MODE_LABEL = { walk: '🐴 WALK', slide: '⛸ SLIDE', lift: '⛓ LIFT' };
function refreshHud(s) {
    const a = sim.run.assess[s.pieceIndex];
    const lap = state.layout?.isCircuit ? sim.run.events.filter(e => e.type === 'lap' && e.t <= sim.t).length + 1 : null;
    $('sim-hud').innerHTML =
        `<span class="hudmode ${s.mode}">${MODE_LABEL[s.mode] ?? s.mode}</span>` +
        `<span><b>${s.v.toFixed(0)}</b> mm/s</span>` +
        `<span><b>${s.mode === 'walk' ? a.stepHz.toFixed(1) : '—'}</b> clacks/s</span>` +
        `<span>piece <b>${sim.ridePath[s.pieceIndex]?.name ?? ''}</b></span>` +
        (lap ? `<span>lap <b>${lap}/3</b></span>` : '') +
        `<span class="hudnote">1:1 replay of the verified dynamics trace</span>`;
}

function traceAt(t) {
    const tr = sim.run.trace;
    if (!tr.length || t <= tr[0].t) return tr[0] ?? null;
    while (sim.cursor < tr.length - 1 && tr[sim.cursor + 1].t <= t) sim.cursor++;
    const a = tr[sim.cursor], b = tr[Math.min(sim.cursor + 1, tr.length - 1)];
    if (a === b) return a;
    const f = (t - a.t) / (b.t - a.t);
    return { t, dist: a.dist + (b.dist - a.dist) * f, v: a.v + (b.v - a.v) * f, mode: a.mode, pieceIndex: a.pieceIndex };
}

function tickSim(dt) {
    sim.t += dt;
    if (sim.t >= sim.run.tEnd || !sim.run.trace.length) {
        toast(OUTCOME_TOASTS[sim.run.outcome] ?? sim.run.outcome);
        stopSim();
        return;
    }
    const s = traceAt(sim.t);
    const p = sim.sampler.at(s.dist);
    sim.horse.position.set(p.x, p.y, p.z);
    sim.horse.rotation.y = Math.PI / 2 - p.h;
    refreshHud(s);

    const a = sim.run.assess[s.pieceIndex];
    if (s.mode === 'walk' && a.stepHz > 0.1) {
        const prev = Math.sin(Math.PI * a.stepHz * sim.phase);
        sim.phase += dt;
        const cur = Math.sin(Math.PI * a.stepHz * sim.phase);
        sim.horse.userData.pivot.rotation.x = 0.14 * cur;
        // lateral waddle seen in reference footage: the toy sways once per
        // two steps (weight shifts alternate sides). Display-only.
        sim.horse.userData.pivot.rotation.z = 0.07 * Math.sin(Math.PI * a.stepHz * sim.phase / 2);
        sim.horse.userData.pend.rotation.x = -state.walker.alphaDeg * Math.PI / 180 * cur;
        if (Math.sign(cur) !== Math.sign(prev) && Math.sign(cur) !== 0) {
            const front = Math.sign(cur) > 0;
            clack(front ? 1900 : 1300);
            dropStrikeMarker(front);
        }
    } else if (s.mode === 'lift') {
        sim.phase += dt;
        sim.horse.userData.pivot.rotation.x = 0.03 * Math.sin(8 * sim.phase); // conveyor judder
        sim.horse.userData.pivot.rotation.z *= 0.9; // waddle settles on the belt
        if (Math.floor(sim.phase * 3) !== Math.floor((sim.phase - dt) * 3)) clack(700); // chain clank
    } else {
        sim.horse.userData.pivot.rotation.x *= 0.9;
        sim.horse.userData.pivot.rotation.z *= 0.9;
        sim.horse.userData.pend.rotation.x *= 0.9;
    }
}

// the figure is always on the track: standing at the ride head when idle
let idleHorse = null;
function refreshIdleHorse() {
    if (idleHorse) { scene.remove(idleHorse); idleHorse = null; }
    if (sim.running || !state.layout) return;
    const ride = resolveRidePath(state.layout.pieces);
    if (!ride.length) return;
    try {
        const sampler = makePathSampler(ride, 10);
        const first = sampler.samples.find(s => s.slopeDeg > 0 || ride[s.pieceIndex]?.isLift);
        const d = Math.max(0, (first?.dist ?? 60) - 60); // stand just before the first drop
        const pt = sampler.at(d);
        idleHorse = buildHorse();
        idleHorse.position.set(pt.x, pt.y, pt.z);
        idleHorse.rotation.y = Math.PI / 2 - pt.h;
        if (jointGuideState.active) {
            idleHorse.visible = false;
        }
        scene.add(idleHorse);
    } catch { /* empty/degenerate layouts have no place to stand */ }
    applyRenderMode();
}

// Dev hook for the Playwright smoke/screenshot scripts: orbit the camera
// around the figure (idle or riding) at spherical angles theta/phi.
window.__frameHorse = (theta = Math.PI / 4, phi = 1.25, dist = 160) => {
    const h = sim.horse ?? idleHorse;
    if (!h) return false;
    const c = new THREE.Vector3();
    new THREE.Box3().setFromObject(h).getCenter(c);
    controls.target.copy(c);
    const az = (Math.PI / 2 - h.rotation.y) + theta; // theta 0 = head-on, π = rear
    camera.position.set(
        c.x + dist * Math.sin(phi) * Math.cos(az),
        c.y + dist * Math.cos(phi),
        c.z + dist * Math.sin(phi) * Math.sin(az));
    controls.update();
    return true;
};

/** Dev hook: frame an arbitrary world point — supports and scenery have no
 *  piece index, and the screenshot scripts need to look at them too. */
window.__frameAt = (x, y, z, { az = 0.6, el = 0.25, dist = 320 } = {}) => {
    controls.target.set(x, y, z);
    camera.position.set(
        x + dist * Math.cos(el) * Math.cos(az),
        y + dist * Math.sin(el),
        z + dist * Math.cos(el) * Math.sin(az));
    controls.update();
    return true;
};

/** Dev hook for the screenshot scripts: frame one piece from a given angle. */
window.__framePiece = (index, { az = 0.6, el = 0.25, dist = 320 } = {}) => {
    const m = pieceMeshes[index];
    if (!m) return false;
    const c = new THREE.Vector3();
    new THREE.Box3().setFromObject(m).getCenter(c);
    controls.target.copy(c);
    camera.position.set(
        c.x + dist * Math.cos(el) * Math.cos(az),
        c.y + dist * Math.sin(el),
        c.z + dist * Math.cos(el) * Math.sin(az));
    controls.update();
    return true;
};

/** Styled modal dialog replacing native alert/confirm. Resolves a button value. */
function showDialog({ title, html, buttons = [{ label: 'OK', value: true, primary: true }] }) {
    return new Promise((resolve) => {
        $('dialog-title').textContent = title;
        $('dialog-body').innerHTML = html;
        const bar = $('dialog-buttons');
        bar.innerHTML = '';
        for (const b of buttons) {
            const el = document.createElement('button');
            el.textContent = b.label;
            if (b.primary) el.classList.add('primary');
            if (b.danger) el.classList.add('danger');
            el.addEventListener('click', () => {
                $('dialog-overlay').style.display = 'none';
                resolve(b.value);
            });
            bar.appendChild(el);
        }
        $('dialog-overlay').style.display = '';
    });
}

let toastTimer = null;
function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * There is ONE export path, and it goes through the print shop.
 *
 * There used to be two: a pair of ZIP buttons on this pane that packed the
 * whole design blind, and the shop, which packs whatever quantities you set
 * and shows you the beds. They shared the packer but not the code around it,
 * so the plate grouping, the bed-contact check and the README all had to be
 * added to each — and the blind one is the one that let a part go out
 * balanced on the tip of its pin. Exporting from the screen that draws the
 * plates means you cannot download a layout you have not seen.
 */

/**
 * The single source of truth for what gets printed: every unique part of the
 * current design with a lazy geometry builder. Used by the ZIP export AND the
 * Parts gallery, so what you inspect is byte-identical to what you download.
 */
function assembleParts() {
    const { pieces } = state.layout;
    const parts = [];
    const note = {
        piece: 'End ribs carry the bowtie pockets; hex socket under the boss; washboard floor.',
        switch: 'Two routes merged with an open frog, three bowtie pockets, and the gate-pin bore where the branch first pulls clear of the main.',
        key: 'Slots up into the pockets of two mating pieces and pulls the seam closed.',
        gate: 'Pin seats in the switch deck bore; blade must swing freely.',
        pillar: 'Hex tenon, 8.6 mm across the flats, 10 mm deep. Sockets are drawn 9.0 in risers and scenery but 8.75 in a track piece: from the same AF 9 drawing the riser sockets measured 8.62–8.65 and the track sockets 8.85–8.95, and the same tenon is snug in one and loose in the other.',
        jog: 'Offset riser: steps a support column 45 mm sideways past the tier below. One grid unit tall, so it replaces a 15 mm riser in the stack.',
        spacer: 'Goes directly under a minimal piece, between the riser stack and the socket. Round with one flat, so it is never confused with a hex riser; count the rings — two for straights and lifts, one for curves.',
        scenery: 'Shares the same hex tenon/socket interlock standard.',
        figure: 'Print on its side; hoof cams must be smooth arcs.'
    };

    const switchPairs = new Map();
    for (const pc of pieces) {
        if (pc.switchKey) {
            const pair = switchPairs.get(pc.switchKey) ?? {};
            pair[pc.role] = pc;
            switchPairs.set(pc.switchKey, pair);
        }
    }
    
    function getPieceSignature(pc, support) {
        const sigParts = [
            pc.type,
            pc.innerWidth.toFixed(1),
            // The seam taper is neighbour-dependent, so a curve entering from a
            // straight is genuinely a different solid from one mid-helix. Two
            // of them must not share a part number.
            (pc.entryWidth ?? pc.innerWidth).toFixed(1),
            (pc.exitWidth ?? pc.innerWidth).toFixed(1),
            pc.planLen.toFixed(1),
            pc.drop.toFixed(3),
            pc.slopeDeg.toFixed(3),
            pc.ridgePitch ? pc.ridgePitch.toFixed(3) : '0',
            pc.waterfall ? pc.waterfall.toFixed(3) : '0',
            pc.switchType ?? '',
            // the underside is a different solid, not a view setting
            pc.skirtStyle ?? SPEC.skirt.style
        ];
        // The support contributes ONE bit to the shape now: whether the piece
        // has a socket boss at all. Where the column goes is the jog's problem,
        // not the track's, so mode/station/side must not split a part number —
        // they used to, and that alone listed one curve as four.
        sigParts.push(support && support.mode !== 'none' ? 'boss' : 'no-boss');
        return sigParts.join('|');
    }

    const uniqueParts = new Map();
    let joints = 0;
    for (const pc of pieces) {
        if (!pc.isImplicitStart && pc.role !== 'branch') joints++;
        if (pc.role === 'branch') continue;
        const support = (state.supports ?? []).find(s => s.pieceIndex === pc.index);
        const sig = getPieceSignature(pc, support);
        if (uniqueParts.has(sig)) {
            const u = uniqueParts.get(sig);
            u.count++;
            u.instances.push(pc);      // every placement, for the all-scene view
        } else {
            uniqueParts.set(sig, { pc, support, count: 1, instances: [pc] });
        }
    }

    /**
     * What a piece's seam taper says about where it sits.
     *
     * At the Standard this never fires: `SPEC.curveWidenMm` is 0, so every
     * piece is one width face to face and a straight beside a curve is the
     * same part as any other straight. It stays for custom-parameter builds,
     * which can still ask for a widened turn — there the straight next to it
     * carries that width at the shared face and really is a different solid,
     * and a parts bin cannot tell without the name saying so.
     */
    const seamRole = (pc) => {
        // curves only ever flare to their own width, so they never take a
        // suffix — that is the whole point of matching on the wider face
        if (pc.radius) return '';
        const body = pc.innerWidth;
        const e = pc.entryWidth ?? body, x = pc.exitWidth ?? body;
        if (e > body && x > body) return '_between_curves';
        if (e > body) return '_out_of_curve';
        if (x > body) return '_into_curve';
        return '';
    };

    /**
     * A part is named for its SHAPE, not for where it happens to sit.
     *
     * The names used to carry the piece's index in the build sequence —
     * `04_straight`. After deduplication that number meant "the first place
     * this shape occurred", so it moved when you edited an earlier piece, it
     * said nothing about the part in your hand, and it made the track parts
     * look like a different species from the stock parts (which have no
     * position and so never had one). The list is a shopping list: `straight
     * ×6` is what you print and what you reach into the bin for.
     *
     * `_boss` marks a piece carrying the hex socket for a support column —
     * but ONLY where the same design also has one without. A suffix that
     * every part carries distinguishes nothing, and almost every piece takes
     * a support, so it read as decoration on all of them. Anything else that
     * splits a signature — only custom parameters can, at the Standard —
     * falls through to a `_2`, `_3` suffix rather than silently colliding.
     */
    const shapeOf = (pc) => (pc.role === 'main' ? (pc.switchType ?? 'switch') : pc.type) + seamRole(pc);
    const hasBoss = (support) => !!(support && support.mode !== 'none');
    const bossSplit = new Set();
    {
        const seen = new Map();
        for (const { pc, support } of uniqueParts.values()) {
            const k = shapeOf(pc), b = hasBoss(support);
            if (seen.has(k) && seen.get(k) !== b) bossSplit.add(k);
            seen.set(k, b);
        }
    }
    const nameUse = new Map();
    const uniqueName = (base) => {
        const n = (nameUse.get(base) ?? 0) + 1;
        nameUse.set(base, n);
        return n === 1 ? base : `${base}_${n}`;
    };
    // WHERE A PART REALLY SITS, for the inspector's all-scene view: local
    // export solid (NO print tilt — assembled orientation) plus one world
    // placement per instance. rotation.y = -h inverts `inPlane`; verified
    // against the built scene rather than trusted from the derivation.
    const placementOf = (pc) => {
        const f = pieceFrame(pc);
        return { at: [f.x, f.y, f.z], yaw: -f.h };
    };
    for (const [sig, item] of uniqueParts.entries()) {
        const { pc, support, count, instances } = item;
        const shape = shapeOf(pc);
        const baseName = uniqueName(shape +
            (bossSplit.has(shape) ? (hasBoss(support) ? '_boss' : '_plain') : ''));
        if (pc.role === 'main') {
            const pair = switchPairs.get(pc.switchKey);
            parts.push({
                name: baseName,
                count,
                sig,
                note: note.switch,
                kind: 'track',
                piece: pair.main,
                support: support,
                build: () => buildSwitchExportGeometry(pair.main, pair.branch, { support, forPrint: true }),
                buildScene: () => buildSwitchExportGeometry(pair.main, pair.branch, { support }),
                placements: instances.map((p) =>
                    placementOf(p.role === 'main' ? p : switchPairs.get(p.switchKey).main))
            });
        } else {
            parts.push({
                name: baseName,
                count,
                sig,
                note: note.piece,
                kind: 'track',
                piece: pc,
                support: support,
                // forPrint lays a minimal piece on its own underside; it is a
                // no-op for a viaduct piece and for any curve (see
                // tiltOntoUnderside), so it is safe to ask for unconditionally
                build: () => buildPieceExportGeometry(pc, { support, forPrint: true }),
                buildScene: () => buildPieceExportGeometry(pc, { support }),
                placements: instances.map(placementOf)
            });
        }
    }
    if (switchPairs.size) {
        // parked in its slot: pin at the deck bore, blade along the wall — the
        // yaw that points the +Z vane along heading h is h - 90 deg
        parts.push({ name: 'gate_paddle', count: switchPairs.size, sig: 'gate_paddle', kind: 'gate', note: note.gate,
            build: () => buildGateGeometry(SPEC, { forPrint: true }),
            buildScene: () => buildGateGeometry(SPEC),
            placements: [...switchPairs.values()].filter((p) => p.main && p.branch).map((p) => {
                // same formula the scene's display paddle uses, parked pose
                const pin = gatePinPosition(p.main, p.branch);
                return { at: [pin.x, pin.deckY, pin.z], yaw: Math.PI / 2 - pin.yawParked };
            }) });
    }
    parts.push({ name: 'bowtie_key', count: joints, sig: 'bowtie_key', kind: 'key', note: note.key,
        build: () => buildKeyGeometry(SPEC, { code: partCode('KEY', GEOMETRY_VERSION) }),
        // seated in its pocket: centred on the seam face, top at the pocket
        // ceiling 3 mm under the uphill deck. Mostly hidden inside the ribs in
        // the all-scene view, which is the honest picture of an assembled key.
        placements: pieces.filter((pc) => !pc.isImplicitStart && pc.role !== 'branch').map((pc) => ({
            at: [pc.entry.x, (pc.entryDeck + SPEC.waterfallStepMm) - 3 - SPEC.key.height, pc.entry.z],
            yaw: -pc.entry.h
        })) });

    // supports: reusable standard modules (foot + risers) with print counts —
    // never cut-to-height "magic" pillars unless custom parameters force it
    const supList = (state.supports ?? [])
        .filter(s => supportsPillar(s) && needsPier(pieces[s.pieceIndex]));
    if (usingStandard()) {
        let feet = 0, jogs = 0;
        const riserCounts = new Map();
        const spacerCounts = new Map();
        // true assembled placements per kind, mirroring rebuild()'s stacking
        const put = (map, key, at, yaw = 0) => {
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({ at, yaw });
        };
        const footAt = [], jogAt = [];
        const riserAt = new Map(), spacerAt = new Map();
        for (const sup of supList) {
            const pc = pieces[sup.pieceIndex];
            // counted before the decompose, because a grounded minimal piece
            // has NO stack under its spacer and would drop out at the `continue`
            const sp = spacerHeightMm(pc);
            let y = stackHeightMm(pc, sup);
            const boss = supportBossPos(pc, sup);
            if (sup.mode === 'jog') {
                jogs++;
                jogAt.push({ at: [sup.x, y, sup.z],
                    yaw: -Math.atan2(boss.z - sup.z, boss.x - sup.x) });
            }
            if (sp > 0) {
                spacerCounts.set(sp, (spacerCounts.get(sp) ?? 0) + 1);
                put(spacerAt, sp, [boss.x, y + (sup.mode === 'jog' ? SPEC.jog.heightMm : 0), boss.z]);
            }
            const dec = decomposeSupport(stackHeightMm(pc, sup));
            if (!dec) continue;
            feet++;
            footAt.push({ at: [sup.x, 0, sup.z], yaw: 0 });
            let ry = STANDARD.footHeight;
            for (const r of [...dec.risers].sort((a, b) => b - a)) {
                riserCounts.set(r, (riserCounts.get(r) ?? 0) + 1);
                put(riserAt, r, [sup.x, ry, sup.z]);
                ry += r;
            }
        }
        if (jogs) parts.push({ name: 'support_jog', count: jogs, sig: 'support_jog', kind: 'support', note: note.jog,
            build: () => buildJogGeometry(SPEC, { code: partCode('JOG', GEOMETRY_VERSION), brim: shop.brimPosts }),
            placements: jogAt });
        for (const [h, count] of [...spacerCounts.entries()].sort((a, b) => b[0] - a[0])) {
            const v = spacerVariant(h);
            parts.push({
                name: `support_spacer_${v.code}`, count, sig: `support_spacer_${v.code}`,
                kind: 'support', note: note.spacer, build: () => spacerGeometryFor(h, true, shop.brimPosts),
                placements: spacerAt.get(h) ?? []
            });
        }
        if (feet) parts.push({ name: 'support_foot', count: feet, sig: 'support_foot', kind: 'support', note: note.pillar,
            build: () => toArraysFromBG(buildSupportFootGeometry(SPEC, { code: partCode('FOOT', GEOMETRY_VERSION) })),
            placements: footAt });
        for (const [r, count] of [...riserCounts.entries()].sort((a, b) => b[0] - a[0])) {
            parts.push({ name: `support_riser_${r}mm`, count, sig: `support_riser_${r}mm`, kind: 'support', note: note.pillar,
                build: () => buildRiserGeometry(r, SPEC, { code: partCode(`R${r}`, GEOMETRY_VERSION), brim: shop.brimPosts }),
                placements: riserAt.get(r) ?? [] });
        }
    } else {
        for (const sup of supList) {
            const pc = pieces[sup.pieceIndex];
            parts.push({ name: `pillar_${pc.name}_h${pc.rimY.toFixed(0)}_CUSTOM`, count: 1, sig: `pillar_${pc.name}_h${pc.rimY.toFixed(0)}_CUSTOM`, kind: 'support', note: 'Custom parameters: this pillar fits only this print batch.', build: () => toArraysFromBG(buildPillarGeometry(pc.rimY)) });
        }
    }

    const kinds = [...new Set(state.scenery.map(s => s.kind))];
    for (const kind of kinds) {
        const count = state.scenery.filter(s => s.kind === kind).length;
        if (kind === 'tower') parts.push({ name: 'scenery_tower', count, sig: 'scenery_tower', kind: 'scenery', note: note.scenery, build: () => buildTowerGeometry(100) });
        if (kind === 'patio') parts.push({ name: 'scenery_patio', count, sig: 'scenery_patio', kind: 'scenery', note: note.scenery, build: () => buildPatioGeometry() });
        if (kind === 'palm') {
            parts.push({ name: 'scenery_palm_island', count, sig: 'scenery_palm_island', kind: 'scenery', note: note.scenery, build: () => buildPalmIslandGeometries().island });
            parts.push({ name: 'scenery_palm_tree_crown_down', count, sig: 'scenery_palm_tree_crown_down', kind: 'scenery', note: note.scenery, build: () => rotFlip(buildPalmIslandGeometries().palm) });
        }
    }

    // figures are stock Klip Klop toys, not printed parts — the print job is
    // track construction only (the Figure lab in Physics is for the curious)
    return { parts, joints, switchCount: switchPairs.size };
}

// ---------------------------------------------------------------------------
// Parts gallery: full-page inspection of every printable part's real export
// geometry (joints, pockets, sockets, washboard — what the slicer will see)
// ---------------------------------------------------------------------------

const gallery = {
    open: false, renderer: null, scene: null, camera: null, controls: null,
    mesh: null, wire: null, dims: null, geo: null, report: null, parts: [],
    style: 'plastic', mode: 1, showDims: 'all'
};

// material styles: how the same watertight mesh reads under different finishes
const GALLERY_MATS = {
    // envMapIntensity is deliberately low: image-based light reaches into
    // concave features almost as strongly as onto flat faces, which flattens
    // pockets and sockets into painted rectangles. The shadow-casting key light
    // describes the shape instead.
    // polygonOffset pushes the surface a hair back so the edge overlay sits on
    // top of it instead of z-fighting the faces it traces.
    // A clearcoat has its own Fresnel term on top of the base layer's, so at
    // grazing angles it goes almost fully reflective — which is why the same
    // part read as matte from above and as polished metal from underneath,
    // where every face is seen edge-on. Half the clearcoat and a rougher one
    // keeps the sheen without the flip, and the part looks like the same
    // plastic from both sides.
    plastic: () => new THREE.MeshPhysicalMaterial({ color: 0xe8b23a, roughness: 0.45, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.5, envMapIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    pla: () => new THREE.MeshStandardMaterial({ color: 0xe8b23a, roughness: 0.85, metalness: 0, envMapIntensity: 0.25, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    clay: () => new THREE.MeshLambertMaterial({ color: 0xe8b23a }),
    normals: () => new THREE.MeshNormalMaterial()
};

/**
 * Studio rig for the part inspector.
 * Recessed features — bowtie pockets, hex sockets — are only legible when
 * something OCCLUDES them. A bright uniform environment lights the inside of a
 * pocket almost as strongly as the flat rib around it, which is what made the
 * joint read as a painted rectangle; so the IBL is dialled back (see
 * GALLERY_MATS.envMapIntensity) and a raking, shadow-casting key describes the
 * shape instead.
 */
function lightPartViewer(target) {
    target.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    target.renderer.toneMappingExposure = 1.15;
    target.renderer.shadowMap.enabled = true;
    target.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    target.scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 0.26));
    const key = new THREE.DirectionalLight(0xfff2d8, 2.4);
    key.position.set(170, 240, 205);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.5;
    target.scene.add(key);
    target.key = key;
    // cool fill keeps the shadow side off black; warm rim separates the
    // silhouette from the background
    const fill = new THREE.DirectionalLight(0xbdd4ff, 0.42);
    fill.position.set(-230, 80, 150);
    target.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd2a0, 0.85);
    rim.position.set(-110, 55, -250);
    target.scene.add(rim);

    // Slicer-style build plate: a light plane the part sits on, so the piece
    // reads as something about to be printed rather than floating in a void.
    // A real (not ShadowMaterial) surface so it also carries the contact shadow.
    target.shadowCatcher = new THREE.Mesh(
        new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x2f4a6e, roughness: 0.92, metalness: 0 })
    );
    target.shadowCatcher.receiveShadow = true;
    target.scene.add(target.shadowCatcher);
}

/**
 * Graph-paper grid for the build plate — fine 10 mm squares with a heavier
 * 50 mm line, in light blue. Two GridHelpers rather than one because a single
 * helper can only draw two line weights and we want the minor grid genuinely
 * faint against the major.
 */
function makeGraphPlate(extent) {
    const g = new THREE.Group();
    // Light lines on a denim plate — inverted from the usual dark-on-light
    // graph paper, which is how a slicer bed actually reads. Divisions are
    // derived from the extent so squares stay a true 10 mm at any plate size.
    const minor = new THREE.GridHelper(extent, Math.round(extent / 10), 0x8ba9cc, 0x8ba9cc);
    minor.material.transparent = true;
    minor.material.opacity = 0.72;
    const major = new THREE.GridHelper(extent, Math.round(extent / 50), 0xd6e4f2, 0xd6e4f2);
    major.material.transparent = true;
    major.material.opacity = 0.95;
    major.position.y = 0.06;         // sit clear of the minor lines
    g.add(minor, major);
    return g;
}

/** Fits the shadow frustum and ground plane to the selected part.
 *  `floorY` overrides where the plate sits: a single part is recentred so its
 *  lowest point IS the bed, but a scene composite keeps world heights — its
 *  floor is the world's y=0, and putting the plate under the bbox min instead
 *  parked it under the lowest PART, leaving everything else "floating" (the
 *  first thing Brett saw in the all-scene view). */
function framePartShadow(target, box, center, size, floorY = null) {
    if (target.key) {
        const r = size * 0.62;
        const sc = target.key.shadow.camera;
        sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
        sc.near = 1; sc.far = size * 4;
        sc.updateProjectionMatrix();
        target.key.position.set(center.x + size * 0.5, center.y + size * 0.9, center.z + size * 0.6);
        target.key.target.position.copy(center);
        target.key.target.updateMatrixWorld();
        target.scene.add(target.key.target);
    }
    // The plate must not extend past the shadow camera's frustum: outside it
    // the shadow map is undefined, so a large plate renders as a black,
    // acne-streaked field. Harmless while the plate was near-white, obvious
    // the moment it went denim. Size it to the frustum and rebuild the grid to
    // match, keeping true 10 mm squares.
    const extent = Math.max(120, Math.round(size * 1.1 / 50) * 50);
    if (target.plateExtent !== extent) {
        if (target.grid) target.scene.remove(target.grid);
        target.grid = makeGraphPlate(extent);
        target.scene.add(target.grid);
        target.plateExtent = extent;
        if (target.shadowCatcher) target.shadowCatcher.scale.set(extent / 1200, 1, extent / 1200);
    }
    // 0.06, not 0.45: the plate is what tells you the part is SITTING on the
    // bed, and at inspection zoom a 0.45 mm gap reads as the part hovering.
    // The shadow catcher stays a little lower so it never z-fights the grid.
    const plateY = floorY ?? box.min.y;
    if (target.shadowCatcher) target.shadowCatcher.position.set(center.x, plateY - 0.25, center.z);
    target.grid.position.set(center.x, plateY - 0.06, center.z);
}

function initGallery() {
    if (gallery.renderer) return;
    const holder = $('parts-stage');
    gallery.renderer = new THREE.WebGLRenderer({ antialias: true });
    gallery.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    gallery.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    gallery.renderer.toneMappingExposure = 1.15;
    gallery.renderer.shadowMap.enabled = true;
    gallery.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    holder.appendChild(gallery.renderer.domElement);
    gallery.scene = new THREE.Scene();
    // Near-black, not near-white. The plate is opaque from above, so a light
    // background was only ever seen from BELOW — and the underside is where
    // this viewer earns its keep (sockets, pockets, the arcade). Down there a
    // pale field washed out the plate's own grid and the part's dark edges
    // both. Dark reads from every angle, which is why CAD viewers use it.
    gallery.scene.background = new THREE.Color(0x0b1017);
    // studio environment: reflections make the physical material read as
    // injection-molded plastic instead of untextured CAD
    const pmrem = new THREE.PMREMGenerator(gallery.renderer);
    gallery.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    gallery.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
    gallery.controls = new OrbitControls(gallery.camera, gallery.renderer.domElement);
    gallery.controls.enableDamping = true;
    // Follow the checkbox, which starts unchecked. Hardcoding `true` here left
    // the viewer spinning with the box off until you toggled it twice.
    gallery.controls.autoRotate = !!$('print-part-rotate')?.checked;
    gallery.controls.autoRotateSpeed = 1.6;
    gallery.controls.zoomSpeed = 3;
    lightPartViewer(gallery);


    $('print-part-shading').addEventListener('change', () => { gallery.style = $('print-part-shading').value; applyGalleryStyle(); });
    $('print-part-rotate').addEventListener('change', () => { gallery.controls.autoRotate = $('print-part-rotate').checked; });
    // AUTO-SPIN YIELDS THE MOMENT YOU TOUCH THE PART. OrbitControls fires
    // `start` on the first pointer-down or wheel tick of a gesture, so one
    // listener covers dragging, pinching and zooming alike — no need to guess
    // at which events count as "interacting".
    //
    // The CHECKBOX is cleared with the flag, not just the flag. They are
    // allowed to disagree exactly once and it is the bug directly above from
    // the other side: a box still ticked while the part sits motionless, and
    // two clicks needed to get spin back because the first one only restates
    // what the box already claims.
    gallery.controls.addEventListener('start', () => {
        if (!gallery.controls.autoRotate) return;
        gallery.controls.autoRotate = false;
        const box = $('print-part-rotate');
        if (box) box.checked = false;
    });
    paintModeButton('print-part-mode', gallery.mode);
    $('print-part-mode').addEventListener('click', () => cycleRenderMode(gallery, 'print-part-mode', applyGalleryStyle));
    $('print-part-dims').addEventListener('change', () => { gallery.showDims = $('print-part-dims').value; applyGalleryStyle(); });
    const allBtn = $('print-all-scene');
    if (allBtn) allBtn.addEventListener('click', () =>
        selectGalleryScene(gallery.parts.map((_, i) => i), 'whole scene'));
}

/**
 * Engineering dimensions, drawn the way a drawing draws them.
 *
 * Every callout is ONE measurement with a stated pair of attachment points:
 * witness lines leave the two measured points (starting a small gap off the
 * surface, so the line belongs to the part rather than growing out of it), a
 * dimension line runs between them carrying arrowheads, and the value sits on
 * that line. Nothing is placed by eye and nothing is grouped — a stack of six
 * numbers in one pill cannot say which surface any of them came from, which is
 * the entire job of a dimension.
 *
 * The text lives IN THE SCENE, on the dimension's own plane, not on a
 * screen-facing billboard: it scales with the part, it sits on the line it
 * belongs to, and it never floats off into the middle distance. The one thing
 * in-scene text gets wrong is reading backwards or upside down from the far
 * side, and that is what orientDimText fixes each frame — the same convention
 * a CAD viewer uses.
 *
 * Sizes all come off the part. A 22 mm key and a 300 mm ramp both want the
 * dimension line to clear the material without flying into the next grid
 * square, so the stand-off, the arrowheads and the text are fractions of the
 * bounding diagonal rather than constants.
 *
 * Where a feature is one the joints depend on, the callout carries a second
 * line: what it should MEASURE once printed. Those come from PRINT_DEVIATION,
 * which is calipers on a printed set, not a model of a printer.
 */
/**
 * Magenta, and it is not a taste call. The annotation has to separate from
 * FOUR things at once: a gold part, a denim plate, a white grid and a
 * near-black background. Cyan cleared the gold and the black and then
 * disappeared into the plate, which is where the callouts actually spend most
 * of their time. Magenta is the one hue that none of the others is near, and
 * it is the drafting convention for construction geometry for that reason.
 */
const DIM_INK = '#ff49b0';

function makeDimGroup(box, part, show = 'all') {
    const g = new THREE.Group();
    const faceables = [];          // text planes that re-orient to the camera
    g.userData.dimText = faceables;
    const size = box.getSize(new THREE.Vector3());
    const { min, max } = box;
    const diag = size.length();
    const S = Math.min(Math.max(diag * 0.026, 0.7), 2.6);    // arrowhead length
    const OFF = Math.min(Math.max(diag * 0.055, 4), 13);     // dim line stand-off
    const GAP = S * 0.7;                                     // witness line gap
    const OVER = S * 1.2;                                    // witness overshoot
    // Text is sized so a value block is about a 25th of the part's diagonal —
    // the proportion a drawing uses. The floor is deliberately low: clamping
    // it up "so small parts stay readable" is what made the key's callouts
    // bigger than the key.
    const TXT = Math.min(Math.max(diag * 0.030, 0.6), 7);    // text cap height

    // WebGL ignores LineBasicMaterial.linewidth — it is always one pixel,
    // which is why these read as hairlines over a busy plate. Line2 draws them
    // as camera-facing quads, so they can actually be 2.5 px. Every segment
    // shares one material and one geometry, built at the end.
    const lineMat = new LineMaterial({
        color: DIM_INK, linewidth: 2.5, resolution: new THREE.Vector2(1, 1),
        depthTest: false, transparent: true, opacity: 0.98
    });
    g.userData.lineMats = [lineMat];
    const segPts = [];
    const inkMat = new THREE.MeshBasicMaterial({
        color: DIM_INK, depthTest: false, transparent: true, opacity: 0.98
    });
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const seg = (a, b) => { segPts.push(a.x, a.y, a.z, b.x, b.y, b.z); };
    /** Solid arrowhead: apex AT `tip`, pointing along `dir`. */
    const arrow = (tip, dir, s = S) => {
        const geo = new THREE.ConeGeometry(s * 0.26, s, 8);
        geo.translate(0, -s / 2, 0);           // apex to the origin
        const m = new THREE.Mesh(geo, inkMat);
        m.quaternion.setFromUnitVectors(V(0, 1, 0), dir.clone().normalize());
        m.position.copy(tip);
        m.renderOrder = 25;
        g.add(m);
    };

    /**
     * A value, lying on the dimension's plane. `dir` is the reading direction
     * (along the dimension line) and `up` points away from the part.
     */
    const PX = 64;
    const text = (lines, pos, dir, up) => {
        const rows = lines.filter(Boolean);
        const fonts = rows.map((_, i) => i === 0
            ? `600 ${PX}px system-ui, -apple-system, sans-serif`
            : `500 ${Math.round(PX * 0.76)}px system-ui, -apple-system, sans-serif`);
        const probe = document.createElement('canvas').getContext('2d');
        const tw = Math.ceil(Math.max(...rows.map((l, i) => {
            probe.font = fonts[i];
            return probe.measureText(l).width;
        }))) + PX * 0.5;
        const rowH = rows.map((_, i) => PX * (i === 0 ? 1.24 : 1.0));
        const th = rowH.reduce((a, b) => a + b, 0);

        const c = document.createElement('canvas');
        c.width = tw; c.height = Math.ceil(th);
        const ctx = c.getContext('2d');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let y = 0;
        rows.forEach((line, i) => {
            ctx.font = fonts[i];
            // dark outline, not a filled pill: the value reads over the part
            // and over the plate without boxing off the geometry behind it
            ctx.lineWidth = PX * 0.10;
            ctx.strokeStyle = 'rgba(6,12,20,0.85)';
            ctx.lineJoin = 'round';
            ctx.strokeText(line, tw / 2, y + rowH[i] / 2);
            // Both rows white. The as-printed row used to take the ink colour
            // to mark it as secondary, which read as a second kind of thing
            // rather than a second line — and magenta text on a gold part is
            // barely legible. Weight and size already say which is which.
            ctx.fillStyle = i === 0 ? '#ffffff' : '#dfe8f2';
            ctx.fillText(line, tw / 2, y + rowH[i] / 2);
            y += rowH[i];
        });

        const tex = new THREE.CanvasTexture(c);
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        // A UNIT quad: the real size is set every frame in orientDimText, so
        // the geometry must not carry one of its own or the two multiply.
        const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({
                map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide
            })
        );
        plane.position.copy(pos);
        plane.renderOrder = 31;
        // Aspect is fixed; the SIZE is set per frame so the value reads the
        // same everywhere — see orientDimText.
        plane.userData = {
            dir: dir.clone().normalize(), up: up.clone().normalize(),
            aspect: tw / th, rows: rows.length
        };
        faceables.push(plane);
        g.add(plane);
    };

    /**
     * As-printed line for a fit-critical feature. `klass` names the measured
     * population; nothing gets a tolerance there is no data for.
     */
    const printedNote = (drawnMm, klass) => {
        if (!klass) return null;
        const p = printedSize(drawnMm, klass);
        return `prints ${p.nominal.toFixed(2)} ±${(2 * p.sigmaMm).toFixed(2)}`;
    };

    /** One linear dimension between two points on the part, offset along `out`. */
    const dim = (a, b, out, main, opts = {}) => {
        const o = out.clone().normalize();
        const off = opts.offMm ?? OFF;
        const A = a.clone().addScaledVector(o, off);
        const B = b.clone().addScaledVector(o, off);
        seg(a.clone().addScaledVector(o, GAP), A.clone().addScaledVector(o, OVER));
        seg(b.clone().addScaledVector(o, GAP), B.clone().addScaledVector(o, OVER));
        const span = B.clone().sub(A);
        const len = span.length();
        if (len < 1e-6) return;
        const dir = span.clone().normalize();
        // A callout is sized by WHAT IT MEASURES, capped by the part. Sizing
        // everything off the part's diagonal instead put 5 mm lettering on a
        // 9 mm pocket depth, and the seven joint dimensions — all of which
        // live inside 30 mm at one end of a 150 mm ramp — piled into an
        // unreadable heap.
        // Text size is no longer a world dimension at all — orientDimText
        // sets it per frame so every value reads the same on screen. TXT is
        // still what the label is OFFSET by, so a callout sits off its line
        // by about its own height.
        const txt = TXT;
        // The arrowhead is part of the callout, so it scales with the callout.
        // Sized off the part instead, a 2.6 mm head sat on a 3 mm dimension
        // whose text was 0.5 mm — five times the lettering it belonged to.
        const s = Math.min(S, Math.max(0.2, len * 0.09));
        if (len > 5 * s) {
            seg(A, B);                                   // arrows inside, pointing out
            arrow(A, dir.clone().negate(), s);
            arrow(B, dir, s);
        } else {
            seg(A.clone().addScaledVector(dir, -3 * s),  // too short: arrows outside
                B.clone().addScaledVector(dir, 3 * s));
            arrow(A, dir, s);
            arrow(B, dir.clone().negate(), s);
        }
        const sub = opts.sub ?? printedNote(opts.drawnMm, opts.klass);
        const mid = A.clone().add(B).multiplyScalar(0.5)
            .addScaledVector(o, txt * (sub ? 1.15 : 0.85));
        text([main, sub], mid, dir, o);
    };

    /** Emit the accumulated segments as ONE fat-line object and hand back g. */
    const finish = () => {
        if (segPts.length) {
            const lg = new LineSegmentsGeometry();
            lg.setPositions(segPts);
            const lines = new LineSegments2(lg, lineMat);
            lines.renderOrder = 24;
            g.add(lines);
        }
        return g;
    };

    const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);
    const mmText = (v) => `${v.toFixed(v < 10 ? 2 : 1)} mm`;

    const name = part?.name ?? '';
    const K = SPEC.key;
    // A part that dimensions its own features does not also want the bounding
    // box: on the key every box dimension is a feature dimension already, and
    // drawing both is how a legible drawing turns into a thicket.
    if (show !== 'features' && name !== 'bowtie_key') {
        dim(V(min.x, min.y, max.z), V(max.x, min.y, max.z), Z, mmText(size.x));
        dim(V(max.x, min.y, min.z), V(max.x, min.y, max.z), X, mmText(size.z));
        dim(V(max.x, min.y, max.z), V(max.x, max.y, max.z), X, mmText(size.y));
    }

    if (!part || show === 'overall') return finish();

    if (name === 'bowtie_key') {
        // The key is recentred: +X is tip to tip, +Z runs into the two pockets,
        // y = 0 is the first layer off the plate.
        const halfDepth = K.depth;
        dim(V(-K.neckHalf, max.y, 0), V(K.neckHalf, max.y, 0), Y,
            `waist ${(2 * K.neckHalf).toFixed(1)} mm`,
            { drawnMm: 2 * K.neckHalf, klass: 'external' });
        dim(V(min.x, min.y, -halfDepth), V(max.x, min.y, -halfDepth), Z.clone().negate(),
            `tip ${size.x.toFixed(2)} mm`, { drawnMm: size.x, klass: 'external' });
        // the full thickness, off the same corner the land is measured from
        dim(V(max.x, min.y, -halfDepth), V(max.x, max.y, -halfDepth), Z.clone().negate(),
            `${size.y.toFixed(1)} mm thick`, { offMm: OFF * 1.7 });
        // engagement into ONE pocket, taken at the tip so the callout sits
        // clear of the part rather than across it
        dim(V(min.x, min.y, 0), V(min.x, min.y, halfDepth), X.clone().negate(),
            `${halfDepth.toFixed(1)} mm engaged`);
        // The land between the two 0.5 mm chamfers — what actually bears on the
        // pocket ceiling, and NOT the overall height.
        dim(V(max.x, min.y + 0.5, halfDepth), V(max.x, max.y - 0.5, halfDepth),
            X, `land ${(size.y - 1).toFixed(1)} mm`, { offMm: OFF * 1.7 });
    }
    else if (/^support_(riser|foot|jog)/.test(name)) {
        const tenonAF = SPEC.socket.hexAF - 2 * SPEC.jointClearanceMm;   // 8.6
        dim(V(-tenonAF / 2, max.y, 0), V(tenonAF / 2, max.y, 0), Y,
            `tenon ${tenonAF.toFixed(1)} mm across flats`, { drawnMm: tenonAF, klass: 'external' });
        dim(V(tenonAF / 2, max.y - 9, 0), V(tenonAF / 2, max.y, 0), X, 'tenon 9.0 mm');
        if (!/^support_foot/.test(name)) {
            // the socket that measured RIGHT — the reference for every other one
            const af = SPEC.socket.hexAF;
            dim(V(-af / 2, min.y, 0), V(af / 2, min.y, 0), Y.clone().negate(),
                `socket ${af.toFixed(1)} mm across flats`, { drawnMm: af, klass: 'holeSlender' });
            dim(V(af / 2, min.y, 0), V(af / 2, min.y + SPEC.socket.depth, 0),
                X.clone().negate(), `${SPEC.socket.depth.toFixed(1)} mm deep`);
        }
    }
    else if (part.piece) {
        trackPieceDims();
    }
    return finish();

    /**
     * The features a track piece is judged on: the channel the figure walks
     * in, the socket a column plugs into, the pocket the key rises into. Each
     * is dimensioned where it is, in the piece's recentred export frame —
     * along +X with +Z lateral and y = 0 at the rim (see recenter).
     */
    function trackPieceDims() {
        const pc = part.piece;
        const support = part.support;
        const spec = SPEC;

        const hd = pc.entry.h;
        const cos = Math.cos(-hd), sin = Math.sin(-hd);
        const toLocal = (wx, wz) => {
            const tx = wx - pc.entry.x, tz = wz - pc.entry.z;
            return [tx * cos - tz * sin, tx * sin + tz * cos];
        };
        let minLx = Infinity, maxLx = -Infinity, minLz = Infinity, maxLz = -Infinity;
        for (const st of stationsForPiece(pc, 5)) {
            const [slx, slz] = toLocal(st.origin[0], st.origin[2]);
            const W = pc.innerWidth / 2 + spec.wall;
            minLx = Math.min(minLx, slx - W); maxLx = Math.max(maxLx, slx + W);
            minLz = Math.min(minLz, slz - W); maxLz = Math.max(maxLz, slz + W);
        }
        const cx = (minLx + maxLx) / 2, cz = (minLz + maxLz) / 2;
        const at = (wx, wz) => {
            const [lx, lz] = toLocal(wx, wz);
            return [lx - cx, lz - cz];
        };

        // ---- the channel, across the open middle --------------------------
        // Taken at MID-PIECE and carried up over the rails, not at an end
        // face: the ends are closed by ribs, so a callout there attaches to
        // two points buried behind material and hangs in space next to a
        // surface that is not the one being measured. Mid-piece the channel
        // is open to the sky, which is exactly where you would put a caliper.
        const half = pc.planLen / 2;
        const mid = planPosAt(pc, half);
        const [mX, mZ] = at(mid.x, mid.z);
        const hl = mid.h - pc.entry.h;                    // heading in the local frame
        const rt = [-Math.sin(hl), Math.cos(hl)];         // lateral unit vector
        const midY = deckYAt(pc, half) - pc.rimY;
        const Wi = innerWidthAt(pc, half) / 2;
        dim(V(mX - rt[0] * Wi, midY, mZ - rt[1] * Wi),
            V(mX + rt[0] * Wi, midY, mZ + rt[1] * Wi), Y,
            `channel ${pc.innerWidth.toFixed(1)} mm`,
            { offMm: spec.railHeight + OFF,
              sub: `prints ≈${(pc.innerWidth - CLEARANCE.printNarrowingMm).toFixed(2)} (measured)` });

        /**
         * Feature clusters stand off by a FEATURE-sized amount, not the
         * part's. `OFF` is 13 mm on a 150 mm ramp, which is right for the
         * ramp's own overall dimensions and absurd for a 19 mm boss — it put
         * the socket callouts 13 and 28 mm out in open air below the piece,
         * where they read as belonging to nothing. Innermost feature closest,
         * as on a drawing.
         */
        const FOFF = 5;

        // ---- the support socket ------------------------------------------
        if (support && support.mode !== 'none') {
            const [sx, sz] = at(support.x, support.z);
            const af = spec.socket.hexAF - (spec.socket.socketShrinkAF ?? 0);
            dim(V(sx - af / 2, 0, sz), V(sx + af / 2, 0, sz), Y.clone().negate(),
                `socket ${af.toFixed(2)} mm across flats`,
                { drawnMm: af, klass: 'holeMassive', offMm: FOFF });
            const bossOD = 2 * spec.socket.bossR;
            dim(V(sx - spec.socket.bossR, 0, sz), V(sx + spec.socket.bossR, 0, sz),
                Y.clone().negate(), `boss Ø ${bossOD.toFixed(1)} mm`,
                { drawnMm: bossOD, klass: 'external', offMm: FOFF * 2.6 });
            // depth runs UP into the boss, so it goes beside it rather than
            // under it — under it, it lands inside the two width callouts
            dim(V(sx, 0, sz + spec.socket.bossR), V(sx, spec.socket.depth, sz + spec.socket.bossR),
                Z, `${spec.socket.depth.toFixed(1)} mm deep`, { offMm: FOFF });
        }

        // ---- the bowtie pocket at the exit face ---------------------------
        if (pc.type === 'end') return;
        const [exX, exZ] = at(pc.exit.x, pc.exit.z);
        const exY = pc.exitDeck - pc.rimY;
        const poc = bowtiePocketPlan({
            neckHalf: K.neckHalf, tipHalf: K.tipHalf, depth: K.depth,
            clearance: K.fitClearanceMm, depthClearance: K.depthClearanceMm
        });
        const mouthHalf = poc[1][0], tipHalf = poc[2][0], pocDepth = poc[2][1];
        const keyH = K.height - 2 * spec.jointClearanceMm;
        const ceilY = exY - 3;                 // the key's vertical stop
        const bandY = ceilY - keyH;
        const inward = exX >= 0 ? -1 : 1;
        const outward = X.clone().multiplyScalar(-inward);

        // Both widths go BELOW the piece, on parallel lines, because that is
        // the side you look at the pocket from — and because the wide end sat
        // above the deck when it was pushed +Y, drawn straight across the
        // walking surface it has nothing to do with. They are already 9 mm
        // apart along the track, so the pair reads as the taper it is.
        dim(V(exX, bandY, exZ - mouthHalf), V(exX, bandY, exZ + mouthHalf),
            Y.clone().negate(), `mouth ${(2 * mouthHalf).toFixed(2)} mm`,
            { drawnMm: 2 * mouthHalf, klass: 'holeMassive', offMm: bandY + FOFF });
        dim(V(exX + inward * pocDepth, bandY, exZ - tipHalf),
            V(exX + inward * pocDepth, bandY, exZ + tipHalf), Y.clone().negate(),
            `wide end ${(2 * tipHalf).toFixed(2)} mm`,
            { drawnMm: 2 * tipHalf, klass: 'holeMassive', offMm: bandY + FOFF * 2.6 });
        dim(V(exX, ceilY, exZ + tipHalf), V(exX + inward * pocDepth, ceilY, exZ + tipHalf),
            Z, `${pocDepth.toFixed(2)} mm deep`, { offMm: FOFF });
        // the band the key occupies and the cap of material above it: the two
        // numbers that decide whether the decks meet flush at the seam
        dim(V(exX, bandY, exZ - tipHalf), V(exX, ceilY, exZ - tipHalf),
            outward, `key band ${keyH.toFixed(1)} mm`, { offMm: FOFF });
        dim(V(exX, ceilY, exZ - tipHalf), V(exX, exY, exZ - tipHalf),
            outward, 'cap 3.0 mm', { offMm: FOFF * 2.6 });
    }
}

/**
 * Keep in-scene dimension text readable.
 *
 * The text is placed in the world, on its dimension line — that is what makes
 * it read as part of the drawing rather than as a floating tag. A plane fixed
 * rigidly in the world, though, is mirrored from behind, upside down from
 * below, and edge-on to nothing from directly above.
 *
 * So only ONE axis is pinned: the reading direction stays along the dimension
 * line, which is the thing that says which measurement the number belongs to.
 * The plane then rotates about that axis until it faces the camera. Position
 * never changes, the number always sits on its own line, and all three failure
 * modes go away at once.
 */
function orientDimText(group, camera) {
    const planes = group?.userData?.dimText;
    if (!planes) return;
    const toCam = new THREE.Vector3(), dir = new THREE.Vector3();
    const up = new THREE.Vector3(), nrm = new THREE.Vector3(), camRight = new THREE.Vector3();
    const m = new THREE.Matrix4();
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    // World-sized text made a 40 mm callout tower over an 8.75 mm one, and put
    // the near ones twice the size of the far ones on the same part. A drawing
    // letters every dimension the same, so size is set per frame from the
    // distance to the camera: constant on screen, still positioned and
    // oriented in the scene. TXT_FRAC is a fraction of viewport height.
    const TXT_FRAC = 0.020;
    const halfFov = Math.tan((camera.fov * Math.PI / 180) / 2);
    for (const p of planes) {
        const dist = camera.position.distanceTo(p.position);
        const h = 2 * dist * halfFov * TXT_FRAC * (p.userData.rows > 1 ? 1.7 : 1);
        p.scale.set(h * p.userData.aspect, h, 1);
        dir.copy(p.userData.dir);
        /**
         * Which way the text reads.
         *
         * A vertical dimension is the degenerate case: its direction is
         * perpendicular to the camera's right vector from every angle, so
         * "does it point screen-right?" is a coin toss decided by rounding,
         * and the label flickers between reading up and reading down as you
         * orbit. Vertical dimensions get the drafting convention instead —
         * they always read UPWARD — which is stable because the direction is
         * fixed in the world, not in the view.
         *
         * Everything else follows the camera, with a deadband so a dimension
         * you happen to be sighting along does not flip on noise either. The
         * chosen sign is remembered, so inside the deadband it simply keeps
         * doing what it was doing.
         */
        const upness = dir.y;                       // dir is unit length
        if (Math.abs(upness) > 0.5) {
            // A vertical dimension is the case a paper drawing solves by
            // turning the text on its side. In a viewer you can orbit, that
            // is the worst of both: 90°-rotated lettering is hard to read AND
            // its direction is perpendicular to the camera's right vector from
            // every angle, so "does it point screen-right?" is a coin toss
            // decided by rounding and the label flips as you move. Vertical
            // callouts read HORIZONTALLY instead — still sitting on their own
            // dimension line, just kept upright.
            dir.copy(camRight);
            dir.y = 0;
            if (dir.lengthSq() < 1e-9) continue;    // looking straight down
            dir.normalize();
        } else {
            const d = dir.dot(camRight);
            if (Math.abs(d) > 0.15) p.userData.sign = d < 0 ? -1 : 1;
            if ((p.userData.sign ?? 1) < 0) dir.negate();
        }
        toCam.copy(camera.position).sub(p.position);
        // the normal is the part of the view direction perpendicular to the
        // reading direction: the text spins about its own dimension line until
        // it faces you, so it is never mirrored, never upside down, and never
        // foreshortened to a sliver — but it still belongs to its dimension.
        nrm.copy(toCam).addScaledVector(dir, -toCam.dot(dir));
        if (nrm.lengthSq() < 1e-9) continue;         // looking straight down it
        nrm.normalize();
        up.crossVectors(nrm, dir).normalize();
        m.makeBasis(dir, up, nrm);
        p.quaternion.setFromRotationMatrix(m);
    }
}

/** (Re)builds the displayed mesh + overlays from gallery.geo and view options. */
/**
 * Hidden-line overlay for the part inspector — the same convention the joint
 * guide uses: solid dark edges where an edge is genuinely visible, dashed grey
 * where it lies behind material. On a solid gold part that is what separates a
 * pocket from a shadow, and it reveals internal features (socket bores, the
 * bowtie pocket) that an opaque render simply hides.
 *
 * The hidden pass draws with depthTest OFF, which is the only way to see an
 * edge that is behind material — and exactly why it must NOT be drawn over a
 * shaded part. Painting it there ignores the solid entirely and the plastic
 * reads as transparent. So `withHidden` is on only for HLR-only mode, where
 * seeing through the part is the whole point.
 *
 * The part mesh is opaque and already writes depth, so no prepass is needed
 * here — only the polygonOffset on GALLERY_MATS so edges win the depth test.
 *
 * THE INK HAS TO KNOW WHAT IT IS DRAWN ON, and `withHidden` is that flag too:
 * it is on exactly when the surface is off. Shaded + HLR draws on a gold part,
 * so the lines are near-black. HLR-only draws on the viewer's own background,
 * which is 0x0b1017 — near-black lines there are invisible, and the mode
 * rendered as an almost blank frame with only the dimension arrows in it. Same
 * fault the wireframe had (dark navy on mid-blue), same fix: light ink on the
 * dark plate.
 */
const EDGE_INK = {
    onPart: { visible: 0x23180a, hidden: 0x2b3138, hiddenOpacity: 0.5 },
    onPlate: { visible: 0xf4efe4, hidden: 0x8fa0b4, hiddenOpacity: 0.45 }
};

function makePartEdges(geo, res, withHidden, thresholdDeg = EDGE_ANGLE.washboard) {
    const g = new THREE.Group();
    const ink = withHidden ? EDGE_INK.onPlate : EDGE_INK.onPart;
    // LineMaterial.resolution is a COPY-ON-SET accessor (it does
    // uniforms.resolution.value.copy(v)), so handing it a shared Vector2 and
    // mutating that later never reaches the shader. The materials themselves
    // have to be updated — see updateLineRes().
    const fat = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(geo, thresholdDeg));
    const hidden = new LineSegments2(fat, new LineMaterial({
        color: ink.hidden, linewidth: 1.5, resolution: res,
        transparent: true, opacity: ink.hiddenOpacity, depthTest: false,
        dashed: true, dashSize: 4.2, gapSize: 1.5
    }));
    hidden.computeLineDistances();
    hidden.renderOrder = 2;
    const visible = new LineSegments2(fat, new LineMaterial({
        color: ink.visible, linewidth: 2.0, resolution: res
    }));
    visible.renderOrder = 3;
    if (withHidden) g.add(hidden);
    g.add(visible);
    g.userData.lineMats = withHidden
        ? [hidden.material, visible.material]
        : [visible.material];
    return g;
}

/**
 * Facet angles above which an edge is drawn.
 *
 * The high threshold exists for exactly ONE feature: the washboard. Its ridges
 * are sampled 6x per 2.5 mm, so at the crests facet-to-facet reaches ~38°, and
 * anything lower emits a comb of ~120 lines across the floor that buries the
 * part. Nothing else on any part needs it — and it costs real information: a
 * chamfer on a 66° bowtie tip meets its flanks at 33°, so at 45° the key's
 * chamfered corners simply had no outline, which is what made them look like a
 * shading artefact. Parts without a washboard get the low threshold.
 */
const EDGE_ANGLE = { washboard: 45, plain: 22 };

/** Push a real viewport size into Line2 materials (see makePartEdges). */
function updateLineRes(mats, w, h) {
    if (!mats || !w || !h) return;
    for (const m of mats) m.resolution.set(w, h);
}

/**
 * Render modes for the part viewers, cycled by one button.
 *   shaded     — just the material, as the printed part would look
 *   shadedHlr  — shaded plus the hidden-line overlay (default)
 *   hlr        — line drawing only; a depth-only stand-in mesh keeps the
 *                hidden/visible split working without drawing the surface
 *   wire       — raw tessellation, i.e. what the slicer actually receives
 */
// Each icon is the same isometric cube drawn the way that mode draws a part:
// filled, filled-with-edges, line-only with a dashed hidden edge, or fully
// triangulated. The glyph says more at a glance than the label does.
const CUBE = 'M7 1.2 13 4.7 13 10.7 7 14.2 1 10.7 1 4.7Z';
const CUBE_TOP = 'M7 1.2 13 4.7 7 8.2 1 4.7Z';
const CUBE_STEM = 'M7 8.2V14.2';
const modeIcon = (body) =>
    `<svg viewBox="0 0 14 15.4" width="13" height="14" fill="none" stroke-linejoin="round" style="vertical-align:-2px">${body}</svg>`;

const RENDER_MODES = [
    {
        key: 'shaded', label: 'Shaded',
        icon: modeIcon(`<path d="${CUBE}" fill="currentColor" opacity=".85"/>`)
    },
    {
        key: 'shadedHlr', label: 'Shaded + HLR',
        icon: modeIcon(`<path d="${CUBE}" fill="currentColor" opacity=".55"/>
            <path d="${CUBE}" stroke="currentColor" stroke-width="1.1"/>
            <path d="${CUBE_TOP}" stroke="currentColor" stroke-width="1.1"/>
            <path d="${CUBE_STEM}" stroke="currentColor" stroke-width="1.1"/>`)
    },
    {
        key: 'hlr', label: 'HLR only',
        icon: modeIcon(`<path d="${CUBE}" stroke="currentColor" stroke-width="1.1"/>
            <path d="${CUBE_TOP}" stroke="currentColor" stroke-width="1.1"/>
            <path d="${CUBE_STEM}" stroke="currentColor" stroke-width="1.1"/>
            <path d="M7 8.2 1 4.7M7 8.2 13 4.7" stroke="currentColor" stroke-width=".9"
                  stroke-dasharray="1.6 1.4" opacity=".75"/>`)
    },
    {
        key: 'wire', label: 'Wireframe',
        icon: modeIcon(`<path d="${CUBE}" stroke="currentColor" stroke-width=".9"/>
            <path d="${CUBE_TOP}" stroke="currentColor" stroke-width=".9"/>
            <path d="${CUBE_STEM}" stroke="currentColor" stroke-width=".9"/>
            <path d="M1 4.7 7 8.2 13 4.7M7 1.2 7 8.2M1 4.7 7 14.2M13 4.7 7 14.2"
                  stroke="currentColor" stroke-width=".7" opacity=".8"/>`)
    }
];

/** Paint a mode button with its icon + label. */
function paintModeButton(btnId, mode) {
    const btn = $(btnId);
    if (!btn) return;
    const m = RENDER_MODES[mode];
    btn.innerHTML = `${m.icon} <span style="margin-left:4px">${m.label}</span>`;
}

/**
 * Takes the viewer state object and its resize function, so the render-mode
 * logic lives in exactly one place.
 */
function applyViewerStyle(target, resizeFn) {
    for (const key of ['mesh', 'prepass', 'wire', 'dims', 'edges']) {
        if (target[key]) {
            target.scene.remove(target[key]);
            target[key] = null;
        }
    }
    if (!target.geo) return;
    const mode = RENDER_MODES[target.mode ?? 1].key;
    const showSurface = mode === 'shaded' || mode === 'shadedHlr';
    const showEdges = mode === 'shadedHlr' || mode === 'hlr';

    if (showSurface) {
        target.mesh = new THREE.Mesh(target.geo, GALLERY_MATS[target.style]());
        // self-shadowing is what makes a pocket read as a cavity, not a decal
        target.mesh.castShadow = true;
        target.mesh.receiveShadow = true;
        target.scene.add(target.mesh);
    } else if (mode === 'hlr') {
        // Depth-only stand-in: without a surface in the depth buffer every
        // edge would pass the depth test and the drawing would be a flat
        // wireframe rather than a hidden-line view.
        target.prepass = new THREE.Mesh(target.geo, new THREE.MeshBasicMaterial({
            colorWrite: false, depthWrite: true,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
        }));
        target.prepass.renderOrder = -10;
        target.scene.add(target.prepass);
    }

    if (showEdges) {
        target.lineRes = target.lineRes ?? new THREE.Vector2(1, 1);
        // a scene composite is mostly track, so it takes the washboard angle
        const kind = target.sceneSelection ? 'track'
            : target.parts?.[target.selectedIndex]?.kind;
        target.edges = makePartEdges(target.geo, target.lineRes, mode === 'hlr',
            kind === 'track' ? EDGE_ANGLE.washboard : EDGE_ANGLE.plain);
        target.lineMats = target.edges.userData.lineMats;
        target.scene.add(target.edges);
        settleResize(resizeFn);      // seed the Line2 resolution
    } else {
        target.lineMats = null;
    }

    if (mode === 'wire') {
        // Bright green on the denim plate: a wireframe's job is to show the
        // tessellation, and dark navy lines on a mid-blue background hid the
        // very triangles you switch to this mode to look at.
        target.wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(target.geo),
            new THREE.LineBasicMaterial({ color: 0x5dff9b, transparent: true, opacity: 0.7 })
        );
        target.scene.add(target.wire);
    }

    // no dims on a scene composite — they describe ONE part's bounding box,
    // and a whole-tower box dimension is a number nobody asked for
    if (target.showDims && target.showDims !== 'none' && target.selectedIndex != null) {
        // from the geometry, not the mesh — there is no mesh in HLR/wire mode
        target.geo.computeBoundingBox();
        target.dims = makeDimGroup(
            target.geo.boundingBox.clone(),
            target.parts[target.selectedIndex],
            target.showDims
        );
        target.scene.add(target.dims);
        // Line2 needs a real viewport before it can compute pixel widths
        updateLineRes(target.dims.userData.lineMats, ...(() => {
            const el = target.renderer?.domElement;
            return [el?.clientWidth ?? 1, el?.clientHeight ?? 1];
        })());
        settleResize(resizeFn);
    }
}

/** Advance a viewer to the next render mode and relabel its button. */
function cycleRenderMode(target, btnId, apply) {
    target.mode = ((target.mode ?? 1) + 1) % RENDER_MODES.length;
    paintModeButton(btnId, target.mode);
    apply();
}

function applyGalleryStyle() { applyViewerStyle(gallery, galleryResize); }

/**
 * Runs a resize now and again once layout has settled. A pane that was just
 * switched from display:none frequently still reports 0x0 on the frame it is
 * revealed, so a single synchronous resize silently does nothing and the view
 * stays blank until something else triggers one.
 */
function settleResize(fn) {
    fn();
    requestAnimationFrame(() => { fn(); requestAnimationFrame(fn); });
}

function galleryResize() {
    const holder = $('parts-stage');
    if (!holder || !gallery.renderer) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    // A container that has not been laid out yet reports 0. Dividing by that
    // put NaN in camera.aspect and the projection matrix stayed broken until
    // some later resize — the "blank the first time, fine the second" bug.
    if (!w || !h) return;
    gallery.renderer.setSize(w, h);
    gallery.camera.aspect = w / h;
    gallery.camera.updateProjectionMatrix();
    if (gallery.lineRes) gallery.lineRes.set(w, h);
    updateLineRes(gallery.lineMats, w, h);
    updateLineRes(gallery.dims?.userData?.lineMats, w, h);
}

function openGallery() {
    setTab('export');
}

function closeGallery() {
    setTab('build');
}

/**
 * EVERY SELECTED PART AT ITS TRUE SCENE POSITION, as one display geometry.
 *
 * Each part carries `placements` (world position + yaw per instance, recorded
 * by assembleParts from the same data rebuild() places the scene with) and
 * `buildScene` (the export solid WITHOUT the print tilt — assembled
 * orientation). Instances are transformed and concatenated: legal here because
 * this mesh is only ever rendered — never exported, measured or sliced, which
 * is where concatenation voids results.
 *
 * Handing the merged geometry to `gallery.geo` is the point: the whole viewer
 * pipeline — Shaded + HLR, HLR-only, wireframe, every material — works on it
 * unchanged.
 */
function compositeSceneGeometry(indices) {
    const pos = [], idx = [];
    let base = 0, placed = 0;
    for (const i of indices) {
        const part = gallery.parts[i];
        const places = part?.placements ?? [];
        if (!places.length) continue;
        const g = (part.buildScene ?? part.build)();
        for (const pl of places) {
            const c = Math.cos(pl.yaw ?? 0), s = Math.sin(pl.yaw ?? 0);
            const P = g.positions, I = g.indices;
            for (let k = 0; k < P.length; k += 3) {
                const x = P[k], y = P[k + 1], z = P[k + 2];
                pos.push(pl.at[0] + x * c + z * s, pl.at[1] + y, pl.at[2] - x * s + z * c);
            }
            for (let k = 0; k < I.length; k++) idx.push(I[k] + base);
            base += P.length / 3;
            placed++;
        }
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx), placed };
}

function selectGalleryScene(indices, label) {
    gallery.selectedIndex = null;
    gallery.sceneSelection = indices;
    const rows = [...$('print-parts-list').children];
    rows.forEach((li, k) => li.classList.toggle('selected', indices.includes(k)));
    $('print-part-caption').innerHTML = '⏳ building scene geometry…';
    setTimeout(() => {
        if (gallery.geo) gallery.geo.dispose();
        const merged = compositeSceneGeometry(indices);
        if (!merged.placed) {
            $('print-part-caption').innerHTML = 'Nothing in this selection has a scene position.';
            return;
        }
        gallery.geo = toBufferGeometry(merged);
        applyGalleryStyle();
        gallery.geo.computeBoundingBox();
        const box = gallery.geo.boundingBox.clone();
        const c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        gallery.controls.target.copy(c);
        gallery.camera.position.set(c.x + size * 0.55, c.y + size * 0.4, c.z + size * 0.55);
        gallery.controls.update();
        // scene composites keep world heights — the floor is the world's, y=0
        framePartShadow(gallery, box, c, size, 0);
        const vol = computeMeshVolumeMm3(merged.positions, merged.indices);
        $('print-part-caption').innerHTML =
            `<b>${label}</b> · ${merged.placed} part${merged.placed === 1 ? '' : 's'} at scene positions · ` +
            `${(vol / 1000).toFixed(0)} cm³ of parts<br>` +
            `<span style="opacity:.8">Every part in assembled orientation where it really sits — ` +
            `⌘/Ctrl-click rows to add or remove parts.</span>`;
    }, 30);
}

function selectGalleryPart(i, additive = false) {
    if (additive) {
        const set = new Set(gallery.sceneSelection ?? (gallery.selectedIndex != null ? [gallery.selectedIndex] : []));
        if (set.has(i)) set.delete(i); else set.add(i);
        if (set.size > 1) { selectGalleryScene([...set].sort((a, b) => a - b), 'selection'); return; }
        i = [...set][0] ?? i;
    }
    gallery.sceneSelection = null;
    const part = gallery.parts[i];
    if (!part) return;
    gallery.selectedIndex = i;
    [...$('print-parts-list').children].forEach((li, k) => li.classList.toggle('selected', k === i));
    $('print-part-caption').innerHTML = '⏳ building export geometry…';
    setTimeout(() => {
        if (gallery.geo) gallery.geo.dispose();
        const mesh = recenter(part.build());
        const report = analyzeMesh(mesh.positions, mesh.indices);
        gallery.geo = toBufferGeometry(mesh);
        applyGalleryStyle();
        gallery.geo.computeBoundingBox();
        const box = gallery.geo.boundingBox.clone();
        const c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        gallery.controls.target.copy(c);
        // low three-quarter angle so undersides (pockets, sockets, ribs) show
        gallery.camera.position.set(c.x + size * 0.8, c.y + size * 0.45, c.z + size * 0.8);
        // OrbitControls caches its own spherical state. On the FIRST open that
        // state was captured with the camera at the origin (radius 0), and with
        // enableDamping + autoRotate the damped update fights the position we
        // just set — the view comes up wrong the first time and is fine on the
        // second. Sync it explicitly.
        gallery.controls.update();
        // Fit the shadow frustum to THIS part — a frustum sized for the whole
        // scene wastes the depth range and washes out small recesses.
        framePartShadow(gallery, box, c, size);
        const cat = /^(pillar|support)/.test(part.name) ? 'pillar'
            : /^scenery/.test(part.name) ? 'scenery'
            : /^figure_body|^figure_pend/.test(part.name) ? 'figure'
            : /^connector|^gate|plugs/.test(part.name) ? 'small' : 'track';
        const countLabel = part.count > 1 ? ` (x${part.count})` : '';
        $('print-part-caption').innerHTML =
            `<b>${part.name}${countLabel}</b> · ${(report.volumeMm3 / 1000).toFixed(1)} cm³ · ≈${printedWeightG(report.volumeMm3, cat).toFixed(0)} g printed · ` +
            `${report.isManifold && report.isConsistent && report.windsOutward
                ? '<span class="ok">✔ watertight</span>' : '<span class="bad">✖ CHECK</span>'}<br>` +
            `<span style="opacity:.8">${part.note ?? ''}</span>`;
    }, 30);
}

// ---------------------------------------------------------------------------
// Lightbox overlay inspector (large preview)
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
    if (gallery.renderer) galleryResize();
});

// ---------------------------------------------------------------------------
// In-app document viewer: renders the project's markdown docs (PHYSICS.md,
// readme) without any external library — a minimal renderer that covers
// exactly the constructs those files use.
// ---------------------------------------------------------------------------

function renderMarkdown(md) {
    const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const inline = (s) => s
        .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\*([^*]+)\*/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const lines = esc(md).split('\n');
    const out = [];
    let list = false, table = false;
    const closeAll = () => {
        if (list) { out.push('</ul>'); list = false; }
        if (table) { out.push('</tbody></table>'); table = false; }
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const h = line.match(/^(#{1,4})\s+(.*)/);
        if (h) { closeAll(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
        if (/^\s*[-*]\s+/.test(line)) {
            if (table) { out.push('</tbody></table>'); table = false; }
            if (!list) { out.push('<ul>'); list = true; }
            out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
            continue;
        }
        if (/^\|/.test(line)) {
            if (list) { out.push('</ul>'); list = false; }
            if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row
            const cells = line.split('|').slice(1, -1).map(c => inline(c.trim()));
            if (!table) {
                out.push(`<table><thead><tr>${cells.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`);
                table = true;
            } else {
                out.push(`<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`);
            }
            continue;
        }
        closeAll();
        if (line === '') continue;
        out.push(`<p>${inline(line)}</p>`);
    }
    closeAll();
    return out.join('\n');
}

async function openDoc(file, title) {
    try {
        const res = await fetch(`./${file}`);
        if (!res.ok) throw new Error(`${res.status}`);
        $('doc-title').textContent = title;
        $('doc-body').innerHTML = renderMarkdown(await res.text());
        $('doc-overlay').style.display = '';
    } catch (err) {
        toast(`Could not load ${file}: ${err.message}`);
    }
}
for (const a of document.querySelectorAll('.doc-link')) {
    a.addEventListener('click', (e) => {
        e.preventDefault();
        openDoc(a.dataset.doc, a.textContent.trim());
    });
}
$('doc-close').addEventListener('click', () => { $('doc-overlay').style.display = 'none'; });
$('btn-refs').addEventListener('click', () => { $('refs-overlay').style.display = ''; });
$('refs-close').addEventListener('click', () => { $('refs-overlay').style.display = 'none'; });

function recenter(mesh) {
    const { positions } = mesh;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
        minY = Math.min(minY, positions[i + 1]);
        minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] -= cx;
        positions[i + 1] -= minY;
        positions[i + 2] -= cz;
    }
    return mesh;
}

function rotForSide(mesh) {
    const { positions } = mesh;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1];
        positions[i] = -y;
        positions[i + 1] = x;
    }
    return mesh;
}

/** Flip upside down (crown-down palm printing). */
function rotFlip(mesh) {
    const { positions } = mesh;
    for (let i = 0; i < positions.length; i += 3) {
        positions[i + 1] = -positions[i + 1];
        positions[i + 2] = -positions[i + 2];
    }
    return mesh;
}

/** The 3MF container around one `3dmodel.model` payload. */
const CT_XML = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS_XML = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
const wrap3MF = (xml) => fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8(CT_XML), { level: 0 }],
    '_rels/.rels': [fflate.strToU8(RELS_XML), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
});

/**
 * Footprint on the bed. Parts are recentred before this, and the exporter
 * turns app Y-up into printer Z-up (X=x, Y=-z, Z=y), so the plate's width
 * comes from app X, its depth from app Z, and the print height from app Y.
 */
function bedFootprint(positions) {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        mnx = Math.min(mnx, positions[i]); mxx = Math.max(mxx, positions[i]);
        mny = Math.min(mny, positions[i + 1]); mxy = Math.max(mxy, positions[i + 1]);
        mnz = Math.min(mnz, positions[i + 2]); mxz = Math.max(mxz, positions[i + 2]);
    }
    return { w: mxx - mnx, d: mxz - mnz, h: mxy - mny };
}

/**
 * Which parts may share a plate.
 *
 * Curves print alone. Bambu Studio raises its cantilever warning on them
 * whatever the geometry underneath, so on a mixed plate the warning names a
 * plate full of unrelated parts and tells you nothing about which one is at
 * risk — and if a curve does come loose it takes the risers packed around it
 * with it. Alone, the warning is attributable and a failure costs one part
 * type. That is worth the plate area it gives away, and it is the only way
 * the next curve print answers the arcade question.
 */
function plateGroup(name) {
    // Each risky type gets its OWN group, not one shared "curved" group: a
    // switch carries a curved branch and draws the same warning, and pairing
    // it with a curve would put the two hardest parts on one plate and lose
    // exactly the attribution this exists for.
    //
    // BUT IT IS NOW A CHOICE, because the reason it was always on stopped
    // being true. It was written for a curve standing 71 mm tall on 1031 mm2
    // of skirt, where a failure was likely enough to be worth a whole plate.
    // A curve laid on its own underside is 41 mm tall on 1777 mm2 — the
    // flattest thing on the build — and isolating it costs eight plates that
    // are 53% empty, which is 86% of all the free space in the job. The
    // leftover is a 67 mm margin and every support part fits in it.
    if (!shop.soloBigParts) return '';
    return /^curve|^switch/.test(name) ? name : '';
}

/**
 * Default the choice from how the big parts actually print: on while they
 * stand rim-down, off once they lie flat. Set explicitly by the user, it
 * stays set — `soloTouched` is what remembers that.
 */
function defaultSoloBigParts() {
    // Was `skirtStyle !== 'minimal'` — on for rim-down viaduct pieces, off once
    // they lie flat. Every piece lies flat now, so this is always off.
    return false;
}

/**
 * One mesh from a plate's copies, each rotated about the bed normal and moved
 * into place.
 *
 * The placement has to be done in PRINTER space to agree with the 3MF, which
 * applies its transform after the exporter's X=x, Y=−z, Z=y rotation. Doing it
 * in app coordinates instead — the obvious way, and what this did first —
 * lands every part at −Y: the plate still fits the bed, so it prints, but the
 * layout is a mirror image of the one the preview drew and the README lists,
 * and the two formats disagree about the same plate. Working backwards through
 * the exporter's rotation, printer (X, Y) = R(θ)·(X₀, Y₀) + (x, y) becomes:
 *
 *     x' =  c·x₀ + s·z₀ + itemX
 *     z' = −s·x₀ + c·z₀ − itemY
 *
 * `tests/export_sets.test.js` holds both formats to the same bounding box.
 */
function mergePlacedMeshes(items, byName) {
    let nv = 0, ni = 0;
    for (const it of items) { const m = byName.get(it.name).mesh; nv += m.positions.length; ni += m.indices.length; }
    const positions = new Float32Array(nv), indices = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const it of items) {
        const m = byName.get(it.name).mesh;
        positions.set(placeForPlate(m.positions, it.rot, it.x, it.y), vo);
        for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k] + vo / 3;
        vo += m.positions.length;
        io += m.indices.length;
    }
    return [positions, indices];
}



/** Below this much first-layer area a part is standing on a point, not sitting. */
const MIN_BED_MM2 = 25;

// ---------------------------------------------------------------------------
// Print shop: pick quantities of any part, watch the plates fill up
//
// The packed export takes the design's own quantities, which is right for
// "build this tower" and useless for everything else — a spare key, four more
// ramps, a ladder of risers. This is the same packer with the counts under your
// control, and it shows you the actual plates before you commit a spool.
//
// Everything on screen is REAL export geometry: the thumbnails and the plate
// layout render the same watertight mesh the 3MF gets, so what you see laid out
// is what the slicer receives.
// ---------------------------------------------------------------------------

const shop = {
    open: false, renderer: null, scene: null, camera: null, controls: null,
    raf: 0, items: [], counts: new Map(), plates: [], group: null, built: false, framedFor: 0,
    // see plateGroup / defaultSoloBigParts. `soloTouched` keeps a deliberate
    // choice from being undone the next time the underside style changes.
    soloBigParts: true, soloTouched: false,
    // Opt-in print brim on the slotted posts — see colletSocketOps.
    brimPosts: false
};

/** Bed outline + grid for one plate, centred on the origin of its own group. */
function shopBedGroup() {
    const g = new THREE.Group();
    const { width: W, depth: D, margin } = PLATE;
    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(W, D),
        new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.95, metalness: 0 })
    );
    plate.rotation.x = -Math.PI / 2;
    plate.receiveShadow = true;
    g.add(plate);
    const grid = new THREE.GridHelper(W, W / 16, 0x4a545e, 0x39424a);
    grid.position.y = 0.05;
    g.add(grid);
    // the usable rectangle — parts may not cross it
    const u = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-(W / 2 - margin), 0.1, -(D / 2 - margin)),
            new THREE.Vector3((W / 2 - margin), 0.1, -(D / 2 - margin)),
            new THREE.Vector3((W / 2 - margin), 0.1, (D / 2 - margin)),
            new THREE.Vector3(-(W / 2 - margin), 0.1, (D / 2 - margin))
        ]),
        new THREE.LineBasicMaterial({ color: 0x6f7b86 })
    );
    g.add(u);
    return g;
}

function initShop() {
    if (shop.renderer) return;
    const holder = $('shop-stage');
    shop.renderer = new THREE.WebGLRenderer({ antialias: true });
    shop.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    shop.renderer.shadowMap.enabled = true;
    shop.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    holder.appendChild(shop.renderer.domElement);
    shop.scene = new THREE.Scene();
    shop.scene.background = new THREE.Color(0x161b21);
    shop.camera = new THREE.PerspectiveCamera(45, 1, 1, 8000);
    shop.controls = new OrbitControls(shop.camera, shop.renderer.domElement);
    shop.controls.enableDamping = true;
    shop.scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x2c3238, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(220, 420, 180);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const c = key.shadow.camera;
    c.left = -600; c.right = 600; c.top = 600; c.bottom = -600; c.near = 1; c.far = 2000;
    c.updateProjectionMatrix();
    shop.scene.add(key);
    shop.group = new THREE.Group();
    shop.scene.add(shop.group);
    const tick = () => {
        shop.raf = requestAnimationFrame(tick);
        if (!shop.open) return;
        shop.controls.update();
        shop.renderer.render(shop.scene, shop.camera);
    };
    tick();
    new ResizeObserver(() => sizeShop()).observe(holder);
}

function sizeShop() {
    const holder = $('shop-stage');
    if (!holder || !shop.renderer) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    shop.renderer.setSize(w, h);
    shop.camera.aspect = w / h;
    shop.camera.updateProjectionMatrix();
    if (shop.open && shop.framedFor) shopFrameAll();
}

/**
 * One small offscreen render per distinct part, cached as a data URL.
 * A live WebGL canvas per row would mean a dozen contexts; browsers cap those
 * and start evicting, and the list scrolls past blank boxes.
 */
async function shopThumbnails(items) {
    const R = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    R.setPixelRatio(2);
    R.setSize(108, 84);
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.3);
    dl.position.set(1, 2, 1.4);
    sc.add(dl);
    const cam = new THREE.PerspectiveCamera(38, 108 / 84, 0.5, 5000);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8b23a, roughness: 0.55, metalness: 0 });
    for (const it of items) {
        const mesh = new THREE.Mesh(it.geo, mat);
        sc.add(mesh);
        it.geo.computeBoundingBox();
        const box = it.geo.boundingBox;
        const ctr = box.getCenter(new THREE.Vector3());
        // Fit the bounding SPHERE against both the vertical fov and the
        // horizontal one the aspect implies. Scaling off the diagonal alone
        // ignored that the thumbnail is wider than it is tall, so the 129 mm
        // riser came out with its ends cropped and every riser looked the same
        // height — which is the one thing the icon has to tell you.
        const r = box.getSize(new THREE.Vector3()).length() / 2;
        const half = cam.fov * Math.PI / 360;
        const dist = 1.12 * Math.max(r / Math.sin(half),
                                     r / Math.sin(Math.atan(cam.aspect * Math.tan(half))));
        cam.position.set(ctr.x + dist * 0.55, ctr.y + dist * 0.45, ctr.z + dist * 0.70);
        cam.lookAt(ctr);
        cam.near = Math.max(0.1, dist - r * 2);
        cam.far = dist + r * 4;
        cam.updateProjectionMatrix();
        R.render(sc, cam);
        it.thumb = R.domElement.toDataURL('image/png');
        sc.remove(mesh);
        await new Promise(r => setTimeout(r));
    }
    R.dispose();
}

/** Rebuild the plate scene from the current counts. */
function shopRepack() {
    const items = shop.items
        .map(it => ({ ...it, count: shop.counts.get(it.name) ?? 0 }))
        .filter(it => it.count > 0);
    const { plates, oversized } = packPlates(items.map(({ name, w, d, h, count }) =>
        ({ name, w, d, h, count, group: plateGroup(name) })));
    shop.plates = plates;

    while (shop.group.children.length) shop.group.remove(shop.group.children[0]);
    const byName = new Map(shop.items.map(it => [it.name, it]));
    const pitch = PLATE.width + 40;
    // Grid, not a row. Eight plates in a line recede to nothing and the far end
    // is unreadable however the camera is placed; a roughly square grid keeps
    // every plate at a similar size on screen.
    const cols = Math.max(1, Math.ceil(Math.sqrt(plates.length)));
    const rows = Math.ceil(plates.length / cols);
    plates.forEach((p, i) => {
        const bed = shopBedGroup();
        bed.position.x = ((i % cols) - (cols - 1) / 2) * pitch;
        bed.position.z = (Math.floor(i / cols) - (rows - 1) / 2) * pitch;
        // Name each bed. With nine of them on screen the plate you are looking
        // at is otherwise anonymous, and the group matters: a plate that says
        // "curveL only" explains why it is half empty instead of looking like
        // a packing failure.
        bed.add(shopPlateTag(`Plate ${p.index}${p.group ? ` · ${p.group} only` : ''}` +
            ` · ${p.items.length} part${p.items.length === 1 ? '' : 's'}` +
            ` · ${(p.utilisation * 100).toFixed(0)}%`));
        for (const it of p.items) {
            const src = byName.get(it.name);
            const m = new THREE.Mesh(src.geo, MAT_SHOP);
            m.castShadow = true;
            // packer gives plate-centred X/Y in the printer's frame; the mesh is
            // app Y-up, so printer Y is -app Z
            m.position.set(it.x, 0, -it.y);
            m.rotation.y = -it.rot * Math.PI / 180;
            bed.add(m);
        }
        shop.group.add(bed);
    });

    const total = items.reduce((s, it) => s + it.count, 0);
    const grams = items.reduce((s, it) => s + printedWeightG(byName.get(it.name).vol, 'track') * it.count, 0);
    const fill = plates.length
        ? Math.round(plates.reduce((s, p) => s + p.utilisation, 0) / plates.length * 100) : 0;
    $('shop-summary').textContent = plates.length
        ? `${plates.length} plate${plates.length === 1 ? '' : 's'} · ${total} parts · ~${grams.toFixed(0)} g · ${fill}% avg fill` +
          (oversized.length ? ` · ${oversized.length} too big for the bed` : '')
        : 'nothing selected';
    $('shop-empty').style.display = plates.length ? 'none' : '';
    $('shop-export').disabled = !plates.length;

    // Reframe only when the NUMBER of plates changes. Doing it on every count
    // change yanks the view out from under someone who is nudging a quantity
    // and watching one plate fill.
    if (plates.length && plates.length !== shop.framedFor) {
        shop.framedFor = plates.length;
        shopFrameAll();
    }
    if (!plates.length) shop.framedFor = 0;
}

const MAT_SHOP = new THREE.MeshStandardMaterial({ color: 0xe8b23a, roughness: 0.5, metalness: 0 });

/** A plate's caption, standing at the back edge of its bed. */
function shopPlateTag(text) {
    const PX = 40;
    const probe = document.createElement('canvas').getContext('2d');
    const font = `600 ${PX}px system-ui, -apple-system, sans-serif`;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + PX;
    const h = Math.ceil(PX * 1.5);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = PX * 0.14;
    ctx.strokeStyle = 'rgba(8,14,22,0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = '#f2f7ff';
    ctx.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    const hMm = 20;
    sp.scale.set(hMm * (w / h), hMm, 1);
    sp.position.set(0, 12, -(PLATE.depth / 2 + 16));
    sp.renderOrder = 20;
    return sp;
}

/**
 * Fit every plate in view. The previous version scaled the camera distance off
 * the row length alone, which ignores the viewport's aspect: on a tall narrow
 * stage the row still ran off both sides. Fit the real bounding box against
 * BOTH the vertical fov and the horizontal one implied by the aspect, and take
 * whichever needs more room.
 */
function shopFrameAll() {
    if (!shop.group.children.length) return;
    const box = new THREE.Box3().setFromObject(shop.group);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const fov = shop.camera.fov * Math.PI / 180;
    const forHeight = Math.max(size.y, size.z) / (2 * Math.tan(fov / 2));
    const forWidth = size.x / (2 * Math.tan(fov / 2) * shop.camera.aspect);
    const dist = 1.22 * Math.max(forHeight, forWidth, 120);
    const dir = new THREE.Vector3(0.18, 0.86, 0.58).normalize();
    shop.controls.target.copy(centre);
    shop.camera.position.copy(centre).addScaledVector(dir, dist);
    shop.camera.near = Math.max(1, dist / 200);
    shop.camera.far = dist * 8;
    shop.camera.updateProjectionMatrix();
    shop.controls.update();
}

/**
 * Fill the quantities from a named set. Presets speak for the DESIGN — a
 * catalogue part the track does not use has no design quantity to scale, so it
 * stays at zero and you add it by hand. That keeps "Sample run" meaning one of
 * each part this track needs, rather than one of everything that exists.
 */
function shopApplyPreset(id) {
    // The presets pick from the DESIGN's parts. Applied to the calibration job
    // they match nothing and set every count to zero, emptying the plate for no
    // visible reason.
    if (shop.calibration) {
        for (const it of shop.items) shop.counts.set(it.name, it.designCount);
        shopBuildList();
        shop.framedFor = 0;
        shopRepack();
        return;
    }
    const set = getExportSet(id);
    const design = shop.items.filter(it => it.designCount > 0)
        .map(it => ({ name: it.name, kind: it.kind, count: it.designCount }));
    const picked = new Map((set.pick(design) ?? []).map(p => [p.name, p.count]));
    for (const it of shop.items) shop.counts.set(it.name, picked.get(it.name) ?? 0);
    const hint = $('shop-preset-hint');
    if (hint) hint.textContent = set.hint;
    shopBuildList();
    shop.framedFor = 0;
    shopRepack();
}

/**
 * Why two pieces of the same type are different solids.
 *
 * The parts list dedupes by signature, so a curve entering from a straight and
 * one entering mid-helix come out as separate rows that look like duplicates —
 * same name stem, same footprint to the millimetre. They are not
 * interchangeable: the seam taper widens the channel 48 -> 51 across a curve,
 * so fitting a 48-entry piece against a 51-exit neighbour leaves the step edge
 * the taper exists to remove. Say which is which.
 */
function shopVariantLabel(part) {
    const pc = part.piece;
    if (!pc) return '';
    const bits = [];
    const ew = pc.entryWidth ?? pc.innerWidth, xw = pc.exitWidth ?? pc.innerWidth;
    bits.push(ew === xw ? `channel ${ew}` : `channel ${ew}→${xw}`);
    const s = part.support;
    bits.push(s && s.mode !== 'none' ? `${s.mode} pier @${s.s.toFixed(0)}` : 'no pier');
    return bits.join(' · ');
}

/**
 * Parts that are really one thing. A walker is a body, a pendulum and its
 * plugs — you never want two bodies and one pendulum, and stepping three rows
 * to get one figure is busywork. A pier is the same story: a foot plus the
 * 15+30+60 ladder stands a piece at any grid height.
 *
 * The kit row is a shortcut, not a mode: it moves the same counts the
 * individual steppers do, and it reads back the number of COMPLETE kits the
 * current counts cover, so sub-selecting one extra pendulum still works and
 * the kit row simply shows what that does or does not complete.
 */
function shopKitsFor(kind) {
    const has = (n) => shop.items.some(i => i.name === n);
    const out = [];
    if (kind === 'figure' && has('figure_body_on_side')) out.push({
        label: 'complete walker',
        parts: { figure_body_on_side: 1, figure_pendulum_on_side: 1, figure_plugs: 1 }
    });
    if (kind === 'support' && has('support_foot')) out.push({
        label: 'pier — foot + 15/30/60 ladder',
        parts: { support_foot: 1, support_riser_15mm: 1,
                 support_riser_30mm: 1, support_riser_60mm: 1 }
    });
    // A switch without its gate paddle cannot route anything, and the switch's
    // own name depends on the design, so this pair is found rather than named.
    if (kind === 'track' && has('gate_paddle')) {
        for (const sw of shop.items.filter(i => /switch/.test(i.name))) {
            out.push({ label: `${shopDisplayName(sw.name)} + Gate Paddle`,
                parts: { [sw.name]: 1, gate_paddle: 1 } });
        }
    }
    return out.filter(k => Object.keys(k.parts).every(has));
}

const shopKitCount = (kit) => Math.min(...Object.entries(kit.parts)
    .map(([n, q]) => Math.floor((shop.counts.get(n) ?? 0) / q)));

function shopAddKit(kind, index, delta) {
    const kit = shopKitsFor(kind)[index];
    if (!kit) return;
    for (const [n, q] of Object.entries(kit.parts)) {
        shop.counts.set(n, Math.max(0, Math.min(999, (shop.counts.get(n) ?? 0) + delta * q)));
    }
    shopBuildList();
    shopRepack();
}

function shopSetCount(name, n) {
    shop.counts.set(name, Math.max(0, Math.min(999, Math.round(n) || 0)));
    const row = document.querySelector(`.shop-row[data-part="${CSS.escape(name)}"] input`);
    if (row) row.value = shop.counts.get(name);
    shopRepack();
}

/**
 * WHAT A PART IS CALLED IN THE SHOP, as against what it is keyed by.
 *
 * Rows showed the internal id: `standard_curveR`, `support_riser_60mm`. The
 * prefix is a provenance detail — "this is the canonical form, not one your
 * design happens to contain" — and it told the reader nothing while pushing
 * the actual name off the front of the line. Brett: "Remove the prefix
 * standard_ in the part names, curveR should be Curve Right."
 *
 * DISPLAY ONLY. `it.name` stays the key everywhere it matters — counts, the
 * packer, the export manifest, `data-part` — because renaming an identity to
 * make it read better is how a count ends up attached to nothing.
 */
function shopDisplayName(name) {
    const pretty = {
        curveL: 'Curve Left', curveR: 'Curve Right',
        // A SWITCH ROW IS THE BODY ONLY, and saying so is the whole point.
        // Brett: "it looks like the switch with gate is the real one, I don't
        // know what that other switch is." A switch cannot route anything
        // without its paddle, so the bare row is for replacing a lost body —
        // the bundle below it is the thing you normally want.
        switchL: 'Switch Left (body only)', switchR: 'Switch Right (body only)',
        straight: 'Straight', start: 'Start Platform', end: 'End Platform',
        lift: 'Powered Lift', powered: 'Powered Track', elevator: 'Elevator',
        bowtie_key: 'Bowtie Key', gate_paddle: 'Gate Paddle',
        support_foot: 'Support Foot', support_jog: 'Support Jog'
    };
    let n = String(name).replace(/^standard_/, '');
    if (pretty[n]) return pretty[n];
    const m = /^support_riser_(\d+)mm$/.exec(n);
    if (m) return `Riser ${m[1]} mm`;
    const sp = /^support_spacer_(.+)$/.exec(n);
    if (sp) return `Spacer ${sp[1]}`;
    const sc = /^scenery_(.+)$/.exec(n);
    if (sc) return sc[1].replace(/^./, (c) => c.toUpperCase());
    // design pieces arrive as `curveR_3`, `straight_11`
    const idx = /^([a-zA-Z]+)_(\d+)$/.exec(n);
    if (idx && pretty[idx[1]]) return `${pretty[idx[1]]} ${idx[2]}`;
    return n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Most-used first. A build is mostly straights and curves, then the platforms
 * that cap it, and only then the one-per-design pieces. Ordering the list the
 * way a build consumes it puts the rows people actually touch at the top —
 * Brett: "sort the parts from most common to least common".
 *
 * Ties break on the design's OWN count, so a design that leans on a piece
 * floats it up regardless of the nominal order.
 */
const SHOP_RANK = ['straight', 'curveL', 'curveR', 'start', 'end',
    'switchL', 'switchR', 'lift', 'powered', 'elevator'];
function shopSortKey(it) {
    const bare = String(it.name).replace(/^standard_/, '').replace(/_\d+$/, '');
    const i = SHOP_RANK.indexOf(bare);
    return i < 0 ? SHOP_RANK.length : i;
}

/** One part row: thumbnail, identity, variant, stepper. */
function makeShopRow(it) {
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.dataset.part = it.name;
    row.innerHTML =
        `<img src="${it.thumb}" alt="">` +
        `<div class="meta"><b title="${it.name}">${shopDisplayName(it.name)}</b>` +
        `<span>${it.w.toFixed(0)}×${it.d.toFixed(0)}×${it.h.toFixed(0)} mm · ` +
        `${printedWeightG(it.vol, 'track').toFixed(0)} g each` +
        // THE `standard_` PREFIX WAS DOING WORK, so removing it from the name
        // has to put the distinction back somewhere. Without it a design that
        // contains a straight showed two rows both reading "Straight" — its own
        // piece and the canonical form — which is worse than an ugly prefix.
        // It belongs on the detail line, not in front of the name.
        (/^standard_/.test(it.name) ? `<br>standard form` : '') +
        (it.variant ? `<br>${it.variant}` : '') + `</span></div>` +
        `<div class="shop-step"><button type="button" data-d="-1">−</button>` +
        `<input type="number" min="0" max="999" value="${shop.counts.get(it.name) ?? 0}">` +
        `<button type="button" data-d="1">+</button></div>`;
    row.querySelectorAll('button').forEach(b => b.addEventListener('click', () =>
        shopSetCount(it.name, (shop.counts.get(it.name) ?? 0) + Number(b.dataset.d))));
    row.querySelector('input').addEventListener('change', (e) =>
        shopSetCount(it.name, Number(e.target.value)));
    return row;
}

function shopBuildList() {
    const list = $('shop-list');
    list.innerHTML = '';
    const LABEL = { track: 'Track & switches', key: 'Connector keys',
                    support: 'Supports & piers', scenery: 'Scenery', figure: 'Walker figure',
                    coupon: 'Calibration coupons', gauge: 'Calibration cards & chips' };
    // `coupon` and `gauge` only ever appear when the shop is holding the
    // calibration job. A kind that is not in this list is not rendered at all —
    // which is how the first version of the calibration job packed and exported
    // 21 parts while showing an empty list.
    for (const kind of ['track', 'key', 'support', 'scenery', 'figure', 'coupon', 'gauge']) {
        // The gate paddle is not a category of its own — it is the part that
        // makes a switch work, and a group of one told nobody that.
        // The plain forms cover any track. Lifts, elevators, switches and the
        // design's own pieces with their specific rim heights are real but
        // rarely wanted, so they fold away instead of burying the rows most
        // people need. Specialty now means only one thing: a piece that exists
        // because of what it sits next to, which at the Standard cannot happen
        // at all — a custom widened build is the only way to get one.
        const isSpecialty = (n) => /_(into_curve|out_of_curve|between_curves)\b/.test(n);
        const all = kind === 'track'
            ? [...shop.items.filter(it => it.kind === 'track'), ...shop.items.filter(it => it.kind === 'gate')]
            : shop.items.filter(it => it.kind === kind);
        const group = (kind === 'track' ? all.filter(it => !isSpecialty(it.name)) : all)
            .slice().sort((a, b) => (shopSortKey(a) - shopSortKey(b))
                || ((shop.counts.get(b.name) ?? 0) - (shop.counts.get(a.name) ?? 0))
                || shopDisplayName(a.name).localeCompare(shopDisplayName(b.name)));
        const advanced = kind === 'track' ? all.filter(it => isSpecialty(it.name)) : [];
        if (!group.length) continue;
        const head = document.createElement('div');
        head.className = 'shop-kind';
        head.textContent = LABEL[kind] ?? kind;
        list.appendChild(head);

        for (const it of group) list.appendChild(makeShopRow(it));
        shopKitsFor(kind).forEach((kit, ki) => {
            const kr = document.createElement('div');
            kr.className = 'shop-row shop-kit';
            const have = shopKitCount(kit);
            kr.innerHTML =
                `<div class="meta"><b>＋ ${kit.label}</b>` +
                `<span>${Object.keys(kit.parts).length} parts at once` +
                `${have ? ` · ${have} complete` : ''}</span></div>` +
                `<div class="shop-step"><button type="button" data-d="-1">−</button>` +
                `<input type="number" value="${have}" readonly tabindex="-1">` +
                `<button type="button" data-d="1">+</button></div>`;
            kr.querySelectorAll('button').forEach(b => b.addEventListener('click', () =>
                shopAddKit(kind, ki, Number(b.dataset.d))));
            list.appendChild(kr);
        });

        if (advanced.length) {
            const det = document.createElement('details');
            det.className = 'shop-adv';
            const sum = document.createElement('summary');
            const chosen = advanced.filter(it => (shop.counts.get(it.name) ?? 0) > 0).length;
            sum.innerHTML = `Specialty &amp; design-specific — ${advanced.length} parts` +
                (chosen ? ` <b>(${chosen} selected)</b>` : '');
            det.appendChild(sum);
            // stay open while anything inside is selected, or a preset's picks
            // would vanish the moment the list rebuilt
            det.open = chosen > 0;
            for (const it of advanced) det.appendChild(makeShopRow(it));
            list.appendChild(det);
        }
    }
}

/**
 * Preview and shop are the SAME thing, which is the point.
 *
 * A design's parts list is an order: N of this curve, M of that riser. The
 * print shop already takes an order and lays it on plates, and it already
 * opens with every quantity seeded from the design. So "preview the plates I
 * am about to export" does not want a second plate viewer that would have to
 * be kept in step with the packer, the grouping rule and the bed size — it
 * wants this one, with the design's own quantities selected.
 *
 * `opts.preset` forces the preset back to the full design, because the shop
 * remembers what you last did in it and a preview of "everything" is what the
 * export buttons beside it are about to produce.
 */
/**
 * What the shop's cached geometry was built FROM.
 *
 * It caches every part's mesh, and nothing was invalidating that: clear the
 * scene, drop in one curve, open the shop, and you were still looking at the
 * previous tower's eleven plates — with the previous underside on them. A
 * fingerprint is better than clearing on every edit, because rebuilding the
 * catalogue takes ~15 seconds and most edits do not change what it contains.
 */
const shopDesignKey = () => JSON.stringify([
    state.sequence, state.skirtStyle,
    (state.scenery ?? []).map(s => s.kind).sort()
]);

async function openPrintShop(opts = {}) {
    $('shop-overlay').style.display = '';
    shop.open = true;
    if (shop.builtFor !== shopDesignKey()) shop.built = false;
    const justBuilt = !shop.built;
    initShop();
    sizeShop();
    if (!shop.built) {
        if (!shop.soloTouched) shop.soloBigParts = defaultSoloBigParts();
        $('shop-solo').checked = shop.soloBigParts;
        $('shop-brim').checked = shop.brimPosts;
        $('shop-summary').textContent = 'building part geometry…';
        try {
            await initCSG();
            const { parts, joints, switchCount } = assembleParts();
            shop.joints = joints;
            shop.switchCount = switchCount;
            // The design's own parts, PLUS everything that exists regardless of
            // what is on the canvas. A design with no curve still wants to be
            // able to order risers it is not using, a gate, a patio. Track
            // pieces stay design-specific — their geometry IS the design — but
            // hardware and scenery are universal and belong in the catalogue
            // whether this track needs them or not.
            const have = new Set(parts.map(p => p.name));
            const haveTypes = new Set(parts.filter(p => p.piece).map(p => p.piece.type));

            // Canonical track pieces for the types this design does not contain.
            // Track geometry IS design-specific — rim height, seam taper, support
            // boss all come from where a piece sits — which is why these are built
            // from a throwaway STANDARD layout rather than the canvas. That is
            // exactly what the Klip Klop Standard is for: pieces built to it mate
            // with any other export at the same major version, so a design with no
            // curve can still order one and it will fit.
            // ...but the UNDERSIDE follows the design, or picking `minimal`
            // gives you a catalogue of viaduct spares that do not match the
            // pieces beside them on the plate.
            const STD = { slopeDeg: STANDARD.slopeDeg, curveRadius: STANDARD.curveRadius,
                innerWidth: STANDARD.innerWidth, skirtStyle: state.skirtStyle };
            // every simple type, from SIMPLE_TYPES rather than a hand-written
            // list that quietly goes stale when a piece type is added
            const seq = SIMPLE_TYPES.flatMap(t => [t, 'straight']);
            const canon = layoutTrack(seq, STD);
            const canonSup = planPillarPositions(canon.pieces);
            // Always catalogued, whatever the canvas holds: these are the
            // plain forms, and the standard group has to be the same three
            // rows on every design or it is not a standard group.
            const canonical = SIMPLE_TYPES
                .map(t => {
                    const pc = canon.pieces.find(p => p.type === t);
                    if (!pc) return null;
                    const support = canonSup.find(x => x.pieceIndex === pc.index);
                    return {
                        name: `standard_${t}`, kind: 'track', count: 0,
                        build: () => buildPieceExportGeometry(pc, { support, forPrint: true })
                    };
                }).filter(Boolean);

            // BOTH HANDS, because a switch is CHIRAL. This built one part named
            // `standard_switch`, hardcoded to switchL — so the store offered a
            // single row for two parts that are mirror images and cannot
            // substitute for each other. Brett: "the part store only has one
            // switch". Curves already get this right, because SIMPLE_TYPES
            // carries curveL and curveR separately; the switch was a special
            // case that forgot it was one.
            if (!parts.some(p => /switch/.test(p.name))) {
                for (const hand of ['switchL', 'switchR']) {
                    try {
                        const sw = layoutTrack([{ type: hand, gate: 'main', main: ['straight'], branch: ['straight'] }], STD);
                        const main = sw.pieces.find(p => p.role === 'main');
                        const branch = sw.pieces.find(p => p.role === 'branch');
                        if (main && branch) canonical.push({
                            name: `standard_${hand}`, kind: 'track', count: 0,
                            build: () => buildSwitchExportGeometry(main, branch, { forPrint: true })
                        });
                    } catch (e) { console.warn(`no standard ${hand} part:`, e.message); }
                }
            }

            const catalogue = [
                { name: 'bowtie_key', kind: 'key', build: () => buildKeyGeometry(SPEC, { code: partCode('KEY', GEOMETRY_VERSION) }) },
                { name: 'gate_paddle', kind: 'gate', build: () => buildGateGeometry(SPEC, { forPrint: true }) },
                { name: 'support_foot', kind: 'support', build: () => toArraysFromBG(buildSupportFootGeometry(SPEC, { code: partCode('FOOT', GEOMETRY_VERSION) })) },
                // 15/30/60 ONLY — the ladder decomposeSupport actually builds
                // from. A 120 was catalogued, thumbnailed, packed and exported,
                // and nothing could ever ask for it: run decomposeSupport over
                // every stack height from 15 to 900 mm and the riser sizes it
                // emits are 15, 30 and 60. The ladder was capped at 60 in
                // 28e1dac and this entry was left behind.
                ...[60, 30, 15].map(r => ({
                    name: `support_riser_${r}mm`, kind: 'support', build: () => buildRiserGeometry(r, SPEC, { code: partCode(`R${r}`, GEOMETRY_VERSION), brim: shop.brimPosts }) })),
                { name: 'support_jog', kind: 'support', build: () => buildJogGeometry(SPEC, { code: partCode('JOG', GEOMETRY_VERSION), brim: shop.brimPosts }) },
                ...SPACER_VARIANTS.map(v => ({
                    name: `support_spacer_${v.code}`, kind: 'support', build: () => spacerGeometryFor(v.heightMm, true, shop.brimPosts) })),
                { name: 'scenery_tower', kind: 'scenery', build: () => buildTowerGeometry(100) },
                { name: 'scenery_patio', kind: 'scenery', build: () => buildPatioGeometry() },
                { name: 'scenery_palm_island', kind: 'scenery', build: () => buildPalmIslandGeometries().island },
                { name: 'scenery_palm_tree_crown_down', kind: 'scenery', build: () => rotFlip(buildPalmIslandGeometries().palm) },
                { name: 'figure_body_on_side', kind: 'figure', build: () => rotForSide(buildFigureGeometries(state.innerWidth).body) },
                { name: 'figure_pendulum_on_side', kind: 'figure', build: () => rotForSide(buildFigureGeometries(state.innerWidth).pendulum) },
                { name: 'figure_plugs', kind: 'figure', build: () => buildFigureGeometries(state.innerWidth).plugSet }
            ].filter(c => !have.has(c.name)).map(c => ({ ...c, count: 0 }));

            shop.items = [];
            shop.counts.clear();
            shop.calibration = null;      // this is the design's catalogue again
            for (const part of [...parts, ...canonical, ...catalogue]) {
                await new Promise(r => setTimeout(r));
                const mesh = recenter(part.build());
                const rep = analyzeMesh(mesh.positions, mesh.indices);
                const fp = bedFootprint(mesh.positions);
                shop.items.push({
                    name: part.name, kind: part.kind ?? 'track', ...fp,
                    variant: shopVariantLabel(part),
                    vol: rep.volumeMm3, mesh, geo: toBufferGeometry(mesh),
                    // watertight is not the same as printable — see bedStability
                    bed: bedStability(mesh.positions, mesh.indices),
                    designCount: part.count ?? 0, thumb: ''
                });
                shop.counts.set(part.name, part.count ?? 0);
            }
            await shopThumbnails(shop.items);
            shopBuildList();
            $('shop-preset-hint').textContent = getExportSet($('shop-preset').value).hint;
            shop.built = true;
            shop.builtFor = shopDesignKey();
        } catch (err) {
            console.error(err);
            $('shop-summary').textContent = `could not build parts: ${err.message}`;
            return;
        }
    }
    // Only seed the preset on a FRESH catalogue. Forcing it on every open
    // threw away whatever you had set — press "Clear all", close, come back,
    // and the plates were full again.
    if (opts.preset && justBuilt) {
        const sel = $('shop-preset');
        if (sel) sel.value = opts.preset;
        shopApplyPreset(opts.preset);
    }
    shopRepack();
}

function closePrintShop() {
    shop.open = false;
    $('shop-overlay').style.display = 'none';
}

/** Export exactly what the preview shows. */
async function shopExport(format = '3mf') {
    const btns = [$('shop-export'), $('shop-export-stl')];
    btns.forEach(b => b && (b.disabled = true));
    try {
        const byName = new Map(shop.items.map(it => [it.name, it]));
        const files = {};
        for (const p of shop.plates) {
            const objs = p.items.map(it => {
                const src = byName.get(it.name);
                return {
                    name: `${it.name}_${it.copy}`, meshKey: it.name,
                    positions: src.mesh.positions, indices: src.mesh.indices,
                    at: [it.x, it.y, 0], rot: it.rot
                };
            });
            const grams = p.items.reduce((s, it) => s + printedWeightG(byName.get(it.name).vol, 'track'), 0);
            const stem = `plate_${String(p.index).padStart(2, '0')}` +
                `${p.group ? `_${p.group}` : ''}_${p.items.length}parts_${Math.round(grams)}g`;
            if (format === 'stl') {
                files[`${stem}.stl`] = new Uint8Array(generateBinarySTL(...mergePlacedMeshes(p.items, byName)));
            } else {
                files[`${stem}.3mf`] = wrap3MF(generateMultiObject3MFXML(objs));
            }
        }
        const manifest = describePlates(shop.plates, []);
        // Only the parts actually ON a plate: warning about a part you ordered
        // none of would just train you to ignore the warnings.
        const onPlates = new Set(shop.plates.flatMap(p => p.items.map(it => it.name)));
        const unstable = shop.items
            .filter(it => onPlates.has(it.name) && it.bed && it.bed.contactMm2 < MIN_BED_MM2)
            .map(it => ({ name: it.name, bed: it.bed }));
        // The calibration parts bring their own paperwork. Exporting them
        // through the ordinary path would otherwise drop the measurement sheet
        // and the nominals a measuring script reads, which are most of the
        // value — the plates alone are just plastic.
        if (shop.calibration) {
            files['MEASUREMENTS.md'] = fflate.strToU8(calibrationSheet(
                shop.calibration.coupons.map(c => ({ ...c,
                    vol: shop.items.find(it => it.name === c.name)?.vol ?? 0 }))));
            // SECTION_NOMINALS.json is gone with the card it served: it existed
            // so a script could match a photographed contour to its feature
            // without anyone typing a number, and there is no photograph now.
            files['LADDER_README.md'] = fflate.strToU8(
                sectionReadme({ manifest: shop.calibration.manifest }));
        }
        files['README.txt'] = fflate.strToU8(exportReadme(
            shop.joints ?? 0, shop.switchCount ?? 0, manifest, unstable));
        const blob = new Blob([fflate.zipSync(files)], { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = shop.calibration
            ? `klipklop_calibration_geo${GEOMETRY_VERSION.replace(/\./g, '-')}` +
              `_${state.skirtStyle}_${shop.plates.length}plates_${format}.zip`
            : `klipklop_${(state.name || 'track').replace(/\W+/g, '_').toLowerCase()}` +
              `_geo${GEOMETRY_VERSION.replace(/\./g, '-')}_${shop.plates.length}plates_${format}.zip`;
        a.click();
        toast(`⬇ ${shop.plates.length} custom plate${shop.plates.length === 1 ? '' : 's'}`);
    } catch (err) {
        console.error(err);
        toast(`Plate export failed: ${err.message}`);
    } finally {
        btns.forEach(b => b && (b.disabled = false));
        shopRepack();      // re-disables them if nothing is selected
    }
}

/**
 * One plate of coupons carrying only the surfaces that touch something else,
 * plus the sheet to write the caliper readings onto.
 *
 * BUILT FROM THE CANONICAL STANDARD, never from the open design. A coupon cut
 * from a custom-parameter piece would certify a track nobody else can print
 * (see isStandardParams), and the whole point of a calibration number is that
 * it transfers. The one thing it does take from the design is the underside
 * style, because a joint printed lying on its underside and the same joint
 * printed rim-down are different measurements.
 */
/**
 * Put the calibration parts INTO the print shop, replacing whatever job is
 * there, rather than exporting a zip behind the user's back.
 *
 * They are parts. Once they are in the shop they get the same quantities,
 * thumbnails, plate preview, packing, bed-contact warnings and export path as
 * everything else, instead of a private pipeline that had to reimplement each
 * of those and could drift from them. It also means you can SEE the plate
 * before committing 2.5 hours to it, and drop the coupons to print only the
 * ladder after a filament change.
 *
 * BUILT FROM THE CANONICAL STANDARD, never from the open design: a coupon cut
 * from a custom-parameter piece would certify a track nobody else can print.
 * The one thing it does take from the design is the underside style, because a
 * joint printed lying on its underside and the same joint printed rim-down are
 * different measurements.
 *
 * Reopening the shop from the toolbar rebuilds the design's own catalogue —
 * `builtFor` is stamped with a sentinel that no design key can equal.
 */
async function loadCalibrationParts() {
    const btn = $('shop-export-cal');
    if (btn) btn.disabled = true;
    $('shop-summary').textContent = 'building calibration parts…';
    try {
        await initCSG();
        const { pieces } = layoutTrack(
            ['start', 'straight', 'straight', 'curveR', 'straight', 'end'],
            { skirtStyle: state.skirtStyle, tileLen: CALIBRATION.rampTileLenMm });
        const sups = planPillarPositions(pieces);
        let piece = null, support = null;
        for (const p of pieces.filter(p => p.type === 'straight')) {
            const sup = sups.find(x => x.pieceIndex === p.index);
            if (sup && sup.mode !== 'none') { piece = p; support = sup; break; }
        }
        if (!piece) piece = pieces.find(p => p.type === 'straight');
        const sw = layoutTrack(
            [{ type: 'switchL', gate: 'main', main: ['straight'], branch: ['straight'] }],
            { skirtStyle: state.skirtStyle });
        const coupons = buildCalibrationCoupons({
            piece, support,
            switchMain: sw.pieces.find(p => p.role === 'main'),
            switchBranch: sw.pieces.find(p => p.role === 'branch')
        }, SPEC);
        const sec = buildCalibrationSection(SPEC);

        // the builders return a MIX of raw arrays and BufferGeometry — the shop
        // loop wants arrays, and a set drawn from six builders cannot get away
        // with picking one
        const arrays = (g) => (g.positions && g.indices)
            ? { positions: new Float32Array(g.positions), indices: new Uint32Array(g.indices) }
            : toArraysFromBG(g);
        const parts = [
            // two groups, because they are two errands: coupons are measured
            // against the model, cards and chips test fits by hand
            ...coupons.map(c => ({ name: c.name, kind: 'coupon', count: c.count,
                build: () => arrays(c.build()) })),
            ...sec.parts.map(p => ({ name: p.name, kind: 'gauge', count: 1,
                build: () => arrays(p.geometry) }))
        ];

        shop.items = [];
        shop.counts.clear();
        for (const part of parts) {
            await new Promise(r => setTimeout(r));
            const mesh = recenter(part.build());
            const rep = analyzeMesh(mesh.positions, mesh.indices);
            shop.items.push({
                name: part.name, kind: part.kind, ...bedFootprint(mesh.positions),
                variant: '', vol: rep.volumeMm3, mesh, geo: toBufferGeometry(mesh),
                bed: bedStability(mesh.positions, mesh.indices),
                designCount: part.count, thumb: ''
            });
            shop.counts.set(part.name, part.count);
        }
        await shopThumbnails(shop.items);
        shopBuildList();
        // the docs travel with the parts, so an export from here carries the
        // measurement sheet and the nominals a measuring script reads
        shop.calibration = { manifest: sec.manifest, coupons };
        shop.joints = 0;
        shop.switchCount = 0;
        shop.built = true;
        shop.builtFor = '__calibration__';
        $('shop-preset-hint').textContent =
            'Calibration parts. Export as usual; the measurement sheet and nominals '
            + 'come with them. Reopen the Print shop to get your design back.';
        shopRepack();
        toast('📏 calibration parts loaded — export as usual');
    } catch (err) {
        console.error(err);
        $('shop-summary').textContent = `could not build calibration parts: ${err.message}`;
        toast(`Calibration parts failed: ${err.message}`);
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * The sheet you write on. Nominals come off SPEC via the coupon builders, so
 * this cannot drift from what was actually exported, and the FIT PAIRS table
 * is the one that answers the question being asked: a measured delta on its
 * own says the printer is off, but a delta against the designed clearance says
 * which way to move the number.
 */
function calibrationSheet(items) {
    const L = [];
    L.push(`# Calibration measurements — geometry v${GEOMETRY_VERSION}`, '');
    L.push(`Underside style: **${state.skirtStyle}**. Printed at the Klip Klop Standard`,
        '(slope 11.217°, curve R 143.64, channel 48) regardless of the open design.', '');
    L.push('Coupons are cut from the real parts and keep their full section and',
        'print orientation, so these numbers transfer to a whole track piece.', '');
    L.push('| coupon | qty | feature | nominal mm | measured mm | delta |');
    L.push('|---|---|---|---|---|---|');
    for (const it of items) {
        it.measures.forEach(([label, nom], i) => {
            L.push(`| ${i === 0 ? it.name : ''} | ${i === 0 ? it.count : ''} | ${label} `
                + `| ${nom.toFixed(2)} | | |`);
        });
    }
    const K = SPEC.key, S = SPEC.socket;
    const fit = K.fitClearanceMm ?? SPEC.jointClearanceMm;
    L.push('', '## Fit pairs — what the clearance is meant to be', '');
    L.push('| pair | male mm | female mm | designed clearance | measured clearance |');
    L.push('|---|---|---|---|---|');
    L.push(`| key tips in pocket | ${(2 * K.tipHalf).toFixed(2)} | ${(2 * (K.tipHalf + fit)).toFixed(2)} `
        + `| ${(2 * fit).toFixed(2)} | |`);
    L.push(`| key neck in pocket | ${(2 * K.neckHalf).toFixed(2)} | ${(2 * (K.neckHalf + fit)).toFixed(2)} `
        + `| ${(2 * fit).toFixed(2)} | |`);
    L.push(`| hex tenon in socket | ${(S.hexAF - 2 * SPEC.jointClearanceMm).toFixed(2)} | ${S.hexAF.toFixed(2)} `
        + `| ${(2 * SPEC.jointClearanceMm).toFixed(2)} | |`);
    L.push(`| gate pin in bore | ${(2 * GATE.pinR).toFixed(2)} | ${(2 * GATE.boreR).toFixed(2)} `
        + `| ${(2 * (GATE.boreR - GATE.pinR)).toFixed(2)} — the pin is a split C and grips | |`);
    L.push('', '## Notes', '');
    for (const it of items) L.push(`- **${it.name}** — ${it.note}`);
    L.push('', '## When you load these', '');
    L.push(...BAMBU_CONFIG_NOTE.split('\n'), '');
    L.push('A hole prints smaller than drawn and a post larger, and by how much',
        'depends on the plastic around it — so measure each feature on ITS OWN coupon',
        'rather than assuming one offset covers the plate.', '');
    return L.join('\n');
}

/**
 * How to read the one card that is left.
 *
 * This used to document a camera workflow — a 1 mm section card of graded holes
 * and islands, reference squares, an ArUco sheet, and a JSON of nominals for a
 * script to match contours against. All of it is gone, and the reason is worth
 * keeping: that card built an XY error CURVE for predicting feature sizes, and
 * nothing decides anything from that curve any more. The joints are measured
 * directly on coupons cut from the real builders, and the joints are the truth.
 * It also could not answer the question that actually bit this project — the
 * same drawing printing wider in a broad part than a slender one — because a
 * card is a third plastic mass again.
 */
function sectionReadme(sec) {
    const m = sec.manifest;
    const L = [];
    L.push('# The bowtie ladder — a fit test, read by hand', '');
    L.push(`One card, ${m.ladderCardSizeMm[0]} x ${m.ladderCardSizeMm[1]} mm and `
        + `${m.ladderThicknessMm.toFixed(1)} mm thick. It is thick on purpose: a 1 mm`,
        'hole is a knife-edge gauge and not a joint — the male part barely engages, so',
        '"fits" comes down to how hard you pushed.', '');
    L.push('**Push the printed `cal_key` along the row and note the first rung it enters.',
        'That rung is the clearance the bowtie needs.** No camera and no inference: a',
        'photograph reads clearances to about 0.18 mm, and your fingers do better.', '');
    L.push('| rung | per-side clearance mm |');
    L.push('|---|---|');
    for (const f of m.features) {
        L.push(`| ${f.tag} | ${f.mates ? `**${f.clearancePerSide.toFixed(2)}** (ships today)`
            : f.clearancePerSide.toFixed(2)} |`);
    }
    L.push('', 'Rungs are 0.06 mm apart, not 0.05: half that is below what a hand can tell',
        'apart, so a finer sweep is neighbours nobody can distinguish and half a card of',
        'plastic buying nothing.', '');
    L.push('The cavity is the KEY\'s own outline grown by the clearance — an assembled',
        'seam presents the whole bowtie, not the half-pocket a single rib carries, so',
        'that is what the key has to enter.', '');
    L.push('## When to print this at all', '');
    L.push('Not by default. The coupons answer "does it fit" directly, because each one',
        'is cut from the real builder and mates with another real part: `cal_ramp` with',
        '`cal_key`, the two posts with each other, `cal_gate_paddle` with',
        '`cal_gate_bearing`. Print those on a new filament or a new printer. This card',
        'only tells you HOW FAR OFF you are, and only for the bowtie — reach for it if',
        'that fit misses.', '');
    L.push('Every shape here is chamfered ' + SECTION.chamferMm + ' mm on its underside, so',
        'the bottom two layers are inset past anything elephant-foot compensation or bed',
        'squish can do to them. What you engage is the normal layers above, which are the',
        'layers a real part mates on.', '');
    return L.join('\n');
}

window.__shop = shop; window.__THREE = THREE;   // dev hook for layout verification
// Headless verification needs to see what actually made it into the scene, not
// just that no exception was thrown — the joint guide's tracks went missing
// once with a clean console (see initJointGuide).
window.__dbg = { get scene() { return scene; }, get joint() { return jointGuideState; },
                 get gallery() { return gallery; } };
$('btn-print-shop').addEventListener('click', () => openPrintShop({ preset: 'all' }));
// Same door, but this one is "show me the job the buttons above will produce",
// so it forces the preset back to the whole design.
$('shop-close').addEventListener('click', () => closePrintShop());
$('shop-export').addEventListener('click', () => shopExport('3mf'));
$('shop-export-stl').addEventListener('click', () => shopExport('stl'));
$('shop-export-cal').addEventListener('click', () => loadCalibrationParts());
(() => {
    const sel = $('shop-preset');
    for (const set of EXPORT_SETS) {
        const o = document.createElement('option');
        o.value = set.id; o.textContent = set.label;
        sel.appendChild(o);
    }
    sel.addEventListener('change', () => shopApplyPreset(sel.value));
})();
$('shop-solo').addEventListener('change', () => {
    shop.soloBigParts = $('shop-solo').checked;
    shop.soloTouched = true;
    shopRepack();          // updates #shop-summary itself
});
$('shop-brim').addEventListener('change', async () => {
    shop.brimPosts = $('shop-brim').checked;
    // The brim is GEOMETRY, so every built mesh and thumbnail is stale and the
    // catalogue has to be rebuilt — clearing `builtFor` is what makes
    // openPrintShop rebuild rather than just reopen.
    //
    // But a rebuild reseeds every count from the DESIGN (`shop.counts.set(...,
    // part.count)`), so ticking this box threw away whatever quantities you had
    // set: measured, a 14-part job came back as 100. Hold them across it. A
    // name that no longer exists is dropped rather than resurrected.
    const keep = new Map(shop.counts);
    shop.builtFor = null;
    await openPrintShop();
    for (const [name, n] of keep) if (shop.counts.has(name)) shop.counts.set(name, n);
    shopBuildList();
    shopRepack();
});
$('shop-zero').addEventListener('click', () => {
    for (const it of shop.items) shop.counts.set(it.name, 0);
    $('shop-preset').selectedIndex = -1;
    $('shop-preset-hint').textContent = '';
    shopBuildList();
    shopRepack();
});
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shop.open) closePrintShop();
});

function toArraysFromBG(g) {
    const positions = new Float32Array(g.attributes.position.array);
    const indices = g.index
        ? new Uint32Array(g.index.array)
        : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    return { positions, indices };
}

/**
 * Bambu 2.8.2+ shows an information dialog on load — it is expected, and the
 * README says so, because the alternative is every printer of these files
 * wondering whether their download is corrupt.
 */
const BAMBU_CONFIG_NOTE =
`Loading these in BambuStudio 2.8.2 or later shows:

    "The 3mf file has invalid config, load geometry data only"

That is expected and nothing is wrong. These files carry GEOMETRY ONLY — no
embedded filament or process settings — so the slicer keeps whatever profile
you have selected instead of overriding it. Click through it and slice
normally.`;

function exportReadme(joints, switchCount, plateManifest = null, unstable = []) {
    const sceneryLines = state.scenery.length
        ? state.scenery.map(s => `  - ${s.kind} at (${s.x}, ${s.z}) mm`).join('\n')
        : '  (none placed)';
    // Numbered as a list, not as literal digits: a design with no switches used
    // to print an empty step "3." where the gate instructions would have gone.
    const steps = [
        `Slide a bowtie key UP into each seam from underneath. The pocket is a
   through-slot open at the rim, so the key goes in from below, not down from
   the deck. Push it ALL THE WAY UP until its top face stops against the top
   of the pocket — that stop is what makes the two walking surfaces meet
   flush, so a key left short leaves a step at the seam. The last
   ${(SPEC.key.gripRiseMm + SPEC.key.seatLandMm).toFixed(1)} mm are a firm slide as the pocket flanks close on it.
   ${joints} seams, ${joints} keys.`,
        `The downhill floor at every seam sits ${SPEC.waterfallStepMm} mm lower than the uphill
   one. That is the waterfall rule and it is deliberate — do not sand it flat.`,
        `Stack a support under each socket: one foot plus risers (120/60/30/15 mm)
   summing to that piece's rim height, which is always a multiple of 15 mm.
   The app's parts list already tells you how many of each.`,
        switchCount
            ? `Press the ${switchCount} gate paddle(s) into the switch bores. The pin is a
   SPLIT PIN: it is drawn oversize and squeezes closed as it goes in, so it
   should take a firm push and then hold wherever you set it. That grip is
   what stops the figure knocking the gate off its route — do not ream the
   bore to ease it.`
            : null,
        `Cut a 3 mm steel/brass rod to ${(FIGURE.widthMm + 3).toFixed(0)} mm for the figure's axle.
   The pendulum must swing DEAD FREE — dry graphite, never oil.`,
        `Drop steel BBs into the ballast bores (see the app's Ballast plan),
   biased rear and low.`,
        `GLUE ALL PLUGS AND THE AXLE ENDS (CA glue) — mandatory choke-hazard
   seal for children under 3.`
    ].filter(Boolean);

    return `KLIP KLOP KONSTRUCTOR — print & assembly notes
==============================================
CANONICAL GEOMETRY v${GEOMETRY_VERSION} — parts from any same-major export mate.
Design: "${state.name}" — slope ${state.slopeDeg}°, channel ${state.innerWidth} mm, curves R${state.curveRadius} mm.
${joints} seam${joints === 1 ? '' : 's'}. Every mesh is watertight (Manifold CSG kernel), a single
solid, and pre-oriented. No support material is needed anywhere.

${plateManifest ? `PLATES
Each plate_NN file is one full build plate, already laid out — slice and print
it as it comes. Parts are positioned about the plate centre, so a slicer that
re-centres the set on load will not move anything. Sized for a Bambu
${PLATE.width}x${PLATE.depth}x${PLATE.height} mm bed (X1 / X1C / P1S / P2S) with a ${PLATE.margin} mm edge margin and
${PLATE.gap} mm between parts. Copies of one part share a single mesh in the file.

${plateManifest}

Change bed size or quantities and the layout changes, so re-export rather than
rearranging by hand — the counts below are what the design actually needs.
` : 'A filename ending in "_6x" means print six of that file.'}

PRINTING
- Material: PLA. 0.2 mm layers.
- Perimeters and infill barely matter here: the track is a ${SPEC.wall} mm shell, which
  is ${Math.round(SPEC.wall / 0.4)} lines wide at a 0.4 nozzle, so it comes out solid whatever you
  set. Two or three perimeters and any infill is fine.
- COOLING MATTERS. The skirt is an arcade, and the crown of each arch is
  bridged across open air — up to about 55 mm on the widest one. Full part
  cooling; slow down for bridges if your slicer offers it. The walking
  surface also bridges the channel, so the same setting protects it.
- Track pieces print rim-down (the flat bottom edge of the skirt on the bed,
  walking surface up) — which is also how they sit in use, so "this way up"
  is simply the way they are oriented in the file.
- A piece touches the bed only on its two end pads, its arcade piers and its
  socket boss. That is a modest footprint for a 150-225 mm part: use a brim
  if your first layer is at all marginal.
- Pillars, risers, feet and towers: print upright. Everything shares one
  interlock — a hex tenon ${(SPEC.socket.hexAF - 2 * SPEC.jointClearanceMm).toFixed(1)} mm across the flats, ${SPEC.socket.depth} mm deep. The
  socket it goes into is drawn ${(SPEC.socket.hexAF - SPEC.socket.socketShrinkAF).toFixed(2)} everywhere — track, riser and
  scenery alike — from a nominal AF ${SPEC.socket.hexAF} cut back by ${SPEC.socket.socketShrinkAF}. The track socket was
  drawn undersize first and is the joint that has felt right in the hand; in
  PETG the riser-to-riser joint did not, so it now gets the same treatment.
  Measure yours past the 0.8 mm lead-in flare at the mouth. Every fit in this
  system is a PETG number; the hex ladder on the calibration card is how to
  re-read it if your printer or filament changes.
- Curves and switches are packed one to a plate. The slicer's cantilever
  warning fires on them whatever the geometry, so alone it tells you which
  part it means, and a part that comes loose takes nothing else with it.
- Bowtie keys print flat. Gate paddles print on their sides — note the pin is
  a split C and needs no support inside its slot.
- Palm trees are pre-rotated crown-down. The figure's body and pendulum are
  pre-rotated onto their sides so the hoof cams print as smooth arcs —
  NEVER print the figure upright.

${unstable.length ? `BED CONTACT — CHECK THESE BEFORE SLICING
${unstable.map(u => `! ${u.name}: only ${u.bed.contactMm2.toFixed(1)} mm² touches the bed, under a part
  ${u.bed.widthMm.toFixed(0)} x ${u.bed.depthMm.toFixed(0)} x ${u.bed.heightMm.toFixed(0)} mm. It is standing on a point with the rest of it
  in mid-air. That is an orientation bug, not a slicer setting — do not try
  to print it.`).join('\n')}

` : ''}ASSEMBLY (in order)
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

SCENERY PLACEMENT (from your design)
${sceneryLines}

TUNING
Use the app's Troubleshooting matrix. Test one straight tile first, at the
design slope of ${state.slopeDeg}°, before committing to a whole tower.

WHEN YOU LOAD THESE
${BAMBU_CONFIG_NOTE}
`;
}

// ---------------------------------------------------------------------------
// Main loop & boot
// ---------------------------------------------------------------------------

function resize() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Line2 widths are screen-space: a stale resolution makes the joint-guide
    // hidden lines the wrong thickness after any window resize.
    if (jointGuideState.lineRes) jointGuideState.lineRes.set(w, h);
    updateLineRes(jointGuideState.lineMats, w, h);
    resizeJointVignettes();
}
window.addEventListener('resize', resize);
window.addEventListener('beforeunload', (e) => {
    if (designDirty && state.sequence.length) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
});

let last = performance.now();
function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (sim.running && !sim.paused) {
        const simDt = dt * (state.simSpeed ?? 1.0);
        tickSim(simDt);
        updateElevatorProngs(simDt);
    }
    // bob the construction arrows
    const bob = Math.sin(now / 250) * 6;
    for (const a of arrowMeshes) a.position.y = a.userData.baseY + bob;
    if (film.active) tickFilmCamera(dt);
    else controls.update();
    fadeStrikeMarkers(now);
    if (jointGuideState.active) {
        tickJointGuideAnimation(dt);
    }
    renderer.render(scene, camera);
    if (jointGuideState.active) renderJointVignettes();
    if (gallery.open) {
        gallery.controls.update();
        // in-scene dimension text is only readable if it turns to face you
        orientDimText(gallery.dims, gallery.camera);
        gallery.renderer.render(gallery.scene, gallery.camera);
    }
}

function syncControls() {
    $('in-eff').value = state.walker.efficiency; $('out-eff').textContent = state.walker.efficiency.toFixed(2);
    $('in-alpha').value = state.walker.alphaDeg; $('out-alpha').textContent = `${state.walker.alphaDeg}°`;
    $('in-leg').value = state.walker.legLenMm; $('out-leg').textContent = `${state.walker.legLenMm} mm`;
    $('in-mass').value = state.walker.massG; $('out-mass').textContent = `${state.walker.massG} g`;
    muSel.value = state.muKey;
    { const el = $('in-skirt-style'); if (el) el.value = state.skirtStyle; }
    for (const btn of document.querySelectorAll('[data-figstyle]')) {
        btn.classList.toggle('primary', btn.dataset.figstyle === state.figureStyle);
        btn.disabled = sim.running;
    }
    $('in-opacity').value = state.figureOpacity ?? 1;
    $('out-opacity').textContent = `${Math.round((state.figureOpacity ?? 1) * 100)}%`;
}

(async () => {
    await initCSG(); // switch display meshes and scenery need booleans
    await loadState();
    updateSpeedButton();
    updateRenderModeButton();
    syncControls();
    rebuild();
    applyRenderMode();
    resize();
    fitView();
    requestAnimationFrame(animate);
})();
