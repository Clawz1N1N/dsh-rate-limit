/**
 * Shared limit-value formatting and input parsing.
 *
 * Both halves import this module: the host uses it for diagnostics and the
 * client uses it for the four fields of a limit menu. Keeping one
 * implementation is what makes the UI's optimistic cascade match the
 * authoritative one, and it is what makes "0" render as "unlimited" in the
 * language the user selected instead of as a bare zero.
 *
 * @module dsh-llm-model-rate-limit/lib/format
 */

import { parseLimitValue } from './info.js';

/** Words a user may type to mean "no limit", in the shipped languages. */
const UNLIMITED_WORDS = new Set([
  'не обмежено',
  'необмежено',
  'без обмежень',
  'unlimited',
  'none',
  'off',
  '∞',
]);

/** @type {Map<string, Intl.NumberFormat>} */
const GROUPERS = new Map();

/**
 * Render one window value for display.
 *
 * @param {number} value
 * @param {string} [locale] - BCP 47 language tag; defaults to Ukrainian.
 * @returns {string}
 */
export function formatLimitValue(value, locale = 'uk') {
  if (value === 0) return unlimitedLabel(locale);
  return groupDigits(value, locale);
}

/**
 * The localized "unlimited" word.
 * @param {string} [locale]
 * @returns {string}
 */
export function unlimitedLabel(locale = 'uk') {
  return locale.toLowerCase().startsWith('en') ? 'unlimited' : 'не обмежено';
}

/**
 * Group digits with the locale's separator.
 * @param {number} value
 * @param {string} [locale]
 * @returns {string}
 */
export function groupDigits(value, locale = 'uk') {
  let formatter = GROUPERS.get(locale);
  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: true });
    } catch {
      formatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0, useGrouping: true });
    }
    GROUPERS.set(locale, formatter);
  }
  return formatter.format(value);
}

/**
 * Parse one field's raw text.
 *
 * @param {string} text
 * @returns {{ ok: true, unlimited: boolean, value: number } | { ok: false, error: string }}
 */
export function parseLimitInput(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { ok: true, unlimited: true, value: 0 };
  if (UNLIMITED_WORDS.has(trimmed.toLowerCase())) return { ok: true, unlimited: true, value: 0 };
  try {
    const value = parseLimitValue(trimmed, 'limit');
    return { ok: true, unlimited: value === 0, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
