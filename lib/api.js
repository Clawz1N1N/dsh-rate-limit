/**
 * The host-side HTTP surface of the plugin.
 *
 * The composer control is a plain browser module with no generated Remote
 * namespace, so the two halves talk over three small JSON routes owned by this
 * plugin:
 *
 * - `GET  {prefix}/state`  — every known model and its live counters.
 * - `POST {prefix}/limit`  — one field edit, answered with the cascaded result.
 * - `GET  {prefix}/events` — a server-sent stream of the same snapshots, pushed
 *   at most once per second while anything is waiting.
 *
 * The body is validated here, once, so the limiter and the configuration editor
 * only ever see well-formed input.
 *
 * @module dsh-llm-model-rate-limit/lib/api
 */

import { MAX_LIMIT, WINDOW_KEYS } from './constants.js';
import { parseLimitKind, parseLimitValue, parseModelKey, parseWindowKey, requireRecord, splitModelKey } from './info.js';
import { policyMapToConfig, normalizePolicyMap } from './policy.js';

/** Largest accepted request body, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;
/** Push interval for the event stream. */
const PUSH_INTERVAL_MS = 1_000;

/**
 * Fields of a model row that are informational milliseconds and tick
 * continuously. They are rounded to the second on the push path so an idle
 * model produces a byte-identical payload; nothing in the composer control
 * reads them (it renders the countdown from `requestsResumeMs` /
 * `tokensResumeMs` and re-anchors on every push).
 */
const PUSH_SECONDS_FIELDS = ['resumeInMs', 'lastRequestAgoMs'];

/**
 * @typedef {object} RateLimitApiOptions
 * @property {import('./limiter.js').ModelRateLimiter} limiter
 * @property {Record<string, unknown>} [initialConfig] - the plugin's `models` map.
 * @property {string[]} [warnings] - activation diagnostics shown beside the control.
 * @property {(models: Record<string, unknown>) => Promise<void>} [persistConfig]
 * @property {(record: Record<string, unknown>) => void} [onLog]
 * @property {string} [prefix]
 * @property {() => void} [onPolicyChanged]
 */

export class RateLimitApi {
  /** @type {import('./limiter.js').ModelRateLimiter} */
  #limiter;
  /** @type {Map<string, import('./policy.js').ModelPolicy>} */
  #policies = new Map();
  /** @type {RateLimitApiOptions['persistConfig']} */
  #persist;
  /** @type {(record: Record<string, unknown>) => void} */
  #log;
  /** @type {string} */
  #prefix;
  /** @type {Set<import('node:http').ServerResponse>} */
  #streams = new Set();
  /** @type {unknown} */
  #pushTimer;
  /** @type {() => void} */
  #onPolicyChanged;
  /** @type {string[]} */
  #warnings;
  /** @type {string} */
  #lastPushed = '';
  /** A push is already scheduled for this tick. */
  #pushScheduled = false;

  /** @param {RateLimitApiOptions} options */
  constructor(options) {
    this.#limiter = options.limiter;
    this.#persist = options.persistConfig;
    this.#log = options.onLog ?? (() => {});
    this.#prefix = options.prefix ?? '/model-rate-limit';
    this.#onPolicyChanged = options.onPolicyChanged ?? (() => {});
    this.#warnings = options.warnings ?? [];
    this.setPolicies(options.initialConfig ?? {});
  }

  /** @returns {string} */
  get prefix() {
    return this.#prefix;
  }

  /** @param {string[]} warnings */
  setWarnings(warnings) {
    this.#warnings = warnings;
  }

  /**
   * Push the current snapshot to every open stream. Called when the engine
   * changes what a waiting request should display; the stream itself is
   * rate-limited to one push per second.
   * @returns {void}
   */
  notify() {
    if (this.#streams.size === 0) return;
    // `#pump` calls this on every admission decision, and `describe()` — one
    // call per model plus a walk of the limiting window — dominates the cost of
    // building the document. Several pumps inside the same tick (a queue
    // draining, a batch of counters charging) must therefore share one build,
    // so the work is deferred by one macrotask and a burst collapses into a
    // single snapshot. Delivery stays immediate from the caller's point of
    // view: the change is on the wire before the next I/O turn.
    if (this.#pushScheduled) return;
    this.#pushScheduled = true;
    const handle = setImmediate(() => {
      this.#pushScheduled = false;
      this.#publishAll();
    });
    handle.unref?.();
  }

  /**
   * Replace every policy from a raw configuration map.
   * @param {Record<string, unknown>} raw
   */
  setPolicies(raw) {
    const policies = normalizePolicyMap(raw);
    this.#policies = policies;
    this.#limiter.setPolicies(policies);
  }

  /**
   * @returns {Record<string, unknown>} detached configuration map.
   */
  configSnapshot() {
    return policyMapToConfig(this.#policies);
  }

  /**
   * Render the complete state document the composer control reads.
   * @returns {Record<string, unknown>}
   */
  stateDocument() {
    /** @type {Array<Record<string, unknown>>} */
    const models = [];
    for (const key of this.#limiter.modelKeys()) {
      const parts = splitModelKey(key);
      if (parts === undefined) continue;
      models.push(this.#limiter.describe(parts.provider, parts.model));
    }
    return {
      version: 1,
      models,
      warnings: [...this.#warnings, ...this.#limiter.warnings()],
    };
  }

  /**
   * Handle one HTTP request under the plugin prefix.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(this.#prefix.length);
    try {
      // The route is loopback-only by binding, but binding is a property of the
      // server, not of the request: any page the user has open can still call
      // it. A same-origin composer request is admitted; a request a visited
      // site made on its own behalf is not.
      if (!isTrustedRequest(request)) {
        this.#log({ level: 'warn', event: 'api-untrusted-request', route, origin: firstHeader(request, 'origin') });
        sendJson(response, 403, { ok: false, error: 'this route only answers the Harness page it is served to' });
        return;
      }
      if (request.method === 'GET' && (route === '/state' || route === '' || route === '/')) {
        sendJson(response, 200, this.stateDocument());
        return;
      }
      if (request.method === 'GET' && route === '/events') {
        this.#openStream(response);
        return;
      }
      if (request.method === 'POST' && route === '/limit') {
        await this.#applyLimit(request, response);
        return;
      }
      sendJson(response, 404, { ok: false, error: `unknown rate-limit route "${route}"` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log({ level: 'error', event: 'api-failed', route, message });
      sendJson(response, 400, { ok: false, error: message });
    }
  }

  /** Stop pushing and release every open event stream. */
  dispose() {
    if (this.#pushTimer !== undefined) {
      clearInterval(/** @type {NodeJS.Timeout} */ (this.#pushTimer));
      this.#pushTimer = undefined;
    }
    for (const stream of this.#streams) {
      try {
        stream.end();
      } catch {
        // The peer is already gone.
      }
    }
    this.#streams.clear();
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async #applyLimit(request, response) {
    const body = requireRecord(await readJsonBody(request), 'the request body');
    const key = parseModelKey(body.model, 'model');
    const parts = splitModelKey(key);
    if (parts === undefined) throw new Error('model must be written as "provider/model"');
    const kind = parseLimitKind(body.kind, 'kind');
    const window = parseWindowKey(body.window, 'window');
    if (body.unlimited === true || body.value === '' || body.value === null) {
      const cleared = this.#limiter.editPolicyWindow(key, kind, window, 0);
      this.#policies.set(key, cleared.policy);
      const persisted = await this.#persistIfPossible();
      sendJson(response, 200, {
        ok: true,
        model: this.#limiter.describe(parts.provider, parts.model),
        adjustments: cleared.adjustments,
        persisted,
      });
      this.#onPolicyChanged();
      this.#publishAll();
      return;
    }
    if (body.value === undefined) throw new Error('value is required unless unlimited is true');
    const value = parseLimitValue(body.value, `${kind}.${window}`);
    if (value > MAX_LIMIT) throw new Error(`the maximum accepted value is ${MAX_LIMIT}`);
    const { policy, adjustments } = this.#limiter.editPolicyWindow(key, kind, window, value);
    this.#policies.set(key, policy);
    const persisted = await this.#persistIfPossible();
    sendJson(response, 200, {
      ok: true,
      model: this.#limiter.describe(parts.provider, parts.model),
      adjustments,
      persisted,
    });
    this.#onPolicyChanged();
    this.#publishAll();
  }

  /**
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async #persistIfPossible() {
    if (this.#persist === undefined) {
      return { ok: false, error: 'the profile configuration editor is unavailable; edit cordis.patch.yml manually' };
    }
    try {
      await this.#persist(this.configSnapshot());
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log({ level: 'warn', event: 'config-write-failed', message });
      return { ok: false, error: message };
    }
  }

  /**
   * @param {import('node:http').ServerResponse} response
   */
  #openStream(response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const initial = `event: snapshot\ndata: ${JSON.stringify(this.#pushedDocument())}\n\n`;
    this.#lastPushed = initial;
    response.write(initial);
    this.#streams.add(response);
    const cleanup = () => {
      this.#streams.delete(response);
      if (this.#streams.size === 0 && this.#pushTimer !== undefined) {
        clearInterval(/** @type {NodeJS.Timeout} */ (this.#pushTimer));
        this.#pushTimer = undefined;
      }
    };
    response.on('close', cleanup);
    response.on('error', cleanup);
    if (this.#pushTimer === undefined) {
      this.#pushTimer = setInterval(() => this.#publishAll(), PUSH_INTERVAL_MS);
      this.#pushTimer.unref?.();
    }
  }

  /** Push the current snapshot to every open stream. */
  #publishAll() {
    if (this.#streams.size === 0) return;
    const payload = `event: snapshot\ndata: ${JSON.stringify(this.#pushedDocument())}\n\n`;
    // `notify()` runs on every pump, and `describe()` is the expensive part of
    // building this document, so the common case is "nothing changed". Compare
    // against what every stream already has instead of writing it again.
    if (payload === this.#lastPushed) return;
    this.#lastPushed = payload;
    for (const stream of this.#streams) {
      try {
        stream.write(payload);
      } catch {
        this.#streams.delete(stream);
      }
    }
  }

  /**
   * The state document as pushed to streams.
   * @returns {Record<string, unknown>}
   */
  #pushedDocument() {
    const document = this.stateDocument();
    const models = /** @type {Array<Record<string, unknown>>} */ (document.models);
    for (const model of models) {
      for (const field of PUSH_SECONDS_FIELDS) {
        const value = model[field];
        if (typeof value === 'number') model[field] = Math.round(value / 1_000) * 1_000;
      }
    }
    return document;
  }
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(response, status, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * `Sec-Fetch-Site` values a request from the Harness page itself can carry.
 * `none` is a direct navigation or a non-browser client, which cannot be
 * forged by a page.
 */
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * Read one request header, lowercased and trimmed.
 * @param {import('node:http').IncomingMessage} request
 * @param {string} name
 * @returns {string | undefined}
 */
export function firstHeader(request, name) {
  const raw = request.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Whether one request may reach the plugin's routes.
 *
 * Two independent signals, both of which a cross-site caller fails: the
 * browser-declared fetch site, and the `Origin` authority against the `Host`
 * it was actually sent to. Neither is a secret and neither is a substitute for
 * real authentication, but together they close the gap a loopback bind leaves
 * open — a page the user merely visited reading usage or rewriting limits.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function isTrustedRequest(request) {
  const site = firstHeader(request, 'sec-fetch-site');
  // A browser's own declaration is decisive when it is present: the header is
  // forbidden to page scripts, so a cross-site page cannot claim otherwise. It
  // is checked *before* the authority comparison on purpose — a desktop shell
  // that serves the page from its own scheme has a matching `Sec-Fetch-Site`
  // but an `Origin` that cannot equal the loopback `Host`, and rejecting that
  // would silently disable the control in exactly the environment it targets.
  if (site !== undefined) return TRUSTED_FETCH_SITES.has(site);
  const origin = firstHeader(request, 'origin');
  if (origin === undefined) return true;
  const host = firstHeader(request, 'host');
  if (host === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/**
 * Read and parse a bounded JSON body.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('the request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the request body is not valid JSON');
  }
}

/**
 * The empty configuration map, used as the plugin's default and by tests.
 * @returns {Record<string, unknown>}
 */
export function emptyModelsConfig() {
  return {};
}

export { WINDOW_KEYS };
