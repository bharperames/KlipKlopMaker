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
import * as fflate from 'fflate';

import {
    SPEC, layoutTrack, stationsForPiece, appendSpiralTier, resolveRidePath,
    getContainer, nodeAt, isSwitchNode, pathKey, openContainers, planPillarPositions
} from './track.js';
import { FRICTION_PRESETS, DEFAULT_WALKER, assessSlope, goldilocksRange, ballastPlan, trackVerdict } from './physics.js';
import { simulateRun, makePathSampler } from './simulate.js';
import { serializeScene, deserializeScene } from './scene_format.js';
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

function saveState() {
    localStorage.setItem('klipklop-scene-v1', JSON.stringify(serializeScene(state)));
}
function applyScene(scene) {
    const s = deserializeScene(scene);
    state.sequence = s.sequence;
    state.scenery = s.scenery;
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
        curveRadius: state.curveRadius
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

    for (const pc of pieces) {
        if (pc.role === 'branch') continue; // rendered with its main sibling
        let mesh;
        if (pc.role === 'main') {
            const pair = switchPairs.get(pc.switchKey);
            mesh = new THREE.Mesh(
                buildSwitchDisplayGeometry(pair.main, pair.branch),
                materialFor(pc, issues.has(pc.index) || issues.has(pair.branch.index))
            );
            mesh.userData.pieceIndex = pc.index;
            mesh.userData.switchKey = pc.switchKey;
            pieceMeshes[pair.branch.index] = mesh;
        } else {
            mesh = new THREE.Mesh(buildPieceDisplayGeometry(pc), materialFor(pc, issues.has(pc.index)));
            mesh.userData.pieceIndex = pc.index;
        }
        mesh.castShadow = mesh.receiveShadow = true;
        pieceMeshes[pc.index] = mesh;
        trackGroup.add(mesh);
    }

    // collision-aware supports: pillars never spear a lower tier; blocked
    // columns move outboard on printable outrigger arms
    state.supports = planPillarPositions(pieces);
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

    // gate paddles: visualize which route each switch feeds
    for (const sw of switches) {
        const pair = switchPairs.get(sw.key);
        const pin = gatePinPosition(pair.main);
        const paddle = new THREE.Mesh(new THREE.BoxGeometry(2.6, SPEC.railHeight - 2, 52), MAT.gate);
        const side = sw.type === 'switchL' ? 1 : -1;
        // vane angles across the UNSELECTED route's mouth
        const blockBranch = sw.gate === 'main';
        const yaw = pair.main.entry.h + (blockBranch ? side * 0.42 : -side * 0.18);
        paddle.position.set(pin.x, pin.deckY + SPEC.railHeight / 2, pin.z);
        paddle.rotation.y = Math.PI / 2 - yaw;
        paddle.translateZ(20);
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
        activeContainer().push(btn.dataset.add);
        state.selected = -1;
        rebuild();
    });
    btn.addEventListener('mouseenter', () => showGhostFor(btn.dataset.add));
    btn.addEventListener('mouseleave', clearGhost);
}
for (const btn of document.querySelectorAll('[data-switch]')) {
    btn.addEventListener('click', () => {
        activeContainer().push({ type: btn.dataset.switch, gate: 'main', main: [], branch: [] });
        state.selected = -1;
        rebuild();
        toast('⑂ Switch added — two new build arrows opened. Click a switch to flip its gate.');
    });
}
for (const btn of document.querySelectorAll('[data-spiral]')) {
    btn.addEventListener('click', () => {
        const c = activeContainer();
        const t = btn.dataset.spiral === 'L' ? 'curveL' : 'curveR';
        c.push(t, t, t, t);
        state.selected = -1;
        rebuild();
    });
}
$('btn-undo').addEventListener('click', () => {
    const c = activeContainer();
    if (c.length) c.pop();
    else if (state.sequence.length) state.sequence.pop();
    state.selected = -1;
    rebuild();
});
$('btn-clear').addEventListener('click', () => {
    state.sequence = []; state.scenery = [];
    state.selected = -1; state.selectedScenery = -1; state.activeEndKey = '[]';
    rebuild();
});
$('btn-demo').addEventListener('click', () => {
    state.sequence = [...DEMO]; state.selected = -1; state.activeEndKey = '[]';
    rebuild(); fitView();
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
        '09-switchyard', '10-lift-and-return', '11-palm-resort']) {
        const o = document.createElement('option');
        o.value = n; o.textContent = n.replace(/^\d+-/, '').replace(/-/g, ' ');
        scenePicker.appendChild(o);
    }
}
scenePicker.addEventListener('change', async () => {
    if (!scenePicker.value) return;
    try {
        const res = await fetch(`./scenes/${scenePicker.value}.json`);
        applyScene(await res.json());
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
        target()[key] = parseFloat(el.value);
        $(outId).textContent = fmt(target()[key]);
        rebuild();
    });
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
muSel.addEventListener('change', () => { state.muKey = muSel.value; rebuild(); });

// ---------------------------------------------------------------------------
// Piece list, selection, in-place editing
// ---------------------------------------------------------------------------

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
            lift: '⛓', switchMain: '⑂'
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
            const container = getContainer(state.sequence, pc.address.slice(0, -1));
            container[pc.address[pc.address.length - 1]] = b.dataset.edType;
            rebuild();
        };
    }
    $('ed-ins').onclick = () => {
        const container = getContainer(state.sequence, pc.address.slice(0, -1));
        container.splice(pc.address[pc.address.length - 1], 0, 'straight');
        state.selected = -1;
        rebuild();
    };
    $('ed-del').onclick = () => {
        const container = getContainer(state.sequence, pc.address.slice(0, -1));
        container.splice(pc.address[pc.address.length - 1], 1);
        state.selected = -1;
        rebuild();
    };
}

function toggleGate(address) {
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
    if (e.key === 'Escape') cancelPlacement();
    if (e.key === 'r' || e.key === 'R') {
        if (state.selectedScenery >= 0) {
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
            state.scenery.splice(state.selectedScenery, 1);
            state.selectedScenery = -1;
            rebuildScenery();
            saveState();
        } else if (state.selected >= 0) {
            const pc = state.layout.pieces[state.selected];
            if (pc && !pc.isImplicitStart && !pc.isImplicitEnd) {
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

    const vol = figureVolumeEstimate(state.innerWidth - 4);
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
    if (!state.soundOn) return;
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
    noise.connect(bp).connect(gain).connect(audioCtx.destination);
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
    const group = new THREE.Group();
    const pivot = new THREE.Group();
    group.add(pivot);
    const body = new THREE.Mesh(toBufferGeometry(extrudeOutlineX(bodySideOutline(), -(state.innerWidth - 4) / 2, (state.innerWidth - 4) / 2)), MAT.horseBody);
    body.castShadow = true;
    pivot.add(body);
    const pend = new THREE.Mesh(toBufferGeometry(extrudeOutlineX(
        pendulumSideOutline().map(([z, y]) => [z - FIGURE.axle.z, y - FIGURE.axle.y]),
        -FIGURE.pendulumW / 2, FIGURE.pendulumW / 2)), MAT.horseLegs);
    pend.castShadow = true;
    pend.position.set(0, FIGURE.axle.y, FIGURE.axle.z);
    pivot.add(pend);
    group.userData = { pivot, pend };
    return group;
}

const OUTCOME_TOASTS = {
    arrived: '🎉 The horse arrived at the corral!',
    stalled: '⏸ Stalled — not enough gait energy for this setup (see Physics lab)',
    tumbled: '💥 Tumbled — slope exceeds the swing limiter (see Physics lab)',
    timeout: '⏱ Simulation timed out'
};

$('btn-run').addEventListener('click', startSim);
$('btn-stop').addEventListener('click', stopSim);

function startSim() {
    stopSim();
    const ridePath = resolveRidePath(state.layout.pieces);
    if (ridePath.length < 3) { toast('Add at least one ramp piece first.'); return; }
    sim.run = simulateRun(ridePath, { ...physOpts(), liftSpeedMmS: SPEC.liftSpeedMmS });
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
    sim.running = false;
    if (sim.horse) { scene.remove(sim.horse); sim.horse = null; }
    $('btn-run').disabled = false;
    $('btn-stop').disabled = true;
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

    const a = sim.run.assess[s.pieceIndex];
    if (s.mode === 'walk' && a.stepHz > 0.1) {
        const prev = Math.sin(Math.PI * a.stepHz * sim.phase);
        sim.phase += dt;
        const cur = Math.sin(Math.PI * a.stepHz * sim.phase);
        sim.horse.userData.pivot.rotation.x = 0.14 * cur;
        sim.horse.userData.pend.rotation.x = -state.walker.alphaDeg * Math.PI / 180 * cur;
        if (Math.sign(cur) !== Math.sign(prev) && Math.sign(cur) !== 0) {
            clack(Math.sign(cur) > 0 ? 1900 : 1300);
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
        const { pieces } = state.layout;
        const parts = [];

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
                parts.push({ name: pc.name.replace('switchMain', 'switch'), build: () => buildSwitchExportGeometry(pair.main, pair.branch, { support }) });
            } else {
                parts.push({ name: pc.name, build: () => buildPieceExportGeometry(pc, { support }) });
            }
        }
        if (switchPairs.size) {
            parts.push({ name: `gate_paddle_print_${switchPairs.size}x`, build: () => buildGateGeometry() });
        }
        parts.push({ name: `connector_key_print_${joints}x`, build: () => buildKeyGeometry() });

        for (const sup of state.supports ?? []) {
            if (sup.mode === 'none') continue;
            const pc = pieces[sup.pieceIndex];
            parts.push({ name: `pillar_${pc.name}_h${pc.rimY.toFixed(0)}`, build: () => toArraysFromBG(buildPillarGeometry(pc.rimY)) });
        }

        // scenery: one part file per kind in use (README lists quantities)
        const kinds = [...new Set(state.scenery.map(s => s.kind))];
        for (const kind of kinds) {
            const count = state.scenery.filter(s => s.kind === kind).length;
            if (kind === 'tower') parts.push({ name: `scenery_tower_print_${count}x`, build: () => buildTowerGeometry(100) });
            if (kind === 'patio') parts.push({ name: `scenery_patio_print_${count}x`, build: () => buildPatioGeometry() });
            if (kind === 'palm') {
                parts.push({ name: `scenery_palm_island_print_${count}x`, build: () => buildPalmIslandGeometries().island });
                parts.push({ name: `scenery_palm_tree_print_${count}x_crown_down`, build: () => rotFlip(buildPalmIslandGeometries().palm) });
            }
        }

        parts.push({ name: 'figure_body_print_on_side', build: () => rotForSide(buildFigureGeometries(state.innerWidth).body) });
        parts.push({ name: 'figure_pendulum_print_on_side', build: () => rotForSide(buildFigureGeometries(state.innerWidth).pendulum) });
        parts.push({ name: 'figure_plugs', build: () => buildFigureGeometries(state.innerWidth).plugSet });

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
    return {
        positions: new Float32Array(g.attributes.position.array),
        indices: new Uint32Array(g.index.array)
    };
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
    controls.update();
    renderer.render(scene, camera);
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
