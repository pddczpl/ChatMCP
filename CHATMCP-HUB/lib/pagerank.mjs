// PageRank over a graph of names, for the repository map: which files matter most when the files that import them matter, and so on. A file is a node, an import is an edge
// from the importing file to the imported one, and a file gets rank from every file that imports it, in proportion to the rank of the importer and divided among everything
// the importer imports.
//
//   p(i) = (1 - d) / N + d * ( sum over every j that imports i of p(j) / out(j)  +  (sum of p(j) over the files j that import nothing) / N )
//
// A file that imports nothing hands its rank to all the files alike, so the ranks always add up to 1. The iteration starts from 1 / N and stops when the ranks move by less than
// `tolerance` (the sum of the changes: 1e-10 leaves every rank within about 1e-9 of the exact one, which takes about 140 rounds at a damping of 0.85), so the answer is the
// stationary one and does not depend on how many rounds a graph happened to need; `maxIterations` bounds the work and `converged: false` says that it ran out. A repeated import counts once, a file that imports itself counts for nothing, and a name that is not a node is not an end of any edge.
// Deterministic: the same nodes and edges give the same ranks, to the last bit.

/**
 * @param {string[]} nodes the names (a repeated name is one node)
 * @param {Iterable<[string, string]>} edges [importer, imported]
 * @param {{damping?: number, maxIterations?: number, tolerance?: number}} [options]
 * @returns {{ranks: Map<string, number>, iterations: number, converged: boolean}}
 */
export function pagerank(nodes, edges, { damping = 0.85, maxIterations = 200, tolerance = 1e-10 } = {}) {
  if (!Array.isArray(nodes)) throw new TypeError('pagerank: nodes must be a list of names');
  if (!(damping >= 0 && damping < 1)) throw new RangeError('pagerank: damping must be at least 0 and below 1');
  const names = [...new Set(nodes)];
  const count = names.length;
  if (count === 0) return { ranks: new Map(), iterations: 0, converged: true };
  const index = new Map(names.map((name, position) => [name, position]));
  const targets = names.map(() => new Set());
  for (const [from, to] of edges ?? []) {
    const source = index.get(from);
    const destination = index.get(to);
    if (source !== undefined && destination !== undefined && source !== destination) targets[source].add(destination);
  }
  const imports = targets.map((set) => [...set]);
  let rank = new Float64Array(count).fill(1 / count);
  let next = new Float64Array(count);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    iterations += 1;
    let spread = 0;
    for (let at = 0; at < count; at += 1) if (imports[at].length === 0) spread += rank[at];
    next.fill((1 - damping) / count + (damping * spread) / count);
    for (let at = 0; at < count; at += 1) {
      const list = imports[at];
      if (list.length === 0) continue;
      const share = (damping * rank[at]) / list.length;
      for (const to of list) next[to] += share;
    }
    let change = 0;
    for (let at = 0; at < count; at += 1) change += Math.abs(next[at] - rank[at]);
    [rank, next] = [next, rank];
    if (change < tolerance) { converged = true; break; }
  }
  return { ranks: new Map(names.map((name, position) => [name, rank[position]])), iterations, converged };
}
