/**
 * Per-model limit policies: parsing, normalization, and the cascade.
 *
 * A policy is one model's four request windows and four token windows. Every
 * function here is pure, so the cascade is unit-testable without a clock, a
 * timer, or a running harness.
 *
 * @module dsh-llm-model-rate-limit/lib/policy
 */

import { LIMIT_KINDS, UNLIMITED, WINDOW_KEYS } from './constants.js';
import { isRecord, parseLimitValue } from './info.js';

/**
 * @typedef {Record<string, number>} WindowValues
 * @typedef {{ requests: WindowValues, tokens: WindowValues }} ModelPolicy
 * @typedef {{ kind: 'requests'|'tokens', window: string, from: number, to: number }} PolicyAdjustment
 */

/**
 * An all-unlimited policy.
 * @returns {ModelPolicy}
 */
export function emptyPolicy() {
  /** @type {WindowValues} */
  const requests = {};
  /** @type {WindowValues} */
  const tokens = {};
  for (const window of WINDOW_KEYS) {
    requests[window] = UNLIMITED;
    tokens[window] = UNLIMITED;
  }
  return { requests, tokens };
}

/**
 * Whether a policy limits nothing at all.
 * @param {ModelPolicy} policy
 * @returns {boolean}
 */
export function isUnlimitedPolicy(policy) {
  for (const kind of LIMIT_KINDS) {
    for (const window of WINDOW_KEYS) {
      if (policy[kind][window] !== UNLIMITED) return false;
    }
  }
  return true;
}

/**
 * Normalize one raw policy object.
 *
 * Missing fields become unlimited. Negative, fractional, or malformed values
 * are rejected rather than clamped, because silently rewriting a user's
 * configuration is worse than refusing the write.
 *
 * @param {unknown} raw - value read from config or the wire.
 * @param {string} subject - label used in error messages.
 * @returns {ModelPolicy}
 */
export function normalizePolicy(raw, subject) {
  const policy = emptyPolicy();
  if (raw === undefined || raw === null) return policy;
  if (!isRecord(raw)) throw new Error(`${subject}: the policy must be an object`);
  for (const kind of LIMIT_KINDS) {
    const values = raw[kind];
    if (values === undefined || values === null) continue;
    if (!isRecord(values)) throw new Error(`${subject}.${kind}: expected an object of windows`);
    for (const window of WINDOW_KEYS) {
      policy[kind][window] = parseLimitValue(values[window], `${subject}.${kind}.${window}`);
    }
  }
  return policy;
}

/**
 * Parse the complete `models` map of the plugin configuration.
 * @param {unknown} raw
 * @returns {Map<string, ModelPolicy>}
 */
export function normalizePolicyMap(raw) {
  /** @type {Map<string, ModelPolicy>} */
  const policies = new Map();
  if (raw === undefined || raw === null) return policies;
  if (!isRecord(raw)) throw new Error('config.models must be an object keyed by "provider/model"');
  for (const [key, value] of Object.entries(raw)) {
    policies.set(key, normalizePolicy(value, `models[${JSON.stringify(key)}]`));
  }
  return policies;
}

/**
 * Serialize a policy map into the plain JSON shape written back to config.
 * @param {Map<string, ModelPolicy>} policies
 * @returns {Record<string, { requests: WindowValues, tokens: WindowValues }>}
 */
export function policyMapToConfig(policies) {
  /** @type {Record<string, { requests: WindowValues, tokens: WindowValues }>} */
  const out = {};
  for (const [key, policy] of policies) {
    out[key] = { requests: { ...policy.requests }, tokens: { ...policy.tokens } };
  }
  return out;
}

/**
 * Apply one field edit and reconcile the other windows.
 *
 * Rules:
 * - The edited field always keeps the value the user typed.
 * - Among bounded (non-zero) values, windows must be non-decreasing:
 *   second <= minute <= hour <= day.
 * - Raising a smaller window raises every bounded larger window below it.
 * - Lowering a larger window lowers every bounded smaller window above it.
 * - Setting the edited field to unlimited (0) never changes another field.
 * - Unlimited windows never move; they stay unlimited.
 *
 * @param {ModelPolicy} policy - policy before the edit; not mutated.
 * @param {'requests'|'tokens'} kind
 * @param {string} window
 * @param {number} value - already parsed and range-checked window value.
 * @returns {{ policy: ModelPolicy, adjustments: PolicyAdjustment[] }}
 */
export function editPolicy(policy, kind, window, value) {
  const index = WINDOW_KEYS.indexOf(window);
  if (index < 0) throw new Error(`unknown window "${window}"`);
  if (kind !== 'requests' && kind !== 'tokens') throw new Error(`unknown limit kind "${kind}"`);
  if (!Number.isInteger(value) || value < 0) throw new Error('the limit value must be a non-negative integer');

  /** @type {ModelPolicy} */
  const next = { requests: { ...policy.requests }, tokens: { ...policy.tokens } };
  /** @type {PolicyAdjustment[]} */
  const adjustments = [];
  next[kind][window] = value;

  if (value !== UNLIMITED) {
    for (let i = index + 1; i < WINDOW_KEYS.length; i += 1) {
      const larger = WINDOW_KEYS[i];
      const current = next[kind][larger];
      if (current === UNLIMITED || current >= value) continue;
      next[kind][larger] = value;
      adjustments.push({ kind, window: larger, from: current, to: value });
    }
    for (let i = index - 1; i >= 0; i -= 1) {
      const smaller = WINDOW_KEYS[i];
      const current = next[kind][smaller];
      if (current === UNLIMITED || current <= value) continue;
      next[kind][smaller] = value;
      adjustments.push({ kind, window: smaller, from: current, to: value });
    }
  }

  return { policy: next, adjustments };
}

/**
 * Clear one window of one kind back to unlimited.
 *
 * Clearing is an edit with value 0, so it never cascades.
 *
 * @param {ModelPolicy} policy
 * @param {'requests'|'tokens'} kind
 * @param {string} window
 * @returns {{ policy: ModelPolicy, adjustments: PolicyAdjustment[] }}
 */
export function clearPolicyWindow(policy, kind, window) {
  return editPolicy(policy, kind, window, UNLIMITED);
}

/**
 * Compare two policies field by field.
 * @param {ModelPolicy} a
 * @param {ModelPolicy} b
 * @returns {Array<{ kind: 'requests'|'tokens', window: string, from: number, to: number }>}
 */
export function diffPolicies(a, b) {
  /** @type {Array<{ kind: 'requests'|'tokens', window: string, from: number, to: number }>} */
  const changes = [];
  for (const kind of LIMIT_KINDS) {
    for (const window of WINDOW_KEYS) {
      if (a[kind][window] !== b[kind][window]) {
        changes.push({ kind, window, from: a[kind][window], to: b[kind][window] });
      }
    }
  }
  return changes;
}
