#!/usr/bin/env node
/**
 * UNDER-DECK VARIANTS FOR THE CURVE — build, GATE, render, slice, score.
 *
 * This script exists because the last round of curve experiments did not have
 * it. They were built in scratchpad scripts that CONCATENATED ribs, spines and
 * lattice onto the shell instead of unioning them: four of eight meshes came
 * out non-manifold (up to 6518 bad edges), they were sliced anyway, and every
 * number taken off them — including the "lattice wins" verdict that shaped two
 * sessions — was void, because a slicer's reading of a non-manifold mesh is
 * undefined. See HANDOFF.md §3.2.
 *
 * So the gate is the point of this file, not the variants:
 *
 *   1. every variant is built by the REAL builder (`buildPieceExportGeometry`)
 *      through its `extraOps` seam, so the added geometry goes through
 *      `csgChain`/manifold-3d and is watertight by construction;
 *   2. `analyzeMesh` runs BEFORE anything is written. A variant that fails is
 *      not written, not sliced and not scored — it is reported and dropped;
 *   3. the FOOTPRINT RULE is checked against the baseline: nothing may reach
 *      past an end face, and nothing may float above the bed. The old lattice
 *      grew ragged tabs past its end face and nobody looked;
 *   4. an underside render is written for every variant, because that is where
 *      those tabs were visible at a glance.
 *
 * Only then does it slice (BambuStudio CLI) and score with
 * `scripts/unsupported_runs.mjs`'s metric: OPEN-ENDED unsupported run length,
 * i.e. plastic that stops in mid-air. Bridges anchored at both ends are fine
 * and are reported separately.
 *
 *   node scripts/curve_variants.mjs                 # build + gate + render
 *   node scripts/curve_variants.mjs --slice         # ... and slice + score
 *   node scripts/curve_variants.mjs --only baseline,honeycomb_8
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fflate from 'fflate';
import { layoutTrack, planPillarPositions, planPosAt, deckYAt, undersidePlane, pieceInFrame, SPEC } from '../js/track.js';
import { initCSG, buildPieceExportGeometry, toBufferGeometry, csgChain, ADDITION, SUBTRACTION } from '../js/pieces.js';
import { sweepSolid, extrudePolygonY, hexPlan, circlePlan, bowtieKeyPlan } from '../js/geometry.js';
import { generateMultiObject3MFXML } from '../js/export_3mf.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { moves, pathLength, pointAt } from './gcode_path.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let OUT = path.join(ROOT, 'test-parts', 'curve_variants');
const BAMBU = '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const PRESETS = `${process.env.HOME}/Library/Application Support/BambuStudio/system/BBL`;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DO_SLICE = argv.includes('--slice');
const ONLY = (flag('only', '') || '').split(',').filter(Boolean);
const PIECE = flag('piece', 'curveR');
// `--piece straight` is the CONTROL, and it needs its own folder or it
// overwrites the curve's slices. A minimal straight prints beautifully, so any
// run length it also carries is a run length that does not predict failure.
OUT = path.resolve(flag('out', OUT));
// PETG, because PETG is the only material this project prints (CLAUDE.md).
const PROCESS = flag('process', '0.20mm Standard @BBL P2S');
const MACHINE = flag('machine', 'Bambu Lab P2S 0.4 nozzle');
const FILAMENT = flag('filament', 'Bambu PETG HF @BBL P2S 0.4 nozzle');

// ---------------------------------------------------------------------------
// The variants
// ---------------------------------------------------------------------------

/**
 * A HONEYCOMB STANDING ON THE BED, which is what Brett actually asked for and
 * what has never actually been built:
 *
 *   "you should be able to put a full 'honeycomb' rising from the floor just
 *    like the side rails so there is no unsupported bed, but it is the anchor
 *    points that are key to reduce the bridge length."
 *
 * The file that was supposed to test this (07_LATTICE_8mm) was a shallow waffle
 * hanging off the underside; it never reached the bed, so it did not implement
 * the idea, and it was non-manifold besides.
 *
 * Built as a SOLID BLOCK filling the whole cavity, with vertical hex prisms cut
 * out of it — the walls are what is left. Doing it that way rather than drawing
 * each wall means:
 *   - the block's bottom is the underside PLANE (the surface the part is laid
 *     on and printed from), so every wall reaches the bed exactly, and
 *   - the block's top is the deck ceiling, which FALLS at the ramp slope, so no
 *     wall gets the level top that CLAUDE.md forbids under a deck.
 * The holes are cut from the block ALONE, before it is offered to the piece, so
 * a vertical prism can never reach up through the walking surface.
 */
function cavityOps({ pitchMm, holePlan, sMarginOverride }) {
    return (piece, spec) => {
        const pl = undersidePlane(piece, spec);
        const Wi = piece.innerWidth / 2;
        // Reach half a wall thickness INTO the rails: the walls have to be
        // anchored to something, and a block that merely touches the channel
        // faces leaves a numerical sliver at the join.
        const uHalf = Wi + spec.wall / 2;
        // Clear the end ribs and their bowtie pockets — the footprint rule and
        // the pocket both live in the first `ribThk` of the piece.
        const sMargin = sMarginOverride ?? (spec.key.ribThk + 0.5);
        const s0 = sMargin, s1 = piece.planLen - sMargin;

        const N = Math.max(2, Math.ceil((s1 - s0) / 3) + 1);
        const stations = [], profiles = [];
        let yLo = Infinity, yHi = -Infinity;
        for (let i = 0; i < N; i++) {
            const s = s0 + ((s1 - s0) * i) / (N - 1);
            const p = planPosAt(piece, s), y = deckYAt(piece, s);
            const right = [Math.sin(p.h), 0, -Math.cos(p.h)];
            stations.push({ s, origin: [p.x, y, p.z], right });
            // The underside is a plane, so its height across the profile is
            // linear in u and two corners describe it exactly.
            const botAt = (u) => pl.at(p.x + right[0] * u, p.z + right[2] * u) - y;
            // TOP PUSHED 0.3 mm UP INTO THE FLOOR, which is already solid, so
            // the union's shape is unchanged and the floor stays 2 mm — but the
            // block's top face is no longer EXACTLY coplanar with the shell's
            // ceiling. On a curve the two surfaces are tessellated at slightly
            // different angles and never quite coincide, so this was not
            // needed; on a STRAIGHT the underside plane and the deck ceiling
            // are exactly parallel over a big flat rectangle, the faces landed
            // exactly on each other, and the union came back with 18
            // non-manifold edges. The gate caught it, which is the point.
            const bL = botAt(-uHalf), bR = botAt(uHalf), top = -spec.floorThk + 0.3;
            profiles.push([[-uHalf, bL], [uHalf, bR], [uHalf, top], [-uHalf, top]]);
            yLo = Math.min(yLo, y + bL, y + bR);
            yHi = Math.max(yHi, y + top);
        }
        const block = toBufferGeometry(sweepSolid(profiles, stations));

        // Grid over the block's plan footprint, culled to the piece so the CSG
        // is not spent on prisms that miss it entirely.
        const rowPitch = pitchMm * Math.sqrt(3) / 2;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const st of stations) {
            for (const u of [-uHalf, uHalf]) {
                const x = st.origin[0] + st.right[0] * u, z = st.origin[2] + st.right[2] * u;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                z0 = Math.min(z0, z); z1 = Math.max(z1, z);
            }
        }
        const near = (x, z) => {
            let d = Infinity;
            for (const st of stations) d = Math.min(d, Math.hypot(x - st.origin[0], z - st.origin[2]));
            return d;
        };
        const holes = [];
        let row = 0;
        for (let z = z0 - pitchMm; z <= z1 + pitchMm; z += rowPitch, row++) {
            const xOff = (row % 2) * (pitchMm / 2);
            for (let x = x0 - pitchMm + xOff; x <= x1 + pitchMm; x += pitchMm) {
                if (near(x, z) > uHalf + pitchMm) continue;
                holes.push({
                    op: SUBTRACTION,
                    geometry: toBufferGeometry(extrudePolygonY(
                        holePlan.map(([hx, hy]) => [x + hx, z + hy]), yLo - 5, yHi + 5))
                });
            }
        }
        // DECIMATION TOLERANCE 0, AND THIS IS NOT A DETAIL.
        //
        // At the production 0.01 mm the comb comes back reporting manifold and
        // clean — and then the union of it with the shell has 3 non-manifold
        // edges and inconsistent winding. Cutting 140 hex prisms out of a slab
        // with a slanted top and bottom leaves slivers at every hole rim;
        // collapsing those to 0.01 mm makes triangles thin enough to defeat the
        // NEXT boolean's predicates, and the damage does not show up until then.
        // Built at tol 0 the same union is watertight. The final `csgChain` in
        // `buildPieceExportGeometry` decimates once, at the end, which is where
        // it belongs: an intermediate result is not a deliverable.
        const combed = csgChain(block, holes, 0);
        return [{ op: ADDITION, geometry: combed }];
    };
}

/**
 * SPINES — walls running ALONG the piece, which is Brett's idea and is probably
 * the right shape of the answer:
 *
 *   "I have wondered what would happen if you just put a center spine down the
 *    underside, just like the outer walls, effectively halving the bridge
 *    distance across the ramp."
 *
 * The arithmetic is on his side. A straight's ceiling bridges WALL TO WALL
 * across the 48 mm channel, and 13 m of those 40-48 mm spans is what strands.
 * One centre spine halves every one of them to 24 mm — and the honeycomb that
 * just worked tops out at 23.4 mm. Same span, and a single 0.8 mm wall is about
 * 1.8 cm3 against the honeycomb's 11.3.
 *
 * Spines were "tried and refuted" once before, but that verdict does not carry:
 * it was measured on a CURVE (whose ceiling contours run along the arc, not
 * across it), on meshes 04/05 that were non-manifold and whose scores are void,
 * with a metric that could not see anchors. None of that applies to a straight.
 *
 * The one thing a spine has that a honeycomb does not is a free edge: a lone
 * 0.8 mm wall standing 15 mm off the bed has nothing bracing it sideways, where
 * hex cells brace each other at every vertex. Anchored into both end ribs it
 * should be fine, but that is what a print decides.
 */
function spineOps({ count, thickMm }) {
    return (piece, spec) => {
        const pl = undersidePlane(piece, spec);
        const Wi = piece.innerWidth / 2;
        const sMargin = spec.key.ribThk + 0.5;
        const s0 = sMargin, s1 = piece.planLen - sMargin;
        const N = Math.max(2, Math.ceil((s1 - s0) / 3) + 1);

        // Evenly divide the channel into count+1 equal bays.
        const us = [];
        for (let i = 1; i <= count; i++) us.push(-Wi + (2 * Wi * i) / (count + 1));

        return us.map((u) => {
            const stations = [], profiles = [];
            for (let i = 0; i < N; i++) {
                const sAt = s0 + ((s1 - s0) * i) / (N - 1);
                const p = planPosAt(piece, sAt), y = deckYAt(piece, sAt);
                const right = [Math.sin(p.h), 0, -Math.cos(p.h)];
                stations.push({ s: sAt, origin: [p.x, y, p.z], right });
                const botAt = (uu) => pl.at(p.x + right[0] * uu, p.z + right[2] * uu) - y;
                // 0.3 mm up into the floor, which is already solid — same reason
                // as the honeycomb block: no exactly-coplanar face with the
                // shell's ceiling.
                const top = -spec.floorThk + 0.3;
                profiles.push([
                    [u - thickMm / 2, botAt(u - thickMm / 2)],
                    [u + thickMm / 2, botAt(u + thickMm / 2)],
                    [u + thickMm / 2, top],
                    [u - thickMm / 2, top]
                ]);
            }
            return { op: ADDITION, geometry: toBufferGeometry(sweepSolid(profiles, stations)) };
        });
    };
}

const spines = (count, thickMm) => ({
    name: `spine_${count}_${String(thickMm).replace('.', 'p')}`,
    note: `${count} spine(s) along the piece, ${thickMm} mm, bed to deck`,
    kind: 'spine',
    ops: spineOps({ count, thickMm })
});

/** Hex cells: walls of `wallMm` left between hex holes on a `cellMm` grid. */
const cell = (cellMm, wallMm) => ({
    name: `honeycomb_${cellMm}_${String(wallMm).replace('.', 'p')}`,
    note: `hex cells ${cellMm} mm, ${wallMm} mm walls, bed to deck`,
    kind: 'honeycomb',
    // ROTATED 30 deg, because hexPlan(af, 0) puts a VERTEX on +x and therefore
    // its flat-sharing neighbours on y and y+/-60 — while the grid below steps
    // along x by the pitch. Unrotated the holes do not tessellate: they overlap
    // on one axis and leave a wedge of solid on another, which is why the first
    // renders showed triangular blobs rather than walls and why a 24 mm cell
    // still cost 17 cm3. With flats facing the grid it is a real honeycomb.
    ops: cavityOps({ pitchMm: cellMm, holePlan: hexPlan(cellMm - wallMm, Math.PI / 6) })
});

/**
 * POSTS, which is the sparse limit of the same idea and much closer to what
 * Brett actually asked for. He said "it is the ANCHOR POINTS that are key to
 * reduce the bridge length" — I read "honeycomb" literally, filled the cavity
 * and handed back a 130 g curve. A bridge does not care what it lands on, only
 * how far away the next landing is.
 *
 * Cut ROUND holes on a grid at a radius LARGER than half the pitch: the circles
 * overlap, the walls between them vanish, and what survives is a post at each
 * grid corner. Same block-minus-prisms machinery, so the posts still stand on
 * the underside plane and still stop at the falling deck ceiling.
 *
 * THE GRID IS TRIANGULAR, NOT SQUARE, and the first cut of this got that wrong:
 * rows are offset by half a pitch, so three neighbouring centres form an
 * equilateral triangle and the surviving post sits at its circumcentre,
 * pitch/sqrt(3) from each — not pitch/sqrt(2). Sized for a square grid the
 * circles overlapped the posts away completely and all three variants came back
 * byte-identical to the baseline. `postMm` is the post's width across corners:
 * r = pitch/sqrt(3) - postMm/2, and a post exists only while that is positive.
 */
const posts = (pitchMm, postMm) => ({
    name: `posts_${pitchMm}_${String(postMm).replace('.', 'p')}`,
    note: `posts ${postMm} mm across on a ${pitchMm} mm grid, bed to deck`,
    kind: 'posts',
    ops: cavityOps({
        pitchMm,
        holePlan: circlePlan(pitchMm / Math.sqrt(3) - postMm / 2)
    })
});

// 1.6 mm walls are four extrusions and cost 46 cm3 on a 12 mm cell — a quarter
// of the cavity turned solid. 0.8 mm is two, which is what a slicer's own
// honeycomb infill uses, and a hex cell is self-bracing at every vertex so a
// thin wall standing 20 mm off the bed is held on three sides. Anchor SPACING
// is the variable that is supposed to matter here; wall thickness is in the
// sweep to find out whether it does.
const VARIANTS = [
    { name: 'baseline', note: 'minimal curve as it ships — the number to beat', ops: null },
    // Brett, on the first sweep: "far too much support structure underneath."
    // He is right — 12/1.6 added 46 cm3 to an 86 cm3 part. These are the sparse
    // end of the same family, kept alongside the heavy ones so the mass/benefit
    // curve is visible rather than asserted.
    cell(12, 0.8), cell(12, 1.6), cell(8, 0.8), cell(8, 1.6),
    cell(16, 0.8), cell(20, 0.8), cell(24, 0.8), cell(16, 0.45), cell(24, 0.45),
    posts(14, 3), posts(18, 3), posts(22, 3.5),
    spines(1, 0.8), spines(1, 1.6), spines(2, 0.8), spines(3, 0.8),
    // A GATE THAT HAS NEVER REJECTED ANYTHING IS NOT KNOWN TO WORK. This one
    // runs the comb straight through the end ribs, sealing the bowtie throat;
    // `--selftest` builds it and PASSES ONLY IF IT IS REJECTED. Without it the
    // key-throat cast could quietly be casting into empty space — which is the
    // shape of the detent test that passed on a part whose keys could not be
    // fitted at all (PLAN.md, 2026-08-08).
    { name: 'SELFTEST_comb_through_the_pocket', selfTest: true,
        note: 'seals the key throat on purpose — the gate must reject it',
        ops: cavityOps({ pitchMm: 12, holePlan: hexPlan(12 - 1.6, Math.PI / 6), sMarginOverride: 0 }) },

    // THE VIADUCT CURVE HAS NEVER BEEN PRINTED AT THE WALL IT NOW HAS.
    //
    // Its arched skirts failed and its deck came out clean. That print was
    // taken at `SPEC.wall` = 1.6, during a spell when the wall had been cut
    // 2.4 -> 1.6 to save plastic; PLAN.md records the revert and the mechanism
    // — an `ARCH.pier` is 8 mm long, so at 1.6 a pier meets the bed on 12.8 mm2
    // and carries a 40 mm wall above it, and a centre pier on a STRAIGHT
    // shifted on the plate and welded back on crooked. At 2.4 the same pier
    // gets 19.2 mm2. Brett: the skirt failures were "made worse by the walling
    // thinning we had previously done, but now have undone."
    //
    // So these two are the same part before and after a change that has already
    // shipped, and the comparison is free. Bed contact is the number to read,
    // not the run length: a pier does not droop, it topples.
    { name: 'viaduct_wall1p6_as_printed', style: 'viaduct', wall: 1.6, ops: null,
        note: 'viaduct curve at the wall the FAILED print was taken at' },
    { name: 'viaduct_wall2p4_current', style: 'viaduct', wall: 2.4, ops: null,
        note: 'viaduct curve as the code stands now — never printed' }
];

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function bounds(g) {
    const p = g.positions;
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
    for (let i = 0; i < p.length; i += 3) {
        b.x0 = Math.min(b.x0, p[i]); b.x1 = Math.max(b.x1, p[i]);
        b.y0 = Math.min(b.y0, p[i + 1]); b.y1 = Math.max(b.y1, p[i + 1]);
        b.z0 = Math.min(b.z0, p[i + 2]); b.z1 = Math.max(b.z1, p[i + 2]);
    }
    return b;
}

/**
 * Triangle area lying within `tol` of the lowest point — the part's bed
 * contact. A variant that grows a spike below the underside plane balances on
 * it, and the first version of `tiltOntoUnderside` was reverted for exactly
 * that (2 mm² of contact against 618).
 */
function bedContactMm2(g, tol = 0.15) {
    const p = g.positions, ix = g.indices;
    let lo = Infinity;
    for (let i = 1; i < p.length; i += 3) lo = Math.min(lo, p[i]);
    let area = 0;
    for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        if (p[a + 1] > lo + tol || p[b + 1] > lo + tol || p[c + 1] > lo + tol) continue;
        const ux = p[b] - p[a], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vz = p[c + 2] - p[a + 2];
        area += Math.abs(ux * vz - uz * vx) / 2;
    }
    return area;
}

/**
 * CAN THE KEY STILL BE FITTED? Under-deck geometry is added into the same
 * cavity the key rises through, and a variant that seals the throat is a
 * variant that cannot join to anything — worth nothing however well it prints.
 *
 * The same ray cast `tests/pieces.test.js` uses on shipped parts: take the
 * key's real printed footprint, fire a ray up through the finished mesh at
 * every point of it, and require the travel from the rim to the seat to be
 * clear. The honeycomb here starts `ribThk + 0.5` = 12.5 mm from the face and
 * the key reaches 9.3 mm, so it is clear by construction — which is exactly the
 * kind of reasoning that put four void meshes in the record, so it is measured
 * instead. Run on the UNTILTED mesh, where "up" is still the key's own axis.
 */
function keyThroatBlock(gFlat, pc, spec) {
    const plan = bowtieKeyPlan({
        neckHalf: spec.key.neckHalf, tipHalf: spec.key.tipHalf,
        depth: spec.key.depth, tipChamfer: spec.key.tipChamfer
    });
    const xs = plan.map(p => p[0]), zs = plan.map(p => p[1]);
    const inside = (x, z) => {
        let hit = false;
        for (let i = 0, j = plan.length - 1; i < plan.length; j = i++) {
            const [xi, zi] = plan[i], [xj, zj] = plan[j];
            if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
        }
        return hit;
    };
    const p = gFlat.positions, ix = gFlat.indices;
    const pocketTop = (pc.entryDeck + spec.waterfallStepMm) - 3;
    const freeTop = pocketTop - (spec.key.gripRiseMm ?? 0) - (spec.key.seatLandMm ?? 0) - 0.2;
    const dir = [Math.cos(pc.entry.h), Math.sin(pc.entry.h)];
    const right = [Math.sin(pc.entry.h), -Math.cos(pc.entry.h)];
    // The rim under a minimal piece is the underside plane, not a constant.
    const pl = undersidePlane(pc, spec);
    let worst = null;
    for (let w = Math.min(...xs); w <= Math.max(...xs); w += 0.5) {
        for (let d = Math.min(...zs); d <= Math.max(...zs); d += 0.5) {
            if (!inside(w, d)) continue;
            const x = pc.entry.x + dir[0] * d + right[0] * w;
            const z = pc.entry.z + dir[1] * d + right[1] * w;
            const hits = [];
            for (let t = 0; t < ix.length; t += 3) {
                const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
                const den = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
                if (Math.abs(den) < 1e-12) continue;
                const l1 = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / den;
                const l2 = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / den;
                const l3 = 1 - l1 - l2;
                if (l1 < 0 || l2 < 0 || l3 < 0) continue;
                hits.push(l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1]);
            }
            hits.sort((q, r) => q - r);
            const y0 = pl.at(x, z) + 0.3;
            for (let i = 0; i + 1 < hits.length; i += 2) {
                if (hits[i] < freeTop && hits[i + 1] > y0) {
                    const at = Math.max(hits[i], y0);
                    if (!worst || at > worst.y) worst = { y: at, w: +w.toFixed(1), d: +d.toFixed(1) };
                    break;
                }
            }
        }
    }
    return worst;
}

/** Every reason this variant must not be written. Empty means it may be. */
function gate(g, base) {
    const fail = [];
    const r = analyzeMesh(g.positions, g.indices);
    if (!r.isManifold) fail.push(`NOT MANIFOLD: ${r.nonManifoldEdges} non-manifold edges, ${r.openEdges} open`);
    if (!r.isConsistent) fail.push('INCONSISTENT WINDING');
    if (!r.windsOutward) fail.push('WINDS INWARD (negative volume)');
    if (base) {
        const b = bounds(g), a = bounds(base);
        // The footprint rule: nothing past an end face, nothing above the bed.
        // 0.05 mm of slack for float, no more.
        const over = [['x', b.x0, a.x0, b.x1, a.x1], ['z', b.z0, a.z0, b.z1, a.z1]];
        for (const [ax, lo, aLo, hi, aHi] of over) {
            if (lo < aLo - 0.05 || hi > aHi + 0.05) {
                fail.push(`FOOTPRINT: ${ax} spans ${lo.toFixed(2)}..${hi.toFixed(2)}, past the baseline's ${aLo.toFixed(2)}..${aHi.toFixed(2)}`);
            }
        }
        if (b.y0 < a.y0 - 0.05) fail.push(`BELOW THE BED: y0 ${b.y0.toFixed(2)} under the baseline's ${a.y0.toFixed(2)}`);
        if (b.y0 > a.y0 + 0.05) fail.push(`FLOATS: y0 ${b.y0.toFixed(2)} above the baseline's ${a.y0.toFixed(2)}`);
        // A VARIANT THAT ADDS NOTHING IS A FAILED VARIANT, not a good score.
        // The first post grid was sized for a square lattice on a triangular
        // one, so the holes swallowed every post and all three came back at
        // exactly the baseline's 85.8 cm3 — which would have sliced, scored and
        // been reported as "posts do nothing" when what they did was not exist.
        const rr = analyzeMesh(base.positions, base.indices);
        if (Math.abs(r.volumeMm3 - rr.volumeMm3) < 1) {
            fail.push(`ADDS NOTHING: ${(r.volumeMm3 / 1000).toFixed(1)} cm3 is its own no-ops reference. The extra geometry did not survive.`);
        }
    }
    return { fail, r, bed: bedContactMm2(g) };
}

// ---------------------------------------------------------------------------
// Underside render — the check nobody ran
// ---------------------------------------------------------------------------

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function png(w, h, rgb) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

/**
 * Orthographic view from BELOW: for each pixel, the height of the LOWEST
 * surface over it, shaded from the bed (dark) to the deck ceiling (light).
 * That is the bed's own view of the part — an unsupported ceiling patch reads
 * as a broad pale field, a wall reaching the bed as a dark line, and a tab
 * hanging past an end face as a dark stub outside the outline.
 */
function undersidePNG(g, file, ppm = 4) {
    const b = bounds(g);
    const w = Math.ceil((b.x1 - b.x0) * ppm) + 8, h = Math.ceil((b.z1 - b.z0) * ppm) + 8;
    const depth = new Float32Array(w * h).fill(Infinity);
    const p = g.positions, ix = g.indices;
    const px = (x) => (x - b.x0) * ppm + 4, py = (z) => (z - b.z0) * ppm + 4;
    for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, c = ix[t + 1] * 3, d = ix[t + 2] * 3;
        const ax = px(p[a]), ay = py(p[a + 2]), av = p[a + 1];
        const bx = px(p[c]), by = py(p[c + 2]), bv = p[c + 1];
        const cx = px(p[d]), cy = py(p[d + 2]), cv = p[d + 1];
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
        const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const qx = i + 0.5, qy = j + 0.5;
                const l1 = ((by - cy) * (qx - cx) + (cx - bx) * (qy - cy)) / den;
                const l2 = ((cy - ay) * (qx - cx) + (ax - cx) * (qy - cy)) / den;
                const l3 = 1 - l1 - l2;
                if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
                const v = l1 * av + l2 * bv + l3 * cv;
                if (v < depth[j * w + i]) depth[j * w + i] = v;
            }
        }
    }
    const span = Math.max(1e-6, b.y1 - b.y0);
    const rgb = Buffer.alloc(w * h * 3);
    for (let k = 0; k < w * h; k++) {
        const v = depth[k];
        if (!isFinite(v)) { rgb[k * 3] = 24; rgb[k * 3 + 1] = 26; rgb[k * 3 + 2] = 32; continue; }
        const t = Math.min(1, Math.max(0, (v - b.y0) / span));
        rgb[k * 3] = Math.round(20 + 235 * t);
        rgb[k * 3 + 1] = Math.round(30 + 200 * t);
        rgb[k * 3 + 2] = Math.round(60 + 150 * (1 - t));
    }
    fs.writeFileSync(file, png(w, h, rgb));
    return { w, h };
}

// ---------------------------------------------------------------------------
// Slice + score
// ---------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kk-curve-'));

/**
 * THE PLATE HAS TO BE NAMED OR PETG WILL NOT SLICE. Neither the process, the
 * machine nor the filament preset carries `curr_bed_type`, so the CLI falls
 * back to the Cool Plate — for which PETG's own temperature table is zero, and
 * every slice dies with "Filaments are not compatible with the plate type".
 * Textured PEI is what PETG runs on and what Brett prints on.
 */
const BED = flag('bed', 'Textured PEI Plate');

function flatten(kind, name, patch = null) {
    const chain = [];
    let cur = name;
    while (cur) {
        const f = path.join(PRESETS, kind, `${cur}.json`);
        if (!fs.existsSync(f)) break;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        chain.unshift(j);
        cur = j.inherits;
    }
    if (!chain.length) throw new Error(`preset not found: ${kind}/${name}`);
    const merged = Object.assign({}, ...chain, patch ?? {});
    delete merged.inherits;
    merged.name = name;
    const out = path.join(TMP, `${kind}_${name.replace(/[^\w.]+/g, '_')}.json`);
    fs.writeFileSync(out, JSON.stringify(merged));
    return out;
}

const zip = (xml) => Buffer.from(fflate.zipSync({
    '[Content_Types].xml': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), { level: 0 }],
    '_rels/.rels': [fflate.strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), { level: 0 }],
    '3D/3dmodel.model': [fflate.strToU8(xml), { level: 6 }]
}));

function write3MF(name, g) {
    const b = bounds(g);
    const at = [128 - (b.x0 + b.x1) / 2, 128 + (b.z0 + b.z1) / 2, -b.y0];
    const f = path.join(OUT, `${name}.3mf`);
    fs.writeFileSync(f, zip(generateMultiObject3MFXML([{ name, positions: g.positions, indices: g.indices, at }])));
    return f;
}

/**
 * The metric, lifted from `scripts/unsupported_runs.mjs` so one run does
 * everything: rasterise each layer's extrusions, then measure how far each
 * bridge move in the next layer travels over empty cells. Runs anchored at
 * both ends are bridges and print; runs that stop in mid-air droop.
 *
 * THE LAYER BOUNDARY IS THE Z OF THE LAST EXTRUSION, not "Z changed" — Bambu
 * z-hops on travel and a hop is a bare `G1 Z...` indistinguishable by pattern.
 * Keyed on that, the grid was wiped several times per layer and the viaduct
 * (clean deck) scored worse than the curve that failed.
 */
function score(gcodeFile) {
    const CELL = 0.5, STEP = 0.4, R = 0.25;
    const lines = fs.readFileSync(gcodeFile, 'utf8').split('\n');

    // pass 1: bounds of everything actually extruded
    let X0 = 1e9, X1 = -1e9, Y0 = 1e9, Y1 = -1e9;
    for (const mv of moves(lines)) {
        if (!mv.extruding) continue;
        for (const [px, py] of mv.pts) {
            X0 = Math.min(X0, px); X1 = Math.max(X1, px);
            Y0 = Math.min(Y0, py); Y1 = Math.max(Y1, py);
        }
    }
    const NX = Math.ceil((X1 - X0) / CELL) + 4, NY = Math.ceil((Y1 - Y0) / CELL) + 4;
    const idx = (px, py) => {
        const i = Math.round((px - X0) / CELL) + 2, j = Math.round((py - Y0) / CELL) + 2;
        return (i < 0 || j < 0 || i >= NX || j >= NY) ? -1 : j * NX + i;
    };
    const mark = (g, ax, ay, bx, by) => {
        const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / (CELL / 2)));
        for (let k = 0; k <= n; k++) {
            const t = k / n, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
            for (let oi = -1; oi <= 1; oi++) for (let oj = -1; oj <= 1; oj++) {
                const p = idx(px + oi * R, py + oj * R);
                if (p >= 0) g[p] = 1;
            }
        }
    };

    // pass 2: layer by layer.
    //
    // THE LAYER BOUNDARY IS NOT "Z CHANGED". Bambu z-hops on travel moves, and
    // the hop is a bare `G1 Z...` indistinguishable from a layer change by
    // pattern — so keying on it wiped the occupancy grid several times per
    // layer. A hop extrudes nothing, so the honest boundary is a change in the
    // Z of the last EXTRUSION, which is immune to hops by construction.
    let prev = new Uint8Array(NX * NY), cur = new Uint8Array(NX * NY);
    let printZ = null;
    const runs = [];

    for (const mv of moves(lines)) {
        if (!mv.extruding) continue;
        if (printZ === null) printZ = mv.z;
        else if (mv.z > printZ + 0.05) { prev = cur; cur = new Uint8Array(NX * NY); printZ = mv.z; }

        if (/Bridge|Overhang|Floating/i.test(mv.feature)) {
            // Walk the move BY ARC LENGTH along its own path. An arc is one
            // move with a bent path, so its unsupported stretches are measured
            // around the curve rather than across the chord.
            const d = pathLength(mv.pts);
            const n = Math.max(1, Math.ceil(d / STEP));
            const sup = [];
            for (let k = 0; k <= n; k++) {
                const [px, py] = pointAt(mv.pts, (d * k) / n);
                const p = idx(px, py);
                sup.push(p >= 0 && prev[p] === 1);
            }
            const dl = d / n;
            let k = 0;
            while (k <= n) {
                if (sup[k]) { k++; continue; }
                let e = k;
                while (e <= n && !sup[e]) e++;
                const len = (e - k) * dl;
                // Carry WHERE, not just how long.
                const [ax, ay] = pointAt(mv.pts, (d * (k + e)) / (2 * n));
                if (len > 0.6) runs.push({ len, both: k > 0 && e <= n, z: mv.z, at: [ax, ay] });
                k = e;
            }
        }
        for (let k = 0; k + 1 < mv.pts.length; k++) {
            mark(cur, mv.pts[k][0], mv.pts[k][1], mv.pts[k + 1][0], mv.pts[k + 1][1]);
        }
    }
    const sum = (a) => a.reduce((p, q) => p + q, 0);
    const openR = runs.filter(r => !r.both);
    const open = openR.map(r => r.len);
    const bridged = runs.filter(r => r.both).map(r => r.len);
    return {
        open: sum(open),
        openMax: Math.max(0, ...open),
        over5: sum(open.filter(v => v >= 5)),
        over10: sum(open.filter(v => v >= 10)),
        over20: sum(open.filter(v => v >= 20)),
        bridged: sum(bridged),
        // BRIDGED IS NOT AUTOMATICALLY FINE, and treating it as fine is the
        // metric's blind spot. Brett, on straights printed from the shipped
        // geometry: "obvious strands of plastic across the underside of the
        // deck, rough to feel and can grab and peel, not fully melted together."
        // A straight's ceiling is flat and anchored at both rails, so almost
        // none of it is open-ended — those strands are SAGGING BRIDGES. Open-
        // ended length predicts collapse; bridge length predicts surface.
        bridgedMax: Math.max(0, ...bridged),
        br10: sum(bridged.filter(v => v >= 10)),
        br20: sum(bridged.filter(v => v >= 20)),
        br40: sum(bridged.filter(v => v >= 40)),
        worst: openR.sort((a, b) => b.len - a.len).slice(0, 6)
            .map(r => ({ len: +r.len.toFixed(1), z: +r.z.toFixed(2), at: r.at.map(v => +v.toFixed(1)) })),
        worstBridged: runs.filter(r => r.both).sort((a, b) => b.len - a.len).slice(0, 6)
            .map(r => ({ len: +r.len.toFixed(1), z: +r.z.toFixed(2), at: r.at.map(v => +v.toFixed(1)) }))
    };
}

function slice(name, f3mf) {
    const out = path.join(TMP, `out_${name}`);
    fs.mkdirSync(out, { recursive: true });
    try {
        execFileSync(BAMBU, [
            '--load-settings', `${flatten('machine', MACHINE)};${flatten('process', PROCESS, { curr_bed_type: BED })}`,
            '--load-filaments', flatten('filament', FILAMENT),
            '--slice', '0', '--outputdir', out, f3mf
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        const r = path.join(out, 'result.json');
        return { failed: fs.existsSync(r) ? JSON.parse(fs.readFileSync(r, 'utf8')).error_string : e.message };
    }
    const gc = path.join(out, 'plate_1.gcode');
    fs.copyFileSync(gc, path.join(OUT, `${name}.gcode`));
    const txt = fs.readFileSync(gc, 'utf8');
    const grams = parseFloat(/^; total filament weight \[g\] : ([0-9.]+)/m.exec(txt)?.[1] ?? '0');
    const secs = parseInt(/^; model printing time: .*\n; total estimated time: (\d+)/m.exec(txt)?.[1] ?? '0', 10);
    const time = (/^; model printing time: ([^;\n]+)/m.exec(txt)?.[1] ?? '?').trim();
    return { grams, time, secs, ...score(gc) };
}

// ---------------------------------------------------------------------------

// Re-score gcode already on disk. Slicing a curve costs minutes; asking a new
// question of a slice already taken costs nothing, and most questions here are
// asked of the same five slices.
if (argv.includes('--rescore')) {
    for (const f of fs.readdirSync(OUT).filter(f => f.endsWith('.gcode')).sort()) {
        const s = score(path.join(OUT, f));
        console.log(`\n  ${f.replace('.gcode', '')}`);
        console.log(`    open-ended ${s.open.toFixed(0)} mm  >5 ${s.over5.toFixed(0)}  >10 ${s.over10.toFixed(0)}  >20 ${s.over20.toFixed(0)}  max ${s.openMax.toFixed(1)}`);
        console.log(`    BRIDGED    ${s.bridged.toFixed(0)} mm  >10 ${s.br10.toFixed(0)}  >20 ${s.br20.toFixed(0)}  >40 ${s.br40.toFixed(0)}  max ${s.bridgedMax.toFixed(1)}`);
        console.log(`    longest OPEN runs (len @ print z, at bed x,y):`);
        for (const w of s.worst) console.log(`      ${String(w.len).padStart(5)} mm  z=${String(w.z).padStart(6)}  (${w.at[0]}, ${w.at[1]})`);
        console.log(`    longest BRIDGES:`);
        for (const w of s.worstBridged) console.log(`      ${String(w.len).padStart(5)} mm  z=${String(w.z).padStart(6)}  (${w.at[0]}, ${w.at[1]})`);
    }
    process.exit(0);
}

await initCSG();
fs.mkdirSync(OUT, { recursive: true });

/**
 * A variant may move `SPEC.wall` and the skirt style, so the piece has to be
 * laid out again for each one — the wall sets the outer width and the style
 * decides whether there is an arcade at all.
 */
/**
 * Everything that has to happen with this variant's wall in force, in one
 * place: the print mesh, the reference mesh the footprint is judged against,
 * and the key-throat ray cast. `undersidePlane` reads `spec.wall`, so a check
 * run after the wall is restored is a check of the wrong part.
 */
function build(v) {
    const wallWas = SPEC.wall;
    if (v.wall) SPEC.wall = v.wall;
    try {
        const { pieces } = layoutTrack(['straight', PIECE, 'straight'],
            { slopeDeg: 11.2167, skirtStyle: v.style ?? SPEC.skirt.style });
        const pc = pieces.find(p => p.type === PIECE) ?? pieces[1];
        const support = planPillarPositions(pieces).find(s => s.pieceIndex === pc.index);
        const one = (extraOps, forPrint) => buildPieceExportGeometry(pc, { support, forPrint, extraOps });
        return {
            g: one(v.ops, true),
            ref: v.ops ? one(null, true) : null,
            keyBlock: keyThroatBlock(one(v.ops, false), pieceInFrame(pc), SPEC)
        };
    } finally {
        SPEC.wall = wallWas;
    }
}

const rows = [];
const SELFTEST = argv.includes('--selftest');
for (const v of VARIANTS) {
    if (ONLY.length ? !ONLY.includes(v.name) : (!!v.selfTest !== SELFTEST)) continue;
    const t0 = Date.now();
    let g, ref, keyBlock;
    try {
        // The footprint gate compares a variant against THE SAME PIECE WITHOUT
        // ITS EXTRA GEOMETRY — not against a shared baseline. A shared baseline
        // is wrong the moment a variant changes the wall or the style, because
        // then the two differ for reasons that have nothing to do with a tab
        // escaping past an end face, which is the only thing being asked.
        ({ g, ref, keyBlock } = build(v));
    } catch (e) {
        console.log(`  BUILD FAILED  ${v.name}: ${e.message}`);
        rows.push({ name: v.name, gated: [`build threw: ${e.message}`] });
        continue;
    }
    const built = ((Date.now() - t0) / 1000).toFixed(1);
    const { fail, r, bed } = gate(g, ref);
    if (keyBlock) fail.push(`KEY CANNOT BE FITTED: blocked at y=${keyBlock.y.toFixed(2)} (lateral ${keyBlock.w}, depth ${keyBlock.d})`);
    const vol = (r.volumeMm3 / 1000).toFixed(1);

    if (v.selfTest) {
        console.log(fail.length
            ? `\n  SELFTEST PASSED  ${v.name} was rejected, as it must be:\n               ${fail.join('\n               ')}`
            : `\n  SELFTEST FAILED  ${v.name} PASSED THE GATE. The gate is not checking what it claims.`);
        rows.push({ name: v.name, selfTest: true, rejected: fail.length > 0, gated: fail });
        continue;
    }

    if (fail.length) {
        // NOT WRITTEN. This is the whole point of the file.
        console.log(`\n  GATE FAILED  ${v.name}  (${built}s) — nothing written, nothing sliced`);
        for (const f of fail) console.log(`               ${f}`);
        rows.push({ name: v.name, gated: fail });
        continue;
    }

    const img = path.join(OUT, `${v.name}_underside.png`);
    const dim = undersidePNG(g, img);
    const f3mf = write3MF(v.name, g);
    console.log(`\n  ok  ${v.name}  (${built}s)  ${vol} cm3  bed contact ${bed.toFixed(0)} mm2  ` +
        `manifold, winding consistent, outward\n      ${path.relative(ROOT, f3mf)}\n      ${path.relative(ROOT, img)} (${dim.w}x${dim.h})`);

    const row = { name: v.name, note: v.note, vol: +vol, bed: Math.round(bed) };
    if (DO_SLICE) {
        const s = slice(v.name, f3mf);
        if (s.failed) console.log(`      SLICE FAILED: ${s.failed}`);
        else console.log(`      ${s.grams.toFixed(1)} g  ${s.time}  open-ended ${s.open.toFixed(0)} mm ` +
            `(>5 ${s.over5.toFixed(0)}, >10 ${s.over10.toFixed(0)}, >20 ${s.over20.toFixed(0)}, max ${s.openMax.toFixed(1)})`);
        Object.assign(row, s);
    }
    rows.push(row);
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ piece: PIECE, process: PROCESS, filament: FILAMENT, rows }, null, 2));

console.log('\n' + '-'.repeat(96));
console.log(`  ${'variant'.padEnd(16)} ${'g'.padStart(6)} ${'open-ended'.padStart(11)} ${'>5mm'.padStart(7)} ${'>10mm'.padStart(7)} ${'>20mm'.padStart(7)} ${'max'.padStart(6)}`);
for (const r of rows) {
    if (r.selfTest) { console.log(`  ${r.name.padEnd(16)}  ${r.rejected ? 'gate self-test PASSED (rejected, as intended)' : 'GATE SELF-TEST FAILED — the gate let it through'}`); continue; }
    if (r.gated) { console.log(`  ${r.name.padEnd(16)}  GATE FAILED — not written`); continue; }
    if (r.open === undefined) { console.log(`  ${r.name.padEnd(16)} ${String(r.vol).padStart(6)} cm3   built + gated, not sliced (pass --slice)`); continue; }
    console.log(`  ${r.name.padEnd(16)} ${r.grams.toFixed(1).padStart(6)} ${r.open.toFixed(0).padStart(11)} ${r.over5.toFixed(0).padStart(7)} ${r.over10.toFixed(0).padStart(7)} ${r.over20.toFixed(0).padStart(7)} ${r.openMax.toFixed(1).padStart(6)}`);
}
console.log(`\n  ${path.relative(ROOT, path.join(OUT, 'results.json'))}`);
console.log('  Judge a print on the MIDDLE THIRD of the walking surface and on the skirt,');
console.log("  never on the slicer's cantilever warning — it fires on curves whatever the geometry.");
