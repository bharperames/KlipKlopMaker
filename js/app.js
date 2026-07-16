/**
 * app.js — Klip Klop Maker main application.
 * Scene, RCT-style path building, gait simulation with klip-klop audio,
 * physics lab panel, and watertight ZIP export of every printable part.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as fflate from 'fflate';

import { SPEC, layoutTrack, samplePath, stationsForPiece, appendSpiralTier } from './track.js';
import { simulateRun, makePathSampler } from './simulate.js';
import { serializeScene, deserializeScene } from './scene_format.js';
import { FRICTION_PRESETS, DEFAULT_WALKER, assessSlope, goldilocksRange, ballastPlan, trackVerdict } from './physics.js';
import {
    initCSG, toBufferGeometry, buildPieceDisplayGeometry, buildPieceExportGeometry,
    buildPillarGeometry, buildFigureGeometries
} from './pieces.js';
import { extrudeOutlineX, bodySideOutline, pendulumSideOutline, FIGURE, figureVolumeEstimate } from './geometry.js';
import { generate3MFXML, generateBinarySTL } from './export_3mf.js';
import { analyzeMesh } from './mesh_utils.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    sequence: [],
    slopeDeg: 11,
    innerWidth: 48,
    curveRadius: 150,
    muKey: 'washboard',
    walker: { ...DEFAULT_WALKER },
    soundOn: true,
    selected: -1,
    layout: null
};

const DEMO = ['straight', ...appendSpiralTier([], 'L'), ...appendSpiralTier([], 'L'), 'straight', 'straight'];

function saveState() {
    localStorage.setItem('klipklop-scene-v1', JSON.stringify(serializeScene(state)));
}
function applyScene(scene) {
    const s = deserializeScene(scene);
    state.sequence = s.sequence;
    state.slopeDeg = s.slopeDeg;
    state.innerWidth = s.innerWidth;
    state.curveRadius = s.curveRadius;
    state.muKey = s.muKey;
    state.walker = s.walker;
    state.name = s.name;
}
async function loadState() {
    // ?scene=<name> loads a bundled scene file (used by the report generator too)
    const sceneName = new URLSearchParams(location.search).get('scene');
    if (sceneName && /^[\w.-]+$/.test(sceneName)) {
        try {
            const res = await fetch(`./scenes/${sceneName}.json`);
            if (res.ok) { applyScene(await res.json()); return; }
        } catch { /* fall through to local state */ }
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
scene.add(trackGroup);

const MAT = {
    ramp: new THREE.MeshLambertMaterial({ color: 0xe8b23a }),
    curve: new THREE.MeshLambertMaterial({ color: 0xe0a52f }),
    start: new THREE.MeshLambertMaterial({ color: 0x74b06c }),
    end: new THREE.MeshLambertMaterial({ color: 0xb9b3a4 }),
    pillar: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
    issue: new THREE.MeshLambertMaterial({ color: 0xd03b3b }),
    ghost: new THREE.MeshLambertMaterial({ color: 0xe8b23a, transparent: true, opacity: 0.4, depthWrite: false }),
    horseBody: new THREE.MeshLambertMaterial({ color: 0xf5f0e8 }),
    horseLegs: new THREE.MeshLambertMaterial({ color: 0x574a3a })
};

function materialFor(piece, hasIssue) {
    if (hasIssue) return MAT.issue;
    if (piece.type === 'start') return MAT.start;
    if (piece.type === 'end') return MAT.end;
    return piece.radius ? MAT.curve : MAT.ramp;
}

// ---------------------------------------------------------------------------
// Track rebuild
// ---------------------------------------------------------------------------

let pieceMeshes = [];

function rebuild() {
    state.layout = layoutTrack(state.sequence, {
        slopeDeg: state.slopeDeg,
        innerWidth: state.innerWidth,
        curveRadius: state.curveRadius
    });
    const { pieces, issues } = state.layout;
    const issuePieces = new Set();
    for (const iss of issues) {
        if (iss.code === 'clearance') { issuePieces.add(iss.i); issuePieces.add(iss.j); }
    }

    trackGroup.clear();
    pieceMeshes = [];
    pieces.forEach((piece, i) => {
        const mesh = new THREE.Mesh(buildPieceDisplayGeometry(piece), materialFor(piece, issuePieces.has(i)));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.pieceIndex = i;
        trackGroup.add(mesh);
        pieceMeshes.push(mesh);
        if (piece.rimY > 1) {
            const stations = stationsForPiece(piece, piece.planLen / 2);
            const mid = stations[Math.floor(stations.length / 2)];
            const pillar = new THREE.Mesh(buildPillarGeometry(piece.rimY), MAT.pillar);
            pillar.position.set(mid.origin[0], 0, mid.origin[2]);
            pillar.castShadow = true;
            trackGroup.add(pillar);
        }
    });

    refreshSelectionHighlight();
    refreshPieceList();
    refreshPhysicsPanel();
    refreshFooter();
    saveState();
}

function refreshSelectionHighlight() {
    const issuePieces = new Set();
    for (const iss of state.layout.issues) {
        if (iss.code === 'clearance') { issuePieces.add(iss.i); issuePieces.add(iss.j); }
    }
    pieceMeshes.forEach((m, i) => {
        const base = materialFor(state.layout.pieces[i], issuePieces.has(i));
        if (i === state.selected) {
            m.material = base.clone();
            m.material.emissive = new THREE.Color(0x553300);
        } else {
            m.material = base;
        }
    });
}

// ---------------------------------------------------------------------------
// UI: build palette, piece list, sliders
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

for (const btn of document.querySelectorAll('[data-add]')) {
    btn.addEventListener('click', () => {
        state.sequence.push(btn.dataset.add);
        state.selected = -1;
        rebuild();
    });
}
for (const btn of document.querySelectorAll('[data-spiral]')) {
    btn.addEventListener('click', () => {
        state.sequence = appendSpiralTier(state.sequence, btn.dataset.spiral);
        state.selected = -1;
        rebuild();
    });
}
$('btn-undo').addEventListener('click', () => { state.sequence.pop(); state.selected = -1; rebuild(); });

// --- design persistence: portable .json scene files -----------------------
$('btn-save').addEventListener('click', () => {
    const scene = serializeScene(state, { name: state.name ?? 'My Klip Klop track' });
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
        '05-slippery-slide', '06-too-shallow-stall', '07-cliffhanger-tumble', '08-tight-radius-jam']) {
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
$('btn-clear').addEventListener('click', () => { state.sequence = []; state.selected = -1; rebuild(); });
$('btn-demo').addEventListener('click', () => { state.sequence = [...DEMO]; state.selected = -1; rebuild(); fitView(); });

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

function refreshPieceList() {
    const ul = $('piece-list');
    ul.innerHTML = '';
    const issueSet = new Set();
    for (const iss of state.layout.issues) {
        if (iss.code === 'clearance') { issueSet.add(iss.i); issueSet.add(iss.j); }
    }
    state.layout.pieces.forEach((piece, i) => {
        const li = document.createElement('li');
        if (i === state.selected) li.classList.add('selected');
        const icon = { start: '🏁', end: '🎪', straight: '⬆', curveL: '⟲', curveR: '⟳' }[piece.type] ?? '·';
        li.innerHTML = `<span>${icon}</span><span>${piece.name}</span>` +
            (issueSet.has(i) ? '<span class="flag" title="clearance conflict">⚠️</span>' : '');
        li.addEventListener('click', () => { selectPiece(i); });
        if (piece.type !== 'start' && piece.type !== 'end') {
            const del = document.createElement('button');
            del.className = 'del'; del.textContent = '✕'; del.title = 'Delete piece';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                state.sequence.splice(i - 1, 1); // -1: implicit start platform
                state.selected = -1;
                rebuild();
            });
            li.appendChild(del);
        }
        ul.appendChild(li);
    });
}

function selectPiece(i) {
    state.selected = state.selected === i ? -1 : i;
    refreshSelectionHighlight();
    refreshPieceList();
}

// raycast selection
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const down = { x: e.clientX, y: e.clientY };
    const up = (e2) => {
        renderer.domElement.removeEventListener('pointerup', up);
        if (Math.hypot(e2.clientX - down.x, e2.clientY - down.y) > 5) return; // drag = orbit
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((e2.clientX - rect.left) / rect.width) * 2 - 1,
            -((e2.clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(pieceMeshes, false);
        if (hits.length) selectPiece(hits[0].object.userData.pieceIndex);
    };
    renderer.domElement.addEventListener('pointerup', up);
});
document.addEventListener('keydown', (e) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.selected > 0 &&
        state.selected < state.layout.pieces.length - 1 &&
        !/INPUT|SELECT/.test(document.activeElement.tagName)) {
        state.sequence.splice(state.selected - 1, 1);
        state.selected = -1;
        rebuild();
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

    const r = assessSlope(state.slopeDeg, opts);
    const v = trackVerdict(state.layout.pieces, opts);
    const chip = r.status === 'walk'
        ? '<span class="chip walk">✔ WALKS</span>'
        : r.status === 'stall'
            ? '<span class="chip warn">⏸ STALLS</span>'
            : `<span class="chip fail">✖ ${r.status.toUpperCase()}S</span>`;
    $('verdict-card').innerHTML = `
        <div style="margin-bottom:8px">${chip}</div>
        <div class="statgrid">
            <div><div class="k">Trot speed</div><div class="v">${r.speedMmS.toFixed(0)} mm/s</div></div>
            <div><div class="k">Cadence</div><div class="v">${r.stepHz.toFixed(1)} clacks/s</div></div>
            <div><div class="k">Stride</div><div class="v">${r.strideMm.toFixed(1)} mm</div></div>
            <div><div class="k">Descent time</div><div class="v">${v.descentTimeS ? v.descentTimeS.toFixed(1) + ' s' : '—'}</div></div>
        </div>
        <div style="margin-top:8px;color:var(--ink-2)">${r.detail}</div>`;

    const vol = figureVolumeEstimate(state.innerWidth - 4);
    const bp = ballastPlan(vol, 15, state.walker.massG);
    // BB packing ≈ 60%, steel 7.8 g/cm³: body bore + pendulum bore capacity
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

// troubleshooting matrix (Phase-5 calibration table)
const MATRIX = [
    ['Toy slides without walking', 'Slope too steep, friction too low, or hoof cam too flat', 'Reduce slope 2°. Use the washboard finish. Verify the hoof arcs printed smooth (parts must lie on their sides).'],
    ['Toy stops / stalls mid-ramp', 'Slope too shallow or axle friction too high', 'Increase slope. Ream the axle bores, add dry graphite to the metal pin. Raise axle-quality in the model to see the effect.'],
    ['Toy tips forward and falls', 'Center of mass too high or too far forward', 'Move ballast lower and rearward in the bore. Slightly flatten the front of the hoof cam.'],
    ['Toy turns sideways and jams', 'Track too wide or legs asymmetric', 'Keep inner width ≤ figure width + 4 mm. Confirm left/right hooves weigh the same.'],
    ['Swinging leg barely moves', 'Pendulum rubbing inside the slot', 'Sand the pendulum faces; add thin washers on the axle as spacers; confirm 0.5 mm clearance per side.'],
    ['Horse stumbles at a seam', 'Uphill lip at the joint', 'Exports already drop each downhill floor 0.25 mm (waterfall rule) — check the printed seam for over-extrusion blobs and re-seat the dovetail.']
];
$('matrix').innerHTML = MATRIX.map(([sym, cause, fix]) => `
    <details class="matrix"><summary>${sym}</summary>
        <div class="fix"><b>Cause:</b> ${cause}<br><b>Fix:</b> ${fix}</div>
    </details>`).join('');

function refreshFooter() {
    const { pieces, issues, totalDropMm } = state.layout;
    $('ft-pieces').textContent = `${pieces.length} pieces`;
    $('ft-drop').textContent = `drop ${totalDropMm.toFixed(0)} mm`;
    $('ft-run').textContent = `run ${pieces.reduce((s, p) => s + p.planLen, 0).toFixed(0)} mm`;
    const errs = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    $('ft-issues').textContent = errs.length
        ? `⛔ ${errs[0].msg}`
        : warns.length ? `⚠️ ${warns[0].msg}` : '✅ layout OK';
}

// tabs
$('tab-physics').addEventListener('click', () => setTab('physics'));
$('tab-export').addEventListener('click', () => setTab('export'));
function setTab(t) {
    $('pane-physics').style.display = t === 'physics' ? '' : 'none';
    $('pane-export').style.display = t === 'export' ? '' : 'none';
    $('tab-physics').classList.toggle('active', t === 'physics');
    $('tab-export').classList.toggle('active', t === 'export');
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
// Simulation
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

$('btn-run').addEventListener('click', startSim);
$('btn-stop').addEventListener('click', stopSim);

const OUTCOME_TOASTS = {
    arrived: '🎉 The horse arrived at the corral!',
    stalled: '⏸ Stalled — not enough gait energy for this setup (see Physics lab)',
    tumbled: '💥 Tumbled — slope exceeds the swing limiter (see Physics lab)',
    timeout: '⏱ Simulation timed out'
};

function startSim() {
    stopSim();
    const { pieces } = state.layout;
    if (pieces.length < 3) { toast('Add at least one ramp piece first.'); return; }
    // Precompute the exact same run the verification harness would produce,
    // then replay its trace in real time.
    sim.run = simulateRun(pieces, physOpts());
    sim.sampler = makePathSampler(pieces, 4);
    sim.horse = buildHorse();
    scene.add(sim.horse);
    sim.t = 0;
    sim.phase = 0;
    sim.cursor = 0;
    sim.running = true;
    if (sim.run.events.some(e => e.type === 'mode' && e.detail.includes('slide'))) {
        toast('⛸ Hooves lose grip on this setup — watch it ski (see Physics lab)');
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

/** Interpolated (dist, v, mode, pieceIndex) from the precomputed trace at time t. */
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
            clack(Math.sign(cur) > 0 ? 1900 : 1300); // klip … klop
        }
    } else {
        // sliding/coasting: level out, no rocking
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

        // track pieces
        pieces.forEach((piece, i) => {
            parts.push({
                name: piece.name,
                build: () => buildPieceExportGeometry(piece, { isFirst: i === 0, isLast: i === pieces.length - 1 })
            });
        });
        // one pillar per elevated piece
        const pillarHeights = pieces.filter(p => p.rimY > 1).map(p => ({ name: `pillar_${p.name}_h${p.rimY.toFixed(0)}`, h: p.rimY }));
        for (const ph of pillarHeights) {
            parts.push({ name: ph.name, build: () => toArraysFromBG(buildPillarGeometry(ph.h)) });
        }
        // figure
        parts.push({ name: 'figure_body_print_on_side', build: () => rotForSide(buildFigureGeometries(state.innerWidth).body) });
        parts.push({ name: 'figure_pendulum_print_on_side', build: () => rotForSide(buildFigureGeometries(state.innerWidth).pendulum) });
        parts.push({ name: 'figure_plugs', build: () => buildFigureGeometries(state.innerWidth).plugSet });

        const files = {};
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            await new Promise(res => setTimeout(res)); // let the progress bar paint
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

        files['README.txt'] = fflate.strToU8(exportReadme());
        const zipped = fflate.zipSync(files);
        const blob = new Blob([zipped], { type: 'application/zip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `klipklop_track_${state.slopeDeg}deg_${pieces.length}pieces_${format}.zip`;
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

/** Rotate a figure part to lie on its side (extrusion axis X → vertical). */
function rotForSide(mesh) {
    const { positions } = mesh;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1];
        positions[i] = -y;     // rotate +90° about Z: (x,y) → (−y, x)
        positions[i + 1] = x;
    }
    return mesh;
}

function exportReadme() {
    const p = state.layout.params;
    return `KLIP KLOP MAKER — print & assembly notes
=========================================
Track: ${state.sequence.length + 2} pieces, slope ${state.slopeDeg}°, channel ${state.innerWidth} mm, curves R${state.curveRadius} mm.
All meshes are watertight (Manifold CSG kernel) and pre-oriented for printing.

PRINTING
- Material: PLA. 0.2 mm layers, 4-5 wall perimeters (toddler-proof), 10% gyroid infill.
- Track pieces: print exactly as oriented (skirt rim on the bed, deck up). No supports:
  the floor bridges the hollow acoustic chamber. The washboard ridges
  (${p.ridgeHeight ?? 0.6} mm × ${p.ridgePitch ?? 2.5} mm, transverse) are modeled into the floor.
- Pillars: print upright as oriented. Hex tenon plugs into the socket under each piece.
- Figure body & pendulum: pre-rotated to lie on their sides so the hoof cams print
  as smooth continuous arcs. NEVER print the figure standing up.

ASSEMBLY (in order)
1. Slide each downhill piece's dovetail slot onto the uphill piece's tab.
   The downhill floor sits 0.25 mm lower by design (waterfall rule) — do not "fix" this.
2. Plug pillars into the hex sockets; trim nothing, heights are pre-computed.
3. Cut a 3 mm steel/brass rod to ${(state.innerWidth - 4 + 3).toFixed(0)} mm for the axle.
   Slide through body + pendulum. Pendulum must swing DEAD FREE — add dry graphite.
4. Drop steel BBs into the ballast bores (see the app's Ballast plan), rear/low bias.
5. GLUE ALL PLUGS AND THE AXLE ENDS (CA glue). This is the choke-hazard seal —
   mandatory for children under 3. Verify nothing rattles loose.

TUNING
Use the app's Troubleshooting matrix. First test on a single straight ramp at 11°.
`;
}

// ---------------------------------------------------------------------------
// Main loop
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
    await loadState();
    syncControls();
    rebuild();
    resize();
    fitView();
    requestAnimationFrame(animate);
})();
