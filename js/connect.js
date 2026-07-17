/**
 * connect.js
 * Brio-style "connect the ends" — pure A* search over STANDARD tiles.
 *
 * Because the part set is standardized, every move is one of four exact
 * transforms of the build state (x, z, heading, deck):
 *   straight : +150 mm along heading, deck −30 (incl. waterfall)
 *   lift     : +150 mm along heading, deck +30
 *   curveL/R : quarter-turn at R=143.64 mm, deck −45
 * Closing a gap is therefore a graph search: find the cheapest tile sequence
 * that carries the tail pose onto the head pose with the mandatory 0.25 mm
 * waterfall step-down — raising with lifts, spending with ramps and curves.
 */

import { STANDARD, SPEC, degToRad } from './track.js';

const R = STANDARD.curveRadius;
const TILE = SPEC.tileLen;
const WF = SPEC.waterfallStepMm;

/** Net deck change per tile, INCLUDING its waterfall seam. */
const NET = { straight: -STANDARD.tileDropMm, lift: STANDARD.tileDropMm, curveL: -STANDARD.curveDropMm, curveR: -STANDARD.curveDropMm };

function applyMove(st, type) {
    const { x, z, h, deck } = st;
    if (type === 'straight' || type === 'lift') {
        return { x: x + Math.cos(h) * TILE, z: z + Math.sin(h) * TILE, h, deck: deck + NET[type] };
    }
    const turn = type === 'curveL' ? Math.PI / 2 : -Math.PI / 2;
    const side = Math.sign(turn);
    const cx = x + Math.cos(h + side * Math.PI / 2) * R;
    const cz = z + Math.sin(h + side * Math.PI / 2) * R;
    const rx = (x - cx) * Math.cos(turn) - (z - cz) * Math.sin(turn);
    const rz = (x - cx) * Math.sin(turn) + (z - cz) * Math.cos(turn);
    return { x: cx + rx, z: cz + rz, h: h + turn, deck: deck + NET[type] };
}

const hIdx = (h) => ((Math.round(h / (Math.PI / 2)) % 4) + 4) % 4;

/**
 * Finds a tile sequence from `tail` (exit pose of the last piece: x, z, h,
 * deck) to `head` (entry pose of the first piece). Success = position within
 * `posTol`, heading aligned, and final deck exactly one waterfall step above
 * the head entry (the closure seam).
 *
 * @returns {{ moves: string[], summary: object } | null}
 */
export function solveClosure(tail, head, opts = {}) {
    const posTol = opts.posTol ?? 5;
    const maxPieces = opts.maxPieces ?? 26;
    const maxExpand = opts.maxExpand ?? 60000;

    const targetDeck = head.deck + WF; // tail-of-solution exit deck
    const goalH = hIdx(head.h);

    const heuristic = (st) => {
        const dist = Math.hypot(head.x - st.x, head.z - st.z);
        const distTiles = Math.max(0, Math.ceil((dist - posTol) / TILE));
        const turnTiles = (goalH - hIdx(st.h) + 4) % 4 === 0 ? 0 : 1;
        const deckTiles = Math.ceil(Math.abs(targetDeck - st.deck) / STANDARD.curveDropMm - 1e-6);
        return Math.max(distTiles, turnTiles, deckTiles);
    };

    const key = (st, n) => `${Math.round(st.x * 2)},${Math.round(st.z * 2)},${hIdx(st.h)},${Math.round(st.deck * 4)}`;
    const start = { x: tail.x, z: tail.z, h: tail.h, deck: tail.deck };
    const open = [{ st: start, moves: [], f: heuristic(start) }];
    const seen = new Map();
    let expanded = 0;

    while (open.length && expanded < maxExpand) {
        // binary-heap-free priority pop (frontiers stay small at these depths)
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
        const cur = open.splice(bi, 1)[0];
        expanded++;

        const st = cur.st;
        if (Math.hypot(head.x - st.x, head.z - st.z) <= posTol
            && hIdx(st.h) === goalH
            && Math.abs(st.deck - targetDeck) <= 0.1
            && cur.moves.length > 0) {
            const counts = {};
            for (const m of cur.moves) counts[m] = (counts[m] ?? 0) + 1;
            return { moves: cur.moves, summary: counts };
        }
        if (cur.moves.length >= maxPieces) continue;

        for (const type of ['straight', 'lift', 'curveL', 'curveR']) {
            const nst = applyMove(st, type);
            const g = cur.moves.length + 1;
            const k = key(nst, g);
            if (seen.has(k) && seen.get(k) <= g) continue;
            seen.set(k, g);
            open.push({ st: nst, moves: [...cur.moves, type], f: g + heuristic(nst) });
        }
    }
    return null;
}

/**
 * Convenience wrapper for the app: derives tail/head poses from a laid-out
 * OPEN root chain and returns the closing tile sequence.
 */
export function solveClosureForLayout(layout) {
    const chain = layout.pieces.filter(pc =>
        !pc.isImplicitStart && !pc.isImplicitEnd && (pc.address?.length === 1));
    if (!chain.length || layout.isCircuit) return null;
    const last = chain[chain.length - 1];
    const first = chain[0];
    return solveClosure(
        { x: last.exit.x, z: last.exit.z, h: last.exit.h, deck: last.exitDeck },
        { x: first.entry.x, z: first.entry.z, h: first.entry.h, deck: first.entryDeck }
    );
}
