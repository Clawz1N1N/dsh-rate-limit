/**
 * Shared constants and the ordered window vocabulary.
 *
 * Order matters everywhere: the cascade rules compare windows by index, and
 * the UI renders them in this exact order (second, minute, hour, day).
 *
 * @module dsh-llm-model-rate-limit/lib/constants
 */

/** Ordered window keys, smallest first. */
export const WINDOW_KEYS = Object.freeze(['perSecond', 'perMinute', 'perHour', 'perDay']);

/** Duration of each window in milliseconds, by window key. */
export const WINDOW_MS = Object.freeze({
  perSecond: 1_000,
  perMinute: 60_000,
  perHour: 3_600_000,
  perDay: 86_400_000,
});

/** The two limit kinds a policy carries. */
export const LIMIT_KINDS = Object.freeze(['requests', 'tokens']);

/**
 * A window value of 0 always means "unlimited". It is never cascaded and never
 * blocks a request.
 */
export const UNLIMITED = 0;

/**
 * Upper bound accepted for one window value. Chosen so that a whole day of
 * per-second resolution stays far away from any safe-integer overflow, while
 * still being an obviously "practically unlimited" ceiling.
 */
export const MAX_LIMIT = 1_000_000_000;

/** Longest window; events older than this are dropped when state is loaded. */
export const MAX_WINDOW_MS = WINDOW_MS.perDay;

/** Persisted state schema version. Bump together with a migration step. */
export const STATE_VERSION = 1;

/** Shortest bucket resolution: one second, shared by every window. */
export const BUCKET_MS = 1_000;

/** Number of one-second buckets in the longest window. */
export const BUCKET_COUNT = MAX_WINDOW_MS / BUCKET_MS;

/** Default reserved output allowance for a request without `maxTokens`. */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_192;

/** Default fixed allowance charged for one image content block. */
export const DEFAULT_IMAGE_TOKENS = 1_024;

/** Default fixed margin added to every computed wake-up. */
export const DEFAULT_WAKE_MARGIN_MS = 80;

/** Default extra random spread added on top of the margin. */
export const DEFAULT_WAKE_JITTER_MS = 120;

/** Default provider-cooldown fallback when a 429 carries no Retry-After. */
export const DEFAULT_RETRY = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 6,
  jitterRatio: 0.25,
});

/** Default interval between periodic counter flushes. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * Replacements for `setTimeout` so tests can drive a clock without real time.
 * @typedef {object} Timers
 * @property {(callback: () => void, delayMs: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/** @type {Timers} */
export const REAL_TIMERS = Object.freeze({
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
});
