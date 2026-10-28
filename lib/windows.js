/**
 * Rolling windows for one model.
 *
 * Four windows (second, minute, hour, day) share one array of one-second
 * buckets, so memory stays bounded no matter how many requests a model serves:
 * exactly `BUCKET_COUNT` slots (86 400), each a request count and a token sum.
 *
 * Per-window totals are kept incrementally in `#offsets`. Recording an event
 * adds its delta to every window that already covers the bucket, and time
 * moving on subtracts only the buckets that actually cross a boundary — a
 * pointer walk over the live buckets that must leave, never a scan of all
 * 86 400 slots. Reading a window is therefore O(1) in the steady state, and
 * the cost of an admission does not grow with the number of live buckets.
 * Expired buckets are repaired exactly when they leave their longest window,
 * which is what makes each window a true rolling window: an event stops
 * counting at the precise moment it falls out.
 *
 * Time is supplied by the caller as monotonic milliseconds, so a wall-clock
 * jump (sleep, hibernation, NTP) can never make an event count twice or keep a
 * window closed forever.
 *
 * @module dsh-llm-model-rate-limit/lib/windows
 */

import { BUCKET_COUNT, BUCKET_MS, WINDOW_KEYS, WINDOW_MS } from './constants.js';

/** Seconds per bucket. */
const BUCKETS_PER_SECOND = BUCKET_MS / 1_000;
/** Live seconds held by the longest window. */
const LIVE_SECONDS = BUCKET_COUNT / BUCKETS_PER_SECOND;

/**
 * Running state of one window.
 *
 * `count`/`tokens` are the window's live totals. `oldestSecond` is the oldest
 * second currently counted inside it, with `oldestCount`/`oldestTokens` being
 * that bucket's contribution — so the window can drop it by subtraction when
 * it crosses the boundary instead of rescanning the buckets.
 *
 * @typedef {object} WindowOffset
 * @property {number} oldestSecond - oldest second counted, or -1 when empty.
 * @property {number} oldestCount - request weight of that oldest bucket.
 * @property {number} oldestTokens - token weight of that oldest bucket.
 * @property {number} count - live request count inside the window.
 * @property {number} tokens - live token sum inside the window.
 */

export class RollingWindows {
  /** @type {Float64Array} request count per one-second bucket. */
  #counts = new Float64Array(BUCKET_COUNT);
  /** @type {Float64Array} token sum per one-second bucket. */
  #tokens = new Float64Array(BUCKET_COUNT);
  /** @type {Int32Array} second index currently stored in each slot. */
  #stamps = new Int32Array(BUCKET_COUNT).fill(-1);
  /**
   * Incremental totals, one entry per window, valid for `#cursor`. `undefined`
   * means "rebuild from the buckets on the next read".
   * @type {Record<string, WindowOffset> | undefined}
   */
  #offsets;
  /** Second index treated as "now" by the last trim. */
  #cursor = -1;
  /** Newest second ever stored in a bucket, or -1. */
  #newest = -1;
  /** Oldest second that may still hold a live bucket. */
  #oldest = -1;
  /** Monotonic second of the newest recorded event, or -1. */
  #lastEventSecond = -1;

  /** @returns {number} monotonic second of the newest recorded event, or -1. */
  get lastEventSecond() {
    return this.#lastEventSecond;
  }

  /** @returns {number} live request count across the longest window. */
  get count() {
    return this.#ensureOffsets().perSecond.count;
  }

  /** @returns {number} live token sum across the longest window. */
  get tokens() {
    return this.#ensureOffsets().perSecond.tokens;
  }

  /** Drop every event. */
  clear() {
    this.#counts.fill(0);
    this.#tokens.fill(0);
    this.#stamps.fill(-1);
    this.#cursor = -1;
    this.#newest = -1;
    this.#oldest = -1;
    this.#lastEventSecond = -1;
    this.#offsets = undefined;
  }

  /**
   * Count one request as started.
   * @param {number} atMs - monotonic wall time of the event.
   */
  record(atMs) {
    this.#write(atMs, 1, 0);
  }

  /**
   * Add a token delta: positive to reserve capacity, negative to release it.
   * @param {number} atMs - monotonic wall time the usage is charged to.
   * @param {number} delta
   */
  charge(atMs, delta) {
    if (delta === 0) return;
    this.#write(atMs, 0, delta);
  }

  /**
   * Bring every window up to `nowMs`.
   *
   * A read at a time *earlier* than a previous read (which the limiter never
   * issues — its clock is monotonic — but a rebased snapshot may) is handled by
   * rebuilding the totals for that instant instead of trusting a forward delta.
   *
   * @param {number} nowMs
   */
  trim(nowMs) {
    const nowSecond = Math.floor(nowMs / 1_000);
    if (this.#cursor < 0) {
      this.#cursor = nowSecond;
      this.#oldest = nowSecond;
      this.#newest = nowSecond;
    }
    this.#cursor = nowSecond;
    this.#prepare(nowSecond);
  }

  /**
   * Count of live events inside one window ending at `nowMs`.
   * @param {string} window
   * @param {number} nowMs
   * @returns {number}
   */
  countIn(window, nowMs) {
    this.trim(nowMs);
    return this.#ensureOffsets()[window].count;
  }

  /**
   * Token total of live events inside one window ending at `nowMs`.
   * @param {string} window
   * @param {number} nowMs
   * @returns {number}
   */
  tokensIn(window, nowMs) {
    this.trim(nowMs);
    return this.#ensureOffsets()[window].tokens;
  }

  /**
   * Earliest monotonic time at which `need` more capacity exists in `window`.
   *
   * Returns `0` when capacity is available now. When nothing inside the current
   * window can help — a need that already reaches the limit — the answer is the
   * moment the window is completely empty, which is a bounded wait rather than
   * a request that can never be sent.
   *
   * @param {string} window
   * @param {number} nowMs
   * @param {number} limit
   * @param {number} need
   * @param {'requests'|'tokens'} kind
   * @returns {number}
   */
  nextFreeAt(window, nowMs, limit, need, kind) {
    this.trim(nowMs);
    const offset = this.#ensureOffsets()[window];
    const key = kind === 'tokens' ? 'tokens' : 'count';
    let total = offset[key];
    // A limit is a ceiling on what may be inside the window, so the need fits
    // whenever the projected total stays within it.
    if (total + need <= limit) return 0;
    const values = kind === 'tokens' ? this.#tokens : this.#counts;
    const nowSecond = Math.floor(nowMs / 1_000);
    const span = WINDOW_MS[window] / 1_000;
    // Only buckets that belong to THIS window can free capacity for it, and the
    // window already knows which one is oldest, so the walk starts at the first
    // live bucket that can actually leave instead of at the window boundary.
    const cutoff = nowSecond - (span - BUCKETS_PER_SECOND);
    const from = Math.max(offset.oldestSecond, cutoff, 0);
    for (let second = from; second <= nowSecond; second += 1) {
      const slot = second % BUCKET_COUNT;
      if (this.#stamps[slot] !== second) continue;
      total -= values[slot];
      if (total + need <= limit) {
        const freeAtMs = (second + span) * 1_000;
        return freeAtMs > nowMs ? freeAtMs : nowMs;
      }
    }
    // Only an empty window can satisfy this need.
    return this.clearAt(window, nowMs);
  }

  /**
   * The moment every event currently inside `window` has left it.
   *
   * Used when a single request is larger than the whole window: waiting for a
   * partial release would never succeed, so the caller waits for an empty
   * window instead of forever.
   *
   * @param {string} window
   * @param {number} nowMs
   * @returns {number} monotonic time, never earlier than `nowMs`.
   */
  clearAt(window, nowMs) {
    this.trim(nowMs);
    const nowSecond = Math.floor(nowMs / 1_000);
    const span = WINDOW_MS[window] / 1_000;
    const cutoff = nowSecond - (span - BUCKETS_PER_SECOND);
    let newest = -1;
    const floor = Math.max(this.#oldest, 0);
    for (let second = floor; second <= nowSecond; second += 1) {
      if (second < cutoff) continue;
      const slot = second % BUCKET_COUNT;
      if (this.#stamps[slot] !== second) continue;
      if (this.#counts[slot] === 0 && this.#tokens[slot] === 0) continue;
      newest = second;
    }
    if (newest < 0) return nowMs;
    return Math.max(nowMs, (newest + span) * 1_000);
  }

  /**
   * Number of live buckets inside one window at `nowMs`.
   * @param {string} window
   * @param {number} nowMs
   * @returns {number}
   */
  liveBucketCount(window, nowMs) {
    this.trim(nowMs);
    const nowSecond = Math.floor(nowMs / 1_000);
    const cutoff = nowSecond - (WINDOW_MS[window] / 1_000 - BUCKETS_PER_SECOND);
    const from = Math.max(this.#oldest, cutoff, 0);
    let live = 0;
    for (let second = from; second <= nowSecond; second += 1) {
      const slot = second % BUCKET_COUNT;
      if (this.#stamps[slot] !== second) continue;
      if (this.#counts[slot] === 0 && this.#tokens[slot] === 0) continue;
      live += 1;
    }
    return live;
  }

  /**
   * Export live buckets for persistence.
   * @param {number} nowMs
   * @returns {Array<[number, number, number]>} `[second, requests, tokens]` rows.
   */
  exportState(nowMs) {
    this.trim(nowMs);
    /** @type {Array<[number, number, number]>} */
    const rows = [];
    const nowSecond = Math.floor(nowMs / 1_000);
    const oldest = Math.max(this.#oldest, nowSecond - LIVE_SECONDS + 1, 0);
    for (let second = oldest; second <= nowSecond; second += 1) {
      const slot = second % BUCKET_COUNT;
      if (this.#stamps[slot] !== second) continue;
      const count = this.#counts[slot];
      const tokens = this.#tokens[slot];
      if (count === 0 && tokens === 0) continue;
      rows.push([second, count, tokens]);
    }
    return rows;
  }

  /**
   * Restore buckets that are still inside the longest window at `nowMs`.
   *
   * `sourceSecond` rebases the persisted second indices into the caller's
   * monotonic domain: the file was written by another process with its own
   * monotonic origin, so a row is stored relative to that origin and must be
   * translated before it can be compared with a live event.
   *
   * Rows older than the longest window, forward-dated rows (a wall clock that
   * moved backwards), and malformed rows are dropped, so a stale or damaged
   * state file can never wedge the limiter.
   *
   * @param {number} nowMs
   * @param {unknown} rows
   * @param {number} [sourceSecond] - the persisted second index that means "now".
   * @returns {number} number of restored buckets.
   */
  importState(nowMs, rows, sourceSecond) {
    this.clear();
    const nowSecond = Math.floor(nowMs / 1_000);
    const offset = typeof sourceSecond === 'number' && Number.isFinite(sourceSecond)
      ? Math.round(nowSecond - sourceSecond)
      : 0;
    const oldestAccepted = nowSecond - LIVE_SECONDS + 1;
    let restored = 0;
    let oldestImported = -1;
    let newestImported = -1;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const [rawSecond, count, tokens] = row;
        if (!Number.isInteger(rawSecond)) continue;
        if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue;
        if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) continue;
        const second = rawSecond + offset;
        if (second > nowSecond || second < oldestAccepted) continue;
        if (count === 0 && tokens === 0) continue;
        const slot = second % BUCKET_COUNT;
        this.#stamps[slot] = second;
        this.#counts[slot] += count;
        this.#tokens[slot] += tokens;
        if (oldestImported < 0 || second < oldestImported) oldestImported = second;
        if (second > newestImported) newestImported = second;
        restored += 1;
      }
    }
    this.#cursor = nowSecond;
    this.#newest = newestImported < 0 ? nowSecond : newestImported;
    // The rebuild walks from the oldest restored bucket, so a state file that
    // only spans part of the day costs only that part.
    this.#oldest = oldestImported < 0 ? nowSecond : oldestImported;
    this.#offsets = undefined;
    this.#prepare(nowSecond);
    return restored;
  }

  /**
   * Record one bucket delta, then fold it into the running totals.
   * @param {number} atMs
   * @param {number} countDelta
   * @param {number} tokenDelta
   */
  #write(atMs, countDelta, tokenDelta) {
    const second = Math.floor(atMs / 1_000);
    if (this.#cursor < 0) {
      this.#cursor = second;
      this.#oldest = second;
      this.#newest = second;
    }
    this.trim(atMs);
    const slot = second % BUCKET_COUNT;
    if (this.#stamps[slot] !== second) {
      if (this.#stamps[slot] >= 0) {
        // A slot is only reused once its previous tenant is out of every
        // window, so it carries no live weight; clearing it is still the honest
        // thing to do.
        this.#counts[slot] = 0;
        this.#tokens[slot] = 0;
      }
      this.#stamps[slot] = second;
      if (this.#oldest < 0 || second < this.#oldest) this.#oldest = second;
    }
    if (countDelta !== 0) this.#counts[slot] += countDelta;
    if (tokenDelta !== 0) this.#tokens[slot] += tokenDelta;
    if (second > this.#lastEventSecond) this.#lastEventSecond = second;
    if (second > this.#newest) this.#newest = second;
    // Fold the delta into every window that already covers this bucket instead
    // of discarding the running totals. A bucket written outside every window
    // is left out of the totals, which is exactly how the windows read it back.
    this.#absorb(second, slot, countDelta, tokenDelta);
  }

  /**
   * Add one bucket's delta to every window whose boundary already covers it.
   * @param {number} second
   * @param {number} slot
   * @param {number} countDelta
   * @param {number} tokenDelta
   */
  #absorb(second, slot, countDelta, tokenDelta) {
    const offsets = this.#offsets;
    if (offsets === undefined) return;
    const count = this.#counts[slot];
    const tokens = this.#tokens[slot];
    const nowSecond = this.#cursor;
    for (const window of WINDOW_KEYS) {
      const offset = offsets[window];
      const from = nowSecond - (WINDOW_MS[window] / 1_000 - BUCKETS_PER_SECOND);
      if (second < from || second > nowSecond) continue;
      offset.count += countDelta;
      offset.tokens += tokenDelta;
      if (offset.oldestSecond < 0 || second < offset.oldestSecond) {
        offset.oldestSecond = second;
        offset.oldestCount = count;
        offset.oldestTokens = tokens;
      } else if (second === offset.oldestSecond) {
        // The oldest bucket of this window just changed weight.
        offset.oldestCount = count;
        offset.oldestTokens = tokens;
      }
    }
  }

  /**
   * Remove one bucket. Its weight has already left every window's totals.
   * @param {number} second
   * @param {number} slot
   */
  #retire(second, slot) {
    this.#counts[slot] = 0;
    this.#tokens[slot] = 0;
    this.#stamps[slot] = -1;
  }

  /**
   * Drop buckets that no window can still count.
   *
   * Only the buckets that fell out of the longest window are visited — in the
   * steady state that is zero or one bucket per call, never all 86 400 slots.
   * @param {number} nowSecond
   */
  #dropOutside(nowSecond) {
    const floor = nowSecond - LIVE_SECONDS + 1;
    if (this.#oldest >= 0) {
      // Clamped so a wide forward jump cannot turn this into a long walk: a
      // bucket older than the circular buffer's own span shares a slot with a
      // live one and is cleared when that slot is reused.
      const from = Math.max(this.#oldest, floor - BUCKET_COUNT, 0);
      const stop = Math.min(floor - 1, nowSecond);
      for (let second = from; second <= stop; second += 1) {
        const slot = second % BUCKET_COUNT;
        if (this.#stamps[slot] === second) this.#retire(second, slot);
      }
    }
    // Buckets dated after "now" only appear when the monotonic reading steps
    // backwards. They carry no live weight, so they are retired and the totals
    // are rebuilt rather than adjusted.
    if (this.#newest > nowSecond) {
      for (let second = nowSecond + 1; second <= this.#newest; second += 1) {
        const slot = second % BUCKET_COUNT;
        if (this.#stamps[slot] === second) this.#retire(second, slot);
      }
      this.#newest = nowSecond;
      this.#oldest = nowSecond;
      this.#offsets = undefined;
    }
  }

  /**
   * Repair the cursor, drop buckets outside every window, move the totals on.
   * @param {number} nowSecond
   */
  #prepare(nowSecond) {
    this.#dropOutside(nowSecond);
    let offsets = this.#offsets;
    if (offsets === undefined) {
      offsets = this.#computeOffsets(nowSecond);
    } else {
      for (const window of WINDOW_KEYS) this.#slide(window, offsets[window], nowSecond);
    }
    this.#offsets = offsets;
    let oldest = -1;
    for (const window of WINDOW_KEYS) {
      const second = offsets[window].oldestSecond;
      if (second >= 0 && (oldest < 0 || second < oldest)) oldest = second;
    }
    this.#oldest = oldest < 0 ? nowSecond : oldest;
  }

  /**
   * Move one window's totals forward, subtracting the buckets that left it.
   * @param {string} window
   * @param {WindowOffset} offset
   * @param {number} nowSecond
   */
  #slide(window, offset, nowSecond) {
    const span = WINDOW_MS[window] / 1_000;
    const windowFrom = nowSecond - (span - BUCKETS_PER_SECOND);
    while (offset.oldestSecond >= 0 && offset.oldestSecond < windowFrom) {
      offset.count -= offset.oldestCount;
      offset.tokens -= offset.oldestTokens;
      const next = this.#nextLiveSecond(offset.oldestSecond + 1, windowFrom, nowSecond);
      if (next < 0) {
        offset.oldestSecond = -1;
        offset.oldestCount = 0;
        offset.oldestTokens = 0;
        break;
      }
      offset.oldestSecond = next;
      const slot = next % BUCKET_COUNT;
      offset.oldestCount = this.#counts[slot];
      offset.oldestTokens = this.#tokens[slot];
    }
  }

  /**
   * First bucket with live weight between `from` and `nowSecond`.
   * @param {number} from
   * @param {number} windowFrom
   * @param {number} nowSecond
   * @returns {number} the second index, or -1.
   */
  #nextLiveSecond(from, windowFrom, nowSecond) {
    const start = Math.max(from, windowFrom, 0);
    for (let second = start; second <= nowSecond; second += 1) {
      const slot = second % BUCKET_COUNT;
      if (this.#stamps[slot] !== second) continue;
      if (this.#counts[slot] === 0 && this.#tokens[slot] === 0) continue;
      return second;
    }
    return -1;
  }

  /**
   * Rebuild every window total from the buckets, for one instant.
   *
   * This is the cold path: a first read, a rebuild after a backwards clock
   * step, or a restored state file. It walks only seconds that hold a bucket.
   *
   * @param {number} nowSecond
   * @returns {Record<string, WindowOffset>}
   */
  #computeOffsets(nowSecond) {
    /** @type {Record<string, WindowOffset>} */
    const offsets = {};
    for (const window of WINDOW_KEYS) {
      offsets[window] = {
        oldestSecond: -1,
        oldestCount: 0,
        oldestTokens: 0,
        count: 0,
        tokens: 0,
      };
    }
    const floor = Math.max(nowSecond - LIVE_SECONDS + 1, 0);
    let oldest = -1;
    let newest = -1;
    for (let second = Math.max(this.#oldest, floor, 0); second <= nowSecond; second += 1) {
      const slot = second % BUCKET_COUNT;
      if (this.#stamps[slot] !== second) continue;
      const count = this.#counts[slot];
      const tokens = this.#tokens[slot];
      if (count === 0 && tokens === 0) continue;
      if (oldest < 0 || second < oldest) oldest = second;
      if (second > newest) newest = second;
      for (const window of WINDOW_KEYS) {
        const offset = offsets[window];
        if (second < nowSecond - (WINDOW_MS[window] / 1_000 - BUCKETS_PER_SECOND)) continue;
        offset.count += count;
        offset.tokens += tokens;
        if (offset.oldestSecond < 0 || second < offset.oldestSecond) {
          offset.oldestSecond = second;
          offset.oldestCount = count;
          offset.oldestTokens = tokens;
        }
      }
    }
    this.#oldest = oldest < 0 ? nowSecond : oldest;
    this.#lastEventSecond = newest;
    return offsets;
  }

  /**
   * Materialize the window totals for the cursor instant if they are stale.
   * @returns {Record<string, WindowOffset>}
   */
  #ensureOffsets() {
    if (this.#offsets !== undefined) return this.#offsets;
    const nowSecond = this.#cursor < 0 ? 0 : this.#cursor;
    this.#offsets = this.#computeOffsets(nowSecond);
    return this.#offsets;
  }
}