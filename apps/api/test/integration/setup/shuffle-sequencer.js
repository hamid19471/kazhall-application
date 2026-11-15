/**
 * Opt-in suite-order shuffler for the integration run.
 *
 * WHY IT EXISTS. jest's default sequencer orders test files by their CACHED
 * duration (slowest first), so the order of a full run depends on a cache
 * directory rather than on anything a reader can see. That is the worst of
 * both worlds for an intermittent failure: the order varies between machines
 * and between runs, which is what makes cross-suite leakage intermittent, and
 * it is not controllable, which is what makes it unreproducible. This
 * sequencer replaces "whatever the cache says" with "a stated permutation of a
 * stated seed", so a failing order can be written down and replayed exactly.
 *
 * OFF BY DEFAULT AND SAFE. With `KAZHAL_INT_SHUFFLE_SEED` unset it defers to
 * the default sequencer, so `pnpm test:int` is unchanged. It never runs files
 * in parallel and never skips one: it is a permutation, nothing else. `sort`
 * is the only method overridden; `shard` and `cacheResults` keep the base
 * behaviour.
 *
 * Written in JavaScript because jest loads `testSequencer` through a plain
 * `require` that does not pass through ts-jest.
 */
const Sequencer = require('@jest/test-sequencer').default;

/**
 * mulberry32 — a small, well-distributed, fully deterministic PRNG.
 *
 * `Math.random()` would defeat the point: a shuffled order that cannot be
 * replayed is no more useful than the cache-derived one it replaced.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so a human-typed seed like `run7` is usable as well as a number. */
function hashSeed(raw) {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && raw.trim() !== '') return numeric >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class ShuffleSequencer extends Sequencer {
  sort(tests) {
    const raw = process.env.KAZHAL_INT_SHUFFLE_SEED;
    if (!raw) return super.sort(tests);

    const random = mulberry32(hashSeed(raw));
    // Sort by path FIRST so the input to the shuffle is itself deterministic:
    // jest's discovery order depends on the filesystem, and shuffling a
    // non-deterministic list with a deterministic PRNG is still
    // non-deterministic.
    const ordered = [...tests].sort((a, b) => (a.path < b.path ? -1 : 1));

    // Fisher-Yates.
    for (let i = ordered.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }

    process.stdout.write(
      `\n[int] suite order shuffled with KAZHAL_INT_SHUFFLE_SEED=${raw}\n`,
    );
    return ordered;
  }
}

module.exports = ShuffleSequencer;
