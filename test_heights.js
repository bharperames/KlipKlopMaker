import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutTrack, planPillarPositions, decomposeSupport, isStandardParams } from './js/track.js';
import { deserializeScene } from './js/scene_format.js';

const SCENES_DIR = './scenes';
const sceneFiles = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).sort();

for (const file of sceneFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, file), 'utf8'));
    const state = deserializeScene(raw);
    const layout = layoutTrack(state.sequence, {
        slopeDeg: state.slopeDeg,
        innerWidth: state.innerWidth,
        curveRadius: state.curveRadius
    });
    
    const isStd = isStandardParams({
        slopeDeg: state.slopeDeg,
        curveRadius: state.curveRadius,
        innerWidth: state.innerWidth
    });
    
    console.log(`Scene: ${file} (Standard Params: ${isStd})`);
    
    const supports = planPillarPositions(layout.pieces);
    for (const sup of supports) {
        if (sup.mode === 'none') continue;
        const pc = layout.pieces[sup.pieceIndex];
        const height = pc.rimY;
        const dec = decomposeSupport(height);
        if (isStd && !dec) {
            console.warn(`  WARNING: Piece ${pc.name} support at height ${height} cannot be decomposed on 15mm grid!`);
        } else {
            console.log(`  Piece ${pc.name} height ${height} -> risers: ${dec ? JSON.stringify(dec.risers) : 'custom'}`);
        }
    }
}
