/**
 * Re-export: `slabIslands` lives in js/mesh_utils.js now, beside
 * `bedStability` — the two measurements of bed contact belong on one page,
 * with the arbiter stated there (islands win). This module keeps the import
 * path the tests and scripts already use.
 */
export { slabIslands } from '../js/mesh_utils.js';
