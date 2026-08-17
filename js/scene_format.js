/**
 * scene_format.js
 * Versioned persistence format for Klip Klop Konstructor designs — pure module.
 *
 * v2 adds: tree-structured sequences (switch nodes with gates), 'lift'
 * segments, and a `scenery` array of placed decorative parts. v1 documents
 * (flat string arrays) load unchanged — a string is a valid tree node.
 */

import { SIMPLE_TYPES, isSwitchNode, STANDARD, GEOMETRY_VERSION, isStandardParams,
    normaliseSkirtStyle } from './track.js';

const major = (v) => String(v).split('.')[0];
import { FRICTION_PRESETS, DEFAULT_WALKER } from './physics.js';
import { FIGURE_STYLES } from './geometry.js';

export const SCENE_FORMAT = 'klipklop-scene';
export const SCENE_VERSION = 2;

export const SCENERY_KINDS = ['tower', 'palm', 'patio'];

/** Builds a scene object from app state (or state-shaped input). */
export function serializeScene(state, meta = {}) {
    return {
        format: SCENE_FORMAT,
        version: SCENE_VERSION,
        geometry: GEOMETRY_VERSION,
        name: meta.name ?? state.name ?? 'Untitled track',
        description: meta.description ?? state.description ?? '',
        sequence: cloneNodes(state.sequence),
        scenery: (state.scenery ?? []).map(s => ({ ...s })),
        figureStyle: state.figureStyle ?? 'knight',
        knightVariant: state.knightVariant === 'comb' ? 'comb' : 'trumpet',
        figureOpacity: typeof state.figureOpacity === 'number' ? state.figureOpacity : 1,
        params: {
            slopeDeg: +STANDARD.slopeDeg.toFixed(4),
            innerWidth: STANDARD.innerWidth,
            curveRadius: +STANDARD.curveRadius.toFixed(2)
        },
        // Which underside the pieces are built with. A scene saved with
        // `minimal` must come back as `minimal` — it is a different printed
        // part, not a view setting.
        skirtStyle: normaliseSkirtStyle(state.skirtStyle),
        surface: state.muKey,
        walker: { ...state.walker },
        ...(meta.expect || state.expect ? { expect: meta.expect ?? state.expect } : {})
    };
}

function cloneNodes(nodes) {
    return nodes.map(n => {
        if (typeof n === 'string') return n;
        if (isSwitchNode(n)) {
            return {
                type: n.type,
                gate: n.gate === 'branch' ? 'branch' : 'main',
                main: cloneNodes(n.main ?? []),
                branch: cloneNodes(n.branch ?? [])
            };
        }
        return { ...n };
    });
}

/**
 * L AND R SWAPPED MEANING IN 2.6.0, so a file written before it has to have its
 * tokens exchanged to keep the shape its author drew.
 *
 * Until 2.6.0 the turn sign was inverted: a `curveR` bent to the WALKER'S LEFT.
 * The UI hid it by wiring the "Curve left" button to `curveR`, so the builder
 * looked correct while the token, the parts list and the ENGRAVING all said the
 * opposite — Brett, holding a printed one: "it is called right curve, but it
 * curves left as the model walks down it."
 *
 * 2.6.0 fixes the sign, which means the same token now builds the mirror of
 * what it used to. Swapping the tokens on load is what makes that invisible: an
 * old design keeps its shape, and only its vocabulary is brought up to date.
 * This is why scenes carry a `geometry` stamp — Brett: "you should have a semver
 * in the scene to make these kind of updates during loading."
 */
function migrateHandedness(sequence, stamp) {
    if (!stamp || cmpVer(stamp, '2.6.0') >= 0) return sequence;
    const flip = { curveL: 'curveR', curveR: 'curveL', switchL: 'switchR', switchR: 'switchL' };
    const walk = (nodes) => nodes.map((n) => {
        if (typeof n === 'string') return flip[n] ?? n;
        if (n && typeof n === 'object') {
            return { ...n,
                ...(flip[n.type] ? { type: flip[n.type] } : {}),
                ...(Array.isArray(n.main) ? { main: walk(n.main) } : {}),
                ...(Array.isArray(n.branch) ? { branch: walk(n.branch) } : {}) };
        }
        return n;
    });
    return walk(sequence);
}

/** -1, 0 or 1 comparing dotted versions numerically rather than as strings. */
function cmpVer(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return Math.sign(d);
    }
    return 0;
}

function validateNodes(nodes, problems, path) {
    if (!Array.isArray(nodes)) { problems.push(`${path}: not an array`); return; }
    nodes.forEach((n, i) => {
        if (typeof n === 'string') {
            if (!SIMPLE_TYPES.includes(n)) problems.push(`${path}[${i}]: unknown segment type "${n}"`);
        } else if (isSwitchNode(n)) {
            if (i !== nodes.length - 1) problems.push(`${path}[${i}]: a switch must be the last node of its branch`);
            validateNodes(n.main ?? [], problems, `${path}[${i}].main`);
            validateNodes(n.branch ?? [], problems, `${path}[${i}].branch`);
        } else if (n && typeof n === 'object' && SIMPLE_TYPES.includes(n.type)) {
            if (n.type === 'elevator' && n.height !== undefined && typeof n.height !== 'number') {
                problems.push(`${path}[${i}]: elevator height must be a number`);
            }
        } else {
            problems.push(`${path}[${i}]: unknown node`);
        }
    });
}

/** Returns a list of problems (empty = valid). Tolerates unknown extra fields. */
export function validateScene(obj) {
    const problems = [];
    if (!obj || typeof obj !== 'object') return ['not an object'];
    if (obj.format !== SCENE_FORMAT) problems.push(`format must be "${SCENE_FORMAT}"`);
    if (typeof obj.version !== 'number' || obj.version > SCENE_VERSION) {
        problems.push(`unsupported version ${obj.version} (this app reads ≤ ${SCENE_VERSION})`);
    }
    validateNodes(obj.sequence ?? null, problems, 'sequence');
    if (obj.surface && !FRICTION_PRESETS[obj.surface]) problems.push(`unknown surface "${obj.surface}"`);
    for (const [i, s] of (obj.scenery ?? []).entries()) {
        if (!SCENERY_KINDS.includes(s.kind)) problems.push(`scenery[${i}]: unknown kind "${s.kind}"`);
        if (typeof s.x !== 'number' || typeof s.z !== 'number') problems.push(`scenery[${i}]: missing position`);
    }
    return problems;
}

/** Converts a valid scene into app-state fields. */
export function deserializeScene(obj) {
    const problems = validateScene(obj);
    if (problems.length) throw new Error(`Invalid scene: ${problems.join('; ')}`);
    return {
        name: obj.name ?? 'Untitled track',
        description: obj.description ?? '',
        sequence: migrateHandedness(cloneNodes(obj.sequence), obj.geometry),
        scenery: (obj.scenery ?? []).map(s => ({ rot: 0, ...s })),
        figureStyle: FIGURE_STYLES.includes(obj.figureStyle) ? obj.figureStyle : 'knight',
        knightVariant: obj.knightVariant === 'comb' ? 'comb' : 'trumpet',
        figureOpacity: typeof obj.figureOpacity === 'number' ? Math.min(1, Math.max(0.3, obj.figureOpacity)) : 1,
        // parameters are CONSTANT: every design lays out on the canonical
        // geometry; legacy/custom params in the file are reported, not obeyed
        slopeDeg: +STANDARD.slopeDeg.toFixed(4),
        innerWidth: STANDARD.innerWidth,
        curveRadius: +STANDARD.curveRadius.toFixed(2),
        skirtStyle: normaliseSkirtStyle(obj.skirtStyle),
        geometryOfFile: obj.geometry ?? null,
        // Same MAJOR mates — that is the promise the export README makes, and
        // an exact-string check broke it the first time a MINOR shipped.
        nonStandard: (obj.geometry != null && major(obj.geometry) !== major(GEOMETRY_VERSION))
            || (obj.params != null && !isStandardParams(obj.params)),
        muKey: obj.surface && FRICTION_PRESETS[obj.surface] ? obj.surface : 'washboard',
        walker: { ...DEFAULT_WALKER, ...(obj.walker ?? {}) },
        expect: obj.expect
    };
}

/** Round-trip helper used by tests. */
export function roundTrip(state) {
    return deserializeScene(JSON.parse(JSON.stringify(serializeScene(state))));
}
