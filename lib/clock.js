/**
 * Clock abstraction.
 *
 * Two readings are needed and they answer different questions:
 * - `mono()` is monotonic and only moves forward. It measures intervals, so a
 *   wall-clock change cannot corrupt a rolling window.
 * - `wall()` is the current wall-clock time. It is used once, to translate the
 *   persisted counters of a previous process into this process's monotonic
 *   domain, and never inside window arithmetic.
 *
 * `createAnchor` captures the offset once per process; a state file stores the
 * anchor beside the counters, so a restart (or a laptop waking from sleep)
 * resumes correctly instead of discarding or double-counting traffic.
 *
 * @module dsh-llm-model-rate-limit/lib/clock
 */

/**
 * @typedef {object} Clock
 * @property {() => number} mono - monotonic milliseconds.
 * @property {() => number} wall - wall-clock milliseconds.
 */

/** @type {Clock} */
export const systemClock = {
  mono: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  wall: () => Date.now(),
};

/**
 * Captured relation between wall time and monotonic time.
 * @typedef {object} ClockAnchor
 * @property {number} mono - monotonic reading at capture time.
 * @property {number} wall - wall reading at capture time.
 */

/**
 * @param {Clock} [clock]
 * @returns {ClockAnchor}
 */
export function createAnchor(clock = systemClock) {
  return { mono: clock.mono(), wall: clock.wall() };
}

/**
 * Translate a wall-clock timestamp into this process's monotonic domain.
 * @param {ClockAnchor} anchor
 * @param {number} wallMs
 * @returns {number}
 */
export function monoOfWall(anchor, wallMs) {
  return anchor.mono + (wallMs - anchor.wall);
}

/**
 * Translate a monotonic timestamp into the current wall-clock domain.
 * @param {ClockAnchor} anchor
 * @param {number} monoMs
 * @returns {number}
 */
export function wallOfMono(anchor, monoMs) {
  return anchor.wall + (monoMs - anchor.mono);
}

/**
 * A clock whose two readings are set explicitly, for tests.
 */
export class FakeClock {
  /** @type {number} */
  #mono;
  /** @type {number} */
  #wall;
  /** @type {number} wall-clock offset applied to `mono()` results. */
  #drift;

  /**
   * @param {number} [startWall] - initial wall time in milliseconds.
   * @param {number} [startMono] - initial monotonic time in milliseconds.
   */
  constructor(startWall = 1_700_000_000_000, startMono = 1_000) {
    this.#wall = startWall;
    this.#mono = startMono;
    this.#drift = 0;
  }

  /** @returns {number} */
  mono() {
    return this.#mono + this.#drift;
  }

  /** @returns {number} */
  wall() {
    return this.#wall;
  }

  /**
   * Advance both readings, as real elapsed time does.
   * @param {number} ms
   */
  advance(ms) {
    this.#mono += ms;
    this.#wall += ms;
  }

  /**
   * Move only the wall clock, as an NTP correction or a hibernation does.
   * @param {number} ms - positive to jump forward, negative to jump back.
   */
  shiftWall(ms) {
    this.#wall += ms;
  }

  /**
   * Stop monotonic time while the wall clock keeps moving: a suspended laptop.
   * @param {number} wallMs
   */
  sleep(wallMs) {
    this.#wall += wallMs;
  }
}
