/**
 * export_sets.js
 * Named subsets of a design's parts list — pure, no DOM, no Three.js.
 *
 * A finished tower is ~70 parts and several hundred grams. Exporting all of it
 * is right when you are ready to build it and wrong for every step before
 * that: proving a seam mates, checking a slicer is happy with the arcade,
 * reprinting the connector keys a toddler lost under the sofa. Those are
 * different jobs and they want different plates, so name them.
 *
 * A set only ever FILTERS parts and adjusts their counts. It never changes
 * geometry — every plate is the same finalized part the full export produces,
 * so anything proven with a sample run holds for the full batch.
 */

/**
 * Every part carries a `kind` from assembleParts:
 *   track    ramps, curves, lifts, merged switch parts
 *   gate     switch gate paddles
 *   key      bowtie connector keys
 *   support  feet, risers, custom pillars
 *   scenery  towers, patios, palm islands
 */
export const PART_KINDS = ['track', 'gate', 'key', 'support', 'scenery'];

/** Keys are tiny and easy to lose; a fit test may as well carry spares. */
const SAMPLE_KEYS = 4;

export const EXPORT_SETS = [
    {
        id: 'all',
        label: 'Everything',
        hint: 'Every part in full quantity — the whole design, ready to build.',
        pick: (parts) => parts
    },
    {
        id: 'sample',
        label: 'Sample run (one of each)',
        hint: 'One of every distinct part, plus spare keys. A fit test: proves ' +
              'seams mate and supports plug in before you commit to a full batch.',
        pick: (parts) => parts.map(p => ({
            ...p,
            count: p.kind === 'key' ? Math.min(p.count, SAMPLE_KEYS) : 1
        }))
    },
    {
        id: 'track',
        label: 'Track only',
        hint: 'Pieces, switch parts, gates and the keys that join them. ' +
              'No supports, no scenery.',
        pick: (parts) => parts.filter(p => p.kind === 'track' || p.kind === 'gate' || p.kind === 'key')
    },
    {
        id: 'supports',
        label: 'Supports only',
        hint: 'Feet, risers and any custom pillars — the stacks the track stands on.',
        pick: (parts) => parts.filter(p => p.kind === 'support')
    },
    {
        id: 'keys',
        label: 'Connector keys only',
        hint: 'Just the bowtie keys. For replacing the ones that go missing.',
        pick: (parts) => parts.filter(p => p.kind === 'key')
    },
    {
        id: 'scenery',
        label: 'Scenery only',
        hint: 'Towers, patios and palm islands.',
        pick: (parts) => parts.filter(p => p.kind === 'scenery')
    }
];

export const getExportSet = (id) => EXPORT_SETS.find(s => s.id === id) ?? EXPORT_SETS[0];

/**
 * Apply a set. Parts whose count falls to zero are dropped rather than
 * exported as empty plates.
 * @returns {{set: object, parts: Array, dropped: number}}
 */
export function applyExportSet(id, parts) {
    const set = getExportSet(id);
    const picked = (set.pick(parts) ?? []).filter(p => (p.count ?? 1) > 0);
    return { set, parts: picked, dropped: parts.length - picked.length };
}

/** One line for the export README, so a plate file explains what it is. */
export function describeExportSet(id, parts) {
    const { set, parts: picked } = applyExportSet(id, parts);
    const total = picked.reduce((s, p) => s + (p.count ?? 1), 0);
    return `Set: ${set.label} — ${picked.length} distinct part${picked.length === 1 ? '' : 's'}, ` +
        `${total} piece${total === 1 ? '' : 's'} total.\n${set.hint}`;
}
