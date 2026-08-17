#!/usr/bin/env node
/**
 * EVERY PART THE LIBRARY CAN PRODUCE, measured the same way, in one table.
 *
 *   node scripts/part_audit.mjs
 *
 * This exists because a part went missing from the shop and nobody noticed:
 * the canonical catalogue offered ONE `standard_switch` for two mirror-image
 * parts, and separately a `support_riser_120mm` that decomposeSupport can never
 * ask for. Neither is visible from any single file — one is a gap between the
 * piece types and the catalogue, the other between the catalogue and the
 * support solver. Only a list of everything, built and measured, shows them.
 *
 * Reports, per part: the mesh gate, unsupported span (see overhang_audit),
 * bed contact, the engraved code, and who can ask for it. A part that nothing
 * can ask for is a finding, not a row.
 */
import { SPEC, STANDARD, GEOMETRY_VERSION, layoutTrack, planPillarPositions,
         decomposeSupport, SPACER_VARIANTS } from '../js/track.js';
import * as P from '../js/pieces.js';
import { analyzeMesh } from '../js/mesh_utils.js';
import { pieceCode, partCode } from '../js/engrave.js';
import { audit } from './overhang_audit.mjs';
await P.initCSG();

const asP = (g) => {
  const pos = g.positions ?? g.attributes.position.array;
  const idx = g.indices ?? (g.index ? g.index.array
    : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i));
  const V = [], T = [];
  for (let i = 0; i < pos.length; i += 3) V.push([pos[i], -pos[i + 2], pos[i + 1]]);
  for (let i = 0; i < idx.length; i += 3) T.push([idx[i], idx[i + 1], idx[i + 2]]);
  return { name: 'p', V, T, pos, idx };
};
const rows = [];
const codes = new Map();
const add = (name, code, g, source) => {
  const o = asP(g);
  const r = analyzeMesh(o.pos, o.idx);
  const a = audit(o, 5);
  let z0 = 1e9; for (const v of o.V) z0 = Math.min(z0, v[2]);
  let bed = 0;
  for (const [x, y, c] of o.T) { const A = o.V[x], B = o.V[y], C = o.V[c];
    if (Math.max(A[2], B[2], C[2]) > z0 + 0.2) continue;
    bed += Math.abs((B[0]-A[0])*(C[1]-A[1]) - (B[1]-A[1])*(C[0]-A[0])) / 2; }
  codes.set(code, [...(codes.get(code) ?? []), name]);
  rows.push({ name, code, source, ok: r.isManifold && r.isConsistent && r.windsOutward,
    cm3: r.volumeMm3 / 1000, span: a[0]?.span ?? 0,
    over: a.filter((x) => x.span > 20).length, bed });
};

const t = layoutTrack(['start','straight','curveL','curveR','lift','powered','elevator','end'],
  { skirtStyle: 'minimal', slopeDeg: STANDARD.slopeDeg });
const sup = planPillarPositions(t.pieces);
const seen = new Set();
for (const pc of t.pieces) {
  if (seen.has(pc.type)) continue; seen.add(pc.type);
  add(pc.type, pieceCode(pc, GEOMETRY_VERSION),
    P.buildPieceExportGeometry(pc, { support: sup.find((s) => s.pieceIndex === pc.index), forPrint: true }),
    'UI · track button');
}
for (const hand of ['switchL', 'switchR']) {
  const sw = layoutTrack([{ type: hand, gate: 'main', main: ['straight'], branch: ['straight'] }],
    { skirtStyle: 'minimal', slopeDeg: STANDARD.slopeDeg });
  const M = sw.pieces.find((p) => p.role === 'main'), B = sw.pieces.find((p) => p.role === 'branch');
  add(hand, pieceCode(M, GEOMETRY_VERSION),
    P.buildSwitchExportGeometry(M, B, { support: planPillarPositions(sw.pieces).find((s) => s.pieceIndex === M.index), forPrint: true }),
    'UI · switch button');
}
for (const [n, c, f, src] of [
  ['bowtie_key','KEY',()=>P.buildKeyGeometry(SPEC,{code:partCode('KEY',GEOMETRY_VERSION)}),'auto · one per seam'],
  ['gate_paddle','GATE',()=>P.buildGateGeometry(SPEC,{forPrint:true}),'auto · one per switch'],
  ['support_foot','FOOT',()=>P.buildSupportFootGeometry(SPEC,{code:partCode('FOOT',GEOMETRY_VERSION)}),'auto · base of every pier'],
  ['support_jog','JOG',()=>P.buildJogGeometry(SPEC,{code:partCode('JOG',GEOMETRY_VERSION)}),'auto · offset column'],
  ...[60,30,15].map((r)=>[`support_riser_${r}mm`,`R${r}`,()=>P.buildRiserGeometry(r,SPEC,{code:partCode('R'+r,GEOMETRY_VERSION)}),'auto · pier ladder']),
  ...SPACER_VARIANTS.map((v)=>[`support_spacer_${v.code}`,'SPC',()=>P.buildSpacerGeometry(v.heightMm,SPEC,{code:partCode('SPC',GEOMETRY_VERSION)}),'auto · seat to grid']),
  ['scenery_tower','TOWER',()=>P.buildTowerGeometry(100),'UI · scenery'],
  ['scenery_patio','PATIO',()=>P.buildPatioGeometry(SPEC),'UI · scenery'],
]) { try { add(n, partCode(c, GEOMETRY_VERSION), f(), src); }
     catch (e) { rows.push({ name:n, code:c, source:src, ok:false, cm3:0, span:0, over:0, bed:0, err:e.message }); } }

console.log('part                code                 mesh         cm3  span >20   bed mm2  asked for by');
for (const r of rows) console.log(r.name.padEnd(19), String(r.code).padEnd(20),
  (r.ok ? 'watertight' : '*** BROKEN ***').padEnd(12), r.cm3.toFixed(1).padStart(6),
  r.span.toFixed(0).padStart(5), String(r.over).padStart(3), r.bed.toFixed(0).padStart(9), '  ', r.source);

// findings
const dup = [...codes].filter(([, n]) => n.length > 1);
const sizes = new Set();
for (let h = 15; h <= 900; h += 15) { const d = decomposeSupport(h); if (!d) continue;
  const rs = d.risers ?? []; (Array.isArray(rs) ? rs : []).forEach((x) => sizes.add(x)); }
console.log('\nriser sizes the support solver ever emits:', [...sizes].sort((a,b)=>a-b).join(', '));
const bad = rows.filter((r) => !r.ok || r.over > 0);
console.log(dup.length ? `\n*** ${dup.length} shared engraving(s): ` + dup.map(([c,n])=>`${c} = ${n.join('+')}`).join('; ') : '\nNo two parts share an engraved code.');
console.log(bad.length ? `*** ${bad.length} over the span gate: ${bad.map((b)=>b.name).join(', ')}` : 'Every part watertight, none over a 20 mm span.');
