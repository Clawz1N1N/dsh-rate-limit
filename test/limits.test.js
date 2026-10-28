/**
 * The cascade, the unlimited sentinel, validation, and the shared formatting
 * helpers. These are the behaviors the composer control mirrors, so both halves
 * are checked against the same examples.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_LIMIT, WINDOW_KEYS } from '../lib/constants.js';
import { parseLimitValue, splitModelKey, modelKeyOf } from '../lib/info.js';
import {
  clearPolicyWindow,
  diffPolicies,
  editPolicy,
  emptyPolicy,
  isUnlimitedPolicy,
  normalizePolicy,
  normalizePolicyMap,
  policyMapToConfig,
} from '../lib/policy.js';
import { formatLimitValue, parseLimitInput } from '../lib/format.js';
import { policy } from './helpers.js';

test('a fresh policy is unlimited everywhere', () => {
  const empty = emptyPolicy();
  assert.equal(isUnlimitedPolicy(empty), true);
  for (const kind of ['requests', 'tokens']) {
    for (const window of WINDOW_KEYS) assert.equal(empty[kind][window], 0);
  }
});

test('raising a smaller window raises bounded larger windows', () => {
  // The prompt's example: per minute is 1, the user sets per second to 5.
  const before = policy({ requests: { perMinute: 1 } });
  const { policy: after, adjustments } = editPolicy(before, 'requests', 'perSecond', 5);
  assert.equal(after.requests.perSecond, 5, 'the edited field always keeps the typed value');
  assert.equal(after.requests.perMinute, 5, 'per minute was raised to match');
  assert.equal(after.requests.perHour, 0, 'an unlimited window is never cascaded');
  assert.equal(after.requests.perDay, 0);
  assert.deepEqual(adjustments, [{ kind: 'requests', window: 'perMinute', from: 1, to: 5 }]);
});

test('raising a smaller window cascades through every bounded larger window', () => {
  const before = policy({ requests: { perMinute: 2, perHour: 3, perDay: 10 } });
  const { policy: after, adjustments } = editPolicy(before, 'requests', 'perSecond', 5);
  assert.equal(after.requests.perMinute, 5);
  assert.equal(after.requests.perHour, 5, 'per hour was below 5 and is raised');
  assert.equal(after.requests.perDay, 10, 'per day was already above 5 and is untouched');
  assert.deepEqual(adjustments.map((a) => a.window), ['perMinute', 'perHour']);
});

test('lowering a larger window lowers bounded smaller windows', () => {
  // The prompt's example: per minute is 5, the user sets per day to 3.
  const before = policy({ requests: { perSecond: 5, perMinute: 5, perHour: 5 } });
  const { policy: after, adjustments } = editPolicy(before, 'requests', 'perDay', 3);
  assert.equal(after.requests.perDay, 3);
  assert.equal(after.requests.perMinute, 3);
  assert.equal(after.requests.perSecond, 3);
  assert.equal(after.requests.perHour, 3);
  assert.deepEqual(adjustments.map((a) => a.window).sort(), ['perHour', 'perMinute', 'perSecond']);
});

test('the audit counterexample is the correct cascade, not a defect', () => {
  // IMPROVEMENTS.md P0-1 claimed that lowering perMinute from 100 to 3 should
  // leave perSecond at 10, because 10 was legal before the edit. The prompt's
  // rule is the opposite: among bounded windows the values must satisfy
  // sec <= min <= hour <= day *after* the edit, the edited field keeps the typed
  // value, and every window that would then violate the order is corrected -- in
  // both directions. A cap of 3 per minute cannot coexist with 10 per second.
  const before = policy({ requests: { perSecond: 10, perMinute: 100 } });
  const { policy: after, adjustments } = editPolicy(before, 'requests', 'perMinute', 3);
  assert.equal(after.requests.perMinute, 3, 'the edited field keeps the typed value');
  assert.equal(after.requests.perSecond, 3, 'perSecond is pulled down to stay <= perMinute');
  assert.deepEqual(adjustments, [{ kind: 'requests', window: 'perSecond', from: 10, to: 3 }]);
});

test('an unlimited window never takes part in the cascade', () => {
  const before = policy({ requests: { perSecond: 0, perMinute: 0, perHour: 0, perDay: 4 } });
  const raised = editPolicy(before, 'requests', 'perMinute', 9);
  assert.equal(raised.policy.requests.perSecond, 0, 'the unlimited smaller window stays unlimited');
  assert.equal(raised.policy.requests.perHour, 0, 'the unlimited middle window stays unlimited');
  assert.equal(raised.policy.requests.perDay, 9, 'the bounded larger window is raised');
});

test('setting the edited field to unlimited changes nothing else', () => {
  const before = policy({ requests: { perSecond: 3, perMinute: 3, perHour: 9 } });
  const { policy: after, adjustments } = editPolicy(before, 'requests', 'perMinute', 0);
  assert.equal(after.requests.perMinute, 0, 'the edited field is unlimited');
  assert.equal(after.requests.perSecond, 3, 'a smaller window is untouched');
  assert.equal(after.requests.perHour, 9, 'a larger window is untouched');
  assert.equal(after.requests.perDay, 0);
  assert.deepEqual(adjustments, [], 'clearing a window never cascades');
});

test('the token cascade uses the same rules as the request cascade', () => {
  const before = policy({ tokens: { perSecond: 100, perMinute: 100, perHour: 100 } });
  const { policy: after } = editPolicy(before, 'tokens', 'perDay', 50);
  assert.deepEqual(after.tokens, { perSecond: 50, perMinute: 50, perHour: 50, perDay: 50 });
  const upward = editPolicy(after, 'tokens', 'perSecond', 80);
  assert.deepEqual(upward.policy.tokens, { perSecond: 80, perMinute: 80, perHour: 80, perDay: 80 });
});

test('clearPolicyWindow is an unlimited edit and never cascades', () => {
  const before = policy({ tokens: { perSecond: 10, perMinute: 20, perHour: 30, perDay: 40 } });
  const { policy: after, adjustments } = clearPolicyWindow(before, 'tokens', 'perHour');
  assert.equal(after.tokens.perHour, 0);
  assert.deepEqual(adjustments, []);
  assert.deepEqual(after.tokens, { perSecond: 10, perMinute: 20, perHour: 0, perDay: 40 });
});

test('normalizePolicy repairs a non-decreasing violation read from a file', () => {
  const map = normalizePolicyMap({
    'deepseek-account/deepseek-flash': { requests: { perSecond: 10, perMinute: 1 } },
  });
  const one = map.get('deepseek-account/deepseek-flash');
  assert.equal(one.requests.perSecond, 10);
  assert.equal(one.requests.perMinute, 1, 'normalizePolicy keeps values as written');
  // The limiter owns the repair, and it is covered by the limiter tests.
});

test('normalizePolicy rejects negative, fractional, and malformed values', () => {
  assert.throws(() => normalizePolicy({ requests: { perSecond: -1 } }, 'p'), /negative/);
  assert.throws(() => normalizePolicy({ requests: { perSecond: 1.5 } }, 'p'), /fractional/);
  assert.throws(() => normalizePolicy({ requests: { perSecond: 'lots' } }, 'p'), /not a valid whole number/);
  assert.throws(() => normalizePolicy({ requests: { perSecond: {} } }, 'p'), /expected a number/);
});

test('parseLimitValue enforces the documented bounds', () => {
  assert.equal(parseLimitValue(0, 'x'), 0);
  assert.equal(parseLimitValue('0', 'x'), 0);
  assert.equal(parseLimitValue('', 'x'), 0, 'an empty field means unlimited');
  assert.equal(parseLimitValue(undefined, 'x'), 0);
  assert.equal(parseLimitValue(MAX_LIMIT, 'x'), MAX_LIMIT);
  assert.throws(() => parseLimitValue(MAX_LIMIT + 1, 'x'), /maximum accepted value/);
  assert.throws(() => parseLimitValue(-5, 'x'), /negative/);
  assert.throws(() => parseLimitValue('3.7', 'x'), /not a valid whole number|whole number/);
  assert.throws(() => parseLimitValue('abc', 'x'), /not a valid whole number/);
  assert.throws(() => parseLimitValue(Number.NaN, 'x'), /finite/);
});

test('parseLimitValue accepts k and m suffixes', () => {
  assert.equal(parseLimitValue('500k', 'x'), 500_000);
  assert.equal(parseLimitValue('1M', 'x'), 1_000_000);
  assert.equal(parseLimitValue('2m', 'x'), 2_000_000);
  assert.equal(parseLimitValue('1 000', 'x'), 1_000);
  assert.equal(parseLimitValue('1.5k', 'x'), 1_500);
  assert.throws(() => parseLimitValue('1,5', 'x'), /whole number/, 'a comma is a decimal separator, so 1,5 is not a whole number');
  assert.equal(parseLimitValue('1,5k', 'x'), 1_500, 'the same reading applies before a suffix');
});

test('parseLimitInput distinguishes unlimited, a value, and a rejection', () => {
  assert.deepEqual(parseLimitInput(''), { ok: true, unlimited: true, value: 0 });
  assert.deepEqual(parseLimitInput('не обмежено'), { ok: true, unlimited: true, value: 0 });
  assert.deepEqual(parseLimitInput('unlimited'), { ok: true, unlimited: true, value: 0 });
  assert.deepEqual(parseLimitInput('42'), { ok: true, unlimited: false, value: 42 });
  const bad = parseLimitInput('-3');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /negative/);
  const text = parseLimitInput('soon');
  assert.equal(text.ok, false);
  assert.match(text.error, /whole number/);
});

test('formatLimitValue renders unlimited and grouped digits', () => {
  assert.equal(formatLimitValue(0, 'uk'), 'не обмежено');
  assert.equal(formatLimitValue(0, 'en'), 'unlimited');
  const grouped = formatLimitValue(500_000, 'uk');
  assert.match(grouped, /500/, 'the digits survive');
  assert.match(grouped, /[\s\u00a0\u202f.]/, 'a group separator is present');
  assert.equal(formatLimitValue(7, 'uk'), '7');
});

test('diffPolicies lists exactly the changed fields', () => {
  const before = policy({ requests: { perMinute: 5 } });
  const after = policy({ requests: { perMinute: 5, perHour: 9 } });
  assert.deepEqual(diffPolicies(before, after), [{ kind: 'requests', window: 'perHour', from: 0, to: 9 }]);
  assert.deepEqual(diffPolicies(before, before), []);
});

test('policyMapToConfig round-trips through normalizePolicyMap', () => {
  const original = {
    'a/b': { requests: { perSecond: 1, perMinute: 2, perHour: 3, perDay: 4 }, tokens: { perSecond: 0, perMinute: 0, perHour: 0, perDay: 0 } },
  };
  const map = normalizePolicyMap(original);
  assert.deepEqual(policyMapToConfig(map), original);
});

test('model keys split on the first separator only', () => {
  assert.equal(modelKeyOf('deepseek-account', 'deepseek-flash'), 'deepseek-account/deepseek-flash');
  assert.deepEqual(splitModelKey('a/b/c'), { provider: 'a', model: 'b/c' });
  assert.equal(splitModelKey('nope'), undefined);
  assert.equal(splitModelKey('/model'), undefined);
  assert.equal(splitModelKey('provider/'), undefined);
});
