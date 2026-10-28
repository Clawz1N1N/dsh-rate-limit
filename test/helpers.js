/**
 * Test doubles and builders.
 *
 * Every timer in the plugin goes through the injected `Timers` pair and every
 * interval through the injected `Clock`, so a test can advance months of
 * virtual time instantly and deterministically.
 *
 * @module test/helpers
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock } from '../lib/clock.js';
import { ModelRateLimiter } from '../lib/limiter.js';
import { emptyPolicy } from '../lib/policy.js';

/*
 * A test process inherits the environment of whatever started it, and
 * `node --test` is routinely started from inside a live DeepSeek Harness
 * session — where `DSH_PROFILE_DIR` points at the *real* profile. The plugin
 * resolves its counter file from that variable, so a suite that boots the
 * plugin and lets one flush through would silently overwrite the counters the
 * running application is holding. Point the variable at a scratch directory
 * before any test body can boot anything, so the suite can never touch a live
 * profile. `persistence.test.js` pins this.
 */
process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-mrl-suite-'));

/**
 * Deterministic timer queue driven by a `FakeClock`.
 */
export class FakeScheduler {
  /** @type {import('../lib/clock.js').FakeClock} */
  clock;
  /** @type {Map<number, { at: number, callback: () => void }>} */
  #pending = new Map();
  #nextId = 0;
  /** @type {Array<{ id: number, at: number }>} */
  fired = [];

  /** @param {FakeClock} clock */
  constructor(clock) {
    this.clock = clock;
  }

  /** @type {import('../lib/constants.js').Timers} */
  get timers() {
    return {
      setTimeout: (callback, delayMs) => {
        const id = ++this.#nextId;
        this.#pending.set(id, { at: this.clock.mono() + Math.max(0, delayMs), callback });
        return id;
      },
      clearTimeout: (handle) => {
        this.#pending.delete(/** @type {number} */ (handle));
      },
    };
  }

  /** @returns {number} number of armed timers. */
  get pendingCount() {
    return this.#pending.size;
  }

  /** @returns {number | undefined} the earliest armed delay, in milliseconds. */
  nextDelay() {
    let earliest;
    for (const timer of this.#pending.values()) {
      const delay = timer.at - this.clock.mono();
      if (earliest === undefined || delay < earliest) earliest = delay;
    }
    return earliest;
  }

  /**
   * Advance the clock and run everything that becomes due.
   * @param {number} ms
   */
  advance(ms) {
    const target = this.clock.mono() + ms;
    for (;;) {
      let due;
      for (const [id, timer] of this.#pending) {
        if (timer.at > target) continue;
        if (due === undefined || timer.at < due.timer.at) due = { id, timer };
      }
      if (due === undefined) break;
      this.#pending.delete(due.id);
      this.clock.advance(due.timer.at - this.clock.mono());
      this.fired.push({ id: due.id, at: due.timer.at });
      due.timer.callback();
    }
    this.clock.advance(target - this.clock.mono());
  }

  /** Move wall time only, leaving monotonic time alone: a suspended laptop. */
  sleepWall(ms) {
    this.clock.sleep(ms);
  }
}

/**
 * Build a limiter with the fast, deterministic knobs tests rely on.
 *
 * @param {Partial<import('../lib/limiter.js').LimiterOptions>} [options]
 * @returns {{ limiter: ModelRateLimiter, clock: FakeClock, scheduler: FakeScheduler, logs: Array<Record<string, unknown>> }}
 */
export function harness(options = {}) {
  const clock = options.clock ?? new FakeClock();
  const scheduler = new FakeScheduler(clock);
  /** @type {Array<Record<string, unknown>>} */
  const logs = [];
  const limiter = new ModelRateLimiter({
    clock,
    timers: scheduler.timers,
    // No jitter and no random spread: window boundaries are exact in tests.
    wakeMarginMs: 1,
    wakeJitterMs: 0,
    random: () => 0.5,
    onLog: (record) => logs.push(record),
    ...options,
  });
  return { limiter, clock, scheduler, logs };
}

/**
 * Build a policy from a sparse description.
 *
 * @param {{ requests?: Record<string, number>, tokens?: Record<string, number> }} [input]
 * @returns {import('../lib/policy.js').ModelPolicy}
 */
export function policy(input = {}) {
  const base = emptyPolicy();
  for (const kind of ['requests', 'tokens']) {
    for (const [window, value] of Object.entries(input[kind] ?? {})) base[kind][window] = value;
  }
  return base;
}

/**
 * A chunk stream builder that mimics the DeepSeek adapter's protocol: any
 * number of deltas, one `usage` chunk, then the terminal `finish`.
 *
 * @param {{ usage?: Record<string, number>, reason?: Record<string, unknown>, text?: string, omitTerminal?: boolean }} [input]
 * @returns {import('../lib/types.js').StreamChunk[]}
 */
export function successChunks(input = {}) {
  const chunks = [];
  if (input.text !== undefined) chunks.push({ type: 'text-delta', text: input.text });
  if (input.usage !== undefined) chunks.push({ type: 'usage', usage: input.usage });
  if (input.omitTerminal !== true) {
    chunks.push({ type: 'finish', reason: input.reason ?? { kind: 'stop' } });
  }
  return chunks;
}

/**
 * A terminal throttling chunk, as the adapter reports an HTTP 429.
 *
 * @param {{ retryAfterMs?: number, status?: number, code?: string }} [input]
 * @returns {import('../lib/types.js').StreamChunk}
 */
export function throttleChunk(input = {}) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: input.code ?? 'RATE_LIMIT',
        message: 'provider throttled this request',
        status: input.status ?? 429,
        ...(input.retryAfterMs === undefined ? {} : { providerRetryAfterMs: input.retryAfterMs }),
      },
    },
  };
}

/**
 * Collect an async iterable into an array.
 *
 * A hang is a bug in the plugin, so the collection is bounded: a test that
 * forgets to advance its fake clock fails loudly instead of stalling the run.
 *
 * @template T
 * @param {AsyncIterable<T>} source
 * @param {string} [label]
 * @returns {Promise<T[]>}
 */
export async function collect(source, label = 'stream') {
  /** @type {T[]} */
  const items = [];
  let finished = false;
  const pump = (async () => {
    for await (const item of source) items.push(item);
    finished = true;
    return items;
  })();
  const guard = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within 200 ms`)), 200);
    timer.unref?.();
  });
  return Promise.race([pump, guard]).finally(() => {
    void finished;
  });
}

/**
 * Let every pending microtask settle.
 * @param {number} [times]
 */
export async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drive a started stream to completion by advancing the fake clock whenever it
 * is waiting on a timer.
 *
 * This is how a test expresses "the request eventually goes through": each step
 * runs the pending work, then jumps the clock by the exact delay the plugin
 * armed, so no real time passes and no step is skipped by an impatient
 * microtask drain.
 *
 * @param {object} options
 * @param {FakeScheduler} options.scheduler
 * @param {Promise<unknown>} options.promise - the in-flight stream collection.
 * @param {number} [options.maxSteps]
 * @returns {Promise<unknown>} the resolved value of `promise`.
 */
export async function drive({ scheduler, promise, maxSteps = 32 }) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await settle(24);
    if (settled) break;
    const delay = scheduler.nextDelay();
    if (delay === undefined) break;
    scheduler.advance(Math.max(1, Math.ceil(delay)) + 1);
  }
  await settle(24);
  return outcome;
}
