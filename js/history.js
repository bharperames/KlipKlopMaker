/**
 * history.js
 * Pure snapshot-based edit stack — no DOM dependencies.
 *
 * Uniformity by construction: instead of per-operation inverse commands
 * (which silently miss operations as the editor grows), every mutation pushes
 * a full snapshot of the design state BEFORE it applies. Undo/redo swap the
 * current state with the stack tops. Design state is small (a piece tree,
 * scenery list and a handful of parameters), so snapshots are cheap.
 *
 * Coalescing: continuous gestures (slider drags, scenery drags) pass a stable
 * `opKey`; consecutive pushes with the same key inside the coalesce window
 * collapse into one undo step, so one slider drag = one undo.
 */

export function createHistory({ limit = 100, coalesceMs = 900, now = () => Date.now() } = {}) {
    const past = [];
    let future = [];
    let lastOpKey = null;
    let lastOpTime = -Infinity;

    return {
        /**
         * Records the pre-mutation snapshot. Call BEFORE applying a change.
         * @param {object} snapshot - JSON-serializable design state
         * @param {string} [opKey] - stable id for coalescing a gesture
         */
        push(snapshot, opKey = null) {
            const t = now();
            const coalesce = opKey !== null && opKey === lastOpKey && (t - lastOpTime) < coalesceMs;
            lastOpKey = opKey;
            lastOpTime = t;
            if (coalesce) return; // gesture continues — keep the original pre-state
            past.push(JSON.stringify(snapshot));
            if (past.length > limit) past.shift();
            future = []; // a new edit invalidates the redo branch
        },

        /** @returns {object|null} the state to restore, or null if empty */
        undo(currentSnapshot) {
            if (!past.length) return null;
            future.push(JSON.stringify(currentSnapshot));
            lastOpKey = null;
            return JSON.parse(past.pop());
        },

        /** @returns {object|null} the state to restore, or null if empty */
        redo(currentSnapshot) {
            if (!future.length) return null;
            past.push(JSON.stringify(currentSnapshot));
            lastOpKey = null;
            return JSON.parse(future.pop());
        },

        /** Ends any coalescing gesture (e.g. on pointerup). */
        endGesture() { lastOpKey = null; },

        canUndo() { return past.length > 0; },
        canRedo() { return future.length > 0; },
        depth() { return { past: past.length, future: future.length }; },
        clear() { past.length = 0; future = []; lastOpKey = null; }
    };
}
