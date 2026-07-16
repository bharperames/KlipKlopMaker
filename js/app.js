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
    SPEC, layoutTrack, stationsForPiece, appendSpiralTier, resolveRidePath,
    getContainer, nodeAt, isSwitchNode, pathKey, openContainers, planPillarPositions
} from './track.js';
import { FRICTION_PRESETS, DEFAULT_WALKER, assessSlope, goldilocksRange, ballastPlan, trackVerdict, printedWeightG } from './physics.js';
import { computeMeshVolumeMm3 } from './mesh_utils.js';
import { simulateRun, makePathSampler } from './simulate.js';
import { serializeScene, deserializeScene } from './scene_format.js';
import { createHistory } from './history.js';
import {
    initCSG, toBufferGeometry, buildPieceDisplayGeometry, buildSwitchDisplayGeometry,
    buildPieceExportGeometry, buildSwitchExportGeometry, gatePinPosition,
    buildPillarGeometry, buildFigureGeometries, buildKeyGeometry, buildGateGeometry,
    buildTowerGeometry, buildPalmIslandGeometries, buildPatioGeometry, mergeSolids
} from './pieces.js';
import { extrudeOutlineX, bodySideOutline, pendulumSideOutline, FIGURE, figureVolumeEstimate } from './geometry.js';
import { generate3MFXML, generateBinarySTL } from './export_3mf.js';
import { analyzeMesh } from './mesh_utils.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    sequence: [],
    scenery: [],
    loop: false,
    figureStyle: 'classic',
    slopeDeg: 11,
    innerWidth: 48,
    curveRadius: 150,
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
        loop: state.loop,
        figureStyle: state.figureStyle,
        slopeDeg: state.slopeDeg,
        innerWidth: state.innerWidth,
        curveRadius: state.curveRadius,
        muKey: state.muKey,
        walker: { ...state.walker },
        name: state.name,
        activeEndKey: state.activeEndKey
    };
}

function recordEdit(opKey = null) {
    history.push(designSnapshot(), opKey);
    refreshHistoryButtons();
}

function restoreSnapshot(s) {
    state.sequence = s.sequence;
    state.scenery = s.scenery;
    state.loop = s.loop === true;
    state.figureStyle = s.figureStyle ?? 'classic';
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
    state.sequence = s.sequence;
    state.scenery = s.scenery;
    state.loop = s.loop === true;
    state.figureStyle = s.figureStyle ?? 'classic';
    state.slopeDeg = s.slopeDeg;
    state.innerWidth = s.innerWidth;
    state.curveRadius = s.curveRadius;
    state.muKey = s.muKey;
    state.walker = s.walker;
    state.name = s.name;
    state.activeEndKey = '[]';
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
        curveRadius: state.curveRadius,
        loop: state.loop
    });
    const { pieces, switches, openEnds } = state.layout;
    const issues = issueSet();

    trackGroup.clear();
    arrowGroup.clear();
    pieceMeshes = new Array(pieces.length).fill(null);
    arrowMeshes = [];

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
        const pads = supportOf(pc.index) ? [supportOf(pc.index).s ?? pc.planLen / 2] : undefined;
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
        const pillar = new THREE.Mesh(buildPillarGeometry(pc.rimY), MAT.pillar);
        pillar.position.set(sup.x, 0, sup.z);
        pillar.castShadow = true;
        trackGroup.add(pillar);
        if (sup.mode === 'outrigger') {
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
        const vane = new THREE.BoxGeometry(2.6, SPEC.railHeight - 2, 62);
        vane.translate(0, 0, 31); // hinge at one end
        const paddle = new THREE.Mesh(vane, MAT.gate);
        const yaw = sw.gate === 'branch' ? pin.yawDiverting : pin.yawParked;
        paddle.position.set(pin.x, pin.deckY + SPEC.railHeight / 2, pin.z);
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
    saveState();
}

function refreshSelectionHighlight() {
    const issues = issueSet();
    pieceMeshes.forEach((m, i) => {
        if (!m || m.userData.pieceIndex !== i) return; // branch alias
        const pc = state.layout.pieces[i];
        const base = materialFor(pc, issues.has(i));
        if (i === state.selected || (pc.switchKey && pieceIsSelectedSwitch(pc))) {
            m.material = base.clone();
            m.material.emissive = new THREE.Color(0x553300);
        } else {
            m.material = base;
        }
    });
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

function activeContainer() {
    return getContainer(state.sequence, JSON.parse(state.activeEndKey));
}

for (const btn of document.querySelectorAll('[data-add]')) {
    btn.addEventListener('click', () => {
        recordEdit();
        activeContainer().push(btn.dataset.add);
        state.selected = -1;
        rebuild();
    });
    btn.addEventListener('mouseenter', () => showGhostFor(btn.dataset.add));
    btn.addEventListener('mouseleave', clearGhost);
}
for (const btn of document.querySelectorAll('[data-switch]')) {
    btn.addEventListener('click', () => {
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
        const c = activeContainer();
        const t = btn.dataset.spiral === 'L' ? 'curveL' : 'curveR';
        c.push(t, t, t, t);
        state.selected = -1;
        rebuild();
    });
}
$('btn-undo').addEventListener('click', doUndo);
$('btn-redo').addEventListener('click', doRedo);
$('btn-clear').addEventListener('click', () => {
    recordEdit();
    state.sequence = []; state.scenery = [];
    state.selected = -1; state.selectedScenery = -1; state.activeEndKey = '[]';
    rebuild();
});
$('btn-demo').addEventListener('click', () => {
    recordEdit();
    state.sequence = [...DEMO]; state.selected = -1; state.activeEndKey = '[]';
    state.loop = false;
    rebuild(); fitView();
});
$('btn-loop').addEventListener('click', () => {
    recordEdit();
    state.loop = !state.loop;
    state.selected = -1;
    syncControls();
    rebuild();
    toast(state.loop
        ? '🔁 Loop mode — the ring must return to its start; lifts pay back the descent (watch the footer for closure hints)'
        : 'Loop mode off — open ends get corrals again');
});

/** RCT ghost preview: hypothetical next piece rendered translucent. */
function showGhostFor(type) {
    clearGhost();
    try {
        const clone = JSON.parse(JSON.stringify(state.sequence));
        const c = getContainer(clone, JSON.parse(state.activeEndKey));
        c.push(type);
        const { pieces } = layoutTrack(clone, {
            slopeDeg: state.slopeDeg, innerWidth: state.innerWidth, curveRadius: state.curveRadius
        });
        const addr = pathKey([...JSON.parse(state.activeEndKey), c.length - 1]);
        const pc = pieces.find(p => pathKey(p.address ?? []) === addr);
        if (pc) {
            const m = new THREE.Mesh(buildPieceDisplayGeometry(pc), MAT.ghost);
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
        rebuild();
        fitView();
        toast(`📂 Loaded "${state.name}"`);
    } catch (err) {
        toast(`Could not load design: ${err.message}`);
    }
    e.target.value = '';
});
const scenePicker = $('scene-picker');
{
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '📚 Example scenes…';
    scenePicker.appendChild(opt);
    for (const n of ['01-first-ramp', '02-demo-tower', '03-grand-helix', '04-s-curve-meadow',
        '05-slippery-slide', '06-too-shallow-stall', '07-cliffhanger-tumble', '08-tight-radius-jam',
        '09-switchyard', '10-lift-and-return', '11-palm-resort', '12-perpetual-motion', '13-grand-circuit']) {
        const o = document.createElement('option');
        o.value = n; o.textContent = n.replace(/^\d+-/, '').replace(/-/g, ' ');
        scenePicker.appendChild(o);
    }
}
scenePicker.addEventListener('change', async () => {
    if (!scenePicker.value) return;
    try {
        const res = await fetch(`./scenes/${scenePicker.value}.json`);
        const json = await res.json();
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
    scenePicker.value = '';
});

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
bindSlider('in-slope', 'out-slope', 'slopeDeg', v => `${v}°`);
bindSlider('in-width', 'out-width', 'innerWidth', v => `${v} mm`);
bindSlider('in-radius', 'out-radius', 'curveRadius', v => `${v} mm`);
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

const styleSel = $('in-style');
styleSel.addEventListener('change', () => {
    recordEdit();
    state.figureStyle = styleSel.value;
    rebuild();
    if (sim.running) { stopSim(); startSim(); } // swap the ridden figure live
    toast(state.figureStyle === 'knight' ? '⚔️ Mike the Knight saddles up' : '🐴 Classic pony selected');
});

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
    total += printedWeightG(figureVolumeEstimate(state.innerWidth - 4, state.figureStyle), 'figure') + 12; // figure + pendulum/keys/plugs
    return total;
}

function refreshPieceList() {
    const ul = $('piece-list');
    ul.innerHTML = '';
    const issues = issueSet();
    const weights = pieceWeightsG();
    state.layout.pieces.forEach((piece, i) => {
        if (piece.role === 'branch') return; // listed with its switch
        const li = document.createElement('li');
        if (i === state.selected) li.classList.add('selected');
        const depth = (piece.address ?? []).filter(a => typeof a === 'string').length;
        li.style.paddingLeft = `${6 + depth * 14}px`;
        const icon = {
            start: '🏁', end: '🎪', straight: '⬆', curveL: '⟲', curveR: '⟳',
            lift: '⛓', switchMain: '⑂'
        }[piece.type] ?? '·';
        const label = piece.type === 'switchMain'
            ? `${piece.name} (gate→${piece.gateOpen ? 'main' : 'branch'})`
            : piece.name;
        const g = weights.get(i);
        li.innerHTML = `<span>${icon}</span><span>${label}</span>` +
            (issues.has(i) ? '<span class="flag" title="clearance conflict">⚠️</span>' : '') +
            (piece.active ? '' : '<span class="flag" title="not on the current ride path">◌</span>') +
            (g ? `<span class="wt" title="estimated printed weight (PLA, project print settings)">≈${g.toFixed(0)} g</span>` : '');
        li.addEventListener('click', () => selectPiece(i));
        ul.appendChild(li);
    });
    // print-job footer: whole-build filament estimate
    const total = printJobTotalG(weights);
    const spoolPct = (total / 1000) * 100;
    $('parts-heading').innerHTML =
        `Parts list <span class="wt">· print job ≈ ${total >= 1000 ? (total / 1000).toFixed(2) + ' kg' : total.toFixed(0) + ' g'} PLA ` +
        `(${spoolPct.toFixed(0)}% of a 1 kg spool, ≈$${(total / 1000 * 20).toFixed(2)} filament)</span>`;
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
            <b>⑂ ${pc.switchType === 'switchL' ? 'Left' : 'Right'} switch</b><br>
            <span style="color:var(--ink-2)">gate feeds the <b>${node.gate}</b> route</span>
            <div class="btn-grid" style="margin-top:8px">
                <button id="ed-gate">⇄ Flip gate</button>
                <button id="ed-del" style="color:var(--critical)">🗑 Remove</button>
            </div>
            <div style="color:var(--ink-2);margin-top:6px;font-size:11.5px">
                Removing keeps the main route's pieces; the branch is discarded.</div>`;
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
    const types = [['straight', '⬆ Straight'], ['curveL', '⟲ Left'], ['curveR', '⟳ Right'], ['lift', '⛓ Lift']];
    card.innerHTML = `
        <b>Edit ${pc.name}</b>
        <div class="btn-grid" style="margin-top:8px">
            ${types.map(([t, l]) =>
                `<button data-ed-type="${t}" ${t === node ? 'disabled' : ''}>${l}</button>`).join('')}
            <button id="ed-ins">＋ Insert straight before</button>
            <button id="ed-del" style="color:var(--critical)">🗑 Delete</button>
        </div>
        <div style="color:var(--ink-2);margin-top:6px;font-size:11.5px">
            Changes re-lay the downstream track automatically (Auto-Z).</div>`;
    for (const b of card.querySelectorAll('[data-ed-type]')) {
        b.onclick = () => {
            recordEdit();
            const container = getContainer(state.sequence, pc.address.slice(0, -1));
            container[pc.address[pc.address.length - 1]] = b.dataset.edType;
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

renderer.domElement.addEventListener('pointermove', (e) => {
    if (placementKind && ghostScenery) {
        const pt = groundPointAt(e);
        if (pt) ghostScenery.position.set(pt.x, 0, pt.z);
    }
    if (draggingScenery >= 0) {
        const pt = groundPointAt(e);
        if (pt) {
            state.scenery[draggingScenery].x = Math.round(pt.x);
            state.scenery[draggingScenery].z = Math.round(pt.z);
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
            state.scenery.push({ kind: placementKind, x: Math.round(pt.x), z: Math.round(pt.z), rot: 0 });
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
        const hits = raycaster.intersectObjects(pieceMeshes.filter(Boolean), false);
        if (hits.length) {
            const idx = hits[0].object.userData.pieceIndex;
            const pc = state.layout.pieces[idx];
            if (pc.switchKey && state.selected === idx) {
                toggleGate(pc.address); // second click on a selected switch flips it
            } else {
                selectPiece(idx);
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
        if (gallery.open) { closeGallery(); return; }
        cancelPlacement();
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
        <div class="fix"><b>Cause:</b> ${cause}<br><b>Fix:</b> ${fix}</div>
    </details>`).join('');

function refreshFooter() {
    const { pieces, issues, totalDropMm } = state.layout;
    $('ft-pieces').textContent = `${pieces.length} pieces`;
    $('ft-drop').textContent = `ride drop ${totalDropMm.toFixed(0)} mm`;
    const rideLen = resolveRidePath(pieces).reduce((s, p) => s + p.planLen, 0);
    $('ft-run').textContent = `ride ${rideLen.toFixed(0)} mm`;
    const errs = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    $('ft-issues').textContent = errs.length
        ? `⛔ ${errs[0].msg}`
        : warns.length ? `⚠️ ${warns[0].msg}` : '✅ layout OK';
}

// tabs
const TABS = ['physics', 'export', 'refs'];
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => setTab(t));
function setTab(t) {
    for (const k of TABS) {
        $(`pane-${k}`).style.display = k === t ? '' : 'none';
        $(`tab-${k}`).classList.toggle('active', k === t);
    }
}

// ---------------------------------------------------------------------------
// Klip-klop audio
// ---------------------------------------------------------------------------

let audioCtx = null;
function clack(freq) {
    if (!state.soundOn && !film.active) return;
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
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

// ---------------------------------------------------------------------------
// Simulation (replays the verified simulateRun trace)
// ---------------------------------------------------------------------------

const sim = { running: false, t: 0, phase: 0, horse: null, run: null, sampler: null, cursor: 0 };

function buildHorse() {
    // RCT3-style ghost test figure: semi-transparent body so the swinging
    // rear-leg pendulum — the actual engine of the gait — stays visible.
    const group = new THREE.Group();
    const pivot = new THREE.Group();
    group.add(pivot);
    const bodyMat = new THREE.MeshLambertMaterial({
        color: state.figureStyle === 'knight' ? 0xc68642 : 0xf5f0e8,
        transparent: true, opacity: 0.5, depthWrite: false
    });
    const body = new THREE.Mesh(toBufferGeometry(extrudeOutlineX(bodySideOutline(state.figureStyle), -(state.innerWidth - 4) / 2, (state.innerWidth - 4) / 2)), bodyMat);
    body.castShadow = true;
    body.renderOrder = 2;
    pivot.add(body);
    const pendMat = new THREE.MeshLambertMaterial({ color: 0xc0392b }); // pendulum pops through the ghost body
    const pend = new THREE.Mesh(toBufferGeometry(extrudeOutlineX(
        pendulumSideOutline().map(([z, y]) => [z - FIGURE.axle.z, y - FIGURE.axle.y]),
        -FIGURE.pendulumW / 2, FIGURE.pendulumW / 2)), pendMat);
    pend.castShadow = true;
    pend.position.set(0, FIGURE.axle.y, FIGURE.axle.z);
    pivot.add(pend);
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
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
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

$('btn-run').addEventListener('click', startSim);
$('btn-stop').addEventListener('click', stopSim);
$('btn-record').addEventListener('click', startFilm);

function startSim() {
    stopSim();
    const ridePath = resolveRidePath(state.layout.pieces);
    if (ridePath.length < 3) { toast('Add at least one ramp piece first.'); return; }
    sim.run = simulateRun(ridePath, {
        ...physOpts(),
        liftSpeedMmS: SPEC.liftSpeedMmS,
        loop: state.loop,
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
    sim.running = true;
    if (sim.run.events.some(e => e.type === 'mode' && e.detail.includes('slide'))) {
        toast('⛸ Hooves lose grip somewhere on this ride — watch it ski (see Physics lab)');
    }
    $('btn-run').disabled = true;
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
    if (sim.horse) { scene.remove(sim.horse); sim.horse = null; }
    $('sim-hud').style.display = 'none';
    $('btn-run').disabled = false;
    $('btn-stop').disabled = true;
}

/** Live telemetry: the numbers the physics engine is actually producing. */
const MODE_LABEL = { walk: '🐴 WALK', slide: '⛸ SLIDE', lift: '⛓ LIFT' };
function refreshHud(s) {
    const a = sim.run.assess[s.pieceIndex];
    const lap = state.loop ? sim.run.events.filter(e => e.type === 'lap' && e.t <= sim.t).length + 1 : null;
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
        sim.horse.userData.pend.rotation.x = -state.walker.alphaDeg * Math.PI / 180 * cur;
        if (Math.sign(cur) !== Math.sign(prev) && Math.sign(cur) !== 0) {
            const front = Math.sign(cur) > 0;
            clack(front ? 1900 : 1300);
            dropStrikeMarker(front);
        }
    } else if (s.mode === 'lift') {
        sim.phase += dt;
        sim.horse.userData.pivot.rotation.x = 0.03 * Math.sin(8 * sim.phase); // conveyor judder
        if (Math.floor(sim.phase * 3) !== Math.floor((sim.phase - dt) * 3)) clack(700); // chain clank
    } else {
        sim.horse.userData.pivot.rotation.x *= 0.9;
        sim.horse.userData.pend.rotation.x *= 0.9;
    }
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
    let joints = 0;
    for (const pc of pieces) {
        if (!pc.isImplicitStart && pc.role !== 'branch') joints++;
        if (pc.role === 'branch') continue;
        const support = (state.supports ?? []).find(s => s.pieceIndex === pc.index);
        if (pc.role === 'main') {
            const pair = switchPairs.get(pc.switchKey);
            parts.push({ name: pc.name.replace('switchMain', 'switch'), note: note.switch, build: () => buildSwitchExportGeometry(pair.main, pair.branch, { support }) });
        } else {
            parts.push({ name: pc.name, note: note.piece, build: () => buildPieceExportGeometry(pc, { support }) });
        }
    }
    if (switchPairs.size) {
        parts.push({ name: `gate_paddle_print_${switchPairs.size}x`, note: note.gate, build: () => buildGateGeometry() });
    }
    parts.push({ name: `connector_key_print_${joints}x`, note: note.key, build: () => buildKeyGeometry() });

    for (const sup of state.supports ?? []) {
        if (sup.mode === 'none') continue;
        const pc = pieces[sup.pieceIndex];
        parts.push({ name: `pillar_${pc.name}_h${pc.rimY.toFixed(0)}`, note: note.pillar, build: () => toArraysFromBG(buildPillarGeometry(pc.rimY)) });
    }

    const kinds = [...new Set(state.scenery.map(s => s.kind))];
    for (const kind of kinds) {
        const count = state.scenery.filter(s => s.kind === kind).length;
        if (kind === 'tower') parts.push({ name: `scenery_tower_print_${count}x`, note: note.scenery, build: () => buildTowerGeometry(100) });
        if (kind === 'patio') parts.push({ name: `scenery_patio_print_${count}x`, note: note.scenery, build: () => buildPatioGeometry() });
        if (kind === 'palm') {
            parts.push({ name: `scenery_palm_island_print_${count}x`, note: note.scenery, build: () => buildPalmIslandGeometries().island });
            parts.push({ name: `scenery_palm_tree_print_${count}x_crown_down`, note: note.scenery, build: () => rotFlip(buildPalmIslandGeometries().palm) });
        }
    }

    const figOpts = { style: state.figureStyle };
    parts.push({ name: `figure_body_${state.figureStyle}_print_on_side`, note: note.figure, build: () => rotForSide(buildFigureGeometries(state.innerWidth, figOpts).body) });
    parts.push({ name: 'figure_pendulum_print_on_side', note: note.figure, build: () => rotForSide(buildFigureGeometries(state.innerWidth, figOpts).pendulum) });
    parts.push({ name: 'figure_plugs', note: 'Choke-hazard covers — glue every one at assembly.', build: () => buildFigureGeometries(state.innerWidth, figOpts).plugSet });

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
    const holder = $('parts-view');
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

    $('parts-shading').addEventListener('change', () => { gallery.style = $('parts-shading').value; applyGalleryStyle(); });
    $('parts-wire').addEventListener('change', () => { gallery.showWire = $('parts-wire').checked; applyGalleryStyle(); });
    $('parts-dims').addEventListener('change', () => { gallery.showDims = $('parts-dims').checked; applyGalleryStyle(); });
}

/** Engineering-style dimension lines (L/W/H in mm) around the part's bbox. */
function makeDimGroup(box) {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x9ec5ff });
    const size = box.getSize(new THREE.Vector3());
    const off = Math.max(14, size.length() * 0.05);
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
        const s = Math.max(30, size.length() * 0.14);
        sp.scale.set(s, s / 4, 1);
        g.add(sp);
    };
    const { min, max } = box;
    const tick = off * 0.25;
    // X (length) along the front-bottom edge
    mkLine(new THREE.Vector3(min.x, min.y, max.z + off), new THREE.Vector3(max.x, min.y, max.z + off));
    mkLine(new THREE.Vector3(min.x, min.y, max.z + off - tick), new THREE.Vector3(min.x, min.y, max.z + off + tick));
    mkLine(new THREE.Vector3(max.x, min.y, max.z + off - tick), new THREE.Vector3(max.x, min.y, max.z + off + tick));
    mkLabel(`${size.x.toFixed(1)} mm`, new THREE.Vector3((min.x + max.x) / 2, min.y + off * 0.4, max.z + off * 1.6));
    // Z (depth) along the right-bottom edge
    mkLine(new THREE.Vector3(max.x + off, min.y, min.z), new THREE.Vector3(max.x + off, min.y, max.z));
    mkLine(new THREE.Vector3(max.x + off - tick, min.y, min.z), new THREE.Vector3(max.x + off + tick, min.y, min.z));
    mkLine(new THREE.Vector3(max.x + off - tick, min.y, max.z), new THREE.Vector3(max.x + off + tick, min.y, max.z));
    mkLabel(`${size.z.toFixed(1)} mm`, new THREE.Vector3(max.x + off * 1.6, min.y + off * 0.4, (min.z + max.z) / 2));
    // Y (height) up the front-right corner
    mkLine(new THREE.Vector3(max.x + off, min.y, max.z + off), new THREE.Vector3(max.x + off, max.y, max.z + off));
    mkLine(new THREE.Vector3(max.x + off - tick, min.y, max.z + off), new THREE.Vector3(max.x + off + tick, min.y, max.z + off));
    mkLine(new THREE.Vector3(max.x + off - tick, max.y, max.z + off), new THREE.Vector3(max.x + off + tick, max.y, max.z + off));
    mkLabel(`${size.y.toFixed(1)} mm`, new THREE.Vector3(max.x + off * 1.4, (min.y + max.y) / 2 + off * 0.5, max.z + off * 1.4));
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
            new THREE.LineBasicMaterial({ color: 0x120f0a, transparent: true, opacity: 0.32 })
        );
        gallery.scene.add(gallery.wire);
    }
    if (gallery.showDims) {
        gallery.dims = makeDimGroup(new THREE.Box3().setFromObject(gallery.mesh));
        gallery.scene.add(gallery.dims);
    }
}

function galleryResize() {
    const holder = $('parts-view');
    const w = holder.clientWidth, h = holder.clientHeight;
    gallery.renderer.setSize(w, h);
    gallery.camera.aspect = w / h;
    gallery.camera.updateProjectionMatrix();
}

function openGallery() {
    $('parts-overlay').style.display = '';
    initGallery();
    galleryResize();
    gallery.parts = assembleParts().parts;
    $('parts-count').textContent = `${gallery.parts.length} unique parts in this design`;
    const list = $('parts-list');
    list.innerHTML = '';
    gallery.parts.forEach((part, i) => {
        const li = document.createElement('li');
        li.textContent = part.name;
        li.addEventListener('click', () => selectGalleryPart(i));
        list.appendChild(li);
    });
    gallery.open = true;
    selectGalleryPart(0);
}

function closeGallery() {
    gallery.open = false;
    $('parts-overlay').style.display = 'none';
}

function selectGalleryPart(i) {
    const part = gallery.parts[i];
    if (!part) return;
    [...$('parts-list').children].forEach((li, k) => li.classList.toggle('selected', k === i));
    $('parts-caption').innerHTML = '⏳ building export geometry…';
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
        const cat = /^pillar/.test(part.name) ? 'pillar'
            : /^scenery/.test(part.name) ? 'scenery'
            : /^figure_body|^figure_pend/.test(part.name) ? 'figure'
            : /^connector|^gate|plugs/.test(part.name) ? 'small' : 'track';
        $('parts-caption').innerHTML =
            `<b>${part.name}</b> · ${(report.volumeMm3 / 1000).toFixed(1)} cm³ · ≈${printedWeightG(report.volumeMm3, cat).toFixed(0)} g printed · ` +
            `${report.isManifold && report.isConsistent && report.windsOutward
                ? '<span class="ok">✔ watertight</span>' : '<span class="bad">✖ CHECK</span>'}<br>` +
            `<span style="opacity:.8">${part.note ?? ''} Auto-rotating — drag to inspect the interlocks.</span>`;
    }, 30);
}

$('btn-parts').addEventListener('click', openGallery);
$('parts-close').addEventListener('click', closeGallery);
window.addEventListener('resize', () => { if (gallery.renderer) galleryResize(); });

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
            log.innerHTML += `<div class="row"><span>${part.name}</span>` +
                `<span>${(report.volumeMm3 / 1000).toFixed(1)} cm³ <span class="${ok ? 'ok' : 'bad'}">${ok ? '✔ watertight' : '✖ CHECK'}</span></span></div>`;
            if (format === 'stl') {
                files[`${part.name}.stl`] = new Uint8Array(generateBinarySTL(mesh.positions, mesh.indices));
            } else {
                const xml = generate3MFXML(mesh.positions, mesh.indices);
                files[`${part.name}.3mf`] = fflate.zipSync({
                    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
                    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
                    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
                });
            }
            prog.value = (i + 1) / parts.length;
        }

        files['README.txt'] = fflate.strToU8(exportReadme(joints, switchPairs.size));
        const zipped = fflate.zipSync(files);
        const blob = new Blob([zipped], { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `klipklop_track_${state.slopeDeg}deg_${parts.length}parts_${format}.zip`;
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

let last = performance.now();
function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (sim.running) tickSim(dt);
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
}

function syncControls() {
    $('in-slope').value = state.slopeDeg; $('out-slope').textContent = `${state.slopeDeg}°`;
    $('in-width').value = state.innerWidth; $('out-width').textContent = `${state.innerWidth} mm`;
    $('in-radius').value = state.curveRadius; $('out-radius').textContent = `${state.curveRadius} mm`;
    $('in-eff').value = state.walker.efficiency; $('out-eff').textContent = state.walker.efficiency.toFixed(2);
    $('in-alpha').value = state.walker.alphaDeg; $('out-alpha').textContent = `${state.walker.alphaDeg}°`;
    $('in-leg').value = state.walker.legLenMm; $('out-leg').textContent = `${state.walker.legLenMm} mm`;
    $('in-mass').value = state.walker.massG; $('out-mass').textContent = `${state.walker.massG} g`;
    muSel.value = state.muKey;
    $('btn-loop').textContent = state.loop ? '🔁 Loop mode: ON' : '🔁 Loop mode: off';
    $('btn-loop').classList.toggle('primary', state.loop);
    $('in-style').value = state.figureStyle;
}

(async () => {
    await initCSG(); // switch display meshes and scenery need booleans
    await loadState();
    syncControls();
    rebuild();
    resize();
    fitView();
    requestAnimationFrame(animate);
})();
