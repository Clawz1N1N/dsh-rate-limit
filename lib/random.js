/**
 * Injectable entropy.
 *
 * Jitter and backoff spread are the only nondeterministic inputs of the
 * limiter, so they live behind one seam that tests can replace with a constant.
 *
 * @module dsh-llm-model-rate-limit/lib/random
 */

/** @returns {number} a value in `[0, 1)`. */
export function random() {
  return Math.random();
}
