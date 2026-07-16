/**
 * track.js
 * Pure track layout engine — no DOM or Three.js dependencies.
 *
 * v2: the track is a TREE, not a list. A node is either a simple segment type
 * ('straight' | 'curveL' | 'curveR' | 'lift') or a switch object:
 *
 *   { type: 'switchL'|'switchR', gate: 'main'|'branch', main: Node[], branch: Node[] }
 *
 * A switch is always the last node of its container array; its two exits each
 * carry their own continuation. Every leaf container is auto-capped with an
 * end platform, and the root is prefixed with a start platform.
 *
 * Physics rule set enforced here (see PHYSICS.md):
 *  - Slope lock (green 10-12°) with Auto-Z elevation solving down every branch
 *  - Waterfall rule: every seam steps the downhill floor 0.25 mm lower
 *  - Washboard pitch snapped per piece so seams land in ridge valleys
 *  - Zero bank: sweep `right` vectors stay horizontal on curves and spirals
 *  - Lifts ascend at the same locked angle (externally powered — the one
 *    exception to gravity-only, flagged with `isLift`)
 */

export const SPEC = {
    slope: { hardMin: 8, greenMin: 10, greenMax: 12, hardMax: 14, default: 11 },
    innerWidth: { min: 46, max: 50, default: 48 },
    curveWidenMm: 3,
    minCurveRadius: 120,
    defaultCurveRadius: 150,
    railHeight: 14,
    wall: 2.4,
    floorThk: 2.0,
    filletR: 2.0,
    skirtDepth: 12,
    ridge: { height: 0.6, pitch: 2.5 },
    waterfallStepMm: 0.25,
    jointClearanceMm: 0.2,
    tileLen: 150,
    platformLen: 150,
    clearanceHeight: 100,
    socket: { hexAF: 9, depth: 10, bossR: 9.5, pillarR: 7 },
    // Bowtie connector key (print-flat butterfly key, Hot-Wheels-style separate
    // connector): pockets recess into full-height end ribs — zero overhangs.
    key: { neckHalf: 8, tipHalf: 12, depth: 9, height: 6, ribThk: 12 },
    liftSpeedMmS: 55
};

const rot2 = (x, z, a) => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];

export function degToRad(d) { return d * Math.PI / 180; }
export function radToDeg(r) { return r * 180 / Math.PI; }

export function effectiveRidgePitch(length, nominalPitch) {
    const n = Math.max(1, Math.round(length / nominalPitch));
    return { pitch: length / n, count: n };
}

export function ridgeOffset(s, pitch, height) {
    return (height / 2) * (1 - Math.cos((2 * Math.PI * s) / pitch));
}

// ---------------------------------------------------------------------------
// Tree helpers (pure editing API used by the app)
// ---------------------------------------------------------------------------

export const SIMPLE_TYPES = ['straight', 'curveL', 'curveR', 'lift'];
export const isSwitchNode = (n) => typeof n === 'object' && n !== null && (n.type === 'switchL' || n.type === 'switchR');

/** Array a `containerPath` refers to: [] = root; [i,'main',...] descends switches. */
export function getContainer(sequence, containerPath) {
    let arr = sequence;
    for (let k = 0; k < containerPath.length; k += 2) {
        const node = arr[containerPath[k]];
        if (!isSwitchNode(node)) throw new Error(`bad container path at ${containerPath[k]}`);
        arr = node[containerPath[k + 1]];
    }
    return arr;
}

/** Node addressed by [...containerPath, index]. */
export function nodeAt(sequence, address) {
    const arr = getContainer(sequence, address.slice(0, -1));
    return arr[address[address.length - 1]];
}

export const pathKey = (p) => JSON.stringify(p);

/**
 * All open build ends: containers that do not terminate in a switch.
 * (A container ending in a switch builds through the switch's branches.)
 */
export function openContainers(sequence) {
    const out = [];
    const visit = (arr, path) => {
        const last = arr[arr.length - 1];
        if (isSwitchNode(last)) {
            visit(last.main, [...path, arr.length - 1, 'main']);
            visit(last.branch, [...path, arr.length - 1, 'branch']);
        } else {
            out.push(path);
        }
        arr.forEach((n, i) => {
            if (isSwitchNode(n) && i < arr.length - 1) {
                // defensive: mid-array switches shouldn't exist, but don't lose them
                visit(n.main, [...path, i, 'main']);
                visit(n.branch, [...path, i, 'branch']);
            }
        });
    };
    visit(sequence, []);
    return out;
}

/** Appends a full 360° spiral tier (4 quarter-turns) to a node array. */
export function appendSpiralTier(sequence, direction = 'L') {
    const t = direction === 'L' ? 'curveL' : 'curveR';
    return [...sequence, t, t, t, t];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function segmentPlan(kind, entry, params) {
    const { x, z, h } = entry;
    const dir = [Math.cos(h), Math.sin(h)];
    if (kind === 'straightish') {
        const len = params.len;
        return { planLen: len, exit: { x: x + dir[0] * len, z: z + dir[1] * len, h }, radius: null, center: null, turn: 0 };
    }
    // curve: params.turnSign ±1, radius R
    const R = params.radius;
    const turn = params.turnSign * Math.PI / 2;
    const [nx, nz] = rot2(dir[0], dir[1], Math.sign(turn) * Math.PI / 2);
    const center = [x + nx * R, z + nz * R];
    const [rx, rz] = rot2(x - center[0], z - center[1], turn);
    return {
        planLen: (Math.PI / 2) * R,
        exit: { x: center[0] + rx, z: center[1] + rz, h: h + turn },
        radius: R, center, turn
    };
}

/**
 * Lays out the full track tree. Returns flat `pieces` in depth-first order
 * (main before branch) with tree metadata:
 *   piece.address     — [...containerPath, index] of the source node
 *   piece.role        — 'main' | 'branch' for the two exits of a switch node
 *   piece.switchKey   — shared by a switch's two role pieces
 *   piece.active      — lies on the ride path given current gate settings
 *   piece.isLift      — powered ascending section
 * Plus `openEnds` (arrow targets), `switches` (gate toggles), `issues`.
 */
export function layoutTrack(sequence, params = {}) {
    const p = {
        slopeDeg: SPEC.slope.default,
        innerWidth: SPEC.innerWidth.default,
        curveRadius: SPEC.defaultCurveRadius,
        tileLen: SPEC.tileLen,
        platformLen: SPEC.platformLen,
        waterfall: SPEC.waterfallStepMm,
        skirtDepth: SPEC.skirtDepth,
        ridgeHeight: SPEC.ridge.height,
        ridgePitch: SPEC.ridge.pitch,
        ...params
    };

    const issues = [];
    if (p.slopeDeg < SPEC.slope.hardMin || p.slopeDeg > SPEC.slope.hardMax) {
        issues.push({ level: 'error', code: 'slope-out-of-range', msg: `Slope ${p.slopeDeg}° is outside the ${SPEC.slope.hardMin}–${SPEC.slope.hardMax}° operating window.` });
    } else if (p.slopeDeg < SPEC.slope.greenMin || p.slopeDeg > SPEC.slope.greenMax) {
        issues.push({ level: 'warn', code: 'slope-marginal', msg: `Slope ${p.slopeDeg}° works but the sweet spot is ${SPEC.slope.greenMin}–${SPEC.slope.greenMax}°.` });
    }
    if (p.curveRadius < SPEC.minCurveRadius) {
        issues.push({ level: 'error', code: 'radius-too-tight', msg: `Curve radius ${p.curveRadius} mm is below the ${SPEC.minCurveRadius} mm minimum — a rigid figure will wedge across the channel.` });
    }

    const tanSlope = Math.tan(degToRad(p.slopeDeg));
    const pieces = [];
    const openEnds = [];
    const switches = [];
    let pieceCounter = 0;

    const makePiece = (kind, node, cursor, entryDeck, meta) => {
        let plan, drop, slopeDeg, isLift = false, innerWidth = p.innerWidth;
        if (kind === 'start' || kind === 'end') {
            plan = segmentPlan('straightish', cursor, { len: p.platformLen });
            drop = 0; slopeDeg = 0;
        } else if (kind === 'straight' || kind === 'switchMain') {
            plan = segmentPlan('straightish', cursor, { len: p.tileLen });
            drop = plan.planLen * tanSlope; slopeDeg = p.slopeDeg;
        } else if (kind === 'lift') {
            plan = segmentPlan('straightish', cursor, { len: p.tileLen });
            drop = -plan.planLen * tanSlope; slopeDeg = -p.slopeDeg; isLift = true;
        } else { // curveL / curveR / switchBranch
            const sign = (kind === 'curveL' || meta.switchType === 'switchL') ? 1 : -1;
            plan = segmentPlan('curve', cursor, { radius: p.curveRadius, turnSign: sign });
            drop = plan.planLen * tanSlope; slopeDeg = p.slopeDeg;
            innerWidth = p.innerWidth + SPEC.curveWidenMm;
        }
        const exitDeck = entryDeck - drop;
        const ridge = effectiveRidgePitch(plan.planLen, p.ridgePitch);
        const piece = {
            type: kind, index: pieceCounter++,
            name: `${String(pieceCounter - 1).padStart(2, '0')}_${kind}`,
            entry: { ...cursor }, exit: { ...plan.exit },
            planLen: plan.planLen, radius: plan.radius, center: plan.center, turn: plan.turn,
            slopeDeg, drop, entryDeck, exitDeck,
            rimY: Math.min(entryDeck, exitDeck) - p.skirtDepth,
            innerWidth, isLift,
            ridgePitch: ridge.pitch, ridgeCount: ridge.count,
            ...meta
        };
        pieces.push(piece);
        return piece;
    };

    /** Walks a node array; returns the final {cursor, deck} for linear chains (null after a switch). */
    const walk = (nodes, prevExit, containerPath, active, capEnd = true) => {
        let cursor = prevExit.cursor;
        let deck = prevExit.deck;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const address = [...containerPath, i];
            const entryDeck = deck - p.waterfall;
            if (isSwitchNode(node)) {
                const gate = node.gate === 'branch' ? 'branch' : 'main';
                const switchKey = pathKey(address);
                const main = makePiece('switchMain', node, cursor, entryDeck,
                    { address, role: 'main', switchKey, switchType: node.type, active: active && gate === 'main', gateOpen: gate === 'main' });
                const branch = makePiece('switchBranch', node, cursor, entryDeck,
                    { address, role: 'branch', switchKey, switchType: node.type, active: active && gate === 'branch', gateOpen: gate === 'branch' });
                // the two route shells are printed as ONE part — share the lower
                // rim plane so the merged solid sits flat on the build plate
                const sharedRim = Math.min(main.rimY, branch.rimY);
                main.rimY = sharedRim;
                branch.rimY = sharedRim;
                switches.push({ address, key: switchKey, gate, entry: { ...cursor }, deck: entryDeck, type: node.type });
                if (i < nodes.length - 1) {
                    issues.push({ level: 'error', code: 'switch-not-last', msg: 'A switch must be the last piece of its branch — pieces after it are unreachable.' });
                }
                walk(node.main ?? [], { cursor: main.exit, deck: main.exitDeck }, [...address, 'main'], active && gate === 'main');
                walk(node.branch ?? [], { cursor: branch.exit, deck: branch.exitDeck }, [...address, 'branch'], active && gate === 'branch');
                return null;
            }
            const piece = makePiece(node, node, cursor, entryDeck, { address, active });
            cursor = piece.exit;
            deck = piece.exitDeck;
        }
        if (capEnd) {
            // leaf: implicit end platform + an open build end just before it
            openEnds.push({ containerPath, cursor: { ...cursor }, deck });
            makePiece('end', 'end', cursor, deck - p.waterfall, { address: [...containerPath, nodes.length], active, isImplicitEnd: true });
        }
        return { cursor, deck };
    };

    if (p.loop) {
        // LOOP MODE: no start/end platforms on the root — the path is a ring.
        // The closure seam must land back on the first piece's entry: same
        // plan position and heading, and stepping DOWN 0.25–3 mm (a circuit
        // must regain via lifts exactly what it spends descending).
        if (sequence.some(isSwitchNode)) {
            issues.push({ level: 'error', code: 'loop-no-switch', msg: 'Loop mode does not support a switch on the main ring yet — put switches on non-loop designs.' });
        }
        const tail = walk(sequence, { cursor: { x: 0, z: 0, h: 0 }, deck: 0 }, [], true /*active*/, false);
        const first = pieces[0];
        if (!sequence.length || !tail || !first) {
            issues.push({ level: 'error', code: 'loop-open', msg: 'Loop mode: add pieces to form the ring.' });
            openEnds.push({ containerPath: [], cursor: tail?.cursor ?? { x: 0, z: 0, h: 0 }, deck: tail?.deck ?? 0 });
        } else {
            const dx = tail.cursor.x - first.entry.x;
            const dz = tail.cursor.z - first.entry.z;
            const dh = Math.abs(((tail.cursor.h - first.entry.h) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
            const stepDown = tail.deck - first.entryDeck;
            const posOk = Math.hypot(dx, dz) <= 5 && dh <= 0.04;
            const elevOk = stepDown >= p.waterfall - 0.05 && stepDown <= 3;
            if (!posOk || !elevOk) {
                const hints = [];
                if (!posOk) hints.push(`ends ${Math.hypot(dx, dz).toFixed(0)} mm / ${radToDeg(dh).toFixed(0)}° from the start`);
                if (!elevOk) hints.push(stepDown < p.waterfall
                    ? `needs ${(p.waterfall - stepDown).toFixed(1)} mm more lift (an uphill lip would trip the figure)`
                    : `closure step-down ${stepDown.toFixed(1)} mm exceeds the 3 mm limit — add descent or remove a lift`);
                issues.push({ level: 'error', code: 'loop-open', msg: `Loop does not close: ${hints.join('; ')}.` });
                openEnds.push({ containerPath: [], cursor: { ...tail.cursor }, deck: tail.deck });
            }
        }
    } else {
        const start = makePiece('start', 'start', { x: 0, z: 0, h: 0 }, 0, { address: [-1], active: true, isImplicitStart: true });
        walk(sequence, { cursor: start.exit, deck: start.exitDeck }, [], true);
    }

    // ground shift: lowest skirt rim rests on the ground
    const minRim = Math.min(...pieces.map(pc => pc.rimY));
    for (const pc of pieces) {
        pc.entryDeck -= minRim;
        pc.exitDeck -= minRim;
        pc.rimY -= minRim;
    }
    for (const sw of switches) sw.deck -= minRim;
    for (const oe of openEnds) oe.deck -= minRim;

    const active = pieces.filter(pc => pc.active);
    const totalDropMm = active.length ? active[0].entryDeck - active[active.length - 1].exitDeck : 0;
    issues.push(...checkClearances(pieces, p));
    return { pieces, issues, totalDropMm, params: p, openEnds, switches };
}

/**
 * The linear piece list the figure actually rides, following current gate
 * settings. Depth-first emission order + active flags make this a filter.
 */
export function resolveRidePath(pieces) {
    return pieces.filter(pc => pc.active);
}

export function deckYAt(piece, s) {
    const f = piece.planLen === 0 ? 0 : s / piece.planLen;
    return piece.entryDeck - piece.drop * f;
}

export function planPosAt(piece, s) {
    if (!piece.radius) {
        const dir = [Math.cos(piece.entry.h), Math.sin(piece.entry.h)];
        return { x: piece.entry.x + dir[0] * s, z: piece.entry.z + dir[1] * s, h: piece.entry.h };
    }
    const a = (s / piece.planLen) * piece.turn;
    const [rx, rz] = rot2(piece.entry.x - piece.center[0], piece.entry.z - piece.center[1], a);
    return { x: piece.center[0] + rx, z: piece.center[1] + rz, h: piece.entry.h + a };
}

export function stationsForPiece(piece, maxStep = 8) {
    const n = Math.max(2, Math.ceil(piece.planLen / maxStep) + 1);
    const stations = [];
    for (let i = 0; i < n; i++) {
        const s = (piece.planLen * i) / (n - 1);
        const { x, z, h } = planPosAt(piece, s);
        stations.push({
            s,
            origin: [x, deckYAt(piece, s), z],
            right: [Math.sin(h), 0, -Math.cos(h)] // zero-bank rule
        });
    }
    return stations;
}

/** Dense centerline samples for simulation — expects a LINEAR piece list. */
export function samplePath(pieces, step = 5) {
    const samples = [];
    let total = 0;
    for (let i = 0; i < pieces.length; i++) {
        const pc = pieces[i];
        const n = Math.max(2, Math.ceil(pc.planLen / step) + 1);
        for (let k = 0; k < n - (i < pieces.length - 1 ? 1 : 0); k++) {
            const s = (pc.planLen * k) / (n - 1);
            const { x, z, h } = planPosAt(pc, s);
            samples.push({
                x, z, h,
                y: deckYAt(pc, s),
                slopeDeg: pc.slopeDeg,
                pieceIndex: i,
                dist: total + s
            });
        }
        total += pc.planLen;
    }
    return samples;
}

/**
 * Collision-aware support planning. A naive pillar under each piece's midpoint
 * spears straight through the tier below on stacked spirals, so every support
 * column is checked against all pieces beneath it:
 *  - 'center': the usual under-boss pillar, tried at several stations
 *  - 'outrigger': boss moved laterally outboard on a printable arm (curves
 *    prefer their outer side) so the pillar drops beside the lower tier
 *  - 'none': no clear column exists — reported so the UI can warn
 *
 * @returns Array<{ pieceIndex, mode, x, z, h, side?, s? }>
 */
export function planPillarPositions(pieces, params = {}) {
    const outerHalfOf = (pc) => pc.innerWidth / 2 + SPEC.wall;
    const clearR = SPEC.socket.pillarR + 2;
    const armOffsetOf = (pc) => outerHalfOf(pc) + SPEC.socket.bossR + 4;

    const samples = pieces.map(pc => {
        const n = Math.max(2, Math.ceil(pc.planLen / 20) + 1);
        const pts = [];
        for (let k = 0; k < n; k++) {
            const s = (pc.planLen * k) / (n - 1);
            const pos = planPosAt(pc, s);
            pts.push([pos.x, deckYAt(pc, s), pos.z]);
        }
        return pts;
    });

    const columnBlocked = (x, z, topY, ignore) => {
        for (let j = 0; j < pieces.length; j++) {
            if (ignore.has(j)) continue;
            const q = pieces[j];
            const reach = outerHalfOf(q) + clearR;
            for (const pt of samples[j]) {
                if (pt[1] >= topY - 1) continue; // only geometry beneath obstructs
                const dx = x - pt[0], dz = z - pt[2];
                if (dx * dx + dz * dz < reach * reach) return true;
            }
        }
        return false;
    };

    const supports = [];
    for (const pc of pieces) {
        if (pc.rimY <= 1 || pc.role === 'branch') continue; // ground / merged with main
        const ignore = new Set(
            pc.switchKey
                ? pieces.filter(q => q.switchKey === pc.switchKey).map(q => q.index)
                : [pc.index]
        );
        let placed = null;
        for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
            const pos = planPosAt(pc, f * pc.planLen);
            if (!columnBlocked(pos.x, pos.z, pc.rimY, ignore)) {
                placed = { pieceIndex: pc.index, mode: 'center', x: pos.x, z: pos.z, h: pos.h, s: f * pc.planLen };
                break;
            }
        }
        if (!placed) {
            // curves hang the arm outboard first; straights try both sides
            const sides = pc.turn > 0 ? [1, -1] : pc.turn < 0 ? [-1, 1] : [1, -1];
            outer: for (const side of sides) {
                for (const f of [0.5, 0.35, 0.65]) {
                    const pos = planPosAt(pc, f * pc.planLen);
                    const right = [Math.sin(pos.h), -Math.cos(pos.h)];
                    const off = armOffsetOf(pc) * side;
                    const bx = pos.x + right[0] * off;
                    const bz = pos.z + right[1] * off;
                    if (!columnBlocked(bx, bz, pc.rimY, ignore)) {
                        placed = { pieceIndex: pc.index, mode: 'outrigger', x: bx, z: bz, h: pos.h, side, s: f * pc.planLen };
                        break outer;
                    }
                }
            }
        }
        supports.push(placed ?? { pieceIndex: pc.index, mode: 'none', x: 0, z: 0, h: 0 });
    }
    return supports;
}

/**
 * Spiral-tier / branch clearance check. Pieces that share an endpoint
 * (parent-child seams, switch siblings) are exempt; everything else that
 * overlaps in plan needs SPEC.clearanceHeight of vertical separation.
 */
export function checkClearances(pieces, params) {
    const issues = [];
    const outerW = (params.innerWidth ?? SPEC.innerWidth.default) + 2 * SPEC.wall + SPEC.curveWidenMm;
    const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 2;
    const related = (a, b) =>
        near(a.exit, b.entry) || near(b.exit, a.entry) || near(a.entry, b.entry) || near(a.exit, b.exit);

    const sampled = pieces.map(pc => {
        const n = Math.max(2, Math.ceil(pc.planLen / 25) + 1);
        const pts = [];
        for (let k = 0; k < n; k++) {
            const s = (pc.planLen * k) / (n - 1);
            const pos = planPosAt(pc, s);
            pts.push([pos.x, deckYAt(pc, s), pos.z]);
        }
        return pts;
    });

    for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) {
            if (related(pieces[i], pieces[j])) continue;
            let clash = false;
            for (const a of sampled[i]) {
                for (const b of sampled[j]) {
                    const dx = a[0] - b[0], dz = a[2] - b[2];
                    if (dx * dx + dz * dz < outerW * outerW && Math.abs(a[1] - b[1]) < SPEC.clearanceHeight) {
                        clash = true; break;
                    }
                }
                if (clash) break;
            }
            if (clash) {
                issues.push({
                    level: 'error', code: 'clearance', i, j,
                    msg: `Pieces ${pieces[i].name} and ${pieces[j].name} overlap with less than ${SPEC.clearanceHeight} mm of vertical clearance — the figure will strike the tier above.`
                });
            }
        }
    }
    return issues;
}
