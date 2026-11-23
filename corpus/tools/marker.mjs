// The third bridge from the corpus tools into DatGold (corpus/README.md, "Splitting out the corpus"): the final-line marker contract,
// version 1, and parseFinalMarker(), its one reader. The scoring reads an agent's claim with it, and so does `chatmcp verify exec`
// (DATGOLD-HUB/lib/proof/cli/exec.mjs), which is packaged from the Hub's bin/ and lib/ only: so the code lives in
// DATGOLD-HUB/lib/proof/marker.mjs and this file only passes it on, and the two readers cannot drift apart. The contract and the reading
// rules are written out there and in corpus/README.md, "The marker contract".
export { BLOCKED_REASON_MAX, MARKER_CONTRACT, MARKER_CONTRACT_VERSION, finalLine, parseFinalMarker } from '../../DATGOLD-HUB/lib/proof/marker.mjs';
