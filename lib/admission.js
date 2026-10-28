/**
 * The `llm/stream` seam.
 *
 * This module turns the admission engine into a stream middleware. It owns the
 * three behaviors that must be invisible to the agent loop:
 *
 * 1. A request that does not fit its model's limits waits in FIFO order and is
 *    then sent unchanged — same messages, same parameters, same session.
 * 2. A provider throttle never surfaces as the step's outcome: the same request
 *    is re-sent after `Retry-After`, or after exponential backoff with jitter.
 * 3. The exact request is written to no counter twice. Each provider attempt is
 *    admitted and charged once, which is what keeps a retry from
 *    double-counting its tokens.
 *
 * @module dsh-llm-model-rate-limit/lib/admission
 */

import { DEFAULT_RETRY } from './constants.js';
import { modelKeyOf } from './info.js';

/** Failure codes a provider uses for a throttle. */
const THROTTLE_CODES = new Set(['RATE_LIMIT', 'TOO_MANY_REQUESTS', 'RATE_LIMITED']);
/** HTTP statuses a provider uses for a throttle. */
const THROTTLE_STATUSES = new Set([429, 503]);

/**
 * @typedef {import('./types.js').StreamOptions} StreamOptions
 * @typedef {import('./types.js').StreamChunk} StreamChunk
 * @typedef {import('./types.js').Lease} Lease
 * @typedef {import('./limiter.js').ModelRateLimiter} ModelRateLimiter
 */

/**
 * @typedef {object} AdmissionOptions
 * @property {number} [maxAttempts]
 * @property {(record: Record<string, unknown>) => void} [onLog]
 * @property {(event: {
 *   phase: 'waiting' | 'sending' | 'retrying' | 'idle',
 *   key: string,
 *   reason: string,
 *   etaMs: number,
 *   attempt: number,
 * }) => void} [onActivity]
 * @property {import('./constants.js').Timers} [timers]
 */

/**
 * Read the throttle facts of a terminal `finish` chunk.
 *
 * @param {StreamChunk} chunk
 * @returns {{ throttle: boolean, providerRetryAfterMs?: number, status?: number, code?: string, message?: string } | undefined}
 */
export function throttleOf(chunk) {
  if (chunk.type !== 'finish') return undefined;
  const reason = chunk.reason;
  if (reason === undefined || reason.kind !== 'error') return undefined;
  const failure = reason.failure;
  if (failure === undefined) return undefined;
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  const code = typeof failure.code === 'string' ? failure.code : undefined;
  const providerRetryAfterMs = typeof failure.providerRetryAfterMs === 'number' && failure.providerRetryAfterMs > 0
    ? failure.providerRetryAfterMs
    : undefined;
  const throttle = (status !== undefined && THROTTLE_STATUSES.has(status)) || (code !== undefined && THROTTLE_CODES.has(code));
  return { throttle, providerRetryAfterMs, status, code };
}

/**
 * Wrap one model call in admission control and provider-throttle recovery.
 *
 * @param {ModelRateLimiter} limiter
 * @param {StreamOptions} options
 * @param {() => AsyncIterable<StreamChunk>} next
 * @param {AdmissionOptions} [admission]
 * @returns {AsyncIterable<StreamChunk>}
 */
export function runAdmittedStream(limiter, options, next, admission = {}) {
  return admittedStream(limiter, options, next, admission);
}

/**
 * @param {ModelRateLimiter} limiter
 * @param {StreamOptions} options
 * @param {() => AsyncIterable<StreamChunk>} next
 * @param {AdmissionOptions} admission
 * @returns {AsyncGenerator<StreamChunk>}
 */
async function* admittedStream(limiter, options, next, admission) {
  const key = modelKeyOf(options.provider, options.model);
  const log = admission.onLog ?? (() => {});
  const activity = admission.onActivity ?? (() => {});
  const maxAttempts = Math.max(1, admission.maxAttempts ?? DEFAULT_RETRY.maxAttempts);

  if (!limiter.limits(options.provider, options.model)) {
    // Fast path: an unlimited model adds no allocation, no timer, and no
    // counter write beyond this single policy lookup.
    let entry;
    try {
      entry = next();
    } catch (error) {
      log({ level: 'error', event: 'stream-threw', model: key, message: messageOf(error) });
      throw error;
    }
    yield* passthrough(entry);
    return;
  }

  const cost = limiter.costOf(options);
  /** @type {Lease | undefined} */
  let lease;
  let attempt = 0;

  while (true) {
    if (options.signal?.aborted === true) {
      yield abortedChunk('the request was cancelled while waiting for capacity');
      return;
    }
    activity({ phase: 'waiting', key, reason: 'waiting', etaMs: 0, attempt });
    const decision = await limiter.admit({ provider: options.provider, model: options.model, signal: options.signal }, cost);
    if (!decision.admitted) {
      yield decision.aborted
        ? abortedChunk('the request was cancelled while waiting for capacity')
        : errorChunk('the request could not be admitted');
      return;
    }
    lease = decision.lease;
    if (lease !== undefined) {
      const status = limiter.describe(options.provider, options.model);
      const queued = typeof status.queueDepth === 'number' && status.queueDepth > 0;
      if (queued) log({ level: 'info', event: 'admitted-after-wait', model: key, queueDepth: status.queueDepth });
    }

    attempt += 1;
    activity({ phase: attempt === 1 ? 'sending' : 'retrying', key, reason: 'sending', etaMs: 0, attempt });
    const outcome = yield* attemptStream(next(), (chunk) => {
      if (chunk.type === 'finish') {
        const throttle = throttleOf(chunk);
        if (throttle !== undefined && throttle.throttle) {
          // Held back on purpose: retrying must not be preceded by a terminal
          // chunk, because a terminal chunk closes the agent's step and nothing
          // would consume the retry.
          return { kind: 'retryable', throttle };
        }
      }
      return { kind: 'yield' };
    });

    const retrying = outcome.terminal !== undefined && outcome.terminal.kind === 'retryable';
    if (retrying) {
      // A throttled attempt produced no completion, so its token reservation is
      // released instead of being charged. The request itself stays counted:
      // the provider really did receive a call, and pacing against it is the
      // whole point of a request budget. Nothing is charged twice, because the
      // release and the real usage are both measured against the same bucket.
      limiter.settle(lease, { inputTokens: 0, outputTokens: 0 });
      if (outcome.usage !== undefined) limiter.chargeUsage(options.provider, options.model, outcome.usage);
    } else {
      limiter.settle(lease, outcome.usage);
    }
    lease = undefined;

    if (outcome.thrown !== undefined) {
      limiter.observeSuccess(options.provider, options.model);
      throw outcome.thrown;
    }

    if (retrying && outcome.terminal !== undefined && outcome.terminal.kind === 'retryable') {
      const { throttle } = outcome.terminal;
      const retryAfterMs = limiter.observeThrottle(options.provider, options.model, {
        providerRetryAfterMs: throttle.providerRetryAfterMs,
        status: throttle.status,
        code: throttle.code,
      });
      if (attempt >= maxAttempts) {
        log({ level: 'error', event: 'throttle-attempts-exhausted', model: key, attempts: attempt });
        // The cooldown armed above belongs to the request that is ending here.
        // Leaving it set would delay the next, unrelated request by a backoff
        // it never triggered.
        limiter.clearCooldown(options.provider, options.model);
        yield errorChunk('the provider kept throttling this model after every local retry', {
          code: throttle.code ?? 'RATE_LIMIT',
          status: throttle.status,
        });
        return;
      }
      activity({ phase: 'waiting', key, reason: 'throttled', etaMs: retryAfterMs, attempt });
      await sleepFor(admission.timers, retryAfterMs);
      continue;
    }

    limiter.observeSuccess(options.provider, options.model);
    activity({ phase: 'idle', key, reason: 'idle', etaMs: 0, attempt });
    return;
  }
}

/**
 * The throttle facts of a retryable attempt.
 * @typedef {{ providerRetryAfterMs?: number, status?: number, code?: string }} ThrottleFacts
 */

/**
 * What the caller wants done with one chunk.
 * @typedef {{ kind: 'yield' } | { kind: 'retryable', throttle: ThrottleFacts }} ClassifyResult
 */

/**
 * @typedef {object} AttemptOutcome
 * @property {unknown} [usage] - provider-reported usage for this attempt.
 * @property {unknown} [thrown] - an error thrown while iterating.
 * @property {{ kind: 'retryable', throttle: ThrottleFacts } | { kind: 'terminal' }} [terminal]
 */

/**
 * Iterate one provider attempt, letting the caller decide what to do with each
 * chunk and reporting how the attempt ended.
 *
 * @param {AsyncIterable<StreamChunk>} source
 * @param {(chunk: StreamChunk) => ClassifyResult} classify
 * @returns {AsyncGenerator<StreamChunk, AttemptOutcome>}
 */
async function* attemptStream(source, classify) {
  /** @type {AttemptOutcome} */
  const outcome = {};
  try {
    for await (const chunk of source) {
      if (chunk.type === 'usage') outcome.usage = chunk.usage;
      const decision = classify(chunk);
      if (decision.kind === 'retryable') {
        outcome.terminal = decision;
        return outcome;
      }
      if (chunk.type === 'finish') outcome.terminal = { kind: 'terminal' };
      yield chunk;
    }
  } catch (error) {
    outcome.thrown = error;
    return outcome;
  }
  return outcome;
}

/**
 * @param {AsyncIterable<StreamChunk>} source
 * @returns {AsyncGenerator<StreamChunk>}
 */
async function* passthrough(source) {
  yield* source;
}

/**
 * @param {import('./constants.js').Timers | undefined} timers
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
function sleepFor(timers, delayMs) {
  const delay = Math.max(0, Math.ceil(delayMs));
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (timers === undefined) {
      setTimeout(resolve, delay);
      return;
    }
    timers.setTimeout(resolve, delay);
  });
}

/**
 * @param {string} message
 * @returns {StreamChunk}
 */
function abortedChunk(message) {
  return { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message } } };
}

/**
 * @param {string} message
 * @param {{ code?: string, status?: number }} [failure]
 * @returns {StreamChunk}
 */
function errorChunk(message, failure = {}) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: failure.code ?? 'LOCAL_RATE_LIMIT',
        message,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      },
    },
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
