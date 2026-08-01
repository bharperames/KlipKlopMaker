import { readFileSync } from 'fs';

const degToRad = (d) => d * Math.PI / 180;

// Load specs
const STANDARD = {
    slopeDeg: -11,
    innerWidth: 24,
    curveRadius: 143.64,
    liftSlopeDeg: 15.5
};

const SPEC = {
    tileLen: 150,
    platformLen: 80,
    waterfallStepMm: 0.25,
    skirtDepth: 12,
    ridge: { height: 1.5, pitch: 12.0 },
    slope: { hardMin: -15, hardMax: 20, greenMin: -12, greenMax: -10 },
    minCurveRadius: 120,
    curveWidenMm: 2.0
};

const raw = readFileSync('./scenes/15-elevator-showcase.json', 'utf8');
const json = JSON.parse(raw);

const p = {
    slopeDeg: json.params.slopeDeg ?? STANDARD.slopeDeg,
    innerWidth: json.params.innerWidth ?? STANDARD.innerWidth,
    curveRadius: json.params.curveRadius ?? STANDARD.curveRadius,
    tileLen: SPEC.tileLen,
    platformLen: SPEC.platformLen,
    waterfall: SPEC.waterfallStepMm,
    ridgeHeight: SPEC.ridge.height,
    ridgePitch: SPEC.ridge.pitch,
    skirtDepth: SPEC.skirtDepth
};

const tanSlope = Math.tan(degToRad(p.slopeDeg));
const liftSlopeDeg = STANDARD.liftSlopeDeg;
const tanLift = Math.tan(degToRad(liftSlopeDeg));

function segmentPlan(kind, cursor, opts = {}) {
    const len = opts.len ?? 150;
    const rad = opts.radius ?? p.curveRadius;
    const turnSign = opts.turnSign ?? 1;

    let exitX, exitZ, exitH;
    let radius = null;
    let center = null;
    let turn = null;

    if (kind === 'straightish') {
        exitX = cursor.x + len * Math.cos(cursor.h);
        exitZ = cursor.z + len * Math.sin(cursor.h);
        exitH = cursor.h;
    } else {
        const angle = Math.PI / 4 * turnSign;
        const R = rad;
        radius = R;
        const cx = cursor.x - R * Math.sin(cursor.h);
        const cz = cursor.z + R * Math.cos(cursor.h);
        center = { x: cx, z: cz };
        turn = angle;
        exitX = cx + R * Math.sin(cursor.h + angle);
        exitZ = cz - R * Math.cos(cursor.h + angle);
        exitH = cursor.h + angle;
    }

    return {
        exit: { x: exitX, z: exitZ, h: exitH },
        planLen: kind === 'straightish' ? len : rad * Math.PI / 4
    };
}

let cur = { x: 0, z: 0, h: 0 };
let deck = 0;

for (let i = 0; i < json.sequence.length; i++) {
    const node = json.sequence[i];
    const kind = typeof node === 'string' ? node : node.type;
    let plan, drop;
    if (kind === 'straight' || kind === 'lift' || kind === 'elevator' || kind === 'powered') {
        plan = segmentPlan('straightish', cur, { len: p.tileLen });
        if (kind === 'elevator') {
            const height = typeof node === 'object' ? (node.height ?? 90) : 90;
            drop = -(height + p.waterfall);
        } else if (kind === 'lift') {
            drop = -plan.planLen * tanLift;
        } else if (kind === 'powered') {
            drop = 0;
        } else {
            drop = plan.planLen * tanSlope;
        }
    } else {
        plan = segmentPlan('curve', cur, { radius: p.curveRadius, turnSign: kind === 'curveL' ? 1 : -1 });
        drop = plan.planLen * tanSlope;
    }
    deck = (deck - p.waterfall) - drop;
    cur = plan.exit;
    console.log(`Piece ${i} (${kind}): exit cursor =`, cur, `deck =`, deck);
}

const dh = Math.abs(((cur.h % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
const stepDown = deck - (-p.waterfall);

console.log('Distance from start (X, Z):', Math.hypot(cur.x, cur.z));
console.log('Heading mismatch (radians):', dh);
console.log('stepDown:', stepDown);
console.log('Is Circuit:', Math.hypot(cur.x, cur.z) <= 5 && dh <= 0.04 && stepDown >= p.waterfall - 0.05 && stepDown <= 3);
