import fs from 'fs';
import { layoutTrack } from '../track.js';

const json = JSON.parse(fs.readFileSync('./scenes/15-elevator-showcase.json', 'utf8'));
const res = layoutTrack(json.sequence, json.params);

console.log("Analyzing overlaps:");
res.pieces.forEach((p1, idx1) => {
  res.pieces.forEach((p2, idx2) => {
    if (idx1 >= idx2) return;
    const dx = Math.abs(p1.entry.x - p2.entry.x);
    const dz = Math.abs(p1.entry.z - p2.entry.z);
    const dh = Math.abs(p1.entry.h - p2.entry.h) % (2*Math.PI);
    if (dx < 5 && dz < 5) {
      console.log(`Identical entry at index ${idx1} (${p1.name}) and index ${idx2} (${p2.name}):`);
      console.log(`  p1: entry={${p1.entry.x.toFixed(1)}, ${p1.entry.z.toFixed(1)}, ${p1.entry.h.toFixed(2)}}, exit={${p1.exit.x.toFixed(1)}, ${p1.exit.z.toFixed(1)}}`);
      console.log(`  p2: entry={${p2.entry.x.toFixed(1)}, ${p2.entry.z.toFixed(1)}, ${p2.entry.h.toFixed(2)}}, exit={${p2.exit.x.toFixed(1)}, ${p2.exit.z.toFixed(1)}}`);
    }
  });
});
