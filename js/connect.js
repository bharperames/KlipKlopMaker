/**
 * connect.js
 * Brio-style "connect the ends" — pure A* search over the tile set.
 *
 * Because parts are standardized, every move is one of four exact transforms
 * of the build state (x, z, heading, deck). The transforms are derived from
 * the LAYOUT'S OWN parameters (standard or custom), so the solver always
 * searches with the same geometry the track was laid out with:
 *   straight : +tileLen along heading, deck −(tile drop incl. waterfall)
 *   lift     : +tileLen along heading, deck +(lift net incl. waterfall)
 *   curveL/R : quarter-turn at the layout radius, deck −(curve drop incl. wf)
 * Success = tail pose carried onto the head pose with a legal waterfall
 * step-down at the closure seam.
 */

import { STANDARD, SPEC, isStandardParams, degToRad } from './track.js';

const WF = SPEC.waterfallStepMm;

function movesFromParams(p) {
    const tile = p.tileLen ?? SPEC.tileLen;
    const R = p.curveRadius ?? STANDARD.curveRadius;
    const slope = p.slopeDeg ?? STANDARD.slopeDeg;
    const liftSlope = p.liftSlopeDeg ?? (isStandardParams(p) ? STANDARD.liftSlopeDeg : slope);
    const tan = Math.tan(degToRad(slope));
    const tanL = Math.tan(degToRad(liftSlope));
    const arc = (Math.PI / 2) * R;
    return {
        tile, R,
        net: {
            straight: -(tile * tan + WF),
            lift: tile * tanL - WF,
            curveL: -(arc * tan + WF),
            curveR: -(arc * tan + WF)
        }
    };
}

function applyMove(st, type, M) {
    const { x, z, h, deck } = st;
    if (type === 'straight' || type === 'lift') {
        return { x: x + Math.cos(h) * M.tile, z: z + Math.sin(h) * M.tile, h, deck: deck + M.net[type] };
    }
    const turn = type === 'curveL' ? Math.PI / 2 : -Math.PI / 2;
    const side = Math.sign(turn);
    const cx = x + Math.cos(h + side * Math.PI / 2) * M.R;
    const cz = z + Math.sin(h + side * Math.PI / 2) * M.R;
    const rx = (x - cx) * Math.cos(turn) - (z - cz) * Math.sin(turn);
    const rz = (x - cx) * Math.sin(turn) + (z - cz) * Math.cos(turn);
    return { x: cx + rx, z: cz + rz, h: h + turn, deck: deck + M.net[type] };
}

const hIdx = (h) => ((Math.round(h / (Math.PI / 2)) % 4) + 4) % 4;

/**
 * Finds a tile sequence from `tail` (exit pose of the last piece) to `head`
 * (entry pose of the first piece). Success = position within posTol, heading
 * aligned, and a closure step-down anywhere in the legal waterfall window.
 * @returns {{ moves: string[], summary: object } | null}
 */
export function solveClosure(tail, head, params = {}, opts = {}) {
    const M = movesFromParams(params);
    const posTol = opts.posTol ?? 5;
    const maxPieces = opts.maxPieces ?? 26;
    const maxExpand = opts.maxExpand ?? 120000;
    const stepMin = WF - 0.05;
    const stepMax = 3;
    const goalH = hIdx(head.h);
    const maxDropPerTile = Math.max(...Object.values(M.net).map(Math.abs));

    const deckGapTiles = (deck) => {
        const step = deck - head.deck;
        if (step >= stepMin && step <= stepMax) return 0;
        const target = step < stepMin ? stepMin : stepMax;
        return Math.ceil(Math.abs(step - target) / maxDropPerTile - 1e-6);
    };

    const heuristic = (st) => {
        const dist = Math.hypot(head.x - st.x, head.z - st.z);
        const distTiles = Math.max(0, Math.ceil((dist - posTol) / M.tile));
        const turnTiles = (goalH - hIdx(st.h) + 4) % 4 === 0 ? 0 : 1;
        return Math.max(distTiles, turnTiles, deckGapTiles(st.deck));
    };

    const key = (st) => `${Math.round(st.x * 2)},${Math.round(st.z * 2)},${hIdx(st.h)},${Math.round(st.deck * 4)}`;
    const start = { x: tail.x, z: tail.z, h: tail.h, deck: tail.deck };
    const open = [{ st: start, moves: [], f: heuristic(start) }];
    const seen = new Map();
    let expanded = 0;

    while (open.length && expanded < maxExpand) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
        const cur = open.splice(bi, 1)[0];
        expanded++;

        const st = cur.st;
        const step = st.deck - head.deck;
        if (Math.hypot(head.x - st.x, head.z - st.z) <= posTol
            && hIdx(st.h) === goalH
            && step >= stepMin && step <= stepMax
            && cur.moves.length > 0) {
            const counts = {};
            for (const m of cur.moves) counts[m] = (counts[m] ?? 0) + 1;
            return { moves: cur.moves, summary: counts };
        }
        if (cur.moves.length >= maxPieces) continue;

        for (const type of ['straight', 'lift', 'curveL', 'curveR']) {
            const nst = applyMove(st, type, M);
            const g = cur.moves.length + 1;
            const k = key(nst);
            if (seen.has(k) && seen.get(k) <= g) continue;
            seen.set(k, g);
            open.push({ st: nst, moves: [...cur.moves, type], f: g + heuristic(nst) });
        }
    }
    return null;
}

/** The root chain's tail/head poses of an open layout (null when unusable). */
export function chainEnds(layout) {
    const chain = layout.pieces.filter(pc =>
        !pc.isImplicitStart && !pc.isImplicitEnd && (pc.address?.length === 1));
    if (!chain.length || layout.isCircuit) return null;
    const last = chain[chain.length - 1];
    const first = chain[0];
    return {
        tail: { x: last.exit.x, z: last.exit.z, h: last.exit.h, deck: last.exitDeck },
        head: { x: first.entry.x, z: first.entry.z, h: first.entry.h, deck: first.entryDeck }
    };
}

/** Human-readable description of the open gap (for failure messages). */
export function describeGap(layout) {
    const ends = chainEnds(layout);
    if (!ends) return null;
    const { tail, head } = ends;
    const dh = ((Math.round((head.h - tail.h) / (Math.PI / 2)) % 4) + 4) % 4;
    return {
        distMm: Math.hypot(head.x - tail.x, head.z - tail.z),
        turnQuarters: dh,
        deckMm: tail.deck - head.deck
    };
}

/**
 * Convenience wrapper for the app: solves the closure for an open root chain
 * using the layout's own parameters.
 */
export function solveClosureForLayout(layout) {
    const ends = chainEnds(layout);
    if (!ends) return null;
    return solveClosure(ends.tail, ends.head, layout.params ?? {});
}
