// PageRank for the repository map (lib/pagerank.mjs): damped power iteration over the import graph, checked against an independent solution of the same equations.
//
//   p = (1 - d) / N + d * (sum over j -> i of p(j) / out(j)  +  (sum of p over nodes that import nothing) / N)
//
// The reference (tests/support/pagerank-reference.mjs) solves that linear system exactly instead of iterating.
import assert from 'node:assert/strict';
import { pagerank } from '../lib/pagerank.mjs';
import { exactPagerank } from './support/pagerank-reference.mjs';

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const near = (ranks, expected, epsilon, label) => {
  for (const [node, value] of expected) assert.ok(Math.abs(ranks.get(node) - value) <= epsilon, `${label}: ${node} is ${ranks.get(node)}, expected ${value}`);
};
const sum = (ranks) => [...ranks.values()].reduce((total, value) => total + value, 0);

// ------------------------------------------------------------------ the equations, on graphs small enough to read
{
  const triangle = pagerank(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  near(triangle.ranks, [['a', 1 / 3], ['b', 1 / 3], ['c', 1 / 3]], 1e-12, 'a cycle');
  assert.equal(triangle.converged, true);

  const star = pagerank(['hub', 'a', 'b', 'c', 'd'], [['a', 'hub'], ['b', 'hub'], ['c', 'hub'], ['d', 'hub']]);
  const reference = exactPagerank(['hub', 'a', 'b', 'c', 'd'], [['a', 'hub'], ['b', 'hub'], ['c', 'hub'], ['d', 'hub']]);
  near(star.ranks, [...reference], 1e-9, 'a star');
  assert.ok(star.ranks.get('hub') > star.ranks.get('a') * 3, 'the node everybody imports outranks the leaves by a wide margin');
  // by hand: leaves a..d import nothing of theirs is imported, so each holds (1-d)/N + d*p(hub)/N (hub imports nothing: its rank is spread over all nodes)
  const d = 0.85; const n = 5;
  const leaf = ((1 - d) / n + (d * star.ranks.get('hub')) / n);
  near(star.ranks, [['a', leaf], ['b', leaf], ['c', leaf], ['d', leaf]], 1e-9, 'the leaves, by hand');
  assert.ok(Math.abs(sum(star.ranks) - 1) < 1e-12, 'the ranks add up to 1');
  ok('PageRank: a cycle is uniform, a star matches the exact solution and the hand calculation, and the ranks add up to 1');
}

// ------------------------------------------------------------------ nodes that import nothing, repeated edges, self edges, unknown names
{
  const nodes = ['main', 'lib', 'util', 'leaf'];
  const edges = [['main', 'lib'], ['main', 'lib'], ['lib', 'util'], ['util', 'util'], ['main', 'ghost'], ['ghost', 'lib'], ['main', 'util']];
  const got = pagerank(nodes, edges);
  near(got.ranks, [...exactPagerank(nodes, edges)], 1e-9, 'repeated, self and unknown edges are the same as none of them');
  const clean = pagerank(nodes, [['main', 'lib'], ['lib', 'util'], ['main', 'util']]);
  near(got.ranks, [...clean.ranks], 1e-12, 'a repeated edge votes once; a self edge and an edge to or from an unknown name are not edges');
  assert.ok(Math.abs(sum(got.ranks) - 1) < 1e-12);
  assert.equal(got.ranks.size, 4, 'only the nodes asked for');
  ok('PageRank: a repeated import votes once, a self import and an unknown name count for nothing, and a node that imports nothing spreads its rank');
}

// ------------------------------------------------------------------ the edges of the cases the repository map meets
{
  assert.deepEqual([...pagerank([], []).ranks], [], 'no files, no ranks');
  assert.deepEqual([...pagerank(['only'], []).ranks], [['only', 1]], 'one file holds all of it');
  const lonely = pagerank(['a', 'b', 'c'], []);
  near(lonely.ranks, [['a', 1 / 3], ['b', 1 / 3], ['c', 1 / 3]], 1e-12, 'no imports: all alike');
  // order is the order asked for: the same graph, nodes listed another way, gives the same ranks
  const edges = [['x', 'y'], ['y', 'z'], ['w', 'z'], ['z', 'x']];
  const one = pagerank(['x', 'y', 'z', 'w'], edges);
  const other = pagerank(['w', 'z', 'y', 'x'], edges);
  near(one.ranks, [...other.ranks], 1e-12, 'listing the nodes in another order');
  // a graph with a long chain converges to the exact solution, not near it
  const chain = Array.from({ length: 40 }, (_, i) => `f${i}`);
  const chainEdges = chain.slice(1).map((name, i) => [chain[i], name]).concat([['f10', 'f3'], ['f20', 'f3'], ['f39', 'f0']]);
  const chained = pagerank(chain, chainEdges);
  near(chained.ranks, [...exactPagerank(chain, chainEdges)], 1e-9, 'a chain of 40 files with cross imports');
  assert.equal(chained.converged, true);
  assert.ok(chained.iterations < 200);
  ok('PageRank: empty and single graphs, no imports, the order of the nodes does not matter, and a longer graph converges to the exact solution within 1e-9');
}

// ------------------------------------------------------------------ the iteration is bounded and says when it gave up
{
  const chain = Array.from({ length: 12 }, (_, i) => `n${i}`);
  const edges = chain.slice(1).map((name, i) => [chain[i], name]);
  const cut = pagerank(chain, edges, { maxIterations: 2 });
  assert.equal(cut.iterations, 2);
  assert.equal(cut.converged, false, 'two rounds are not enough, and the answer says so');
  assert.ok(Math.abs(sum(cut.ranks) - 1) < 1e-9, 'an unfinished answer is still a distribution');
  assert.throws(() => pagerank(['a'], [], { damping: 1 }), /damping/);
  assert.throws(() => pagerank(['a'], [], { damping: -0.1 }), /damping/);
  assert.throws(() => pagerank('a', []), /nodes/);
  ok('PageRank: the number of rounds is bounded and an unfinished answer says so, and a damping outside [0, 1) is refused');
}

console.log(`\nPASS: ${checks} pagerank checks`);
