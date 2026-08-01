import fs from 'fs';
import { layoutTrack } from '../track.js';

const json = JSON.parse(fs.readFileSync('./scenes/15-elevator-showcase.json', 'utf8'));
const res = layoutTrack(json.sequence, json.params);

console.log("Is Circuit:", res.isCircuit);
console.log("\nIssues:");
console.log(res.issues);

console.log("\nPieces:");
res.pieces.forEach((pc) => {
  console.log(`${pc.name}: type=${pc.type}`);
  console.log(`  entry: { x: ${pc.entry.x.toFixed(2)}, z: ${pc.entry.z.toFixed(2)}, h: ${pc.entry.h.toFixed(2)}, deck: ${pc.entryDeck.toFixed(2)} }`);
  console.log(`  exit:  { x: ${pc.exit.x.toFixed(2)}, z: ${pc.exit.z.toFixed(2)}, h: ${pc.exit.h.toFixed(2)}, deck: ${pc.exitDeck.toFixed(2)} }`);
  console.log(`  rimY:  ${pc.rimY.toFixed(2)}`);
});
