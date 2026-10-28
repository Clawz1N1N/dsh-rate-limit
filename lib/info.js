/**
 * Serialization and validation primitives for the HTTP API of the plugin.
 *
 * The client half is plain JavaScript with no type check, so every field that
 * crosses the wire is validated here once, on the host, before it can reach the
 * limiter or the configuration editor.
 *
 * @module dsh-llm-model-rate-limit/lib/info
 */

import { LIMIT_KINDS, MAX_LIMIT, WINDOW_KEYS } from './constants.js';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject a non-object payload.
 * @param {unknown} value
 * @param {string} subject
 * @returns {Record<string, unknown>}
 */
export function requireRecord(value, subject) {
  if (!isRecord(value)) throw new Error(`${subject} must be a JSON object`);
  return value;
}

/**
 * Parse one window value.
 *
 * Accepts a non-negative safe integer, a decimal string with optional `k`/`m`
 * suffix (`500k`, `1.5m`), or the empty string (unlimited). Rejects negative,
 * fractional, malformed, and out-of-range input with a short explanation.
 *
 * @param {unknown} value - raw value from config or the wire.
 * @param {string} subject - human-readable field name for the error message.
 * @returns {number} integer within `0..MAX_LIMIT`.
 */
export function parseLimitValue(value, subject) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${subject}: must be a finite integer`);
    if (!Number.isInteger(value)) throw new Error(`${subject}: fractional values are not allowed`);
    return checkRange(value, subject);
  }
  if (typeof value !== 'string') throw new Error(`${subject}: expected a number`);
  // Grouping whitespace is noise; a comma is read as a decimal separator and a
  // non-whole result is refused below, so "1,000" is a thousand while "1,5" is
  // rejected rather than silently multiplied.
  const text = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (text === '') return 0;
  const negative = /^-/.test(text);
  const match = /^-?(\d+(?:\.\d+)?)([kmKM])?$/.exec(text);
  if (match === null) throw new Error(`${subject}: not a valid whole number`);
  if (negative) throw new Error(`${subject}: negative values are not allowed`);
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) throw new Error(`${subject}: not a valid number`);
  const factor = match[2] === undefined ? 1 : match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  const scaled = numeric * factor;
  if (!Number.isInteger(scaled)) throw new Error(`${subject}: the value must be a whole number`);
  return checkRange(scaled, subject);
}

/**
 * @param {number} value
 * @param {string} subject
 * @returns {number}
 */
function checkRange(value, subject) {
  if (value < 0) throw new Error(`${subject}: negative values are not allowed`);
  if (value > MAX_LIMIT) throw new Error(`${subject}: the maximum accepted value is ${MAX_LIMIT}`);
  return value;
}

/**
 * Parse a `provider/model` key from the wire.
 * @param {unknown} value
 * @param {string} subject
 * @returns {string}
 */
export function parseModelKey(value, subject) {
  if (typeof value !== 'string') throw new Error(`${subject}: expected a model key string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${subject}: the model key must not be empty`);
  if (trimmed.length > 512) throw new Error(`${subject}: the model key is too long`);
  return trimmed;
}

/**
 * Parse a limit kind.
 * @param {unknown} value
 * @param {string} subject
 * @returns {'requests'|'tokens'}
 */
export function parseLimitKind(value, subject) {
  if (value === 'requests' || value === 'tokens') return value;
  throw new Error(`${subject}: expected one of ${LIMIT_KINDS.join(', ')}`);
}

/**
 * Parse a window key.
 * @param {unknown} value
 * @param {string} subject
 * @returns {string}
 */
export function parseWindowKey(value, subject) {
  if (typeof value === 'string' && WINDOW_KEYS.includes(value)) return value;
  throw new Error(`${subject}: expected one of ${WINDOW_KEYS.join(', ')}`);
}

/**
 * Compose the canonical model key used by policies and diagnostics.
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
export function modelKeyOf(provider, model) {
  return `${provider}/${model}`;
}

/**
 * Split a canonical model key. The provider never contains `/`, the model id
 * may, so only the first separator is significant.
 * @param {string} key
 * @returns {{ provider: string, model: string } | undefined}
 */
export function splitModelKey(key) {
  const at = key.indexOf('/');
  if (at <= 0 || at === key.length - 1) return undefined;
  return { provider: key.slice(0, at), model: key.slice(at + 1) };
}
