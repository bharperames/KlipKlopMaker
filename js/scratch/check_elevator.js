import { readFileSync } from 'fs';
import { layoutTrack } from '/Users/brettharper/Code/KlipKlopMaker/js/track.js';

const raw = readFileSync('./scenes/15-elevator-showcase.json', 'utf8');
const json = JSON.parse(raw);

const res = layoutTrack(json.sequence, json.params);

for (let i = 0; i < res.pieces.length; i++) {
    const pc = res.pieces[i];
    console.log(`${i}: ${pc.name}: entry =`, pc.entry, `exit =`, pc.exit);
}
