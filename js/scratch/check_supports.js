import fs from 'fs';
import { layoutTrack, planPillarPositions } from '../track.js';

const json = JSON.parse(fs.readFileSync('./scenes/15-elevator-showcase.json', 'utf8'));
const res = layoutTrack(json.sequence, json.params);
const supports = planPillarPositions(res.pieces);

console.log("Supports:");
supports.forEach((sup) => {
  console.log(`Piece ${sup.pieceIndex} (${res.pieces[sup.pieceIndex].name}): x=${sup.x.toFixed(2)}, z=${sup.z.toFixed(2)}, mode=${sup.mode}, s=${sup.s.toFixed(2)}`);
});
