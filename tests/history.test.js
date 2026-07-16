import { createHistory } from '../js/history.js';

const snap = (n) => ({ sequence: ['straight'], value: n });

describe('edit stack', () => {
    test('undo restores the pre-mutation snapshot; redo restores the undone one', () => {
        const h = createHistory();
        h.push(snap(1));            // about to mutate 1 → 2
        expect(h.canUndo()).toBe(true);
        const back = h.undo(snap(2));
        expect(back.value).toBe(1);
        expect(h.canRedo()).toBe(true);
        const fwd = h.redo(snap(1));
        expect(fwd.value).toBe(2);
    });

    test('a new edit clears the redo branch', () => {
        const h = createHistory();
        h.push(snap(1));
        h.undo(snap(2));
        expect(h.canRedo()).toBe(true);
        h.push(snap(1)); // diverge
        expect(h.canRedo()).toBe(false);
    });

    test('multi-step undo walks back through every operation type uniformly', () => {
        const h = createHistory();
        const states = [snap(0)];
        // simulate heterogeneous ops: add piece, flip gate, move scenery, slider
        for (let i = 1; i <= 4; i++) {
            h.push(states[i - 1], null);
            states.push(snap(i));
        }
        let cur = states[4];
        for (let i = 3; i >= 0; i--) {
            cur = h.undo(cur);
            expect(cur.value).toBe(i);
        }
        expect(h.canUndo()).toBe(false);
        for (let i = 1; i <= 4; i++) {
            cur = h.redo(cur);
            expect(cur.value).toBe(i);
        }
        expect(h.canRedo()).toBe(false);
    });

    test('coalesces a slider drag into a single undo step', () => {
        let t = 0;
        const h = createHistory({ now: () => t });
        h.push(snap(10), 'slider:slope'); t += 100;
        h.push(snap(11), 'slider:slope'); t += 100;
        h.push(snap(12), 'slider:slope');
        expect(h.depth().past).toBe(1);
        const back = h.undo(snap(13));
        expect(back.value).toBe(10); // one undo returns to before the whole drag
    });

    test('same opKey after the coalesce window is a new step', () => {
        let t = 0;
        const h = createHistory({ now: () => t, coalesceMs: 900 });
        h.push(snap(1), 'slider:slope');
        t += 2000;
        h.push(snap(2), 'slider:slope');
        expect(h.depth().past).toBe(2);
    });

    test('endGesture splits coalescing even within the window', () => {
        let t = 0;
        const h = createHistory({ now: () => t });
        h.push(snap(1), 'drag:scenery0');
        h.endGesture();
        h.push(snap(2), 'drag:scenery0');
        expect(h.depth().past).toBe(2);
    });

    test('respects the depth limit', () => {
        const h = createHistory({ limit: 5 });
        for (let i = 0; i < 20; i++) h.push(snap(i));
        expect(h.depth().past).toBe(5);
        expect(h.undo(snap(99)).value).toBe(19);
    });

    test('undo/redo on empty stacks return null without corrupting state', () => {
        const h = createHistory();
        expect(h.undo(snap(1))).toBeNull();
        expect(h.redo(snap(1))).toBeNull();
        h.push(snap(1));
        expect(h.undo(snap(2)).value).toBe(1);
    });

    test('snapshots are deep-isolated from later state mutation', () => {
        const h = createHistory();
        const s = { sequence: ['straight'], nested: { gate: 'main' } };
        h.push(s);
        s.nested.gate = 'branch';
        s.sequence.push('curveL');
        const back = h.undo({ sequence: [], nested: {} });
        expect(back.nested.gate).toBe('main');
        expect(back.sequence).toEqual(['straight']);
    });
});
