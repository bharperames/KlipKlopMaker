/**
 * scene_format.js
 * Versioned persistence format for Klip Klop Maker designs — pure module.
 *
 * A "scene" is a complete, portable description of a design: the path
 * sequence, track parameters, surface finish, and walker configuration,
 * plus optional metadata and test expectations (used by the verification
 * harness in tests/scenes.test.js and scripts/generate_reports.mjs).
 */

import { SPEC } from './track.js';
import { FRICTION_PRESETS, DEFAULT_WALKER } from './physics.js';

export const SCENE_FORMAT = 'klipklop-scene';
export const SCENE_VERSION = 1;

const SEGMENT_TYPES = new Set(['straight', 'curveL', 'curveR']);

/** Builds a scene object from app state (or state-shaped input). */
export function serializeScene(state, meta = {}) {
    return {
        format: SCENE_FORMAT,
        version: SCENE_VERSION,
        name: meta.name ?? state.name ?? 'Untitled track',
        description: meta.description ?? state.description ?? '',
        sequence: [...state.sequence],
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

/**
 * Validates a parsed scene object. Returns a list of problems (empty = valid).
 * Unknown fields are tolerated (forward compatibility).
 */
export function validateScene(obj) {
    const problems = [];
    if (!obj || typeof obj !== 'object') return ['not an object'];
    if (obj.format !== SCENE_FORMAT) problems.push(`format must be "${SCENE_FORMAT}"`);
    if (typeof obj.version !== 'number' || obj.version > SCENE_VERSION) {
        problems.push(`unsupported version ${obj.version} (this app reads ≤ ${SCENE_VERSION})`);
    }
    if (!Array.isArray(obj.sequence)) problems.push('sequence must be an array');
    else {
        for (const t of obj.sequence) {
            if (!SEGMENT_TYPES.has(t)) problems.push(`unknown segment type "${t}"`);
        }
    }
    const p = obj.params ?? {};
    if (typeof p.slopeDeg !== 'number') problems.push('params.slopeDeg missing');
    if (typeof p.innerWidth !== 'number') problems.push('params.innerWidth missing');
    if (typeof p.curveRadius !== 'number') problems.push('params.curveRadius missing');
    if (obj.surface && !FRICTION_PRESETS[obj.surface]) problems.push(`unknown surface "${obj.surface}"`);
    return problems;
}

/**
 * Converts a valid scene into app-state fields, clamping parameters into the
 * physics envelope only where the value would break geometry generation
 * (out-of-envelope slopes/radii are allowed — the layout engine flags them,
 * which is exactly what stall/slide test scenes rely on).
 */
export function deserializeScene(obj) {
    const problems = validateScene(obj);
    if (problems.length) throw new Error(`Invalid scene: ${problems.join('; ')}`);
    return {
        name: obj.name ?? 'Untitled track',
        description: obj.description ?? '',
        sequence: [...obj.sequence],
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
