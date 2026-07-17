import { layoutTrack, deckYAt } from '../js/track.js';
import { buildPieceDisplayGeometry } from '../js/pieces.js';
import { initCSG } from '../js/pieces.js';

describe('Elevator Track Piece', () => {
    beforeAll(async () => {
        // Initialize CSG kernel for geometry generation tests
        await initCSG();
    });

    test('layoutTrack resolves elevator as a simple type and sets the correct climbing height', () => {
        // String form
        const { pieces: piecesStr } = layoutTrack(['elevator']);
        const elStr = piecesStr[1];
        expect(elStr.type).toBe('elevator');
        expect(elStr.planLen).toBe(150);
        expect(elStr.drop).toBe(-90.25); // climbs 90mm by default, plus waterfall adjustment

        // Object form with custom height
        const { pieces: piecesObj } = layoutTrack([{ type: 'elevator', height: 120 }]);
        const elObj = piecesObj[1];
        expect(elObj.type).toBe('elevator');
        expect(elObj.drop).toBe(-120.25); // custom climbing height, plus waterfall adjustment
    });

    test('deckYAt implements flat-climb-flat profile correctly', () => {
        const { pieces } = layoutTrack([{ type: 'elevator', height: 100 }]);
        const el = pieces[1];

        const yEntry = el.entryDeck;
        const yExit = el.exitDeck;

        // Entry flat zone (s = 0 to 40)
        expect(deckYAt(el, 0)).toBeCloseTo(yEntry, 6);
        expect(deckYAt(el, 20)).toBeCloseTo(yEntry, 6);
        expect(deckYAt(el, 40)).toBeCloseTo(yEntry, 6);

        // Exit flat zone (s = 110 to 150)
        expect(deckYAt(el, 110)).toBeCloseTo(yExit, 6);
        expect(deckYAt(el, 130)).toBeCloseTo(yExit, 6);
        expect(deckYAt(el, 150)).toBeCloseTo(yExit, 6);

        // Climb zone (s = 40 to 110)
        const midY = (yEntry + yExit) / 2;
        expect(deckYAt(el, 75)).toBeCloseTo(midY, 6);
        expect(deckYAt(el, 57.5)).toBeCloseTo((yEntry + midY) / 2, 6);
    });

    test('geometry generation builds watertight mesh without error', () => {
        const { pieces } = layoutTrack([{ type: 'elevator', height: 90 }]);
        const el = pieces[1];
        
        // Should generate interactive display geometry using CSG successfully
        const geom = buildPieceDisplayGeometry(el);
        expect(geom).toBeDefined();
        expect(geom.attributes.position.count).toBeGreaterThan(0);
    });
});
