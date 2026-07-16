/**
 * physics.js
 * Pure gait physics for the Klip-Klop passive dynamic walker — no DOM/Three.js.
 *
 * Model: McGeer's rimless wheel, the canonical reduced model of passive dynamic
 * walking. The figure alternates pivots (front hooves / swinging rear pendulum)
 * exactly like a rimless wheel whose spokes are separated by the swing-limiter
 * angle 2α. Each "spoke" strike is one klip (or klop).
 *
 *  - During a step the stance leg is an inverted pendulum: ω̇ = (g/l)·sin(φ),
 *    where φ is the leg angle from vertical and γ is the ramp slope.
 *  - At hoof strike the angular velocity is scaled by cos(2α) (angular momentum
 *    about the new pivot), losing kinetic energy — this loss is what the slope
 *    replenishes. Toy-grade axles and hoof scuffing lose more, modeled by an
 *    additional efficiency factor η.
 *  - Steady gait: ω_s² = 4·(g/l)·sinα·sinγ · K/(1−K), with K = η·cos²(2α).
 *  - Stall: the post-strike energy can't vault the pendulum over top dead
 *    center: ½ω_s² < (g/l)·(1 − cos(α−γ)).
 *  - Slide: the hoof-ramp interface can't hold the rocking contact:
 *    tan(γ) > SLIP_SAFETY·μs. Printed washboard ridges raise the effective μs.
 *  - Tumble: γ > α — the next hoof lands beyond the swing limiter's reach and
 *    the figure pitches over its front axle instead of stepping.
 */

const G_MM_S2 = 9810; // gravity in mm/s²
const SLIP_SAFETY = 0.85;

/**
 * Effective static friction of PLA-on-PLA by ramp floor finish.
 * Literature: printed PLA COF ≈ 0.38–0.67; transverse (perpendicular-to-travel)
 * layer/ridge orientation measurably grippier than longitudinal. The generated
 * washboard ridges mechanically interlock with the hoof cam and act above plain
 * friction — modeled as the top preset.
 */
export const FRICTION_PRESETS = {
    smooth:        { label: 'Smooth floor (no ridges)',            mu: 0.32 },
    perpendicular: { label: 'Perpendicular layer lines',           mu: 0.45 },
    washboard:     { label: 'Washboard ridges (generated)',        mu: 0.60 }
};

export const DEFAULT_WALKER = {
    alphaDeg: 18,     // swing-limiter half-angle (stride stop tabs)
    legLenMm: 26,     // axle height above hoof contact = pendulum length
    efficiency: 0.26, // toy-grade axle + scuffing energy retention multiplier
    massG: 45         // assembled figure incl. ballast (injection-molded class)
};

const d2r = (d) => d * Math.PI / 180;

/**
 * Steady-state post-strike angular velocity of the rimless wheel (rad/s).
 * Returns 0 when no steady gait exists (flat or uphill).
 */
export function steadyOmega(slopeDeg, walker = DEFAULT_WALKER) {
    const a = d2r(walker.alphaDeg), g = d2r(slopeDeg);
    if (g <= 0) return 0;
    const K = walker.efficiency * Math.cos(2 * a) ** 2;
    const gain = 4 * (G_MM_S2 / walker.legLenMm) * Math.sin(a) * Math.sin(g);
    return Math.sqrt(gain * K / (1 - K));
}

/**
 * Numerically integrates one stance phase of the inverted pendulum from
 * φ = −(α−γ) to φ = +(α+γ), starting at ω0. Returns null if the figure
 * fails to vault top dead center (stall).
 */
export function integrateStep(slopeDeg, omega0, walker = DEFAULT_WALKER) {
    const a = d2r(walker.alphaDeg), g = d2r(slopeDeg);
    const gl = G_MM_S2 / walker.legLenMm;
    let phi = -(a - g);
    let omega = omega0;
    let t = 0;
    const dt = 0.0005;
    const tMax = 3;
    while (phi < a + g) {
        omega += gl * Math.sin(phi) * dt;
        if (omega <= 0) return null; // fell back — stall
        phi += omega * dt;
        t += dt;
        if (t > tMax) return null;
    }
    return { stepTime: t, omegaEnd: omega };
}

/**
 * Full assessment of a slope against a walker + surface configuration.
 * @returns {{ status: 'stall'|'walk'|'slide'|'tumble',
 *             speedMmS, stepHz, strideMm, omegaSteady, detail }}
 */
export function assessSlope(slopeDeg, opts = {}) {
    const walker = { ...DEFAULT_WALKER, ...opts.walker };
    const mu = opts.mu ?? FRICTION_PRESETS.washboard.mu;
    const a = d2r(walker.alphaDeg), g = d2r(slopeDeg);
    const strideMm = 2 * walker.legLenMm * Math.sin(a);

    if (slopeDeg <= 0) {
        return { status: 'stall', speedMmS: 0, stepHz: 0, strideMm, omegaSteady: 0, detail: 'No gravity gradient — nothing drives the gait.' };
    }
    if (Math.tan(g) > SLIP_SAFETY * mu) {
        return { status: 'slide', speedMmS: 0, stepHz: 0, strideMm, omegaSteady: 0, detail: `tan(${slopeDeg.toFixed(1)}°) exceeds ${SLIP_SAFETY}·μs (μs=${mu}) — hooves ski instead of rocking.` };
    }
    if (g > a) {
        return { status: 'tumble', speedMmS: 0, stepHz: 0, strideMm, omegaSteady: 0, detail: `Slope exceeds the ±${walker.alphaDeg}° swing limiter — figure pitches over its front axle.` };
    }

    const omegaS = steadyOmega(slopeDeg, walker);
    const barrier = (G_MM_S2 / walker.legLenMm) * (1 - Math.cos(a - g));
    if (0.5 * omegaS * omegaS < barrier) {
        return { status: 'stall', speedMmS: 0, stepHz: 0, strideMm, omegaSteady: omegaS, detail: 'Energy recovered per step cannot vault the stance leg over top dead center.' };
    }

    const step = integrateStep(slopeDeg, omegaS, walker);
    if (!step) {
        return { status: 'stall', speedMmS: 0, stepHz: 0, strideMm, omegaSteady: omegaS, detail: 'Stance integration failed to complete a step.' };
    }

    const speedMmS = strideMm / step.stepTime;
    return {
        status: 'walk',
        speedMmS,
        stepHz: 1 / step.stepTime,
        strideMm,
        omegaSteady: omegaS,
        detail: `Steady gait: ${(1 / step.stepTime).toFixed(1)} steps/s at ${speedMmS.toFixed(0)} mm/s.`
    };
}

/**
 * Scans slopes to find the workable band — the "Goldilocks zone" — for the
 * current walker + surface. With toy-grade defaults this lands near 8–14°,
 * matching the empirical range of the original Fisher-Price playsets.
 */
export function goldilocksRange(opts = {}, scanMax = 30) {
    let minDeg = null, maxDeg = null;
    for (let d = 0.5; d <= scanMax; d += 0.1) {
        const r = assessSlope(d, opts);
        if (r.status === 'walk') {
            if (minDeg === null) minDeg = d;
            maxDeg = d;
        } else if (minDeg !== null) {
            break;
        }
    }
    return { minDeg, maxDeg };
}

/**
 * Ballast plan: printed PLA is far lighter than injection-molded ABS, so the
 * figure needs metal mass low in the body to keep the CoM down and the
 * pendulum energetic.
 * @param {number} bodyVolMm3 - solid volume of the printed body mesh
 * @param {number} infillPct  - slicer infill percentage (walls approximated)
 * @param {number} targetMassG - desired assembled mass
 */
export function ballastPlan(bodyVolMm3, infillPct, targetMassG) {
    const PLA_G_MM3 = 0.00124;
    const effectiveSolidFraction = 0.30 + 0.70 * (infillPct / 100); // shell + infill approximation
    const plasticG = bodyVolMm3 * PLA_G_MM3 * effectiveSolidFraction;
    const ballastG = Math.max(0, targetMassG - plasticG);
    const BB_G = 0.35;          // 4.5 mm steel BB
    const M3_NUT_G = 0.33;
    return {
        plasticG,
        ballastG,
        bbCount: Math.round(ballastG / BB_G),
        m3NutCount: Math.round(ballastG / M3_NUT_G)
    };
}

/**
 * Verdict for a laid-out track: per-piece gait status plus total descent stats.
 */
export function trackVerdict(pieces, opts = {}) {
    const perPiece = pieces.map(pc => {
        if (pc.type === 'start' || pc.type === 'end') {
            return { name: pc.name, status: 'platform', speedMmS: 0 };
        }
        const r = assessSlope(pc.slopeDeg, opts);
        return { name: pc.name, status: r.status, speedMmS: r.speedMmS, stepHz: r.stepHz, detail: r.detail };
    });
    const running = perPiece.filter(r => r.status !== 'platform');
    const allWalk = running.length > 0 && running.every(r => r.status === 'walk');
    const runLen = pieces.filter(pc => pc.type !== 'start' && pc.type !== 'end')
        .reduce((s, pc) => s + pc.planLen, 0);
    const speed = running.length ? running[0].speedMmS : 0;
    return {
        perPiece,
        allWalk,
        runLengthMm: runLen,
        descentTimeS: speed > 0 ? runLen / speed : null,
        totalSteps: speed > 0 ? Math.round(runLen / (assessSlope(pieces.find(p => p.slopeDeg > 0)?.slopeDeg ?? 11, opts).strideMm || 1)) : 0
    };
}
