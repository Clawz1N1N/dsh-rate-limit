/**
 * Token estimation for reservations.
 *
 * The reservation only has to be conservative: it is replaced by the provider's
 * reported `usage` as soon as the stream settles. A mounted token meter is
 * therefore used when it is available (it is replay-aware and knows the exact
 * route pricing), and a documented character heuristic is the fallback.
 *
 * @module dsh-llm-model-rate-limit/lib/estimate
 */

import { DEFAULT_IMAGE_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS } from './constants.js';

/** Characters per token in the fallback heuristic. */
const CHARS_PER_TOKEN = 4;
/** Fixed structural overhead per content block. */
const BLOCK_OVERHEAD = 4;
/** Fixed structural overhead per message. */
const MESSAGE_OVERHEAD = 4;

/**
 * @typedef {object} EstimateInput
 * @property {unknown} [system]
 * @property {ReadonlyArray<unknown>} [messages]
 * @property {ReadonlyArray<unknown>} [tools]
 * @property {ReadonlyArray<unknown>} [stop]
 * @property {number} [maxTokens]
 */

/**
 * Estimate the complete cost of one provider request: prompt plus the output
 * allowance that the provider will bill for.
 *
 * @param {EstimateInput} options - the frozen request.
 * @param {number} reservedOutputTokens - allowance used when the request has no explicit cap.
 * @param {number} imageTokens - fixed allowance per image block.
 * @returns {number} positive safe-integer reservation.
 */
export function estimateRequestTokens(options, reservedOutputTokens, imageTokens) {
  let total = 0;
  if (typeof options.system === 'string' && options.system.length > 0) {
    total += textTokens(options.system) + MESSAGE_OVERHEAD;
  }
  for (const message of options.messages ?? []) total += messageTokens(message, imageTokens) + MESSAGE_OVERHEAD;
  if ((options.tools?.length ?? 0) > 0) total += textTokens(safeJson(options.tools)) + BLOCK_OVERHEAD;
  if ((options.stop?.length ?? 0) > 0) total += textTokens(safeJson(options.stop)) + BLOCK_OVERHEAD;
  const explicit = typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? options.maxTokens
    : undefined;
  total += explicit ?? reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(total)));
}

/**
 * Estimate one message, preferring a mounted token meter.
 * @param {unknown} message
 * @param {number} imageTokens
 * @param {{ estimateMessage?: (message: unknown) => number }} [meter]
 * @returns {number}
 */
export function messageTokens(message, imageTokens, meter) {
  if (typeof meter?.estimateMessage === 'function') {
    try {
      const measured = meter.estimateMessage(message);
      if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
        return Math.ceil(measured);
      }
    } catch {
      // A meter that refuses an unusual message must not block the request.
    }
  }
  const record = asRecord(message);
  const content = record?.content;
  if (typeof content === 'string') return textTokens(content) + MESSAGE_OVERHEAD;
  return contentTokens(Array.isArray(content) ? content : [], imageTokens);
}

/**
 * Price a content-block array recursively without resolving attachment bytes.
 * @param {ReadonlyArray<unknown>} blocks
 * @param {number} imageTokens
 * @returns {number}
 */
export function contentTokens(blocks, imageTokens) {
  let total = 0;
  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined) {
      total += textTokens(String(block)) + BLOCK_OVERHEAD;
      continue;
    }
    switch (record.type) {
      case 'text':
      case 'reasoning':
        total += textTokens(typeof record.text === 'string' ? record.text : '') + BLOCK_OVERHEAD;
        break;
      case 'image':
        total += (imageTokens > 0 ? imageTokens : DEFAULT_IMAGE_TOKENS) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        total += textTokens(typeof record.name === 'string' ? record.name : '')
          + textTokens(typeof record.arguments === 'string' ? record.arguments : safeJson(record.arguments))
          + BLOCK_OVERHEAD;
        break;
      case 'tool-result':
        total += contentTokens(Array.isArray(record.content) ? record.content : [], imageTokens) + BLOCK_OVERHEAD;
        break;
      default:
        total += textTokens(safeJson(record)) + BLOCK_OVERHEAD;
    }
  }
  return total;
}

/**
 * Characters-per-token heuristic.
 * @param {string} text
 * @returns {number}
 */
export function textTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Sum the provider-reported usage of one attempt.
 *
 * Prompt tokens and completion tokens both count, including cache reads and
 * cache writes, because providers bill those against the same per-minute
 * token budget they enforce.
 *
 * @param {unknown} usage
 * @returns {number | undefined}
 */
export function usageTokens(usage) {
  const record = asRecord(usage);
  if (record === undefined) return undefined;
  const parts = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
  let total = 0;
  let seen = false;
  for (const part of parts) {
    const value = record[part];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    total += value;
    seen = true;
  }
  if (!seen) {
    const totalField = record.totalTokens;
    if (typeof totalField === 'number' && Number.isFinite(totalField) && totalField >= 0) return totalField;
    return undefined;
  }
  return total;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | undefined}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
