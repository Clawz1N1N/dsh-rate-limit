/**
 * The admission engine: rolling windows, a FIFO idle queue, one timer per
 * model, and 429 cooldown.
 *
 * Nothing in this module knows about Cordis, HTTP, or React: it receives a
 * clock, a timer pair, an optional token meter, and an optional persistence
 * port. That is what makes the whole queue/idle/backoff surface testable with a
 * fake clock and no real waiting.
 *
 * @module dsh-llm-model-rate-limit/lib/limiter
 */

import {
  DEFAULT_IMAGE_TOKENS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_RETRY,
  DEFAULT_WAKE_JITTER_MS,
  DEFAULT_WAKE_MARGIN_MS,
  LIMIT_KINDS,
  REAL_TIMERS,
  UNLIMITED,
  WINDOW_KEYS,
  WINDOW_MS,
} from './constants.js';
import { random } from './random.js';
import { createAnchor, monoOfWall, systemClock, wallOfMono } from './clock.js';
import { estimateRequestTokens, usageTokens } from './estimate.js';
import { isRecord, modelKeyOf } from './info.js';
import { diffPolicies, editPolicy, emptyPolicy, isUnlimitedPolicy, normalizePolicy } from './policy.js';
import { RollingWindows } from './windows.js';

/**
 * @typedef {import('./policy.js').ModelPolicy} ModelPolicy
 * @typedef {import('./policy.js').PolicyAdjustment} PolicyAdjustment
 * @typedef {import('./constants.js').Timers} Timers
 * @typedef {import('./clock.js').Clock} Clock
 * @typedef {import('./clock.js').ClockAnchor} ClockAnchor
 */

/**
 * @typedef {object} LimiterOptions
 * @property {Clock} [clock]
 * @property {Timers} [timers]
 * @property {{ estimateMessage?: (message: unknown) => number }} [meter]
 * @property {number} [reservedOutputTokens]
 * @property {number} [imageTokens]
 * @property {number} [wakeMarginMs]
 * @property {number} [wakeJitterMs]
 * @property {Partial<typeof DEFAULT_RETRY>} [retry]
 * @property {() => number} [random]
 * @property {{ load: () => Promise<unknown>, save: (state: unknown) => Promise<void> }} [persistence]
 * @property {(record: Record<string, unknown>) => void} [onLog]
 * @property {(event: { key: string, reason: string }) => void} [onStatus]
 */

/**
 * @typedef {object} ModelState
 * @property {import('./types.js').QueueEntry[]} queue
 * @property {unknown} timer
 * @property {boolean} pumping
 * @property {number} cooldownUntil
 * @property {number} failureStreak
 * @property {string | undefined} warning
 * @property {number} waits - how many requests had to queue for this model.
 * @property {number} waitMs - total time those requests spent queued.
 * @property {number | null} lastThrottledAt - monotonic instant of the last provider throttle.
 */

/**
 * @typedef {object} Admitted
 * @property {number} cost - reserved token cost.
 * @property {RollingWindows} windows
 * @property {string} key
 */

export class ModelRateLimiter {
  /** @type {Clock} */
  #clock;
  /** @type {Timers} */
  #timers;
  /** @type {ClockAnchor} */
  #anchor;
  /** @type {LimiterOptions} */
  #options;
  /** @type {Map<string, ModelPolicy>} */
  #policies = new Map();
  /** @type {Map<string, RollingWindows>} */
  #windows = new Map();
  /** @type {Map<string, ModelState>} */
  #models = new Map();
  /** @type {Set<Promise<unknown>>} */
  #active = new Set();
  #disposed = false;
  #sequence = 0;

  /** @param {LimiterOptions} [options] */
  constructor(options = {}) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#anchor = createAnchor(this.#clock);
  }

  /**
   * Replace the whole policy map, for example after a configuration write.
   * @param {Map<string, ModelPolicy>} policies
   * @returns {Map<string, PolicyAdjustment[]>} adjustments applied to smaller windows, by model key.
   */
  setPolicies(policies) {
    const adjustments = new Map();
    for (const [key, policy] of policies) adjustments.set(key, this.updatePolicy(key, policy));
    for (const key of [...this.#policies.keys()]) {
      if (policies.has(key)) continue;
      this.#policies.delete(key);
      this.#releaseModel(key);
    }
    return adjustments;
  }

  /**
   * Install or replace one model's policy. A narrower window that now exceeds a
   * wider one is raised, so a policy read from a file cannot violate the
   * non-decreasing rule.
   *
   * @param {string} key
   * @param {ModelPolicy} policy
   * @returns {PolicyAdjustment[]}
   */
  updatePolicy(key, policy) {
    const normalized = normalizePolicy(policy, `models[${JSON.stringify(key)}]`);
    /** @type {PolicyAdjustment[]} */
    const adjustments = [];
    /** @type {ModelPolicy} */
    const repaired = { requests: { ...normalized.requests }, tokens: { ...normalized.tokens } };
    for (const kind of LIMIT_KINDS) {
      for (let i = 1; i < WINDOW_KEYS.length; i += 1) {
        const smaller = WINDOW_KEYS[i - 1];
        const larger = WINDOW_KEYS[i];
        const small = repaired[kind][smaller];
        const large = repaired[kind][larger];
        if (small === UNLIMITED || large === UNLIMITED || large >= small) continue;
        repaired[kind][larger] = small;
        adjustments.push({ kind, window: larger, from: large, to: small });
      }
    }
    this.#policies.set(key, repaired);
    this.#model(key).warning = undefined;
    this.#reschedule(key);
    return adjustments;
  }

  /**
   * Apply one field edit to one model, cascading to the other windows.
   * @param {string} key
   * @param {'requests'|'tokens'} kind
   * @param {string} window
   * @param {number} value
   * @returns {{ policy: ModelPolicy, adjustments: PolicyAdjustment[] }}
   */
  editPolicyWindow(key, kind, window, value) {
    const current = this.#policies.get(key) ?? emptyPolicy();
    const { policy, adjustments } = editPolicy(current, kind, window, value);
    this.#policies.set(key, policy);
    this.#reschedule(key);
    return { policy, adjustments };
  }

  /**
   * @param {string} key
   * @returns {ModelPolicy}
   */
  policyOf(key) {
    return this.#policies.get(key) ?? emptyPolicy();
  }

  /**
   * Every configured model key.
   * @returns {string[]}
   */
  modelKeys() {
    return [...this.#policies.keys()].sort();
  }

  /**
   * Whether a request to this model would be subject to any limit at all.
   * @param {string} provider
   * @param {string} model
   * @returns {boolean}
   */
  limits(provider, model) {
    const policy = this.#policies.get(modelKeyOf(provider, model));
    return policy !== undefined && !isUnlimitedPolicy(policy);
  }

  /**
   * A detached snapshot of one model, for the HTTP API and the composer control.
   * @param {string} provider
   * @param {string} model
   * @param {number} [nowMs]
   * @returns {Record<string, unknown>}
   */
  describe(provider, model, nowMs = this.#clock.mono()) {
    const key = modelKeyOf(provider, model);
    const policy = this.policyOf(key);
    const windows = this.#windows.get(key);
    const state = this.#models.get(key);
    /** @type {Record<string, unknown>} */
    const usage = {};
    for (const kind of LIMIT_KINDS) {
      /** @type {Record<string, unknown>} */
      const perKind = {};
      for (const window of WINDOW_KEYS) {
        const limit = policy[kind][window];
        perKind[window] = {
          limit,
          used: windows === undefined
            ? 0
            : kind === 'tokens'
              ? Math.max(0, Math.round(windows.tokensIn(window, nowMs)))
              : windows.countIn(window, nowMs),
        };
      }
      usage[kind] = perKind;
    }
    const cooldownUntil = state?.cooldownUntil ?? 0;
    const nextFreeMs = this.#nextFreeMs(key, nowMs);
    // Two independent countdowns, one per kind. Each answers "how long until this
    // kind stops being the thing that blocks me", measured across every window of
    // that kind, and both include an active provider cooldown because it blocks a
    // request regardless of which budget is exhausted.
    //
    // A countdown is only meaningful when something is actually waiting: a model
    // that is merely idle at its cap has no request to resume, and reporting one
    // would tell a polling client that a blocked request will clear. The gate is
    // the host's to own — /state is a public surface — so the client agrees by
    // construction rather than by duplicating the predicate.
    const blocked = (state?.queue.length ?? 0) > 0 || cooldownUntil > nowMs;
    const cooldownMs = Math.max(0, Math.round(cooldownUntil - nowMs));
    const requestsResumeMs = blocked
      ? Math.max(this.#resumeInForKind(key, 'requests', nowMs), cooldownMs)
      : 0;
    const tokensResumeMs = blocked
      ? Math.max(this.#resumeInForKind(key, 'tokens', nowMs), cooldownMs)
      : 0;
    const names = this.#namesOf(provider, model);
    return {
      key,
      provider,
      model,
      ...names,
      configured: this.#policies.has(key),
      limited: this.limits(provider, model),
      policy: { requests: { ...policy.requests }, tokens: { ...policy.tokens } },
      usage,
      cooldownMs,
      queueDepth: state?.queue.length ?? 0,
      retryInMs: cooldownMs > 0 ? cooldownMs : null,
      resumeInMs: nextFreeMs === null ? null : Math.max(0, Math.round(nextFreeMs - nowMs)),
      requestsResumeMs,
      tokensResumeMs,
      lastRequestAgoMs: this.#lastRequestAgoMs(windows, nowMs),
      warning: state?.warning,
      // P2-3: how often this model has had to wait and for how long, plus when
      // the provider last throttled it. The structured log records already
      // carried these facts; nothing surfaced them, so a user could not tell a
      // local budget from a provider limit.
      stats: {
        waits: state?.waits ?? 0,
        waitMs: Math.max(0, Math.round(state?.waitMs ?? 0)),
        lastThrottledAgoMs: state?.lastThrottledAt === null || state?.lastThrottledAt === undefined
          ? null
          : Math.max(0, Math.round(nowMs - state.lastThrottledAt)),
      },
    };
  }

  /**
   * How long until one limit kind stops blocking, across all of its windows.
   *
   * The answer is the latest window: a request needs every window of that kind to
   * be satisfied at the same instant, so the slowest one decides. A frozen clock
   * (the timer still has to fire, or a suspended process) guarantees at least one
   * millisecond, which keeps a countdown from showing zero while the request is
   * still queued.
   *
   * @param {string} key
   * @param {'requests'|'tokens'} kind
   * @param {number} nowMs
   * @returns {number} milliseconds until this kind allows the head request.
   */
  #resumeInForKind(key, kind, nowMs) {
    if (!this.#policies.has(key)) return 0;
    const policy = this.policyOf(key);
    const windows = this.#windows.get(key);
    if (windows === undefined) return 0;
    const headCost = this.#headCost(key);
    let wake = 0;
    for (const window of WINDOW_KEYS) {
      const limit = policy[kind][window];
      if (limit === UNLIMITED) continue;
      const need = kind === 'tokens' ? Math.min(headCost, limit) : 1;
      const at = windows.nextFreeAt(window, nowMs, limit, need, kind);
      if (at > wake) wake = at;
    }
    return Math.max(0, Math.round(wake - nowMs));
  }

  /**
   * Display names for one route, when a resolver is installed.
   *
   * The shipped model selector shows a provider's display name as its group and a
   * model's display name as its row; the control must show the same words, so the
   * names travel with the state document. A resolver is optional: without one the
   * client substitutes whatever its own catalog knows, and finally the raw ids.
   *
   * @param {string} provider
   * @param {string} model
   * @returns {{ providerName?: string, modelName?: string }}
   */
  #namesOf(provider, model) {
    const resolver = this.#options.resolveNames;
    if (resolver === undefined) return {};
    try {
      const names = resolver(provider, model);
      if (!isRecord(names)) return {};
      return {
        ...(typeof names.providerName === 'string' && names.providerName.length > 0
          ? { providerName: names.providerName }
          : {}),
        ...(typeof names.modelName === 'string' && names.modelName.length > 0
          ? { modelName: names.modelName }
          : {}),
      };
    } catch {
      // A resolver must never be able to break the state read.
      return {};
    }
  }

  /** @returns {string[]} */
  warnings() {
    /** @type {string[]} */
    const out = [];
    for (const [key, state] of this.#models) {
      if (state.warning !== undefined) out.push(`${key}: ${state.warning}`);
    }
    return out;
  }

  /**
   * Serialize counters for persistence.
   * @returns {Record<string, unknown>}
   */
  exportState() {
    const now = this.#clock.mono();
    /** @type {Record<string, Array<[number, number, number]>>} */
    const models = {};
    for (const [key, windows] of this.#windows) {
      const rows = windows.exportState(now);
      if (rows.length > 0) models[key] = rows;
    }
    return {
      anchor: this.#anchor,
      savedWall: wallOfMono(this.#anchor, now),
      models,
    };
  }

  /**
   * Restore counters written by an earlier process. Rows outside the longest
   * window, and rows dated after the current monotonic time, are dropped.
   *
   * @param {{ anchor?: { mono: number, wall: number }, models?: unknown, savedWall?: number }} state
   * @returns {{ restored: number, dropped: string[], skewMs: number }}
   */
  importState(state) {
    const now = this.#clock.mono();
    const source = isRecord(state) ? state.models : undefined;
    if (!isRecord(source)) return { restored: 0, dropped: [], skewMs: 0 };
    const anchor = isRecord(state.anchor)
      && typeof state.anchor.mono === 'number'
      && typeof state.anchor.wall === 'number'
      ? { mono: state.anchor.mono, wall: state.anchor.wall }
      : this.#anchor;
    // The file's "now" translated into the writer's monotonic domain: the
    // writer's anchor pair converts its wall reading, and the reader's live wall
    // clock says what that reading is now. Both halves must be translated
    // together, or an imported counter would be dated in a foreign timeline.
    // Rebase the persisted second indices onto this process's monotonic clock:
    // the writer's anchor pair says where its "now" sat on the wall clock, and
    // this process's own wall reading says how long ago that was.
    const sourceNow = monoOfWall(anchor, this.#clock.wall());
    /** @type {string[]} */
    const dropped = [];
    let restored = 0;
    for (const [key, rows] of Object.entries(source)) {
      const windows = this.#windowsFor(key);
      // The longest window is 24 hours, so a restored row older than that is
      // already refused here; a row that survives is still counted as dropped
      // when no window of this model's policy would ever read it.
      const count = windows.importState(now, rows, Math.floor(sourceNow / 1_000));
      const policy = this.policyOf(key);
      const reachable = WINDOW_KEYS.some((window) => {
        if (policy.requests[window] === UNLIMITED && policy.tokens[window] === UNLIMITED) return false;
        return windows.liveBucketCount(window, now) > 0;
      });
      if (count === 0 || !reachable) dropped.push(key);
      restored += count;
    }
    // `saveState` records the wall reading it wrote under, and nothing ever
    // validated it. A wall clock that stepped backwards between runs made the
    // reader translate every row into its own future, so rows were pulled
    // forward past "now" and dropped. Dropping is the safe direction, but the
    // loss used to be invisible; report the skew so it reaches the log and the
    // status document.
    const savedWall = state.savedWall;
    const skewMs = typeof savedWall === 'number' && Number.isFinite(savedWall)
      ? savedWall - this.#clock.wall()
      : 0;
    return { restored: dropped.length > 0 ? 0 : restored, dropped, skewMs };
  }

  /**
   * Admit one provider request. Resolves with a lease when the request may be
   * sent, and rejects only when the caller cancelled it or the limiter was
   * disposed. A queued request consumes no tokens and schedules no timer of its
   * own: the model owns exactly one timer, armed for the moment the limiting
   * window frees.
   *
   * @param {{ provider: string, model: string, signal?: AbortSignal, sessionId?: string }} options
   * @param {number} cost
   * @returns {{ admitted: boolean, lease: import('./types.js').Lease | undefined, aborted: boolean }}
   */
  async admit(options, cost) {
    const key = modelKeyOf(options.provider, options.model);
    if (!this.limits(options.provider, options.model)) {
      // Fast path: an unlimited model allocates nothing, arms no timer, and
      // records nothing, so it costs exactly one map lookup.
      return { admitted: true, lease: undefined, aborted: false };
    }
    if (this.#disposed) return { admitted: false, lease: undefined, aborted: true };
    if (options.signal?.aborted === true) return { admitted: false, lease: undefined, aborted: true };

    const state = this.#model(key);
    const now = this.#clock.mono();
    const reason = this.#blockingReason(key, cost, now);
    if (reason === undefined && state.queue.length === 0) {
      return { admitted: true, lease: this.#reserve(key, cost, now), aborted: false };
    }

    const entry = /** @type {import('./types.js').QueueEntry} */ ({
      id: ++this.#sequence,
      cost,
      options,
      queuedAt: this.#clock.mono(),
      deadline: Number.POSITIVE_INFINITY,
      resolve: () => {},
      settled: false,
      admitted: false,
      abortListener: undefined,
    });
    return new Promise((resolve) => {
      entry.resolve = resolve;
      state.queue.push(entry);
      if (options.signal !== undefined) {
        entry.abortListener = () => this.#cancel(key, entry);
        options.signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      this.#notifyStatus(key, reason ?? 'queue');
      this.#pump(key);
    });
  }

  /**
   * Remove one waiter because its caller cancelled, leaving no timer behind.
   * @param {string} key
   * @param {import('./types.js').QueueEntry} entry
   */
  #cancel(key, entry) {
    if (entry.settled) return;
    const state = this.#models.get(key);
    if (state === undefined) return;
    const index = state.queue.indexOf(entry);
    if (index >= 0) state.queue.splice(index, 1);
    entry.settled = true;
    this.#detachAbort(entry);
    entry.resolve({ admitted: false, lease: undefined, aborted: true });
    this.#pump(key);
  }

  /**
   * @param {import('./types.js').QueueEntry} entry
   */
  #detachAbort(entry) {
    if (entry.abortListener === undefined) return;
    entry.options.signal?.removeEventListener('abort', entry.abortListener);
    entry.abortListener = undefined;
  }

  /**
   * Release a lease whose request will not consume the token reservation.
   * @param {import('./types.js').Lease | undefined} lease
   */
  rollback(lease) {
    if (lease === undefined) return;
    const { key, windows, cost } = lease;
    windows.charge(lease.atMs, -cost);
    this.#active.delete(lease);
    this.#reschedule(key);
  }

  /**
   * Finish a lease, replacing the reservation with the provider's real usage.
   * The reservation and the usage were both charged to the same bucket, so the
   * adjustment is their difference: a request that overran is charged the
   * overrun, a request that came in short gets the difference back, and no
   * counter is ever written twice for one attempt.
   *
   * @param {import('./types.js').Lease | undefined} lease
   * @param {unknown} usage - provider-reported usage for this attempt.
   */
  settle(lease, usage) {
    if (lease === undefined) return;
    const actual = usageTokens(usage);
    // The correction is written at the settle instant, not at the admission
    // instant. A provider call admitted just before a window rolls would
    // otherwise report its overrun into a bucket that has already left that
    // window, so the overrun would never be counted anywhere and the limiter
    // would let the next request go too early. Writing it "now" always lands in
    // a live bucket; the reservation and the refund together still sum to the
    // real usage for every window that spans both.
    if (actual !== undefined) lease.windows.charge(this.#clock.mono(), actual - lease.cost);
    this.#active.delete(lease);
    this.#reschedule(lease.key);
  }

  /**
   * Charge provider-reported usage that belongs to no reservation, which is how
   * a rejection that still reports tokens is accounted for.
   *
   * @param {string} provider
   * @param {string} model
   * @param {unknown} usage
   */
  chargeUsage(provider, model, usage) {
    const key = modelKeyOf(provider, model);
    const actual = usageTokens(usage);
    if (actual === undefined || actual <= 0) return;
    if (!this.limits(provider, model)) return;
    this.#windowsFor(key).charge(this.#clock.mono(), actual);
    this.#reschedule(key);
  }

  /**
   * Register a provider throttle so later requests wait.
   * @param {string} provider
   * @param {string} model
   * @param {{ providerRetryAfterMs?: number, status?: number, code?: string }} failure
   * @returns {number} cooldown applied, in milliseconds.
   */
  observeThrottle(provider, model, failure = {}) {
    const key = modelKeyOf(provider, model);
    const state = this.#model(key);
    const retry = { ...DEFAULT_RETRY, ...this.#options.retry };
    state.failureStreak += 1;
    const providerDelay = failure.providerRetryAfterMs;
    const delay = typeof providerDelay === 'number' && Number.isFinite(providerDelay) && providerDelay > 0
      ? providerDelay
      : this.#backoffDelay(state.failureStreak, retry);
    const until = this.#clock.mono() + delay;
    state.lastThrottledAt = this.#clock.mono();
    if (until > state.cooldownUntil) state.cooldownUntil = until;
    if (failure.status === 429 || failure.code === 'RATE_LIMIT') {
      this.#log({
        level: 'warn',
        event: 'provider-throttled',
        model: key,
        status: failure.status,
        cooldownMs: Math.round(delay),
        source: typeof providerDelay === 'number' && providerDelay > 0 ? 'retry-after' : 'backoff',
      });
    }
    this.#reschedule(key);
    return delay;
  }

  /**
   * Record a clean completion so the backoff ladder resets.
   * @param {string} provider
   * @param {string} model
   */
  observeSuccess(provider, model) {
    const state = this.#model(modelKeyOf(provider, model));
    state.failureStreak = 0;
  }

  /**
   * Drop a cooldown that was armed for a request that is now over.
   *
   * `observeThrottle` arms the penalty before the caller has decided whether it
   * will retry, so an exhausted retry budget used to leave the model in
   * cooldown: the *next, unrelated* request then waited out a backoff it never
   * triggered. The streak resets with it, because the escalation ladder exists
   * to spread one request's retries apart, not to remember them across
   * requests; a provider that is still throttling answers the fresh request
   * with its own 429 (and its own `Retry-After`), so nothing is lost.
   *
   * @param {string} provider
   * @param {string} model
   */
  clearCooldown(provider, model) {
    const key = modelKeyOf(provider, model);
    const state = this.#models.get(key);
    if (state === undefined) return;
    if (state.cooldownUntil <= this.#clock.mono() && state.failureStreak === 0) return;
    state.cooldownUntil = 0;
    state.failureStreak = 0;
    this.#reschedule(key);
  }

  /**
   * Note that a single request cannot fit inside its own window; the engine
   * waits for an empty window and reports the condition instead of hanging.
   * @param {string} provider
   * @param {string} model
   * @param {string} detail
   */
  noteOversized(provider, model, detail) {
    const key = modelKeyOf(provider, model);
    const state = this.#model(key);
    state.warning = detail;
    this.#log({ level: 'warn', event: 'request-exceeds-limit', model: key, detail });
  }

  /**
   * Wait until `targetMono` for a retry; resolves early when the caller aborts.
   * @param {number} targetMono
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<void>}
   */
  waitUntil(targetMono, signal) {
    const delay = targetMono - this.#clock.mono();
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      /** @type {unknown} */
      let handle;
      const finish = () => {
        if (handle !== undefined) this.#timers.clearTimeout(handle);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      handle = this.#timers.setTimeout(finish, Math.ceil(delay));
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** Release every timer and resolve every queued waiter as aborted. */
  dispose() {
    this.#disposed = true;
    for (const [key, state] of this.#models) {
      if (state.timer !== undefined) {
        this.#timers.clearTimeout(state.timer);
        state.timer = undefined;
      }
      for (const entry of state.queue.splice(0)) {
        if (entry.settled) continue;
        entry.settled = true;
        entry.resolve({ admitted: false, lease: undefined, aborted: true });
      }
      this.#models.delete(key);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * @param {string} key
   * @returns {ModelState}
   */
  #model(key) {
    let state = this.#models.get(key);
    if (state === undefined) {
      state = {
        queue: [],
        timer: undefined,
        pumping: false,
        cooldownUntil: 0,
        failureStreak: 0,
        warning: undefined,
        waits: 0,
        waitMs: 0,
        lastThrottledAt: null,
      };
      this.#models.set(key, state);
    }
    return state;
  }

  /**
   * @param {string} key
   * @returns {RollingWindows}
   */
  #windowsFor(key) {
    let windows = this.#windows.get(key);
    if (windows === undefined) {
      windows = new RollingWindows();
      this.#windows.set(key, windows);
    }
    return windows;
  }

  /**
   * Drop a model whose policy was removed from the configuration. Every
   * per-model structure is allocated on first use, so releasing the counters
   * here is what makes a model with no policy cost nothing again -- the
   * alternative is one rolling window per configured-then-deleted model kept
   * for the life of the process, with its counters still published by /state.
   * A queue is pumped rather than discarded: with no limits left its requests
   * should be admitted immediately.
   *
   * @param {string} key
   */
  #releaseModel(key) {
    this.#windows.delete(key);
    const state = this.#models.get(key);
    if (state === undefined) return;
    if (state.timer !== undefined) {
      this.#timers.clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.cooldownUntil = 0;
    state.failureStreak = 0;
    state.warning = undefined;
    if (state.queue.every((entry) => entry.settled)) this.#models.delete(key);
    else this.#pump(key);
  }

  /**
   * @param {string} key
   * @param {number} cost
   * @param {number} now
   * @returns {string | undefined} the limiting reason, or undefined when free.
   */
  #blockingReason(key, cost, now) {
    const policy = this.policyOf(key);
    const state = this.#models.get(key);
    if (state !== undefined && state.cooldownUntil > now) return 'cooldown';
    const windows = this.#windows.get(key);
    if (windows === undefined) return undefined;
    for (const window of WINDOW_KEYS) {
      const limit = policy.requests[window];
      if (limit !== UNLIMITED && windows.countIn(window, now) + 1 > limit) return `requests:${window}`;
    }
    for (const window of WINDOW_KEYS) {
      const limit = policy.tokens[window];
      if (limit === UNLIMITED) continue;
      // A token limit is a ceiling on what may be inside the window, so the
      // reservation fits whenever the projected total stays within it. A
      // request whose own reservation reaches the ceiling waits for an empty
      // window instead of being sent and reported as an overrun.
      const need = Math.min(cost, limit);
      if (windows.tokensIn(window, now) + need > limit) return `tokens:${window}`;
    }
    return undefined;
  }

  /**
   * @param {string} key
   * @param {number} cost
   * @param {number} now
   * @returns {import('./types.js').Lease}
   */
  #reserve(key, cost, now) {
    const windows = this.#windowsFor(key);
    windows.record(now);
    if (cost > 0) windows.charge(now, cost);
    const lease = /** @type {import('./types.js').Lease} */ ({ key, cost, atMs: now, windows });
    this.#active.add(lease);
    return lease;
  }

  /**
   * The next instant a request may start, or `null` when only an empty window
   * can free enough room.
   *
   * A window that is not blocking contributes nothing; a window that is
   * blocking contributes the exact moment its oldest event rolls out. The
   * latest contribution across windows is the answer, because every window must
   * be satisfied at the same instant. A request larger than a window needs the
   * window to be completely empty, which is a bounded wait, never forever.
   *
   * @param {string} key
   * @param {number} now
   * @returns {number | null} monotonic time, `0` when capacity is already free, or `null` when nothing can help.
   */
  #nextFreeMs(key, now) {
    const policy = this.policyOf(key);
    const windows = this.#windows.get(key);
    const state = this.#models.get(key);
    let wake = 0;
    if (state !== undefined && state.cooldownUntil > now) wake = state.cooldownUntil;
    if (windows === undefined) return wake;
    const headCost = this.#headCost(key);
    for (const window of WINDOW_KEYS) {
      const requestLimit = policy.requests[window];
      if (requestLimit !== UNLIMITED) {
        const at = windows.nextFreeAt(window, now, requestLimit, 1, 'requests');
        if (at > wake) wake = at;
      }
      const tokenLimit = policy.tokens[window];
      if (tokenLimit !== UNLIMITED) {
        const need = Math.min(headCost, tokenLimit);
        const at = windows.nextFreeAt(window, now, tokenLimit, need, 'tokens');
        if (at > wake) wake = at;
      }
    }
    return wake;
  }

  /**
   * @param {string} key
   * @returns {number} cost of the entry that will go first.
   */
  #headCost(key) {
    const state = this.#models.get(key);
    const head = state?.queue.find((entry) => !entry.settled);
    return head === undefined ? 1 : Math.max(1, head.cost);
  }

  /**
   * Estimate the cost of one request.
   * @param {import('./types.js').StreamOptions} options
   * @returns {number}
   */
  costOf(options) {
    return estimateRequestTokens(
      options,
      this.#options.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
      this.#options.imageTokens ?? DEFAULT_IMAGE_TOKENS,
    );
  }

  /** @param {string} key */
  #reschedule(key) {
    const state = this.#models.get(key);
    if (state === undefined) return;
    this.#pump(key);
  }

  /**
   * Hand out capacity to the head of the queue, in arrival order, and arm the
   * model's single timer when nothing more can start now.
   * @param {string} key
   */
  #pump(key) {
    if (this.#disposed) return;
    const state = this.#models.get(key);
    if (state === undefined || state.pumping) return;
    state.pumping = true;
    try {
      if (state.timer !== undefined) {
        this.#timers.clearTimeout(state.timer);
        state.timer = undefined;
      }
      const pending = state.queue.filter((entry) => !entry.settled);
      state.queue = pending;
      // Deadlines are swept first and independently of admission order, so a
      // cancelled waiter is released even while the head of the queue is blocked.
      for (const entry of pending) {
        if (entry.deadline > this.#clock.mono()) continue;
        entry.settled = true;
        this.#detachAbort(entry);
        entry.resolve({ admitted: false, lease: undefined, aborted: false });
      }
      // Admission is strictly in arrival order and stops at the first request
      // that does not fit. That is what the queue is for: letting a later,
      // cheaper request overtake a blocked head is how an oversized request
      // starves, because the window it needs to empty is refilled underneath it.
      // Stopping also keeps #headCost -- the cost the next wake-up is computed
      // from -- the cost of the request that will actually go next.
      for (const entry of state.queue) {
        if (entry.settled) continue;
        const now = this.#clock.mono();
        if (this.#blockingReason(key, entry.cost, now) !== undefined) break;
        entry.settled = true;
        entry.admitted = true;
        // Only a request that actually queued is a wait. The head of a queue
        // that was pumped immediately has a `queuedAt` from the same instant,
        // which records a zero-length wait rather than dropping the request
        // from the tally.
        state.waits += 1;
        state.waitMs += Math.max(0, now - entry.queuedAt);
        this.#detachAbort(entry);
        entry.resolve({ admitted: true, lease: this.#reserve(key, entry.cost, now), aborted: false });
      }
      state.queue = state.queue.filter((entry) => !entry.settled);
      if (state.queue.length > 0) {
        const now = this.#clock.mono();
        const oversized = this.#oversizedReason(key);
        if (oversized !== undefined && state.warning !== oversized) {
          state.warning = oversized;
          this.#log({ level: 'warn', event: 'request-exceeds-limit', model: key, detail: oversized });
        } else if (oversized === undefined) {
          state.warning = undefined;
        }
        const next = this.#nextFreeMs(key, now);
        const target = next === null ? this.#emptyWindowAt(key, now) : next;
        const delay = Math.max(1, Math.ceil(target + this.#margin() - now));
        state.timer = this.#timers.setTimeout(() => {
          state.timer = undefined;
          this.#pump(key);
        }, delay);
        this.#notifyStatus(key, this.#queueReason(key, now));
        return;
      }
      state.warning = undefined;
      this.#notifyStatus(key, 'idle');
    } finally {
      state.pumping = false;
    }
  }

  /**
   * The moment the longest blocking window is completely empty.
   * @param {string} key
   * @param {number} now
   * @returns {number}
   */
  #emptyWindowAt(key, now) {
    const windows = this.#windows.get(key);
    if (windows === undefined) return now;
    const policy = this.policyOf(key);
    let latest = now;
    for (const window of WINDOW_KEYS) {
      if (policy.requests[window] === UNLIMITED && policy.tokens[window] === UNLIMITED) continue;
      const clearAt = windows.clearAt(window, now);
      if (clearAt > latest) latest = clearAt;
    }
    return latest;
  }

  /**
   * Describe why a queued request cannot fit its own window, if that is the case.
   * @param {string} key
   * @returns {string | undefined}
   */
  #oversizedReason(key) {
    const policy = this.policyOf(key);
    const state = this.#models.get(key);
    const head = state?.queue.find((entry) => !entry.settled);
    if (head === undefined) return undefined;
    for (const window of WINDOW_KEYS) {
      const limit = policy.tokens[window];
      if (limit !== UNLIMITED && head.cost > limit) {
        return `this request reserves about ${head.cost} tokens, more than the ${window} token limit`
          + ` of ${limit}; it is sent as soon as that window is empty`;
      }
    }
    return undefined;
  }

  /**
   * @param {string} key
   * @param {number} now
   * @returns {string}
   */
  #queueReason(key, now) {
    const state = this.#models.get(key);
    const head = state?.queue.find((entry) => !entry.settled);
    if (head === undefined) return 'idle';
    return this.#blockingReason(key, head.cost, now) ?? 'queue';
  }

  /** @returns {number} */
  #margin() {
    const base = this.#options.wakeMarginMs ?? DEFAULT_WAKE_MARGIN_MS;
    const jitter = this.#options.wakeJitterMs ?? DEFAULT_WAKE_JITTER_MS;
    return base + (jitter > 0 ? this.#random() * jitter : 0);
  }

  /**
   * @param {number} streak
   * @param {{ initialDelayMs: number, maxDelayMs: number, jitterRatio: number }} retry
   * @returns {number}
   */
  #backoffDelay(streak, retry) {
    const exponent = Math.min(Math.max(streak - 1, 0), 30);
    const target = Math.min(retry.initialDelayMs * 2 ** exponent, retry.maxDelayMs);
    const spread = Math.min(Math.max(retry.jitterRatio, 0), 1);
    const factor = 1 - spread + 2 * spread * this.#random();
    return Math.max(0, Math.round(Math.min(retry.maxDelayMs, target * factor)));
  }

  /** @returns {number} injectable entropy, so tests can pin the jitter. */
  #random() {
    return (this.#options.random ?? random)();
  }

  /**
   * @param {RollingWindows | undefined} windows
   * @param {number} now
   * @returns {number | null}
   */
  #lastRequestAgoMs(windows, now) {
    if (windows === undefined || windows.lastEventSecond < 0) return null;
    return Math.max(0, Math.round(now - windows.lastEventSecond * 1_000));
  }

  /**
   * @param {string} key
   * @param {string} reason
   */
  #notifyStatus(key, reason) {
    if (this.#options.onStatus === undefined) return;
    // No ETA is passed. It used to be computed here with a `#nextFreeMs` walk
    // plus a `#emptyWindowAt` fallback on every pump, and the only subscriber
    // discarded it: the wait a client renders comes from `describe()`, which
    // measures it once per pushed document. Recomputing it here was pure cost
    // on the hot admission path.
    this.#options.onStatus({ key, reason });
  }

  /** @param {Record<string, unknown>} record */
  #log(record) {
    this.#options.onLog?.(record);
  }
}
