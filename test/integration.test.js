/**
 * End-to-end integration: the host plugin, a real HTTP server, and a mock
 * provider that reports usage and can throttle.
 *
 * The mock provider stands in for a DSH adapter: it yields the chunk protocol
 * the harness defines (`usage` then a terminal `finish`) and can reply with an
 * HTTP-429-shaped failure carrying `Retry-After`. Virtual time is advanced
 * explicitly, so the whole scenario runs deterministically and instantly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { runAdmittedStream } from '../lib/admission.js';
import { FakeClock } from '../lib/clock.js';
import { ModelRateLimiter } from '../lib/limiter.js';
import { RateLimitApi } from '../lib/api.js';
import { FakeScheduler, successChunks, throttleChunk } from './helpers.js';

/** Let queued microtasks run so the plugin reaches its next await point. */
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A provider that answers from a script and records every attempt.
 *
 * The `llm/stream` waterfall hands its listener a zero-argument `next`, so the
 * provider is called with nothing and reads the request from its own closure.
 */
class MockProvider {
  /** @type {number} */
  attempts = 0;
  /** @type {Array<import('../lib/types.js').StreamChunk | Array<import('../lib/types.js').StreamChunk>>} */
  scripts;
  /** @type {number} */
  #index = 0;

  /** @param {Array<import('../lib/types.js').StreamChunk | Array<import('../lib/types.js').StreamChunk>>} scripts */
  constructor(scripts) {
    this.scripts = scripts;
    // Bound once so the method can be handed to the limiter as a plain callback.
    this.call = this.call.bind(this);
  }

  /** @returns {AsyncIterable<import('../lib/types.js').StreamChunk>} */
  call() {
    this.attempts += 1;
    const entry = this.scripts[Math.min(this.#index, this.scripts.length - 1)];
    this.#index += 1;
    const chunks = Array.isArray(entry) ? entry : [entry];
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  }
}

/**
 * Boot the plugin's pieces the way the host does: one limiter, one API, one route.
 *
 * @param {Record<string, unknown>} models
 */
async function boot(models) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  /** @type {Array<Record<string, unknown>>} */
  const logs = [];
  const limiter = new ModelRateLimiter({
    clock,
    timers: scheduler.timers,
    wakeMarginMs: 1,
    wakeJitterMs: 0,
    random: () => 0.5,
    onLog: (record) => logs.push(record),
  });
  /** @type {Array<Record<string, unknown>>} */
  const writes = [];
  const api = new RateLimitApi({
    limiter,
    initialConfig: models,
    persistConfig: async (next) => {
      writes.push(next);
    },
  });
  const server = createServer((request, response) => {
    void api.handle(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    clock,
    scheduler,
    limiter,
    api,
    logs,
    writes,
    url: `http://127.0.0.1:${port}${api.prefix}`,
    close: async () => {
      api.dispose();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * Start one request and expose its collected chunks and completion state.
 *
 * @param {Awaited<ReturnType<typeof boot>>} host
 * @param {MockProvider} provider
 * @param {{ provider: string, model: string, messages: unknown[] }} options
 */
function send(host, provider, options) {
  /** @type {Array<import('../lib/types.js').StreamChunk>} */
  const chunks = [];
  const state = { settled: false };
  const done = (async () => {
    try {
      const stream = runAdmittedStream(host.limiter, /** @type {any} */ (options), provider.call, {
        timers: host.scheduler.timers,
        onLog: (record) => host.logs.push(record),
      });
      for await (const chunk of stream) {
        if (chunk.type === 'usage') state['usage'] = chunk.usage;
        chunks.push(chunk);
      }
    } finally {
      state.settled = true;
    }
  })();
  return {
    chunks,
    done,
    get settled() {
      return state.settled;
    },
    /** Advance the clock by exactly `ms` and let everything queued run. */
    async step(ms) {
      if (ms > 0) host.scheduler.advance(ms);
      await settle();
    },
    async finish(maxSteps = 32) {
      for (let step = 0; step < maxSteps && !state.settled; step += 1) {
        await settle();
        if (state.settled) break;
        const delay = host.scheduler.nextDelay();
        if (delay === undefined) break;
        host.scheduler.advance(Math.max(1, Math.ceil(delay)) + 1);
      }
      await settle();
      return state.settled;
    },
  };
}

const flashOptions = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'привіт' }] }],
};

test('a throttled request is retried after Retry-After and charged once', { timeout: 20_000 }, async () => {
  const host = await boot({
    'deepseek-account/deepseek-flash': {
      requests: { perMinute: 50 },
      tokens: { perDay: 1_000_000 },
    },
  });
  const provider = new MockProvider([
    throttleChunk({ retryAfterMs: 5_000 }),
    successChunks({ usage: { inputTokens: 120, outputTokens: 25, cacheReadTokens: 5 } }),
  ]);
  try {
    const request = send(host, provider, flashOptions);
    await request.step(0);
    assert.equal(provider.attempts, 1, 'the first attempt was sent');
    assert.equal(request.settled, false, 'the stream stays open while it waits');

    await request.step(4_000);
    assert.equal(provider.attempts, 1, 'the retry waited for Retry-After');

    const finished = await request.finish();
    assert.equal(finished, true, 'the retry completed');
    assert.equal(provider.attempts, 2);
    assert.equal(request.chunks.filter((chunk) => chunk.type === 'finish').length, 1, 'exactly one terminal chunk');
    assert.equal(request.chunks.at(-1)?.reason?.kind, 'stop');
    assert.equal(host.logs.some((entry) => entry.event === 'provider-throttled'), true, 'the throttle was logged');

    const state = await (await fetch(`${host.url}/state`)).json();
    assert.equal(state.models[0].usage.requests.perMinute.used, 2, 'each provider attempt is one request');
    assert.equal(state.models[0].usage.tokens.perDay.used, 150, 'only the successful attempt is charged its usage');
  } finally {
    await host.close();
  }
});

test('an over-limit request waits, consumes nothing, and is sent unchanged', { timeout: 20_000 }, async () => {
  const host = await boot({
    'deepseek-account/deepseek-flash': {
      requests: { perMinute: 2 },
      tokens: { perDay: 1_000_000 },
    },
  });
  const provider = new MockProvider([successChunks({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } })]);
  try {
    const first = send(host, provider, flashOptions);
    const firstDone = await first.finish();
    assert.equal(firstDone, true);
    assert.equal(provider.attempts, 1);

    const second = send(host, provider, flashOptions);
    const secondDone = await second.finish();
    assert.equal(secondDone, true);
    assert.equal(provider.attempts, 2);

    // The budget is two per minute and both are spent, so the third request must
    // wait even though every previous attempt has already settled.
    const third = send(host, provider, flashOptions);
    await third.step(0);
    assert.equal(provider.attempts, 2, 'the over-limit request is not sent');

    const waiting = await (await fetch(`${host.url}/state`)).json();
    assert.equal(waiting.models[0].queueDepth, 1, 'the control can see the queue');
    assert.ok(waiting.models[0].resumeInMs > 0, 'the control can show a countdown');
    assert.equal(host.scheduler.pendingCount, 1, 'exactly one timer is armed for the whole model');
    assert.equal(waiting.models[0].usage.tokens.perDay.used, 300, 'only the two settled requests are charged');

    // While it waits, the reservation is not on the books yet: the engine only
    // charges the real usage once the request settles.
    await third.step(1_000);
    assert.equal(provider.attempts, 2, 'still waiting after a second');
    assert.equal(
      await (await fetch(`${host.url}/state`)).json().then((doc) => doc.models[0].usage.tokens.perDay.used),
      300,
      'waiting costs no tokens',
    );

    await third.step(59_100);
    assert.equal(provider.attempts, 3, 'the request was sent once the window rolled');
    const thirdDone = await third.finish();
    assert.equal(thirdDone, true);
    assert.equal(third.chunks.at(-1)?.reason?.kind, 'stop');
    assert.equal(host.limiter.describe('deepseek-account', 'deepseek-flash').queueDepth, 0);
    assert.equal(host.scheduler.pendingCount, 0, 'no timer is left behind');
    assert.equal(host.limiter.policyOf('deepseek-account/deepseek-flash').requests.perMinute, 2);
  } finally {
    await host.close();
  }
});

test('a menu edit persists and a rejected value changes nothing', { timeout: 20_000 }, async () => {
  const host = await boot({ 'deepseek-account/deepseek-flash': { requests: { perMinute: 1 } } });
  try {
    const edit = await fetch(`${host.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-account/deepseek-flash', kind: 'requests', window: 'perSecond', value: '5' }),
    });
    assert.equal(edit.status, 200);
    const body = await edit.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.adjustments, [{ kind: 'requests', window: 'perMinute', from: 1, to: 5 }], 'the cascade was reported');
    assert.deepEqual(host.writes.at(-1), {
      'deepseek-account/deepseek-flash': {
        requests: { perSecond: 5, perMinute: 5, perHour: 0, perDay: 0 },
        tokens: { perSecond: 0, perMinute: 0, perHour: 0, perDay: 0 },
      },
    });

    const rejected = await fetch(`${host.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-account/deepseek-flash', kind: 'requests', window: 'perMinute', value: -4 }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /negative/);
    assert.equal(host.writes.length, 1, 'the rejected edit was not persisted');
    assert.equal(host.limiter.policyOf('deepseek-account/deepseek-flash').requests.perMinute, 5);

    const state = await (await fetch(`${host.url}/state`)).json();
    assert.equal(state.models[0].policy.requests.perSecond, 5, 'the live policy carries the edit');
  } finally {
    await host.close();
  }
});

test('two models are limited independently through the whole stack', { timeout: 20_000 }, async () => {
  const host = await boot({
    'p/a': { requests: { perSecond: 1 } },
    'p/b': { requests: { perSecond: 1 } },
  });
  const provider = new MockProvider([successChunks({ usage: { inputTokens: 5, outputTokens: 5 } })]);
  const options = (model) => ({ provider: 'p', model, messages: [] });
  try {
    // t = 0: both windows are empty, so both first requests go at once. This is
    // the whole point: one model's budget never gates another model's call.
    const a1 = send(host, provider, options('a'));
    const b1 = send(host, provider, options('b'));
    await a1.step(0);
    assert.equal(provider.attempts, 2, 'the two models do not share a queue');
    assert.equal(a1.settled, true);
    assert.equal(b1.settled, true);

    // Within the same second both windows are now full.
    const a2 = send(host, provider, options('a'));
    await a2.step(0);
    assert.equal(provider.attempts, 2, 'model a is capped');
    assert.equal(host.limiter.describe('p', 'a').queueDepth, 1);

    const b2 = send(host, provider, options('b'));
    await b2.step(0);
    assert.equal(provider.attempts, 2, 'model b is capped by its own limit too');
    assert.equal(host.limiter.describe('p', 'b').queueDepth, 1);

    // One second later both windows roll and both queued requests are sent.
    await a2.step(1_100);
    assert.equal(provider.attempts, 4, 'each model resumed on its own schedule');
    assert.equal(await a2.finish(), true);
    assert.equal(await b2.finish(), true);
    assert.equal(host.scheduler.pendingCount, 0);

    const document = await (await fetch(`${host.url}/state`)).json();
    const usage = Object.fromEntries(document.models.map((model) => [model.key, model.usage.requests.perSecond.used]));
    assert.equal(usage['p/a'], 1, 'model a used its second slot');
    assert.equal(usage['p/b'], 1, 'model b used its second slot');
    assert.equal(host.limiter.policyOf('p/a').requests.perSecond, 1, 'each model keeps its own policy');
    assert.equal(host.limiter.policyOf('p/b').requests.perSecond, 1);
  } finally {
    await host.close();
  }
});

test('a model with no policy yet becomes editable and persists its first limit', { timeout: 20_000 }, async () => {
  // This is the state a fresh installation is in: the plugin knows no models at
  // all, and the control must still let the user type the first value.
  const host = await boot({});
  try {
    const before = await (await fetch(`${host.url}/state`)).json();
    assert.deepEqual(before.models, []);
    assert.deepEqual(before.warnings, []);

    const created = await fetch(`${host.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unorouter/kimi-k3:free', kind: 'requests', window: 'perMinute', value: '30' }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.ok, true);
    assert.equal(body.model.limited, true, 'the model is limited from the first write');
    assert.equal(body.model.queueDepth, 0);
    assert.equal(body.model.usage.requests.perMinute.used, 0);
    assert.equal(body.model.policy.requests.perMinute, 30);
    assert.deepEqual(body.adjustments, [], 'nothing else moved');

    const after = await (await fetch(`${host.url}/state`)).json();
    assert.equal(after.models.length, 1, 'the state document lists the new model');
    assert.equal(after.models[0].key, 'unorouter/kimi-k3:free');
    assert.equal(host.writes.length, 1, 'the first write was persisted');

    // A second field on the same model accumulates instead of replacing.
    const raised = await fetch(`${host.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unorouter/kimi-k3:free', kind: 'tokens', window: 'perHour', value: '500k' }),
    });
    const raisedBody = await raised.json();
    assert.equal(raisedBody.model.policy.tokens.perHour, 500_000);
    assert.equal(raisedBody.model.policy.requests.perMinute, 30, 'the earlier field is still there');
    assert.deepEqual(host.writes.at(-1), {
      'unorouter/kimi-k3:free': {
        requests: { perSecond: 0, perMinute: 30, perHour: 0, perDay: 0 },
        tokens: { perSecond: 0, perMinute: 0, perHour: 500_000, perDay: 0 },
      },
    });

    // Clearing a field brings that window back to unlimited.
    const cleared = await fetch(`${host.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unorouter/kimi-k3:free', kind: 'requests', window: 'perMinute', unlimited: true }),
    });
    const clearedBody = await cleared.json();
    assert.equal(clearedBody.model.policy.requests.perMinute, 0);
    assert.equal(clearedBody.model.limited, true, 'the token limit still applies');
    assert.equal(host.limiter.limits('unorouter', 'kimi-k3:free'), true);

    const provider = new MockProvider([successChunks()]);
    const pass = [];
    for await (const chunk of runAdmittedStream(
      host.limiter,
      { provider: 'unorouter', model: 'kimi-k3:free', messages: [] },
      provider.call,
      { timers: host.scheduler.timers },
    )) {
      pass.push(chunk.type);
    }
    assert.deepEqual(pass, ['finish'], 'the model still answers while under its limits');
    assert.equal(host.scheduler.pendingCount, 0);
  } finally {
    await host.close();
  }
});

test('an unlimited model passes through the whole stack without accounting', { timeout: 20_000 }, async () => {
  const host = await boot({});
  const provider = new MockProvider([successChunks({ usage: { inputTokens: 5, outputTokens: 5 } })]);
  try {
    const request = send(host, provider, { provider: 'p', model: 'm', messages: [] });
    await request.step(0);
    assert.equal(request.settled, true, 'an unlimited request needs no clock advance');
    assert.equal(request.chunks.at(-1)?.type, 'finish');
    assert.equal(host.scheduler.pendingCount, 0);
    assert.equal(await (await fetch(`${host.url}/state`)).json().then((doc) => doc.models.length), 0);
  } finally {
    await host.close();
  }
});
