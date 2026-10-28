/**
 * Host half of `dsh-llm-model-rate-limit`.
 *
 * The plugin wraps the one seam every provider request passes through —
 * `llm/stream` — and gives each model its own request and token budget over
 * rolling second/minute/hour/day windows. Reaching a limit never stops the
 * model: the request waits in a FIFO queue that consumes no tokens and arms
 * exactly one timer for the moment the limiting window frees, then the very
 * same request is sent and the task continues.
 *
 * @module dsh-llm-model-rate-limit
 */

import { homedir } from 'node:os';

import { runAdmittedStream } from './admission.js';
import { RateLimitApi } from './api.js';
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_IMAGE_TOKENS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_RETRY,
  DEFAULT_WAKE_JITTER_MS,
  DEFAULT_WAKE_MARGIN_MS,
} from './constants.js';
import { ModelRateLimiter } from './limiter.js';
import { Config, usingHarnessSchema } from './schema.js';
import { loadState, resolveStateDir, saveState, statePathIn } from './store.js';

/** Plugin name inside the Cordis composition. */
export const name = 'model-rate-limit';

/**
 * How far the wall clock must lag the one that wrote the state file before the
 * skew is reported. Below a second it is ordinary scheduling jitter between the
 * flush and the read, not a clock correction.
 */
const WALL_SKEW_NOTICE_MS = 1_000;

/**
 * Bucket rows a single flush may write comfortably. Above this the flush
 * interval is stretched in proportion, so the state file's size bounds how much
 * write work runs per second instead of how much runs per flush.
 */
const FLUSH_ROWS_PER_INTERVAL = 5_000;

/**
 * Count the persisted bucket rows of one exported document.
 * @param {{ models?: Record<string, unknown[]> }} document
 * @returns {number}
 */
function countRows(document) {
  let total = 0;
  for (const rows of Object.values(document.models ?? {})) total += rows.length;
  return total;
}

/** Services the plugin cannot work without. */
export const inject = ['llm'];

export { Config };

/**
 * Resolve one configuration document, so the plugin behaves the same whether the
 * Loader validated the row or a caller handed over a partial object.
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {{
 *   models: Record<string, unknown>,
 *   reservedOutputTokens: number,
 *   imageTokens: number,
 *   wakeMarginMs: number,
 *   wakeJitterMs: number,
 *   retry: { initialDelayMs: number, maxDelayMs: number, maxAttempts: number, jitterRatio: number },
 *   persistence: { enabled: boolean, flushIntervalMs: number },
 * }}
 */
export function resolveConfig(raw = {}) {
  const merged = /** @type {any} */ (Config(raw));
  return {
    models: merged.models ?? {},
    reservedOutputTokens: merged.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
    imageTokens: merged.imageTokens ?? DEFAULT_IMAGE_TOKENS,
    wakeMarginMs: merged.wakeMarginMs ?? DEFAULT_WAKE_MARGIN_MS,
    wakeJitterMs: merged.wakeJitterMs ?? DEFAULT_WAKE_JITTER_MS,
    retry: { ...DEFAULT_RETRY, ...(merged.retry ?? {}) },
    persistence: { enabled: true, flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS, ...(merged.persistence ?? {}) },
  };
}

/**
 * Install admission control, the counter store, and the composer API.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** @type {string[]} */
  const warnings = [];
  /** @type {(record: Record<string, unknown>) => void} */
  const log = (record) => {
    const entry = { plugin: name, ...record };
    if (record.level === 'error' || record.level === 'warn') {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(entry);
      else console.warn(entry);
      return;
    }
    if (typeof ctx.logger?.debug === 'function') ctx.logger.debug(entry);
  };

  /** @type {RateLimitApi | undefined} */
  let api;

  // Display names are resolved on the client side from the session's model
  // catalog, which always knows the provider and model display names the
  // shipped selector shows. The host-side resolver that called into
  // ctx.llm.providerInfo() was crashing the application because listProviders()
  // returns objects, not strings, and providerInfo() rejected them with
  // NO_ADAPTER. The client merges catalog names into the state document, so no
  // host-side resolver is needed.

  const limiter = new ModelRateLimiter({
    meter: ctx.get('tokenMeter'),
    reservedOutputTokens: config.reservedOutputTokens,
    imageTokens: config.imageTokens,
    wakeMarginMs: config.wakeMarginMs,
    wakeJitterMs: config.wakeJitterMs,
    retry: config.retry,
    onLog: log,
    onStatus: () => {
      // A queued request is the only reason the composer control needs a push
      // between its own reads, so this is where a live stream learns about it.
      api?.notify();
    },
  });

  const stateDir = resolveStateDir({
    profileDir: process.env.DSH_PROFILE_DIR,
    home: ctx.get('homePaths')?.home ?? homedir(),
  });
  const statePath = statePathIn(stateDir);
  const persistenceEnabled = config.persistence.enabled !== false;

  // ── counters ─────────────────────────────────────────────────────────────
  if (persistenceEnabled) {
    void (async () => {
      const loaded = await loadState(statePath);
      if (loaded.reason !== undefined) {
        warnings.push(`counters were not restored: ${loaded.reason}`);
        log({ level: 'warn', event: 'state-load-failed', reason: loaded.reason });
        return;
      }
      if (loaded.state === undefined) return;
      try {
        const restored = limiter.importState(loaded.state);
        log({ level: 'info', event: 'state-restored', buckets: restored.restored, dropped: restored.dropped.length });
        // P1-1: the file was written under a wall clock that is ahead of this
        // one (a backwards correction, or a laptop that slept through a
        // timezone/dst change). Rows dated in the reader's future cannot be
        // honoured and were dropped, which is safe but silent, so say it.
        if (restored.skewMs > WALL_SKEW_NOTICE_MS) {
          const seconds = Math.round(restored.skewMs / 1_000);
          warnings.push(`counters were read under a wall clock ${seconds}s behind the one that wrote them; rows inside that gap were dropped`);
          log({
            level: 'warn',
            event: 'state-clock-skew',
            skewMs: Math.round(restored.skewMs),
            restored: restored.restored,
            dropped: restored.dropped.length,
          });
        }
      } catch (error) {
        warnings.push(`counters were not restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    /** @type {Promise<void>} */
    let flushChain = Promise.resolve();
    /** Rows the last flush wrote, which is also what the next one will cost. */
    let lastRows = 0;
    /** The counter payload last written, so an unchanged one is not rewritten. */
    let lastWritten = '';
    const flush = () => {
      flushChain = flushChain.then(async () => {
        try {
          const document = /** @type {any} */ (limiter.exportState());
          lastRows = countRows(document);
          // Only the counters are compared: `savedWall` moves every millisecond
          // and would make every document look new.
          const counters = JSON.stringify(document.models);
          if (counters === lastWritten) return;
          lastWritten = counters;
          await saveState(statePath, document);
        } catch (error) {
          log({ level: 'warn', event: 'state-save-failed', message: error instanceof Error ? error.message : String(error) });
        }
      });
      return flushChain;
    };
    // The state file is a whole-document snapshot, so every flush re-serializes
    // every live bucket: a day of traffic at one request per second across four
    // models is a few hundred thousand rows, and a fixed five-second interval
    // then rewrites tens of megabytes continuously. Skipping the write when the
    // counters have not changed removes the idle cost entirely; stretching the
    // interval in proportion to the rows bounds the *sustained* write rate when
    // traffic is heavy. A longer interval only widens how much of the newest
    // traffic a crash can lose, and that loss is already biased toward waiting
    // longer, never toward sending early.
    const baseInterval = Math.max(250, config.persistence.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    /** @type {unknown} */
    let timer;
    const scheduleFlush = () => {
      const stretch = Math.max(1, Math.ceil(lastRows / FLUSH_ROWS_PER_INTERVAL));
      timer = setTimeout(async () => {
        await flush();
        scheduleFlush();
      }, baseInterval * stretch);
      /** @type {{ unref?: () => void }} */ (timer).unref?.();
    };
    scheduleFlush();
    ctx.effect(() => async () => {
      clearTimeout(/** @type {NodeJS.Timeout} */ (timer));
      await flush();
    }, `${name}: flush counters`);
  }

  // ── model calls ──────────────────────────────────────────────────────────
  ctx.effect(() => ctx.on('llm/stream', (options, next) => runAdmittedStream(
    limiter,
    /** @type {any} */ (options),
    next,
    {
      maxAttempts: config.retry.maxAttempts,
      onLog: log,
      onActivity: () => api?.notify(),
    },
  )), `${name}: llm stream admission`);

  // ── composer control API ─────────────────────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const editor = ctx.get('configEditor');
    api = new RateLimitApi({
      limiter,
      initialConfig: config.models,
      warnings,
      prefix: '/model-rate-limit',
      onLog: log,
      ...(editor === undefined
        ? {}
        : {
          persistConfig: async (models) => {
            const entry = findOwnEntry(editor);
            if (entry === undefined) {
              throw new Error('this profile has no uniquely addressed "model-rate-limit" row to edit');
            }
            await editor.edit(entry, (current) => ({ ...current, models }));
          },
        }),
    });
    const disposeRoutes = webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: '/model-rate-limit',
        handler: (request, response) => api.handle(request, response),
      }),
      `${name}: composer API routes`,
    );
    ctx.effect(() => () => {
      disposeRoutes();
      api?.dispose();
      api = undefined;
    }, `${name}: api teardown`);
    log({ level: 'info', event: 'api-registered', prefix: '/model-rate-limit', configEditor: editor !== undefined });
  });

  ctx.effect(() => () => limiter.dispose(), `${name}: dispose limiter`);
}

/**
 * Find this plugin's own profile row.
 *
 * `configEditor.edit` writes the row that carries the profile override. An
 * ambiguous or missing row is reported instead of guessed, because writing the
 * wrong row would silently misconfigure another plugin.
 *
 * @param {{ entries: () => Array<{ options: { id?: string, name?: string } }> }} editor
 * @returns {any}
 */
export function findOwnEntry(editor) {
  const matches = editor.entries().filter((entry) => entry.options.id === name || entry.options.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}
