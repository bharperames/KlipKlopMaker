/**
 * Brio-style closure solver: standard tiles let "connect ends" be a search.
 */
import { layoutTrack, STANDARD, SPEC } from '../js/track.js';
import { solveClosure, solveClosureForLayout } from '../js/connect.js';

const close = (seq) => {
    const layout = layoutTrack(seq);
    const sol = solveClosureForLayout(layout);
    expect(sol).not.toBeNull();
    const closed = layoutTrack([...seq, ...sol.moves]);
    return { sol, closed };
};

describe('solveClosureForLayout', () => {
    test.each([
        [['lift', 'lift', 'lift', 'curveL', 'curveL']],
        [['straight', 'curveL', 'curveL']],
        [['lift', 'lift', 'curveR']],
        [['straight', 'straight', 'curveL', 'straight', 'curveL']],
        [['straight']],
    ])('closes %j into a verified circuit', (seq) => {
        const { closed } = close(seq);
        expect(closed.isCircuit).toBe(true);
        const tail = closed.pieces[closed.pieces.length - 1];
        const stepDown = tail.exitDeck - closed.pieces[0].entryDeck;
        expect(stepDown).toBeGreaterThanOrEqual(SPEC.waterfallStepMm - 0.05);
        expect(stepDown).toBeLessThanOrEqual(3);
    });

    test('balances elevation with lifts (net drop of the patch offsets the chain)', () => {
        const { sol } = close(['straight', 'curveL', 'curveL']); // chain descends 120
        const net = sol.moves.reduce((s, m) =>
            s + (m === 'lift' ? STANDARD.tileDropMm : m === 'straight' ? -STANDARD.tileDropMm : -STANDARD.curveDropMm), 0);
        expect(net).toBe(120); // exactly repays the chain's descent
    });

    test('returns null for an already-closed circuit', () => {
        const ring = ['lift', 'lift', 'lift', 'curveL', 'curveL', 'lift', 'lift', 'lift', 'curveL', 'curveL'];
        expect(solveClosureForLayout(layoutTrack(ring))).toBeNull();
    });

    test('solver is deterministic', () => {
        const layout = layoutTrack(['straight', 'curveL', 'curveL']);
        const a = solveClosureForLayout(layout);
        const b = solveClosureForLayout(layout);
        expect(a.moves).toEqual(b.moves);
    });
});

describe('the standard grid makes closure guaranteed arithmetic', () => {
    // the user's "easy autocomplete challenge": down, U-turn, lift back past
    // the start, U-turn again — tail sits 3 tiles behind the head, 30 mm up
    const CHALLENGE = ['straight', 'straight', 'curveR', 'curveR',
        'lift', 'lift', 'lift', 'lift', 'lift', 'lift', 'lift',
        'curveR', 'curveR', 'lift', 'lift'];

    test('closes in exactly 3 tiles at standard parameters', () => {
        const layout = layoutTrack(CHALLENGE);
        const sol = solveClosureForLayout(layout);
        expect(sol).not.toBeNull();
        expect(sol.moves.length).toBe(3);
        const closed = layoutTrack([...CHALLENGE, ...sol.moves]);
        expect(closed.isCircuit).toBe(true);
    });

    test('the same shape at custom 14°/R190 has no legal closure (why the standard exists)', () => {
        const layout = layoutTrack(CHALLENGE, { slopeDeg: 14, curveRadius: 190 });
        const sol = solveClosureForLayout(layout);
        expect(sol).toBeNull();
    }, 30000);
});
