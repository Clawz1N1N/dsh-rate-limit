/**
 * Shared structural typedefs.
 *
 * These describe values that cross module boundaries where a JSDoc `@typedef`
 * keeps the checked surface honest without introducing a build step.
 *
 * @module dsh-llm-model-rate-limit/lib/types
 */

/**
 * One frozen provider request as the `llm/stream` waterfall delivers it.
 * Only the fields the limiter reads are named.
 *
 * @typedef {object} StreamOptions
 * @property {string} provider
 * @property {string} model
 * @property {string} [system]
 * @property {ReadonlyArray<unknown>} [messages]
 * @property {ReadonlyArray<unknown>} [tools]
 * @property {ReadonlyArray<unknown>} [stop]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
 * @property {string} [sessionId]
 */

/** One `llm/stream` chunk; only `type`, `usage`, and `reason` are read. */
/**
 * @typedef {object} StreamChunk
 * @property {string} type
 * @property {unknown} [usage]
 * @property {{ kind: string, failure?: { code?: string, status?: number, providerRetryAfterMs?: number } }} [reason]
 */

/**
 * Capacity granted to one request. Releasing it is what lets the next queued
 * request start.
 *
 * @typedef {object} Lease
 * @property {string} key
 * @property {number} cost - reserved tokens, charged to the current bucket.
 * @property {number} atMs - monotonic time the reservation was charged at.
 * @property {RollingWindows} windows
 * @property {boolean} [released]
 */

/**
 * One waiter in a model's FIFO admission queue.
 *
 * @typedef {object} QueueEntry
 * @property {number} id
 * @property {number} cost
 * @property {{ provider: string, model: string, signal?: AbortSignal }} options
 * @property {number} queuedAt - monotonic instant the waiter entered the queue.
 * @property {number} deadline
 * @property {(result: { admitted: boolean, lease: Lease | undefined, aborted: boolean }) => void} resolve
 * @property {boolean} settled
 * @property {boolean} admitted
 * @property {(() => void) | undefined} abortListener
 */

export {};
