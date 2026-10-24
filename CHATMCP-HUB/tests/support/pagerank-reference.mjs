// The PageRank equations solved exactly, for the tests of lib/pagerank.mjs and of the repository map to compare against. It does not iterate: it solves
//
//   p = (1 - d) / N + d * (sum over j -> i of p(j) / out(j)  +  (sum of p over nodes that import nothing) / N)
//
// as a linear system (I - d M) p = (1 - d) / N by Gaussian elimination with partial pivoting, so a mistake in the iteration, in the handling of nodes that import nothing or in
// the treatment of repeated and self edges cannot hide behind a test that repeats the same loop.

/**
 * @param {string[]} nodes
 * @param {[string, string][]} edges [importer, imported]; a repeated edge counts once, a self edge and an edge to or from a name that is not a node are no edges
 * @returns {Map<string, number>}
 */
export function exactPagerank(nodes, edges, damping = 0.85) {
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node, i]));
  const out = nodes.map(() => new Set());
  for (const [from, to] of edges) {
    if (index.has(from) && index.has(to) && from !== to) out[index.get(from)].add(index.get(to));
  }
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let j = 0; j < n; j += 1) {
    if (out[j].size === 0) for (let i = 0; i < n; i += 1) a[i][j] -= damping / n;
    else for (const i of out[j]) a[i][j] -= damping / out[j].size;
  }
  const b = Array.from({ length: n }, () => (1 - damping) / n);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / a[col][col];
      for (let k = col; k < n; k += 1) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row];
    for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * x[k];
    x[row] = sum / a[row][row];
  }
  return new Map(nodes.map((node, i) => [node, x[i]]));
}
