/**
 * Regression tests for the post-implementation review backlog.
 *
 * Every case pins a defect that was found by inspection and fixed afterwards, so
 * a later refactor cannot quietly reintroduce it. The backlog entry each test
 * covers is named in its title.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { RateLimitApi, isTrustedRequest } from '../lib/api.js';
import { FakeClock } from '../lib/clock.js';
import { harness, policy } from './helpers.js';

/**
 * Start a server that routes everything under the plugin prefix into the API.
 *
 * @param {RateLimitApi} api
 */
async function serve(api) {
  const server = createServer((request, response) => {
    void api.handle(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}${api.prefix}`,
    close: async () => {
      api.dispose();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * @param {Partial<import('../lib/api.js').RateLimitApiOptions>} [options]
 */
function apiWith(options = {}) {
  const { limiter } = harness();
  const api = new RateLimitApi({
    limiter,
    initialConfig: {},
    persistConfig: async () => {},
    ...options,
  });
  return { api, limiter };
}

/**
 * A buffered SSE reader: one outstanding `read()` at a time, and a timeout that
 * never discards data. Racing a fresh `read()` per call would abandon the loser,
 * and the abandoned promise would then swallow the next frame.
 *
 * @param {Response} response
 */
function streamReader(response) {
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (response.body.getReader());
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {Promise<void> | null} */
  let inflight = null;
  const pull = () => {
    if (inflight === null) {
      inflight = reader.read().then((result) => {
        inflight = null;
        if (result.done !== true) buffer += decoder.decode(result.value);
      });
    }
    return inflight;
  };
  return {
    /** @param {number} ms */
    async next(ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (buffer !== '') {
          const frame = buffer;
          buffer = '';
          return frame;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return '';
        const timedOut = await Promise.race([pull().then(() => false), delay(remaining).then(() => true)]);
        if (timedOut && buffer === '') return '';
      }
    },
  };
}

// ── P1-1: a wall clock that stepped backwards is reported ───────────────────

test('P1-1: importState reports the skew of the file it just read', () => {
  const { limiter, clock } = harness({ clock: new FakeClock(1_700_000_000_000, 1_000) });
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 10 } }));
  const restored = limiter.importState({
    anchor: { mono: 0, wall: 0 },
    // Written 90 seconds "later" than the reader's own wall clock.
    savedWall: clock.wall() + 90_000,
    models: {},
  });
  assert.equal(restored.skewMs, 90_000);
  assert.deepEqual(restored.dropped, []);
});

test('P1-1: a file with no timestamp reports no skew instead of NaN', () => {
  const { limiter } = harness();
  const restored = limiter.importState({
    anchor: { mono: 0, wall: 0 },
    models: {},
  });
  assert.equal(restored.skewMs, 0);
});

test('P1-1: a malformed state document is refused without throwing', () => {
  const { limiter } = harness();
  assert.deepEqual(limiter.importState(/** @type {any} */ (undefined)), {
    restored: 0,
    dropped: [],
    skewMs: 0,
  });
  assert.deepEqual(limiter.importState(/** @type {any} */ ({ models: 7 })), {
    restored: 0,
    dropped: [],
    skewMs: 0,
  });
});

// ── P1-3: an unchanged snapshot is not pushed again ────────────────────────

test('P1-3: an unchanged document is not written to the stream a second time', async () => {
  const { api, limiter } = apiWith({
    initialConfig: { 'acme/model': { requests: { perMinute: 30 }, tokens: {} } },
  });
  limiter.updatePolicy('acme/model', policy({ requests: { perMinute: 30 } }));
  const server = await serve(api);
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const stream = streamReader(response);
    const initial = await stream.next(500);
    assert.match(initial, /event: snapshot/);

    // Every pump calls notify(). With nothing changed, none of them may write.
    api.notify();
    api.notify();
    api.notify();
    assert.equal(await stream.next(120), '', 'an identical snapshot is suppressed');

    // A real change still goes out immediately.
    limiter.updatePolicy('acme/model', policy({ requests: { perMinute: 5 } }));
    api.notify();
    const changed = await stream.next(500);
    assert.match(changed, /event: snapshot/);
    assert.match(changed, /"perMinute":5/);
  } finally {
    controller.abort();
    await server.close();
  }
});

test('P1-3: a burst of pumps shares one document build', async () => {
  const { api, limiter } = apiWith({
    initialConfig: { 'acme/model': { requests: { perMinute: 30 }, tokens: {} } },
  });
  limiter.updatePolicy('acme/model', policy({ requests: { perMinute: 30 } }));
  const server = await serve(api);
  const controller = new AbortController();
  let builds = 0;
  const describe = limiter.describe.bind(limiter);
  limiter.describe = (...args) => {
    builds += 1;
    return describe(...args);
  };
  try {
    const response = await fetch(`${server.url}/events`, { signal: controller.signal });
    const stream = streamReader(response);
    assert.match(await stream.next(500), /event: snapshot/);

    // One tick, ten admission decisions.
    builds = 0;
    for (let i = 0; i < 10; i += 1) api.notify();
    await delay(30);
    assert.equal(builds, 1, 'ten pumps in one tick cost one describe() call, not ten');

    // A later tick builds again, so nothing is starved by the coalescing.
    builds = 0;
    api.notify();
    await delay(30);
    assert.equal(builds, 1);
    // The identical payload is still suppressed on the wire.
    assert.equal(await stream.next(120), '');
  } finally {
    controller.abort();
    await server.close();
  }
});

// ── P1-8: a cross-site page cannot read or rewrite limits ──────────────────

test('P1-8: isTrustedRequest accepts the harness page and refuses others', () => {
  /** @param {Record<string, string>} headers */
  const request = (headers) => /** @type {any} */ ({ headers });
  assert.equal(isTrustedRequest(request({})), true, 'no origin at all (curl, tests)');
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'none' })), true, 'a typed URL');
  assert.equal(
    isTrustedRequest(
      request({ 'sec-fetch-site': 'same-origin', origin: 'dsh-app://harness', host: '127.0.0.1:19387' }),
    ),
    true,
    'a desktop shell on its own scheme: the browser vouched, so the authority comparison is skipped',
  );
  assert.equal(
    isTrustedRequest(request({ origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' })),
    true,
  );
  assert.equal(
    isTrustedRequest(request({ origin: 'http://localhost:19387', host: 'LOCALHOST:19387' })),
    true,
    'case and default port do not matter',
  );
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isTrustedRequest(request({ 'sec-fetch-site': 'same-site' })), false);
  assert.equal(
    isTrustedRequest(request({ origin: 'https://evil.example', host: '127.0.0.1:19387' })),
    false,
    'a foreign origin',
  );
  assert.equal(
    isTrustedRequest(request({ origin: 'http://127.0.0.1:19387' })),
    false,
    'an origin with no host to compare against',
  );
  assert.equal(isTrustedRequest(request({ origin: 'not a url' })), false);
});

test('P1-8: a cross-site read is refused with a reason', async () => {
  const { api } = apiWith();
  const server = await serve(api);
  try {
    const response = await fetch(`${server.url}/state`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /Harness page/);
  } finally {
    await server.close();
  }
});

test('P1-8: a cross-site write is refused and nothing is stored', async () => {
  const { api, limiter } = apiWith();
  const server = await serve(api);
  try {
    const response = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ model: 'p/m', kind: 'requests', window: 'perMinute', value: 9_999 }),
    });
    assert.equal(response.status, 403);
    assert.equal(limiter.policyOf('p/m').requests.perMinute, 0, 'the limit was not written');
  } finally {
    await server.close();
  }
});

// ── P1-9: an exhausted retry budget leaves no cooldown behind ───────────────

test('P1-9: clearCooldown drops the penalty and the streak', () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 100 } }));
  const armed = limiter.observeThrottle('p', 'm', { status: 429, providerRetryAfterMs: 5_000 });
  assert.equal(armed, 5_000);
  assert.equal(limiter.describe('p', 'm').cooldownMs, 5_000);
  assert.equal(limiter.describe('p', 'm').retryInMs, 5_000);

  limiter.clearCooldown('p', 'm');
  const after = limiter.describe('p', 'm');
  assert.equal(after.cooldownMs, 0);
  assert.equal(after.retryInMs, null);

  // The escalation ladder restarted too: the next throttle is a first attempt.
  assert.equal(limiter.observeThrottle('p', 'm', {}), 1_000);
});

test('P1-9: clearing a cooldown on an unknown or healthy model is a no-op', () => {
  const { limiter } = harness();
  limiter.clearCooldown('p', 'never-seen');
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 5 } }));
  limiter.clearCooldown('p', 'm');
  assert.equal(limiter.describe('p', 'm').cooldownMs, 0);
});

// ── P1-10: the usage correction lands in the bucket it is settled in ───────

test('P1-10: a late usage correction is charged to the settle instant', async () => {
  const { limiter, clock } = harness();
  limiter.updatePolicy('p/m', policy({ tokens: { perSecond: 1_000_000 } }));

  const admission = await limiter.admit({ provider: 'p', model: 'm' }, 100);
  assert.equal(limiter.describe('p', 'm').usage.tokens.perSecond.used, 100, 'the reservation is charged');

  // The provider answers two seconds later: the reservation's own bucket has
  // already rolled out of the one-second window.
  clock.advance(2_000);
  assert.equal(limiter.describe('p', 'm').usage.tokens.perSecond.used, 0);

  limiter.settle(admission.lease, { inputTokens: 300, outputTokens: 0 });
  assert.equal(
    limiter.describe('p', 'm').usage.tokens.perSecond.used,
    200,
    'the +200 overrun was written where it can still be seen',
  );

  // And it expires with the window it was written into, like any other event.
  clock.advance(1_000);
  assert.equal(limiter.describe('p', 'm').usage.tokens.perSecond.used, 0);
});

test('P1-10: settling inside the reservation window still sums to real usage', async () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ tokens: { perMinute: 1_000_000 } }));
  const admission = await limiter.admit({ provider: 'p', model: 'm' }, 100);
  limiter.settle(admission.lease, { inputTokens: 300, outputTokens: 0 });
  assert.equal(limiter.describe('p', 'm').usage.tokens.perMinute.used, 300, 'reservation + correction = usage');
});

// ── P2-3: waiting history is surfaced for the model on screen ───────────────

test('P2-3: describe reports how often a model waited and for how long', async () => {
  const { limiter, clock, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perSecond: 1 } }));
  assert.deepEqual(limiter.describe('p', 'm').stats, { waits: 0, waitMs: 0, lastThrottledAgoMs: null });

  // First request consumes the second; the second one waits for the next bucket.
  const first = await limiter.admit({ provider: 'p', model: 'm' }, 1);
  limiter.settle(first.lease, { inputTokens: 0, outputTokens: 0 });
  const waiting = limiter.admit({ provider: 'p', model: 'm' }, 1);
  scheduler.advance(1_500);
  const second = await waiting;
  limiter.settle(second.lease, { inputTokens: 0, outputTokens: 0 });

  const stats = limiter.describe('p', 'm').stats;
  assert.equal(stats.waits, 1);
  // The exact wake instant is the window edge plus the (test-pinned) 1 ms margin.
  assert.ok(stats.waitMs >= 1_000 && stats.waitMs <= 1_050, `waited ${stats.waitMs}ms`);

  limiter.observeThrottle('p', 'm', { status: 429, providerRetryAfterMs: 2_000 });
  clock.advance(500);
  const aged = limiter.describe('p', 'm').stats;
  assert.equal(aged.lastThrottledAgoMs, 500);
});

test('P2-3: an unlimited model reports no waiting history at all', () => {
  const { limiter } = harness();
  const status = limiter.describe('p', 'm');
  assert.equal(status.stats.waits, 0);
  assert.equal(status.stats.lastThrottledAgoMs, null);
});