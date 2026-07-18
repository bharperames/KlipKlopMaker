/**
 * app.js — Klip Klop Maker main application.
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
import * as fflate from 'fflate';

import {
    SPEC, STANDARD, GEOMETRY_VERSION, isStandardParams, decomposeSupport,
    layoutTrack, stationsForPiece, appendSpiralTier, resolveRidePath,
    getContainer, nodeAt, isSwitchNode, pathKey, openContainers, planPillarPositions,
    planPosAt, deckYAt
} from './track.js';
import { FRICTION_PRESETS, DEFAULT_WALKER, assessSlope, goldilocksRange, ballastPlan, trackVerdict, printedWeightG } from './physics.js';
import { computeMeshVolumeMm3 } from './mesh_utils.js';
import { simulateRun, makePathSampler } from './simulate.js';
import { serializeScene, deserializeScene } from './scene_format.js';
import { createHistory } from './history.js';
import { createClosureSolver, chainEnds, describeGap } from './connect.js';
import {
    initCSG, toBufferGeometry, buildPieceDisplayGeometry, buildSwitchDisplayGeometry,
    buildPieceExportGeometry, buildSwitchExportGeometry, gatePinPosition,
    buildPillarGeometry, buildSupportFootGeometry, buildRiserGeometry,
    buildFigureGeometries, buildKeyGeometry, buildGateGeometry,
    buildTowerGeometry, buildPalmIslandGeometries, buildPatioGeometry, mergeSolids
} from './pieces.js';
import { extrudeOutlineX, bodySideOutline, pendulumSideOutline, FIGURE, figureVolumeEstimate } from './geometry.js';
import { buildKnightHorseModel } from './horse_model.js';
import { generate3MFXML, generateBinarySTL } from './export_3mf.js';
import { analyzeMesh } from './mesh_utils.js';

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
    walker: { ...DEFAULT_WALKER },
    soundOn: true,
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
controls.maxPolarAngle = Math.PI * 0.495;
controls.zoomSpeed = 3; // touchpad pinch/scroll deltas are tiny — boost gain

scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x8a7a55, 0.85));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.7);
sun.position.set(500, 900, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -900; sun.shadow.camera.right = 900;
sun.shadow.camera.top = 900; sun.shadow.camera.bottom = -900;
sun.shadow.camera.far = 3000;
scene.add(sun);

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

const MAT = {
    ramp: new THREE.MeshLambertMaterial({ color: 0xe8b23a }),
    curve: new THREE.MeshLambertMaterial({ color: 0xe0a52f }),
    lift: new THREE.MeshLambertMaterial({ color: 0xc95a3c }),
    switch: new THREE.MeshLambertMaterial({ color: 0xd8983b }),
    start: new THREE.MeshLambertMaterial({ color: 0x74b06c, transparent: true, opacity: 0.6 }),
    end: new THREE.MeshLambertMaterial({ color: 0xb9b3a4, transparent: true, opacity: 0.6 }),
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
    patio: new THREE.MeshLambertMaterial({ color: 0xc9b8a0 })
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
        curveRadius: state.curveRadius
    });
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
        const pads = (sup && sup.mode !== 'none') ? [sup.s] : undefined;
        let mesh;
        if (pc.role === 'main') {
            const pair = switchPairs.get(pc.switchKey);
            mesh = new THREE.Mesh(
                buildSwitchDisplayGeometry(pair.main, pair.branch, SPEC, pads),
                materialFor(pc, issues.has(pc.index) || issues.has(pair.branch.index))
            );
            mesh.userData.pieceIndex = pc.index;
            mesh.userData.switchKey = pc.switchKey;
            pieceMeshes[pair.branch.index] = mesh;
        } else {
            mesh = new THREE.Mesh(buildPieceDisplayGeometry(pc, SPEC, pads), materialFor(pc, issues.has(pc.index)));
            mesh.userData.pieceIndex = pc.index;
        }
        mesh.castShadow = mesh.receiveShadow = true;
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
    for (const sup of state.supports) {
        const pc = pieces[sup.pieceIndex];
        if (sup.mode === 'none') {
            state.layout.issues.push({
                level: 'warn', code: 'no-support',
                msg: `No clear pillar column under ${pc.name} — it will need a scenery tower or manual support.`
            });
            continue;
        }
        trackGroup.add(buildSupportObject(pc.rimY, sup.x, sup.z));
        if (sup.mode === 'center') {
            const f = sup.s / pc.planLen;
            const ceilY = (pc.entryDeck - pc.drop * f) - SPEC.floorThk;
            const bossH = (ceilY + 0.5) - pc.rimY;
            if (bossH > 0) {
                const bossMesh = new THREE.Mesh(
                    new THREE.CylinderGeometry(SPEC.socket.bossR, SPEC.socket.bossR, bossH, 16),
                    materialFor(pc, false)
                );
                bossMesh.position.set(sup.x, pc.rimY + bossH / 2, sup.z);
                bossMesh.castShadow = true;
                trackGroup.add(bossMesh);
            }
        } else if (sup.mode === 'outrigger') {
            // arm reaches from the skirt wall out to the boss (lateral = local X)
            const right = [Math.sin(sup.h), -Math.cos(sup.h)];
            const arm = new THREE.Mesh(new THREE.BoxGeometry(26, 11, 22), MAT.pillar);
            arm.position.set(
                sup.x - right[0] * sup.side * 12,
                pc.rimY + 5.5,
                sup.z - right[1] * sup.side * 12
            );
            arm.rotation.y = Math.PI / 2 - sup.h;
            arm.castShadow = true;
            trackGroup.add(arm);
        }
    }

    // gate blades: hinged on the wall opposite the branch — parked flat along
    // the wall (straight through) or swung in to deflect into the branch
    for (const sw of switches) {
        const pair = switchPairs.get(sw.key);
        const pin = gatePinPosition(pair.main);
        const vane = new THREE.BoxGeometry(2.6, SPEC.railHeight - 2, 52);
        vane.translate(0, (SPEC.railHeight - 2) / 2, 24); // hinge at one end
        const paddle = new THREE.Mesh(vane, MAT.gate);
        const yaw = sw.gate === 'branch' ? pin.yawDiverting : pin.yawParked;
        paddle.position.set(pin.x, pin.deckY, pin.z);
        paddle.rotation.y = Math.PI / 2 - yaw;
        paddle.userData.switchKey = sw.key;
        paddle.userData.pieceIndex = pair.main.index;
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
    refreshSelectionHighlight();
    refreshPieceList();
    refreshPhysicsPanel();
    refreshFooter();
    refreshEditorCard();
    refreshIdleHorse();
    refreshParamsMode();
    refreshPrintPartsList();
    $('btn-connect').disabled = state.layout.isCircuit || !state.sequence.length || state.sequence.some(n => typeof n !== 'string');
    saveState();
}

function usingStandard() {
    return isStandardParams({ slopeDeg: state.slopeDeg, curveRadius: state.curveRadius, innerWidth: state.innerWidth });
}

// standard support stacks (foot + risers) — cached geometries, one design each
const supportGeomCache = new Map();
function supportGeom(kind) {
    if (!supportGeomCache.has(kind)) {
        supportGeomCache.set(kind, kind === 'foot'
            ? buildSupportFootGeometry()
            : toBufferGeometry(buildRiserGeometry(Number(kind))));
    }
    return supportGeomCache.get(kind);
}

/** A support at (x,z): stacked standard parts on-grid, legacy pillar otherwise. */
function buildSupportObject(heightMm, x, z) {
    const dec = usingStandard() ? decomposeSupport(heightMm) : null;
    if (!dec) {
        const pillar = new THREE.Mesh(buildPillarGeometry(heightMm), MAT.pillar);
        pillar.position.set(x, 0, z);
        pillar.castShadow = true;
        return pillar;
    }
    const g = new THREE.Group();
    const foot = new THREE.Mesh(supportGeom('foot'), MAT.pillar);
    foot.castShadow = true;
    g.add(foot);
    let y = STANDARD.footHeight;
    for (const r of [...dec.risers].sort((a, b) => b - a)) {
        const m = new THREE.Mesh(supportGeom(String(r)), MAT.pillar);
        m.position.y = y;
        m.castShadow = true;
        g.add(m);
        y += r;
    }
    g.position.set(x, 0, z);
    return g;
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
        obj.traverse(o => { o.castShadow = true; o.userData.sceneryIndex = i; });
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
        if (sup.mode === 'none') continue;
        const pc = state.layout.pieces[sup.pieceIndex];
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
            if (sup.mode === 'none') continue;
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
            .find(h => h.object.userData.switchKey !== undefined);
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
        if (lightbox.open) { closeLightbox(); return; }
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
    return { mu: FRICTION_PRESETS[state.muKey].mu, walker: state.walker };
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

    const vol = figureVolumeEstimate(state.innerWidth - 4, state.figureStyle);
    const bp = ballastPlan(vol, 15, state.walker.massG);
    const W = state.innerWidth - 4;
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
    ['Toy turns sideways and jams', 'Track too wide or legs asymmetric', 'Keep inner width ≤ figure width + 4 mm. Confirm left/right hooves weigh the same.'],
    ['Swinging leg barely moves', 'Pendulum rubbing inside the slot', 'Sand the pendulum faces; add thin washers on the axle as spacers; confirm 0.5 mm clearance per side.'],
    ['Horse stumbles at a seam', 'Uphill lip at the joint', 'Exports drop each downhill floor 0.25 mm (waterfall rule) — check the printed seam for blobs and re-seat the bowtie key.'],
    ['Horse stops at a switch', 'Gate vane misaligned or pin too tight', 'The vane must clear the selected route completely; ream the pin bore, verify the gate swings freely.']
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
const TABS = ['build', 'export', 'physics'];
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => setTab(t));
function setTab(t) {
    for (const k of TABS) {
        $(`pane-${k}`).style.display = k === t ? '' : 'none';
        $(`tab-${k}`).classList.toggle('active', k === t);
    }
    if (t === 'export') {
        refreshPrintPartsList();
        initGallery();
        gallery.open = true;
        galleryResize();
        if (gallery.parts && gallery.parts.length > 0) {
            selectGalleryPart(0);
        }
    } else {
        gallery.open = false;
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

function transformMeshToLocalFrame(mesh, piece) {
    if (!piece || !piece.entry) return mesh;
    const { positions } = mesh;
    const h = piece.entry.h;
    const cos = Math.cos(-h);
    const sin = Math.sin(-h);
    for (let i = 0; i < positions.length; i += 3) {
        const tx = positions[i] - piece.entry.x;
        const tz = positions[i + 2] - piece.entry.z;
        positions[i] = tx * cos - tz * sin;
        positions[i + 2] = tx * sin + tz * cos;
        positions[i + 1] = positions[i + 1] - piece.entryDeck;
    }
    return mesh;
}

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
        li.addEventListener('click', () => {
            selectGalleryPart(i);
        });
        list.appendChild(li);
    });

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
    const W2 = (state.innerWidth - 4) / 2;
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

    const stream = renderer.domElement.captureStream(60);
    // mix the synthesized klip-klop audio into the recording (even when the
    // speaker toggle is muted, the film still gets its soundtrack)
    audioCtx ??= makeAudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    film.audioDest = audioCtx.createMediaStreamDestination();
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
        scene.add(idleHorse);
    } catch { /* empty/degenerate layouts have no place to stand */ }
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

$('btn-export-stl').addEventListener('click', () => doExport('stl'));
$('btn-export-3mf').addEventListener('click', () => doExport('3mf'));

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
        switch: 'Two routes merged with an open frog, three bowtie pockets, gate-pin bore at the mouth.',
        key: 'Drops into the pockets of two mating pieces — Hot-Wheels-style seam connector.',
        gate: 'Pin seats in the switch deck bore; blade must swing freely.',
        pillar: 'Hex tenon (8.6 AF) plugs into any track/scenery socket (9 AF × 10).',
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
            pc.planLen.toFixed(1),
            pc.drop.toFixed(3),
            pc.slopeDeg.toFixed(3),
            pc.ridgePitch ? pc.ridgePitch.toFixed(3) : '0',
            pc.waterfall ? pc.waterfall.toFixed(3) : '0',
            pc.switchType ?? ''
        ];
        if (support && support.mode !== 'none') {
            sigParts.push(support.mode);
            sigParts.push(support.s.toFixed(1));
            sigParts.push(support.side ?? '0');
        } else {
            sigParts.push('no-support');
        }
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
            uniqueParts.get(sig).count++;
        } else {
            uniqueParts.set(sig, { pc, support, count: 1 });
        }
    }

    for (const [sig, item] of uniqueParts.entries()) {
        const { pc, support, count } = item;
        const baseName = pc.role === 'main' ? pc.name.replace('switchMain', 'switch') : pc.name;
        if (pc.role === 'main') {
            const pair = switchPairs.get(pc.switchKey);
            parts.push({
                name: baseName,
                count,
                sig,
                note: note.switch,
                build: () => {
                    const mesh = buildSwitchExportGeometry(pair.main, pair.branch, { support });
                    return transformMeshToLocalFrame(mesh, pair.main);
                }
            });
        } else {
            parts.push({
                name: baseName,
                count,
                sig,
                note: note.piece,
                build: () => {
                    const mesh = buildPieceExportGeometry(pc, { support });
                    return transformMeshToLocalFrame(mesh, pc);
                }
            });
        }
    }
    if (switchPairs.size) {
        parts.push({ name: 'gate_paddle_print', count: switchPairs.size, sig: 'gate_paddle_print', note: note.gate, build: () => buildGateGeometry() });
    }
    parts.push({ name: 'connector_key_print', count: joints, sig: 'connector_key_print', note: note.key, build: () => buildKeyGeometry() });

    // supports: reusable standard modules (foot + risers) with print counts —
    // never cut-to-height "magic" pillars unless custom parameters force it
    const supList = (state.supports ?? []).filter(sup => sup.mode !== 'none');
    if (usingStandard()) {
        let feet = 0;
        const riserCounts = new Map();
        for (const sup of supList) {
            const dec = decomposeSupport(pieces[sup.pieceIndex].rimY);
            if (!dec) continue;
            feet++;
            for (const r of dec.risers) riserCounts.set(r, (riserCounts.get(r) ?? 0) + 1);
        }
        if (feet) parts.push({ name: 'support_foot_print', count: feet, sig: 'support_foot_print', note: note.pillar, build: () => toArraysFromBG(buildSupportFootGeometry()) });
        for (const [r, count] of [...riserCounts.entries()].sort((a, b) => b[0] - a[0])) {
            parts.push({ name: `support_riser_${r}mm_print`, count, sig: `support_riser_${r}mm_print`, note: note.pillar, build: () => buildRiserGeometry(r) });
        }
    } else {
        for (const sup of supList) {
            const pc = pieces[sup.pieceIndex];
            parts.push({ name: `pillar_${pc.name}_h${pc.rimY.toFixed(0)}_CUSTOM`, count: 1, sig: `pillar_${pc.name}_h${pc.rimY.toFixed(0)}_CUSTOM`, note: 'Custom parameters: this pillar fits only this print batch.', build: () => toArraysFromBG(buildPillarGeometry(pc.rimY)) });
        }
    }

    const kinds = [...new Set(state.scenery.map(s => s.kind))];
    for (const kind of kinds) {
        const count = state.scenery.filter(s => s.kind === kind).length;
        if (kind === 'tower') parts.push({ name: 'scenery_tower_print', count, sig: 'scenery_tower_print', note: note.scenery, build: () => buildTowerGeometry(100) });
        if (kind === 'patio') parts.push({ name: 'scenery_patio_print', count, sig: 'scenery_patio_print', note: note.scenery, build: () => buildPatioGeometry() });
        if (kind === 'palm') {
            parts.push({ name: 'scenery_palm_island_print', count, sig: 'scenery_palm_island_print', note: note.scenery, build: () => buildPalmIslandGeometries().island });
            parts.push({ name: 'scenery_palm_tree_print_crown_down', count, sig: 'scenery_palm_tree_print_crown_down', note: note.scenery, build: () => rotFlip(buildPalmIslandGeometries().palm) });
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
    style: 'plastic', showWire: false, showDims: true
};

// material styles: how the same watertight mesh reads under different finishes
const GALLERY_MATS = {
    plastic: () => new THREE.MeshPhysicalMaterial({ color: 0xe8b23a, roughness: 0.32, metalness: 0, clearcoat: 0.65, clearcoatRoughness: 0.25 }),
    pla: () => new THREE.MeshStandardMaterial({ color: 0xe8b23a, roughness: 0.85, metalness: 0 }),
    clay: () => new THREE.MeshLambertMaterial({ color: 0xe8b23a }),
    normals: () => new THREE.MeshNormalMaterial()
};

function initGallery() {
    if (gallery.renderer) return;
    const holder = $('print-part-view');
    gallery.renderer = new THREE.WebGLRenderer({ antialias: true });
    gallery.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    holder.appendChild(gallery.renderer.domElement);
    gallery.scene = new THREE.Scene();
    gallery.scene.background = new THREE.Color(0x272420);
    // studio environment: reflections make the physical material read as
    // injection-molded plastic instead of untextured CAD
    const pmrem = new THREE.PMREMGenerator(gallery.renderer);
    gallery.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    gallery.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
    gallery.controls = new OrbitControls(gallery.camera, gallery.renderer.domElement);
    gallery.controls.enableDamping = true;
    gallery.controls.autoRotate = true;
    gallery.controls.autoRotateSpeed = 1.6;
    gallery.controls.zoomSpeed = 3;
    gallery.scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 0.55));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.1);
    key.position.set(200, 350, 150);
    gallery.scene.add(key);
    const grid = new THREE.GridHelper(600, 30, 0x554e42, 0x3d3830);
    gallery.scene.add(grid);

    $('print-part-shading').addEventListener('change', () => { gallery.style = $('print-part-shading').value; applyGalleryStyle(); });
    $('print-part-rotate').addEventListener('change', () => { gallery.controls.autoRotate = $('print-part-rotate').checked; });
    $('print-part-wire').addEventListener('change', () => { gallery.showWire = $('print-part-wire').checked; applyGalleryStyle(); });
    $('print-part-dims').addEventListener('change', () => { gallery.showDims = $('print-part-dims').checked; applyGalleryStyle(); });
}

/**
 * Engineering-style dimensions: witness (extension) lines run FROM the part's
 * bounding corners out to the dimension line, so callouts visually attach to
 * the part instead of floating in space. Small fixed offset regardless of size.
 */
function makeDimGroup(box) {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x9ec5ff });
    const size = box.getSize(new THREE.Vector3());
    const off = 7;               // dimension line sits this far off the part
    const ext = off + 3;         // witness lines overshoot it slightly
    const mkLine = (a, b) => {
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        g.add(new THREE.Line(geo, mat));
    };
    const mkLabel = (text, pos) => {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.font = 'bold 40px sans-serif';
        ctx.fillStyle = '#cfe2ff';
        ctx.textAlign = 'center';
        ctx.fillText(text, 128, 46);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
        sp.position.copy(pos);
        const s = Math.min(46, Math.max(16, size.length() * 0.09));
        sp.scale.set(s, s / 4, 1);
        g.add(sp);
    };
    const { min, max } = box;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    // X (length): witness lines from the front-bottom corners, dim line between
    mkLine(V(min.x, min.y, max.z), V(min.x, min.y, max.z + ext));
    mkLine(V(max.x, min.y, max.z), V(max.x, min.y, max.z + ext));
    mkLine(V(min.x, min.y, max.z + off), V(max.x, min.y, max.z + off));
    mkLabel(`${size.x.toFixed(1)} mm`, V((min.x + max.x) / 2, min.y + 3, max.z + off + 5));

    // Z (depth): witness from the right-bottom corners
    mkLine(V(max.x, min.y, min.z), V(max.x + ext, min.y, min.z));
    mkLine(V(max.x, min.y, max.z), V(max.x + ext, min.y, max.z));
    mkLine(V(max.x + off, min.y, min.z), V(max.x + off, min.y, max.z));
    mkLabel(`${size.z.toFixed(1)} mm`, V(max.x + off + 5, min.y + 3, (min.z + max.z) / 2));

    // Y (height): witness from the front-right edge, vertical dim beside it
    mkLine(V(max.x, min.y, max.z), V(max.x + ext, min.y, max.z + ext));
    mkLine(V(max.x, max.y, max.z), V(max.x + ext, max.y, max.z + ext));
    mkLine(V(max.x + off, min.y, max.z + off), V(max.x + off, max.y, max.z + off));
    mkLabel(`${size.y.toFixed(1)} mm`, V(max.x + off + 4, (min.y + max.y) / 2, max.z + off + 4));
    return g;
}

/** (Re)builds the displayed mesh + overlays from gallery.geo and view options. */
function applyGalleryStyle() {
    for (const key of ['mesh', 'wire', 'dims']) {
        if (gallery[key]) {
            gallery.scene.remove(gallery[key]);
            gallery[key] = null;
        }
    }
    if (!gallery.geo) return;
    gallery.mesh = new THREE.Mesh(gallery.geo, GALLERY_MATS[gallery.style]());
    gallery.scene.add(gallery.mesh);
    if (gallery.showWire) {
        gallery.wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(gallery.geo),
            new THREE.LineBasicMaterial({ color: 0x2bff6a, transparent: true, opacity: 0.55 })
        );
        gallery.scene.add(gallery.wire);
    }
    if (gallery.showDims) {
        gallery.dims = makeDimGroup(new THREE.Box3().setFromObject(gallery.mesh));
        gallery.scene.add(gallery.dims);
    }
}

function galleryResize() {
    const holder = $('print-part-view');
    if (!holder || !gallery.renderer) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    gallery.renderer.setSize(w, h);
    gallery.camera.aspect = w / h;
    gallery.camera.updateProjectionMatrix();
}

function openGallery() {
    setTab('export');
}

function closeGallery() {
    setTab('build');
}

function selectGalleryPart(i) {
    const part = gallery.parts[i];
    if (!part) return;
    [...$('print-parts-list').children].forEach((li, k) => li.classList.toggle('selected', k === i));
    $('print-part-caption').innerHTML = '⏳ building export geometry…';
    setTimeout(() => {
        if (gallery.geo) gallery.geo.dispose();
        const mesh = recenter(part.build());
        const report = analyzeMesh(mesh.positions, mesh.indices);
        gallery.geo = toBufferGeometry(mesh);
        applyGalleryStyle();
        const box = new THREE.Box3().setFromObject(gallery.mesh);
        const c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        gallery.controls.target.copy(c);
        // low three-quarter angle so undersides (pockets, sockets, ribs) show
        gallery.camera.position.set(c.x + size * 0.8, c.y + size * 0.45, c.z + size * 0.8);
        const cat = /^(pillar|support)/.test(part.name) ? 'pillar'
            : /^scenery/.test(part.name) ? 'scenery'
            : /^figure_body|^figure_pend/.test(part.name) ? 'figure'
            : /^connector|^gate|plugs/.test(part.name) ? 'small' : 'track';
        const countLabel = part.count > 1 ? ` (x${part.count})` : '';
        $('print-part-caption').innerHTML =
            `<b>${part.name}${countLabel}</b> · ${(report.volumeMm3 / 1000).toFixed(1)} cm³ · ≈${printedWeightG(report.volumeMm3, cat).toFixed(0)} g printed · ` +
            `${report.isManifold && report.isConsistent && report.windsOutward
                ? '<span class="ok">✔ watertight</span>' : '<span class="bad">✖ CHECK</span>'}<br>` +
            `<span style="opacity:.8">${part.note ?? ''} Drag in inspector to rotate.</span>`;
    }, 30);
}

// ---------------------------------------------------------------------------
// Lightbox overlay inspector (large preview)
// ---------------------------------------------------------------------------

const lightbox = {
    open: false, renderer: null, scene: null, camera: null, controls: null,
    mesh: null, wire: null, dims: null, geo: null, report: null, parts: [],
    style: 'plastic', showWire: false, showDims: true, selectedIndex: 0
};

function initLightbox() {
    if (lightbox.renderer) return;
    const holder = $('parts-view');
    lightbox.renderer = new THREE.WebGLRenderer({ antialias: true });
    lightbox.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    holder.appendChild(lightbox.renderer.domElement);
    lightbox.scene = new THREE.Scene();
    lightbox.scene.background = new THREE.Color(0x1d1a16);
    const pmrem = new THREE.PMREMGenerator(lightbox.renderer);
    lightbox.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    lightbox.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
    lightbox.controls = new OrbitControls(lightbox.camera, lightbox.renderer.domElement);
    lightbox.controls.enableDamping = true;
    lightbox.controls.autoRotate = true;
    lightbox.controls.autoRotateSpeed = 1.6;
    lightbox.controls.zoomSpeed = 3;
    lightbox.scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 0.55));
    const key = new THREE.DirectionalLight(0xfff2d8, 1.1);
    key.position.set(200, 350, 150);
    lightbox.scene.add(key);
    const grid = new THREE.GridHelper(600, 30, 0x554e42, 0x3d3830);
    lightbox.scene.add(grid);

    $('parts-shading').addEventListener('change', () => { lightbox.style = $('parts-shading').value; applyLightboxStyle(); });
    $('parts-rotate').addEventListener('change', () => { lightbox.controls.autoRotate = $('parts-rotate').checked; });
    $('parts-wire').addEventListener('change', () => { lightbox.showWire = $('parts-wire').checked; applyLightboxStyle(); });
    $('parts-dims').addEventListener('change', () => { lightbox.showDims = $('parts-dims').checked; applyLightboxStyle(); });
}

function applyLightboxStyle() {
    for (const key of ['mesh', 'wire', 'dims']) {
        if (lightbox[key]) {
            lightbox.scene.remove(lightbox[key]);
            lightbox[key] = null;
        }
    }
    if (!lightbox.geo) return;
    lightbox.mesh = new THREE.Mesh(lightbox.geo, GALLERY_MATS[lightbox.style]());
    lightbox.scene.add(lightbox.mesh);
    if (lightbox.showWire) {
        lightbox.wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(lightbox.geo),
            new THREE.LineBasicMaterial({ color: 0x2bff6a, transparent: true, opacity: 0.55 })
        );
        lightbox.scene.add(lightbox.wire);
    }
    if (lightbox.showDims) {
        lightbox.dims = makeDimGroup(new THREE.Box3().setFromObject(lightbox.mesh));
        lightbox.scene.add(lightbox.dims);
    }
}

function lightboxResize() {
    const holder = $('parts-view');
    if (!holder || !lightbox.renderer) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    lightbox.renderer.setSize(w, h);
    lightbox.camera.aspect = w / h;
    lightbox.camera.updateProjectionMatrix();
}

function selectLightboxPart(i) {
    lightbox.selectedIndex = i;
    const part = lightbox.parts[i];
    if (!part) return;
    [...$('parts-list').children].forEach((li, k) => li.classList.toggle('selected', k === i));
    $('parts-caption').innerHTML = '⏳ building export geometry…';
    setTimeout(() => {
        if (lightbox.geo) lightbox.geo.dispose();
        const mesh = recenter(part.build());
        const report = analyzeMesh(mesh.positions, mesh.indices);
        lightbox.geo = toBufferGeometry(mesh);
        applyLightboxStyle();
        const box = new THREE.Box3().setFromObject(lightbox.mesh);
        const c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        lightbox.controls.target.copy(c);
        lightbox.camera.position.set(c.x + size * 0.8, c.y + size * 0.45, c.z + size * 0.8);
        const cat = /^(pillar|support)/.test(part.name) ? 'pillar'
            : /^scenery/.test(part.name) ? 'scenery'
            : /^figure_body|^figure_pend/.test(part.name) ? 'figure'
            : /^connector|^gate|plugs/.test(part.name) ? 'small' : 'track';
        const countLabel = part.count > 1 ? ` (x${part.count})` : '';
        $('parts-caption').innerHTML =
            `<b>${part.name}${countLabel}</b> · ${(report.volumeMm3 / 1000).toFixed(1)} cm³ · ≈${printedWeightG(report.volumeMm3, cat).toFixed(0)} g printed · ` +
            `${report.isManifold && report.isConsistent && report.windsOutward
                ? '<span class="ok">✔ watertight</span>' : '<span class="bad">✖ CHECK</span>'}<br>` +
            `<span style="opacity:.8">${part.note ?? ''} Drag in inspector to rotate.</span>`;
    }, 30);
}

function openLightbox() {
    $('parts-overlay').style.display = '';
    initLightbox();
    lightboxResize();
    lightbox.parts = assembleParts().parts;
    $('parts-count').textContent = `${lightbox.parts.length} unique parts in this design`;
    const list = $('parts-list');
    list.innerHTML = '';
    lightbox.parts.forEach((part, i) => {
        const li = document.createElement('li');
        const countLabel = part.count > 1 ? ` (x${part.count})` : '';
        li.textContent = `${part.name}${countLabel}`;
        li.addEventListener('click', () => selectLightboxPart(i));
        list.appendChild(li);
    });

    let index = 0;
    const inlineList = $('print-parts-list');
    if (inlineList) {
        const selectedLi = inlineList.querySelector('li.selected');
        if (selectedLi) {
            const siblings = [...inlineList.children];
            index = siblings.indexOf(selectedLi);
            if (index < 0) index = 0;
        }
    }

    lightbox.open = true;
    selectLightboxPart(index);
}

function closeLightbox() {
    lightbox.open = false;
    $('parts-overlay').style.display = 'none';
    selectGalleryPart(lightbox.selectedIndex);
}

$('btn-open-lightbox').addEventListener('click', openLightbox);
$('parts-close').addEventListener('click', closeLightbox);

window.addEventListener('resize', () => {
    if (gallery.renderer) galleryResize();
    if (lightbox.renderer) lightboxResize();
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

async function doExport(format) {
    const btns = [$('btn-export-stl'), $('btn-export-3mf')];
    btns.forEach(b => b.disabled = true);
    const prog = $('export-progress');
    const log = $('export-log');
    prog.style.display = ''; prog.value = 0;
    log.innerHTML = '';

    try {
        await initCSG();
        const { parts, joints, switchCount } = assembleParts();
        const files = {};
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            await new Promise(res => setTimeout(res));
            const mesh = recenter(part.build());
            const report = analyzeMesh(mesh.positions, mesh.indices);
            const ok = report.isManifold && report.isConsistent && report.windsOutward;
            const fileName = part.count > 1 ? `${part.name}_${part.count}x` : part.name;
            log.innerHTML += `<div class="row"><span>${fileName}</span>` +
                `<span>${(report.volumeMm3 / 1000).toFixed(1)} cm³ <span class="${ok ? 'ok' : 'bad'}">${ok ? '✔ watertight' : '✖ CHECK'}</span></span></div>`;
            if (format === 'stl') {
                files[`${fileName}.stl`] = new Uint8Array(generateBinarySTL(mesh.positions, mesh.indices));
            } else {
                const xml = generate3MFXML(mesh.positions, mesh.indices);
                files[`${fileName}.3mf`] = fflate.zipSync({
                    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
                    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
                    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
                });
            }
            prog.value = (i + 1) / parts.length;
        }

        files['README.txt'] = fflate.strToU8(exportReadme(joints, switchCount));
        const zipped = fflate.zipSync(files);
        const blob = new Blob([zipped], { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `klipklop_${(state.name || 'track').replace(/\W+/g, '_').toLowerCase()}_geo${GEOMETRY_VERSION.replace(/\./g, '-')}_${parts.length}parts_${format}.zip`;
        a.click();
        toast(`⬇ Exported ${parts.length} watertight parts (${format.toUpperCase()})`);
    } catch (err) {
        console.error(err);
        toast(`Export failed: ${err.message}`);
    } finally {
        btns.forEach(b => b.disabled = false);
        prog.style.display = 'none';
    }
}

function toArraysFromBG(g) {
    const positions = new Float32Array(g.attributes.position.array);
    const indices = g.index
        ? new Uint32Array(g.index.array)
        : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    return { positions, indices };
}

function exportReadme(joints, switchCount) {
    const sceneryLines = state.scenery.length
        ? state.scenery.map(s => `  - ${s.kind} at (${s.x}, ${s.z}) mm`).join('\n')
        : '  (none placed)';
    return `KLIP KLOP MAKER — print & assembly notes
=========================================
CANONICAL GEOMETRY v${GEOMETRY_VERSION} — parts from any same-major export mate.
Design: "${state.name}" — slope ${state.slopeDeg}°, channel ${state.innerWidth} mm, curves R${state.curveRadius} mm.
All meshes are watertight (Manifold CSG kernel) and pre-oriented for printing —
no supports needed anywhere.

PRINTING
- Material: PLA. 0.2 mm layers, 4-5 wall perimeters (toddler-proof), 10% gyroid infill.
- Track pieces: print as oriented (skirt rim on the bed, deck up). The washboard
  ridges and the sealed end-rib acoustic chambers are modeled in.
- Connector keys: print ${joints}x flat (file is one key — multiply in your slicer).
- ${switchCount ? `Gate paddles: print ${switchCount}x lying on their sides. Pin drops into the deck bore; it must swing freely.` : 'No switches in this design.'}
- Pillars & towers: print upright. Everything shares one interlock: hex tenon
  8.6 mm AF into hex socket 9 mm AF × 10 deep.
- Palm trees: pre-rotated crown-down. Figure body & pendulum: pre-rotated onto
  their sides so the hoof cams print as smooth arcs. NEVER print the figure upright.

ASSEMBLY (in order)
1. Butt each seam together and drop a bowtie connector key into the shared
   pocket under the floor (Hot-Wheels style). The downhill floor sits 0.25 mm
   lower by design (waterfall rule) — do not "fix" this.
2. Plug pillars/towers into the hex sockets; heights are pre-computed.
3. ${switchCount ? 'Insert gate paddles into switch bores; flick to route the horse.' : ''}
4. Cut a 3 mm steel/brass rod to ${(state.innerWidth - 4 + 3).toFixed(0)} mm for the axle.
   Pendulum must swing DEAD FREE — add dry graphite.
5. Drop steel BBs into the ballast bores (see the app's Ballast plan), rear/low bias.
6. GLUE ALL PLUGS AND THE AXLE ENDS (CA glue) — mandatory choke-hazard seal
   for children under 3.

SCENERY PLACEMENT (from your design)
${sceneryLines}

TUNING
Use the app's Troubleshooting matrix. First test on a single straight ramp at 11°.
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
    renderer.render(scene, camera);
    if (gallery.open) {
        gallery.controls.update();
        gallery.renderer.render(gallery.scene, gallery.camera);
    }
    if (lightbox.open) {
        lightbox.controls.update();
        lightbox.renderer.render(lightbox.scene, lightbox.camera);
    }
}

function syncControls() {
    $('in-eff').value = state.walker.efficiency; $('out-eff').textContent = state.walker.efficiency.toFixed(2);
    $('in-alpha').value = state.walker.alphaDeg; $('out-alpha').textContent = `${state.walker.alphaDeg}°`;
    $('in-leg').value = state.walker.legLenMm; $('out-leg').textContent = `${state.walker.legLenMm} mm`;
    $('in-mass').value = state.walker.massG; $('out-mass').textContent = `${state.walker.massG} g`;
    muSel.value = state.muKey;
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
    syncControls();
    rebuild();
    resize();
    fitView();
    requestAnimationFrame(animate);
})();
