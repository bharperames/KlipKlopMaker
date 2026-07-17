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
