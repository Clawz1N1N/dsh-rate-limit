/**
 * The plugin's configuration schema.
 *
 * DSH resolves `@deepseek-ai/schemastery` from the installation, so that package
 * is preferred at runtime: its schema objects are what the Loader, Settings, and
 * the configuration surface understand. The module is imported dynamically and a
 * small local builder with the same callable surface is used when it cannot be
 * resolved — for example in a unit test that imports the plugin straight from the
 * workspace. Both paths validate the same document and apply the same defaults.
 *
 * @module dsh-llm-model-rate-limit/lib/schema
 */

import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_IMAGE_TOKENS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_RETRY,
  DEFAULT_WAKE_JITTER_MS,
  DEFAULT_WAKE_MARGIN_MS,
  MAX_LIMIT,
  UNLIMITED,
  WINDOW_KEYS,
} from './constants.js';
import { parseLimitValue } from './info.js';

/** @type {any} */
let schemastery;
try {
  // The specifier is optional. The harness resolves it from its own installation
  // (inside `app.asar` when DSH runs from the Desktop bundle, which a profile's
  // module resolution cannot reach), so a workspace load normally falls back to
  // the local builder below. Both schemas expose the same callable surface and
  // the same Standard Schema protocol.
  schemastery = (await import('@deepseek-ai/schemastery')).default;
} catch {
  schemastery = undefined;
}

/**
 * Decorate a plain validator with the callable schema surface the harness uses:
 * chainable metadata methods plus the Standard Schema v1 protocol that Cordis
 * reads through `Config['~standard'].validate`.
 *
 * @param {(value: unknown) => unknown} validate
 * @param {{ kind: string, fallback: () => unknown, meta?: Record<string, unknown> }} meta
 * @returns {any}
 */
function schemaOf(validate, meta) {
  const schema = (value) => validate(value);
  schema.type = meta.kind;
  schema.meta = meta.meta ?? {};
  schema.__kind = meta.kind;
  schema.__default = meta.fallback;
  schema.__validate = (value) => validate(value);
  Object.defineProperty(schema, '~standard', {
    configurable: true,
    get() {
      return {
        version: 1,
        vendor: 'dsh-llm-model-rate-limit',
        validate: (value) => {
          try {
            return { value: validate(value) };
          } catch (error) {
            if (error instanceof TypeError) return { issues: [{ message: error.message }] };
            throw error;
          }
        },
      };
    },
  });
  schema.default = (value) => {
    const wrapped = (input) => (input === undefined || input === null ? value : validate(input));
    Object.assign(wrapped, schema);
    Object.defineProperty(wrapped, '~standard', { configurable: true, get: () => schema['~standard'] });
    wrapped.__default = () => value;
    return wrapped;
  };
  for (const method of ['required', 'description', 'role', 'comment', 'step', 'min', 'max', 'volatile', 'hidden']) {
    schema[method] = () => schema;
  }
  return schema;
}

/**
 * An object document: unknown keys are dropped, known keys take their defaults.
 * @param {Record<string, any>} fields
 * @returns {any}
 */
function objectOf(fields) {
  const schema = schemaOf((value) => {
    const source = value === undefined || value === null ? {} : value;
    if (typeof source !== 'object' || Array.isArray(source)) throw new TypeError('expected an object');
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, field] of Object.entries(fields)) {
      const raw = /** @type {Record<string, unknown>} */ (source)[name];
      out[name] = field.__validate(raw);
    }
    return out;
  }, { kind: 'object', fallback: () => ({}) });
  schema.__default = () => schema({});
  return schema;
}

/**
 * A free-form object map (the `models` dictionary).
 * @returns {any}
 */
function dictOf() {
  return schemaOf((value) => {
    const source = value === undefined || value === null ? {} : value;
    if (typeof source !== 'object' || Array.isArray(source)) throw new TypeError('expected an object');
    return { .../** @type {Record<string, unknown>} */ (source) };
  }, { kind: 'dict', fallback: () => ({}) }).default({});
}

/**
 * A window value: a non-negative whole number, or a string the shared parser
 * accepts (`500k`, `''`). Unlimited is the default.
 * @returns {any}
 */
function windowField() {
  return schemaOf((value) => {
    if (value === undefined || value === null) return UNLIMITED;
    return parseLimitValue(value, 'limit');
  }, { kind: 'limit', fallback: () => UNLIMITED }).default(UNLIMITED);
}

/**
 * One limit kind: the four ordered windows.
 * @returns {any}
 */
function limitWindows() {
  /** @type {Record<string, any>} */
  const fields = {};
  for (const window of WINDOW_KEYS) fields[window] = windowField();
  return objectOf(fields);
}

/**
 * A bounded number with a default.
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {boolean} [integer] - whether a fractional value is refused.
 * @returns {any}
 */
function numberField(fallback, min, max, integer = true) {
  return schemaOf((value) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('expected a number');
    if (integer && !Number.isInteger(value)) throw new TypeError('expected an integer');
    if (value < min || value > max) throw new TypeError(`expected a value between ${min} and ${max}`);
    return value;
  }, { kind: 'number', fallback: () => fallback }).default(fallback);
}

/**
 * A boolean with a default.
 * @param {boolean} fallback
 * @returns {any}
 */
function booleanField(fallback) {
  return schemaOf((value) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new TypeError('expected a boolean');
    return value;
  }, { kind: 'boolean', fallback: () => fallback }).default(fallback);
}

/** @returns {any} the local fallback schema. */
function buildFallbackConfig() {
  const config = objectOf({
    models: dictOf(),
    reservedOutputTokens: numberField(DEFAULT_RESERVED_OUTPUT_TOKENS, 1, Number.MAX_SAFE_INTEGER),
    imageTokens: numberField(DEFAULT_IMAGE_TOKENS, 1, Number.MAX_SAFE_INTEGER),
    wakeMarginMs: numberField(DEFAULT_WAKE_MARGIN_MS, 1, 60_000),
    wakeJitterMs: numberField(DEFAULT_WAKE_JITTER_MS, 0, 60_000),
    retry: objectOf({
      initialDelayMs: numberField(DEFAULT_RETRY.initialDelayMs, 1, 3_600_000),
      maxDelayMs: numberField(DEFAULT_RETRY.maxDelayMs, 1, 3_600_000),
      maxAttempts: numberField(DEFAULT_RETRY.maxAttempts, 1, 32),
      jitterRatio: numberField(DEFAULT_RETRY.jitterRatio, 0, 1, false),
    }),
    persistence: objectOf({
      enabled: booleanField(true),
      flushIntervalMs: numberField(DEFAULT_FLUSH_INTERVAL_MS, 250, 600_000),
    }),
  });
  config.__modelPolicy = limitWindows;
  return config;
}

/** @returns {any} the schema built with the harness's own schema library. */
function buildHarnessConfig() {
  const z = schemastery;
  const field = () => z.union([z.number().step(1).min(0).max(MAX_LIMIT), z.string()]).default(0);
  const windows = () => z.object(Object.fromEntries(WINDOW_KEYS.map((window) => [window, field()])));
  const policy = z.object({ requests: windows(), tokens: windows() });
  const config = z.object({
    models: z.dict(policy).default({}),
    reservedOutputTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_RESERVED_OUTPUT_TOKENS),
    imageTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_IMAGE_TOKENS),
    wakeMarginMs: z.number().step(1).min(1).max(60_000).default(DEFAULT_WAKE_MARGIN_MS),
    wakeJitterMs: z.number().step(1).min(0).max(60_000).default(DEFAULT_WAKE_JITTER_MS),
    retry: z.object({
      initialDelayMs: z.number().step(1).min(1).max(3_600_000).default(DEFAULT_RETRY.initialDelayMs),
      maxDelayMs: z.number().step(1).min(1).max(3_600_000).default(DEFAULT_RETRY.maxDelayMs),
      maxAttempts: z.number().step(1).min(1).max(32).default(DEFAULT_RETRY.maxAttempts),
      jitterRatio: z.number().min(0).max(1).default(DEFAULT_RETRY.jitterRatio),
    }).default(DEFAULT_RETRY),
    persistence: z.object({
      enabled: z.boolean().default(true),
      flushIntervalMs: z.number().step(1).min(250).max(600_000).default(DEFAULT_FLUSH_INTERVAL_MS),
    }).default({ enabled: true, flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS }),
  });
  config.__modelPolicy = () => policy;
  return config;
}

/** The schema the Loader validates the plugin row with. */
export const Config = schemastery === undefined ? buildFallbackConfig() : buildHarnessConfig();

/**
 * Whether the harness's own schema library answered. Exposed for the activation
 * diagnostic; both schemas accept and normalize the same document.
 * @returns {boolean}
 */
export function usingHarnessSchema() {
  return schemastery !== undefined;
}
