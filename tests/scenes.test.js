/**
 * Scene harness: loads every scene in scenes/, lays it out, simulates it,
 * and verifies the outcome against the scene's embedded `expect` block.
 * Adding a scene file automatically adds it to the harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutTrack, resolveRidePath } from '../js/track.js';
import { FRICTION_PRESETS } from '../js/physics.js';
import { simulateRun, verifyEnergyBudget } from '../js/simulate.js';
import { validateScene, deserializeScene, serializeScene, roundTrip } from '../js/scene_format.js';

const SCENES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenes');
const sceneFiles = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).sort();

test('there are scenes to verify', () => {
    expect(sceneFiles.length).toBeGreaterThanOrEqual(5);
});

/*
 * 'start' AND 'end' TOKENS ARE ALIASES FOR THE IMPLICIT PLATFORMS, and the
 * builder and the validator apply ONE rule to them. They used to disagree
 * twice over: the validator rejected the tokens everywhere (so a file
 * spelling the natural thing refused to load and the app silently fell back
 * to the demo), while the builder accepted them everywhere and BUILT them —
 * ['start','straight','end'], the spelling half this suite uses, quietly
 * produced five pieces, with a phantom platform 0.25 mm under each real one.
 */
describe('platform tokens are aliases, agreed between builder and validator', () => {
    const walker = { alphaDeg: 18, legLenMm: 26, efficiency: 0.26, massG: 45 };

    test('tokens in their implicit positions validate, build once, and round-trip', () => {
        const scene = {
            format: 'klipklop-scene', version: 2,
            name: 'One straight one switch',
            sequence: ['start', 'straight',
                { type: 'switchR', gate: 'branch', main: ['end'], branch: ['end'] }],
            scenery: [], surface: 'washboard', walker
        };
        expect(validateScene(scene)).toEqual([]);
        const state = deserializeScene(scene);
        expect(roundTrip(state).sequence).toEqual(scene.sequence);
        const { pieces, issues } = layoutTrack(state.sequence, {});
        expect(issues.filter(i => i.level === 'error')).toEqual([]);
        // ONE start and ONE end per route — the alias never doubles
        expect(pieces.filter(p => p.type === 'start')).toHaveLength(1);
        expect(pieces.filter(p => p.type === 'end')).toHaveLength(2);
    });

    test('the plain spelling builds the same pieces as the token spelling', () => {
        const spell = (seq) => layoutTrack(seq, {}).pieces.map(p => p.type).join(',');
        expect(spell(['start', 'straight', 'end'])).toBe(spell(['straight']));
    });

    test('a misplaced platform token is rejected by both sides', () => {
        const seq = ['straight', 'end', 'straight'];
        const scene = { format: 'klipklop-scene', version: 2, name: 'x',
            sequence: seq, scenery: [], surface: 'washboard', walker };
        expect(validateScene(scene)).not.toEqual([]);
        const { issues } = layoutTrack(seq, {});
        expect(issues.some(i => i.code === 'misplaced-platform')).toBe(true);
    });
});

describe.each(sceneFiles)('%s', (file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, file), 'utf8'));

    test('is a valid scene document', () => {
        expect(validateScene(raw)).toEqual([]);
    });

    test('round-trips through serialize/deserialize losslessly', () => {
        const state = deserializeScene(raw);
        const again = roundTrip(state);
        expect(again.sequence).toEqual(state.sequence);
        expect(again.slopeDeg).toBe(state.slopeDeg);
        expect(again.walker).toEqual(state.walker);
        expect(again.muKey).toBe(state.muKey);
    });

    const state = deserializeScene(raw);
    const layout = layoutTrack(state.sequence, {
        slopeDeg: state.slopeDeg,
        innerWidth: state.innerWidth,
        curveRadius: state.curveRadius
    });
    const result = simulateRun(resolveRidePath(layout.pieces), {
        mu: FRICTION_PRESETS[state.muKey].mu,
        walker: state.walker,
        loop: layout.isCircuit,
        maxLaps: 3
    });
    const exp = raw.expect ?? {};

    test(`simulation outcome is "${exp.outcome}"`, () => {
        expect(result.outcome).toBe(exp.outcome);
    });

    test('meets its timing / gait expectations', () => {
        if (exp.maxTimeS !== undefined) expect(result.tEnd).toBeLessThanOrEqual(exp.maxTimeS);
        if (exp.minClacks !== undefined) expect(result.stats.clacks).toBeGreaterThanOrEqual(exp.minClacks);
        if (exp.minWalkedFraction !== undefined) expect(result.stats.walkedFraction).toBeGreaterThanOrEqual(exp.minWalkedFraction);
        if (exp.maxWalkedFraction !== undefined) expect(result.stats.walkedFraction).toBeLessThanOrEqual(exp.maxWalkedFraction);
        if (exp.minMaxV !== undefined) expect(result.stats.maxV).toBeGreaterThanOrEqual(exp.minMaxV);
        if (exp.minLaps !== undefined) expect(result.stats.laps).toBeGreaterThanOrEqual(exp.minLaps);
    });

    test('raises exactly the expected layout errors', () => {
        const errs = [...new Set(layout.issues.filter(i => i.level === 'error').map(i => i.code))].sort();
        expect(errs).toEqual([...(exp.layoutErrors ?? [])].sort());
    });

    test('respects the energy budget (no energy creation)', () => {
        expect(verifyEnergyBudget(result.trace).ok).toBe(true);
    });
});
