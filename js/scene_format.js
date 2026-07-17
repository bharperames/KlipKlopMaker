/**
 * scene_format.js
 * Versioned persistence format for Klip Klop Maker designs — pure module.
 *
 * v2 adds: tree-structured sequences (switch nodes with gates), 'lift'
 * segments, and a `scenery` array of placed decorative parts. v1 documents
 * (flat string arrays) load unchanged — a string is a valid tree node.
 */

import { SIMPLE_TYPES, isSwitchNode } from './track.js';
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
        name: meta.name ?? state.name ?? 'Untitled track',
        description: meta.description ?? state.description ?? '',
        sequence: cloneNodes(state.sequence),
        scenery: (state.scenery ?? []).map(s => ({ ...s })),
        figureStyle: state.figureStyle ?? 'classic',
        figureOpacity: typeof state.figureOpacity === 'number' ? state.figureOpacity : 1,
        params: {
            slopeDeg: state.slopeDeg,
            innerWidth: state.innerWidth,
            curveRadius: state.curveRadius
        },
        surface: state.muKey,
        walker: { ...state.walker },
        ...(meta.expect || state.expect ? { expect: meta.expect ?? state.expect } : {})
    };
}

function cloneNodes(nodes) {
    return nodes.map(n => typeof n === 'string' ? n : {
        type: n.type,
        gate: n.gate === 'branch' ? 'branch' : 'main',
        main: cloneNodes(n.main ?? []),
        branch: cloneNodes(n.branch ?? [])
    });
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
    const p = obj.params ?? {};
    if (typeof p.slopeDeg !== 'number') problems.push('params.slopeDeg missing');
    if (typeof p.innerWidth !== 'number') problems.push('params.innerWidth missing');
    if (typeof p.curveRadius !== 'number') problems.push('params.curveRadius missing');
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
        sequence: cloneNodes(obj.sequence),
        scenery: (obj.scenery ?? []).map(s => ({ rot: 0, ...s })),
        figureStyle: FIGURE_STYLES.includes(obj.figureStyle) ? obj.figureStyle : 'classic',
        figureOpacity: typeof obj.figureOpacity === 'number' ? Math.min(1, Math.max(0.3, obj.figureOpacity)) : 1,
        slopeDeg: obj.params.slopeDeg,
        innerWidth: obj.params.innerWidth,
        curveRadius: obj.params.curveRadius,
        muKey: obj.surface && FRICTION_PRESETS[obj.surface] ? obj.surface : 'washboard',
        walker: { ...DEFAULT_WALKER, ...(obj.walker ?? {}) },
        expect: obj.expect
    };
}

/** Round-trip helper used by tests. */
export function roundTrip(state) {
    return deserializeScene(JSON.parse(JSON.stringify(serializeScene(state))));
}
