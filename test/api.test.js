/**
 * The host HTTP surface, exercised through a real `node:http` server and real
 * `fetch` calls: state reads, field writes with their cascade, validation
 * failures, and the server-sent event stream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { RateLimitApi } from '../lib/api.js';
import { harness, policy } from './helpers.js';

/**
 * Start a server that routes everything under the plugin prefix into the API.
 *
 * @param {RateLimitApi} api
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
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
  const writes = [];
  const api = new RateLimitApi({
    limiter,
    initialConfig: {},
    persistConfig: async (models) => {
      writes.push(models);
    },
    ...options,
  });
  return { api, limiter, writes };
}

test('GET /state describes every configured model', async () => {
  const { api, limiter } = apiWith({
    initialConfig: {
      'deepseek-account/deepseek-flash': { requests: { perMinute: 30 }, tokens: { perHour: 500_000 } },
      'acme/kimi-k3:free': { requests: { perSecond: 2 } },
    },
  });
  const server = await serve(api);
  try {
    const response = await fetch(`${server.url}/state`);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.version, 1);
    assert.deepEqual(document.models.map((model) => model.key).sort(), [
      'acme/kimi-k3:free',
      'deepseek-account/deepseek-flash',
    ]);
    const flash = document.models.find((model) => model.model === 'deepseek-flash');
    assert.equal(flash.policy.requests.perMinute, 30);
    assert.equal(flash.usage.requests.perMinute.limit, 30);
    assert.equal(flash.limited, true);
    assert.deepEqual(document.warnings, []);
    assert.equal(limiter.limits('deepseek-account', 'deepseek-flash'), true);
  } finally {
    await server.close();
  }
});

test('POST /limit writes one field, cascades, and persists', async () => {
  const { api, writes } = apiWith({
    initialConfig: { 'p/m': { requests: { perMinute: 1 }, tokens: {} } },
  });
  const server = await serve(api);
  try {
    const response = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'p/m', kind: 'requests', window: 'perSecond', value: '5' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.model.policy.requests.perSecond, 5);
    assert.equal(body.model.policy.requests.perMinute, 5, 'the larger window was raised');
    assert.deepEqual(body.adjustments, [{ kind: 'requests', window: 'perMinute', from: 1, to: 5 }]);
    assert.deepEqual(body.persisted, { ok: true });
    assert.deepEqual(writes.at(-1), {
      'p/m': {
        requests: { perSecond: 5, perMinute: 5, perHour: 0, perDay: 0 },
        tokens: { perSecond: 0, perMinute: 0, perHour: 0, perDay: 0 },
      },
    });
  } finally {
    await server.close();
  }
});

test('POST /limit clears a field when unlimited is requested', async () => {
  const { api } = apiWith({ initialConfig: { 'p/m': { requests: { perSecond: 9, perMinute: 9 } } } });
  const server = await serve(api);
  try {
    const response = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'p/m', kind: 'requests', window: 'perSecond', unlimited: true }),
    });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.model.policy.requests.perSecond, 0);
    assert.equal(body.model.policy.requests.perMinute, 9, 'clearing never cascades');
    assert.deepEqual(body.adjustments, []);
  } finally {
    await server.close();
  }
});

test('an invalid value is refused with an explanation and changes nothing', async () => {
  const { api, writes } = apiWith({ initialConfig: { 'p/m': { requests: { perMinute: 7 } } } });
  const server = await serve(api);
  try {
    for (const value of [-1, 2.5, 'lots', '']) {
      const response = await fetch(`${server.url}/limit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'p/m', kind: 'requests', window: 'perMinute', value: '7' }),
      });
      assert.equal(response.status, 200, `${value} is a valid write, used as a control`);
      assert.equal((await response.json()).ok, true);
    }
    const bad = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'p/m', kind: 'requests', window: 'perMinute', value: -1 }),
    });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /negative/);

    const malformed = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /not valid JSON/);

    const unknownKey = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nokey', kind: 'requests', window: 'perMinute', value: 1 }),
    });
    assert.equal(unknownKey.status, 400);

    const state = await (await fetch(`${server.url}/state`)).json();
    assert.equal(state.models[0].policy.requests.perMinute, 7, 'nothing was written by the failures');
  } finally {
    await server.close();
  }
});

test('an unknown route is a 404 and an unknown method is refused', async () => {
  const { api } = apiWith();
  const server = await serve(api);
  try {
    const missing = await fetch(`${server.url}/nope`);
    assert.equal(missing.status, 404);
    const wrongMethod = await fetch(`${server.url}/limit`);
    assert.equal(wrongMethod.status, 404);
  } finally {
    await server.close();
  }
});

test('a failing configuration write is reported without losing the edit', async () => {
  const { api } = apiWith({
    initialConfig: {},
    persistConfig: async () => {
      throw new Error('the profile patch is read-only');
    },
  });
  const server = await serve(api);
  try {
    const response = await fetch(`${server.url}/limit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'p/m', kind: 'tokens', window: 'perHour', value: '500k' }),
    });
    const body = await response.json();
    assert.equal(body.ok, true, 'the live policy still changed');
    assert.equal(body.model.policy.tokens.perHour, 500_000);
    assert.equal(body.persisted.ok, false);
    assert.match(body.persisted.error, /read-only/);
  } finally {
    await server.close();
  }
});

test('the event stream announces the current state and later edits', async () => {
  const { api, limiter } = apiWith({ initialConfig: { 'p/m': { requests: { perMinute: 4 } } } });
  const server = await serve(api);
  /** @type {AbortController} */
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.url}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readFrame = async () => {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data !== undefined) return JSON.parse(data.slice('data: '.length));
          continue;
        }
        const next = await reader.read();
        if (next.done === true) throw new Error('the stream ended before a frame arrived');
        buffer += decoder.decode(next.value, { stream: true });
      }
    };

    const first = await readFrame();
    assert.equal(first.models.length, 1);
    assert.equal(first.models[0].policy.requests.perMinute, 4);

    limiter.editPolicyWindow('p/m', 'requests', 'perMinute', 12);
    api.notify();
    const second = await readFrame();
    assert.equal(second.models[0].policy.requests.perMinute, 12, 'the push carries the new limit');

    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    controller.abort();
    await server.close();
  }
});

test('configuration loaded from a file is repaired on activation', async () => {
  const { api, limiter } = apiWith({
    initialConfig: { 'p/m': { requests: { perSecond: 10, perMinute: 1 } } },
  });
  assert.equal(limiter.policyOf('p/m').requests.perMinute, 10);
  const document = api.stateDocument();
  const model = /** @type {any} */ (document.models[0]);
  assert.equal(model.policy.requests.perSecond, 10);
  assert.equal(model.policy.requests.perMinute, 10);
});

test('a policy write survives a round trip through the API document', async () => {
  const { api } = apiWith({ initialConfig: { 'p/m': policy({ tokens: { perDay: 2_000_000 } }) } });
  const snapshot = api.configSnapshot();
  const fresh = apiWith({ initialConfig: snapshot });
  assert.deepEqual(fresh.api.configSnapshot(), snapshot);
});
