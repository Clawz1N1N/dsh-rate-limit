/**
 * Admission behavior: the idle queue, FIFO order, cancellation, live limit
 * changes, oversized requests, and the provider-throttle recovery.
 *
 * Every timing assertion runs against the fake clock, so the suite never waits.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAdmittedStream, throttleOf } from '../lib/admission.js';
import { DEFAULT_IMAGE_TOKENS } from '../lib/constants.js';
import { collect, drive, harness, policy, settle, successChunks, throttleChunk } from './helpers.js';

/**
 * Build a `next` implementation that records every call and replays a script.
 *
 * @param {Array<Array<import('../lib/types.js').StreamChunk>>} scripts - one entry per attempt; the last entry repeats.
 * @param {Array<{ provider: string, model: string, messages: unknown[] }>} calls
 * @returns {() => AsyncIterable<import('../lib/types.js').StreamChunk>}
 */
function scriptedProvider(scripts, calls) {
  let attempt = 0;
  return () => {
    const script = scripts[Math.min(attempt, scripts.length - 1)];
    attempt += 1;
    return (async function* () {
      for (const chunk of script) yield chunk;
    })();
  };
}

test('a request over the limit is not sent until capacity frees, then sent exactly once', async () => {
  const { limiter, clock, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perSecond: 1 } }));

  /** @type {Array<{ messages: unknown[] }>} */
  const calls = [];
  const options = { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hello' }] };
  const next = scriptedProvider([successChunks({ usage: { inputTokens: 10, outputTokens: 5 } })], calls);
  const wrapped = () => {
    calls.push({ messages: options.messages });
    return next();
  };

  const first = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  assert.equal(calls.length, 1, 'the first request goes straight through');

  const second = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  assert.equal(calls.length, 1, 'the second request is not sent while the window is full');
  assert.equal(scheduler.pendingCount, 1, 'exactly one timer is armed for the whole model');
  assert.deepEqual(await first, successChunks({ usage: { inputTokens: 10, outputTokens: 5 } }));

  // Only the first request has been billed; the waiting one has no reservation.
  const usage = limiter.describe('p', 'm').usage;
  assert.equal(usage.tokens.perMinute.used, 15, 'only the settled request is charged');
  assert.equal(limiter.describe('p', 'm').queueDepth, 1);

  clock.advance(1_001);
  scheduler.advance(1);
  const secondChunks = await second;
  assert.equal(calls.length, 2, 'the queued request is sent once the window rolls');
  assert.equal(secondChunks.length, 2);
  assert.equal(scheduler.pendingCount, 0, 'no timer is left behind');
});

test('a waiting request is re-sent unchanged, with the same context and parameters', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 1 } }));
  /** @type {Array<Record<string, unknown>>} */
  const seen = [];
  const options = {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: 'привіт' }],
    system: 'be brief',
    maxTokens: 128,
  };
  const wrapped = () => {
    seen.push({ ...options, messages: options.messages });
    return (async function* () {
      yield* successChunks();
    })();
  };
  await collect(runAdmittedStream(limiter, options, wrapped));
  const waiting = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  scheduler.advance(60_100);
  await waiting;
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], seen[1], 'the second attempt carries the identical request');
  assert.equal(options.maxTokens, 128, 'the caller-owned request is not rewritten');
});

test('parallel requests are admitted in FIFO order', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perSecond: 1 } }));
  /** @type {string[]} */
  const order = [];
  const options = (id) => ({ provider: 'p', model: 'm', messages: [{ id }] });
  const wrapped = (id) => () => (async function* () {
    order.push(id);
    yield* successChunks();
  })();

  const first = collect(runAdmittedStream(limiter, options('a'), wrapped('a')));
  await settle();
  const rest = ['b', 'c', 'd'].map((id) => collect(runAdmittedStream(limiter, options(id), wrapped(id))));
  await settle();
  assert.deepEqual(order, ['a'], 'only the first request runs');

  scheduler.advance(1_100);
  await settle();
  assert.deepEqual(order, ['a', 'b']);
  scheduler.advance(1_100);
  await settle();
  assert.deepEqual(order, ['a', 'b', 'c']);
  scheduler.advance(1_100);
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'arrival order is preserved');
});

test('a cancelled waiter leaves the queue without sending anything', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perSecond: 1 } }));
  let sent = 0;
  const wrapped = () => {
    sent += 1;
    return (async function* () {
      yield* successChunks();
    })();
  };
  const controller = new AbortController();
  const options = { provider: 'p', model: 'm', signal: controller.signal };
  await collect(runAdmittedStream(limiter, options, wrapped));
  const waiting = collect(runAdmittedStream(limiter, { ...options }, wrapped));
  await settle();
  controller.abort();
  const chunks = await waiting;
  assert.equal(sent, 1, 'the cancelled request was never sent');
  assert.equal(chunks.at(-1)?.reason?.kind, 'aborted');
  assert.equal(limiter.describe('p', 'm').queueDepth, 0, 'the queue is empty again');
  scheduler.advance(60_000);
  assert.equal(sent, 1, 'no timer resends a cancelled request');
});

test('raising a limit mid-wait wakes the queued request immediately', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perHour: 1 } }));
  let sent = 0;
  const wrapped = () => {
    sent += 1;
    return (async function* () {
      yield* successChunks();
    })();
  };
  const options = { provider: 'p', model: 'm' };
  await collect(runAdmittedStream(limiter, options, wrapped));
  const waiting = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  assert.equal(sent, 1);
  const before = scheduler.pendingCount;
  assert.equal(before, 1);

  // The user raises the hour limit from the composer control.
  limiter.editPolicyWindow('p/m', 'requests', 'perHour', 10);
  await settle();
  const chunks = await waiting;
  assert.equal(sent, 2, 'the queued request started as soon as the new limit allowed it');
  assert.equal(chunks.at(-1)?.type, 'finish');
  scheduler.advance(3_600_000);
  assert.equal(sent, 2, 'nothing else was sent');
});

test('a request larger than its whole window waits for an empty window and warns', async () => {
  const { limiter, scheduler, logs } = harness();
  limiter.updatePolicy('p/m', policy({ tokens: { perMinute: 100 } }));
  let sent = 0;
  const wrapped = () => {
    sent += 1;
    return (async function* () {
      yield* successChunks({ usage: { inputTokens: 10, outputTokens: 10 } });
    })();
  };
  const options = { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'x'.repeat(20_000) }] };
  assert.ok(limiter.costOf(options) > 100, 'the request really is larger than its window');

  // Occupy the window first, so the oversized request cannot start immediately.
  limiter.observeThrottle; // no-op guard: the throttle path is covered elsewhere
  const blocker = collect(runAdmittedStream(limiter, { provider: 'p', model: 'm', messages: [] }, wrapped));
  await settle();
  assert.equal(sent, 1);

  const waiting = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  assert.equal(sent, 1, 'an oversized request is not sent while the window holds anything');
  const status = limiter.describe('p', 'm');
  assert.equal(typeof status.warning, 'string', 'the condition is reported instead of hidden');
  assert.match(String(status.warning), /more than the perMinute token limit/);
  assert.ok(logs.some((entry) => entry.event === 'request-exceeds-limit'));

  await blocker;
  scheduler.advance(60_100);
  const chunks = await waiting;
  assert.equal(sent, 2, 'the request is sent once the window is empty');
  assert.equal(chunks.at(-1)?.type, 'finish');
  assert.equal(limiter.describe('p', 'm').warning, undefined, 'the warning clears after admission');
});

test('a 429 with Retry-After is retried after exactly that delay', async () => {
  const { limiter, clock, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 10 } }));
  /** @type {number[]} */
  const attemptTimes = [];
  let attempt = 0;
  const wrapped = () => {
    attemptTimes.push(clock.mono());
    attempt += 1;
    const script = attempt === 1 ? [throttleChunk({ retryAfterMs: 2_500 })] : successChunks();
    return (async function* () {
      yield* script;
    })();
  };
  const stream = collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, wrapped, { timers: scheduler.timers }));
  await settle();
  assert.equal(attemptTimes.length, 1, 'the first attempt was sent');
  scheduler.advance(2_400);
  await settle();
  assert.equal(attemptTimes.length, 1, 'the retry waited for Retry-After');
  scheduler.advance(200);
  const chunks = await stream;
  assert.equal(attemptTimes.length, 2, 'the retry was sent after the provider delay');
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop', 'the successful retry is the only terminal chunk');
});

test('the cooldown from a 429 delays the next request of the same model', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 50 } }));
  let attempt = 0;
  const wrapped = () => {
    attempt += 1;
    const script = attempt === 1 ? [throttleChunk({ retryAfterMs: 5_000 })] : successChunks();
    return (async function* () {
      yield* script;
    })();
  };
  const first = collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, wrapped, { timers: scheduler.timers }));
  await settle();
  // A second, independent request arrives while the cooldown is active.
  let secondSent = 0;
  const second = collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, () => {
    secondSent += 1;
    return (async function* () {
      yield* successChunks();
    })();
  }, { timers: scheduler.timers }));
  await settle();
  assert.equal(secondSent, 0, 'the cooldown holds the second request back');
  assert.ok(limiter.describe('p', 'm').cooldownMs > 0);

  scheduler.advance(5_100);
  await Promise.all([first, second]);
  assert.equal(secondSent, 1);
});

test('an unlimited model never waits and never retries', async () => {
  const { limiter, scheduler } = harness();
  let attempts = 0;
  const wrapped = () => {
    attempts += 1;
    return (async function* () {
      yield throttleChunk({ retryAfterMs: 10_000 });
    })();
  };
  const chunks = await collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, wrapped, { timers: scheduler.timers }));
  assert.equal(attempts, 1, 'the throttle is the provider layer own business');
  assert.equal(chunks.at(-1)?.reason?.failure?.status, 429, 'the original terminal chunk passes through');
  assert.equal(scheduler.pendingCount, 0, 'nothing is scheduled for an unlimited model');
});

test('a non-throttle failure is passed through without a retry', async () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 20 } }));
  let attempts = 0;
  const wrapped = () => {
    attempts += 1;
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key', status: 401 } } };
    })();
  };
  const chunks = await collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, wrapped));
  assert.equal(attempts, 1);
  assert.equal(chunks.at(-1)?.reason?.failure?.code, 'AUTH');
});

test('a persistent throttle stops after the configured attempt budget', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 500 } }));
  let attempts = 0;
  const wrapped = () => {
    attempts += 1;
    return (async function* () {
      yield throttleChunk({ retryAfterMs: 1 });
    })();
  };
  const stream = collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, wrapped, {
    timers: scheduler.timers,
    maxAttempts: 3,
  }));
  for (let i = 0; i < 6; i += 1) {
    scheduler.advance(5);
    await settle();
  }
  const chunks = await stream;
  assert.equal(attempts, 3, 'the budget bounds the retries');
  assert.equal(chunks.at(-1)?.reason?.kind, 'error');
});

test('a retried attempt is charged once, never twice', async () => {
  const { limiter, scheduler } = harness({ reservedOutputTokens: 100 });
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 10 }, tokens: { perMinute: 10_000 } }));
  let attempt = 0;
  const wrapped = () => {
    attempt += 1;
    const script = attempt === 1
      ? [throttleChunk({ retryAfterMs: 100 })]
      : successChunks({ usage: { inputTokens: 100, outputTokens: 50 } });
    return (async function* () {
      yield* script;
    })();
  };
  const stream = collect(runAdmittedStream(limiter, { provider: 'p', model: 'm' }, wrapped, { timers: scheduler.timers }));
  await drive({ scheduler, promise: stream });
  assert.equal(attempt, 2, 'the throttle was retried once');
  const status = limiter.describe('p', 'm');
  assert.equal(status.usage.requests.perMinute.used, 2, 'each provider attempt is one request');
  assert.equal(status.usage.tokens.perMinute.used, 150, 'the successful attempt is charged its real usage once');
});

test('token usage replaces the reservation instead of adding to it', async () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ tokens: { perMinute: 10_000 } }));
  const options = { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'x'.repeat(400) }] };
  const wrapped = () => (async function* () {
    yield* successChunks({ usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 5 } });
  })();
  await collect(runAdmittedStream(limiter, options, wrapped));
  const used = limiter.describe('p', 'm').usage.tokens.perMinute.used;
  assert.equal(used, 165, 'prompt + completion + cache read + cache write is the billed total');
});

test('a stream that ends without usage keeps the conservative reservation', async () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ tokens: { perMinute: 100_000 } }));
  const options = { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'x'.repeat(4_000) }] };
  const wrapped = () => (async function* () {
    // Aborted mid-stream: no usage chunk ever arrives.
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'user cancelled' } } };
  })();
  await collect(runAdmittedStream(limiter, options, wrapped));
  const used = limiter.describe('p', 'm').usage.tokens.perMinute.used;
  const reservation = limiter.costOf(options);
  assert.equal(used, reservation, 'the estimate stands in for the missing usage');
  assert.ok(used > 1_000);
});

test('the reservation falls back to the configured output allowance', () => {
  const { limiter } = harness({ reservedOutputTokens: 4_096 });
  const withCap = limiter.costOf({ provider: 'p', model: 'm', maxTokens: 10 });
  const withoutCap = limiter.costOf({ provider: 'p', model: 'm' });
  assert.ok(withoutCap >= 4_096, 'the configured allowance is reserved');
  assert.ok(withCap < 100, 'an explicit cap wins');
});

test('an image block is priced with the configured allowance', () => {
  const { limiter } = harness({ imageTokens: DEFAULT_IMAGE_TOKENS });
  const withImage = limiter.costOf({
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image', ref: 'x' }] }],
  });
  const withoutImage = limiter.costOf({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [] }] });
  assert.ok(withImage - withoutImage >= DEFAULT_IMAGE_TOKENS);
});

test('describe reports separate request and token countdowns', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perSecond: 1 }, tokens: { perMinute: 10_000 } }));
  await limiter.admit({ provider: 'p', model: 'm' }, 10_000);
  const secondAdmit = limiter.admit({ provider: 'p', model: 'm' }, 10_000);
  await settle();
  const status = limiter.describe('p', 'm');
  assert.ok(status.requestsResumeMs > 0, 'requests countdown is non-zero when the request budget is exhausted');
  assert.ok(status.tokensResumeMs > 0, 'tokens countdown is non-zero when the token budget is exhausted');
  assert.notEqual(status.requestsResumeMs, status.tokensResumeMs, 'the two countdowns are independent');
  scheduler.advance(61_000);
  await secondAdmit;
});

test('describe reports zero countdowns when the model is unlimited', () => {
  const { limiter } = harness();
  const status = limiter.describe('p', 'm');
  assert.equal(status.requestsResumeMs, 0);
  assert.equal(status.tokensResumeMs, 0);
});

test('the host adds display names to the state document when a resolver is installed', () => {
  const { limiter } = harness({
    resolveNames: (provider, model) => ({
      providerName: provider === 'deepseek-account' ? 'DeepSeek Account' : provider,
      modelName: model === 'deepseek-flash' ? 'DeepSeek-Flash' : model,
    }),
  });
  limiter.updatePolicy('deepseek-account/deepseek-flash', policy({ requests: { perMinute: 10 } }));
  const status = limiter.describe('deepseek-account', 'deepseek-flash');
  assert.equal(status.providerName, 'DeepSeek Account');
  assert.equal(status.modelName, 'DeepSeek-Flash');
});

test('throttleOf recognizes a status, a code, and ignores everything else', () => {
  assert.equal(throttleOf({ type: 'finish', reason: { kind: 'stop' } }), undefined);
  assert.equal(throttleOf({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', status: 401 } } })?.throttle, false);
  assert.equal(throttleOf(throttleChunk())?.throttle, true);
  assert.equal(throttleOf({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } })?.throttle, true);
  assert.equal(throttleOf({ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 503 } } })?.throttle, true);
});

test('disposing the limiter releases queued waiters as aborted', async () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perHour: 1 } }));
  const wrapped = () => (async function* () {
    yield* successChunks();
  })();
  const options = { provider: 'p', model: 'm' };
  await collect(runAdmittedStream(limiter, options, wrapped));
  const waiting = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  limiter.dispose();
  const chunks = await waiting;
  assert.equal(chunks.at(-1)?.reason?.kind, 'aborted');
});

test('a cheaper request does not overtake a blocked head, so nothing starves', async () => {
  const { limiter, scheduler } = harness({ reservedOutputTokens: 1 });
  limiter.updatePolicy('p/m', policy({ tokens: { perMinute: 100_000 } }));
  /** @type {string[]} */
  const order = [];
  const wrapped = (id) => () => (async function* () {
    order.push(id);
    yield* successChunks();
  })();
  const request = (id, maxTokens) => collect(
    runAdmittedStream(limiter, { provider: 'p', model: 'm', maxTokens }, wrapped(id)),
  );

  const first = request('first', 50_000);
  await settle();
  assert.deepEqual(order, ['first'], 'the first request fits the empty window');

  // The window now holds 50 000 of its 100 000 tokens. `big` needs 60 000, more
  // than the 50 000 still free, so it waits for the window to empty. `cheap`
  // would fit in the space that is left; admitting it would refill the window
  // and push `big` back on every tick -- starvation. Strict arrival order is
  // what prevents that, and it is also what makes the wake-up instant honest,
  // because the next wake-up is computed from the head's cost.
  const big = request('big', 60_000);
  await settle();
  const cheap = request('cheap', 1);
  await settle();
  assert.deepEqual(order, ['first'], 'the blocked head holds the queue');
  assert.equal(limiter.describe('p', 'm').queueDepth, 2, 'both later requests are queued');

  scheduler.advance(61_000);
  await Promise.all([first, big, cheap]);
  assert.deepEqual(order, ['first', 'big', 'cheap'], 'the queue drains strictly in arrival order');
});

test('removing a policy releases that model\'s counters', async () => {
  const { limiter } = harness();
  const wrapped = () => (async function* () {
    yield* successChunks();
  })();
  limiter.updatePolicy('p/a', policy({ requests: { perHour: 1 } }));
  limiter.updatePolicy('p/b', policy({ requests: { perHour: 4 } }));
  await collect(runAdmittedStream(limiter, { provider: 'p', model: 'a' }, wrapped));
  await collect(runAdmittedStream(limiter, { provider: 'p', model: 'b' }, wrapped));
  assert.equal(limiter.describe('p', 'a').usage.requests.perHour.used, 1);

  limiter.setPolicies(new Map([['p/b', policy({ requests: { perHour: 4 } })]]));
  const released = limiter.describe('p', 'a');
  assert.equal(released.configured, false);
  assert.equal(released.limited, false);
  assert.equal(released.usage.requests.perHour.used, 0, 'the counters go with the policy');
  assert.equal(released.usage.tokens.perDay.used, 0);
  assert.equal(released.lastRequestAgoMs, null, 'nothing is remembered about the released model');
  assert.equal(limiter.describe('p', 'b').usage.requests.perHour.used, 1, 'another model is untouched');
});

test('removing a policy lets its queued request go at once', async () => {
  const { limiter } = harness();
  const wrapped = () => (async function* () {
    yield* successChunks();
  })();
  const options = { provider: 'p', model: 'm' };
  limiter.updatePolicy('p/m', policy({ requests: { perHour: 1 } }));
  const first = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  const waiting = collect(runAdmittedStream(limiter, options, wrapped));
  await settle();
  assert.equal(limiter.describe('p', 'm').queueDepth, 1, 'the second request is capped');

  limiter.setPolicies(new Map());
  await settle();
  const chunks = await waiting;
  await first;
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop', 'the queue is admitted as soon as the cap is gone');
  assert.equal(limiter.describe('p', 'm').queueDepth, 0);
});

test('two models keep independent queues and counters', async () => {
  const { limiter, scheduler } = harness();
  limiter.updatePolicy('p/a', policy({ requests: { perSecond: 1 } }));
  limiter.updatePolicy('p/b', policy({ requests: { perSecond: 1 } }));
  /** @type {string[]} */
  const order = [];
  const wrapped = (id) => () => (async function* () {
    order.push(id);
    yield* successChunks();
  })();
  const a1 = collect(runAdmittedStream(limiter, { provider: 'p', model: 'a' }, wrapped('a1')));
  const b1 = collect(runAdmittedStream(limiter, { provider: 'p', model: 'b' }, wrapped('b1')));
  await settle();
  assert.deepEqual(order.sort(), ['a1', 'b1'], 'the two models do not share a queue');
  const a2 = collect(runAdmittedStream(limiter, { provider: 'p', model: 'a' }, wrapped('a2')));
  await settle();
  assert.equal(order.includes('a2'), false, 'model a is capped');
  scheduler.advance(1_100);
  await Promise.all([a1, b1, a2]);
  assert.ok(order.includes('a2'));
  assert.equal(limiter.describe('p', 'b').queueDepth, 0);
});
