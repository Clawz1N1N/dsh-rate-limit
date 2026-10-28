/**
 * The two module surfaces the loader actually evaluates.
 *
 * The host half is checked against a minimal Cordis-shaped context: it must
 * activate, register its `llm/stream` listener and its routes, and dispose
 * everything it registered. The client half is checked by running it against the
 * page's module-loader contract, because a factory that throws on load blanks
 * the composer control with no host-side diagnostic at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { apply, Config, findOwnEntry, inject, name } from '../lib/index.js';
import { collect, settle, successChunks } from './helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A context that records registrations and can be disposed.
 *
 * @param {{ services?: Record<string, unknown>, withWebServer?: boolean, withConfigEditor?: boolean }} [options]
 */
function fakeHostContext(options = {}) {
  const services = new Map(Object.entries(options.services ?? {}));
  if (options.withWebServer === true) {
    services.set('webServer', {
      register: (route) => {
        registrations.routes.push(route);
        return () => {
          registrations.routes = registrations.routes.filter((entry) => entry !== route);
        };
      },
    });
  }
  if (options.withConfigEditor === true) {
    services.set('configEditor', {
      entries: () => options.entries ?? [{ options: { id: 'model-rate-limit', name: 'dsh-llm-model-rate-limit' } }],
      edit: async () => {},
    });
  }
  const registrations = {
    /** @type {Array<{ kind: string, path: string, handler: Function }>} */
    routes: [],
    /** @type {string[]} */
    events: [],
    /** @type {Record<string, Function[]>} */
    listeners: {},
    /** @type {string[]} */
    effects: [],
    /** @type {Array<Function>} */
    cleanups: [],
  };
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    get: (key) => services.get(key),
    effect: (callback, label) => {
      registrations.effects.push(String(label));
      const cleanup = callback();
      if (typeof cleanup === 'function') registrations.cleanups.push(cleanup);
      return () => {};
    },
    on: (event, listener) => {
      registrations.events.push(event);
      (registrations.listeners[event] ??= []).push(listener);
      return () => {
        registrations.listeners[event] = registrations.listeners[event].filter((entry) => entry !== listener);
      };
    },
    inject: (deps, callback) => {
      if (deps.every((dep) => services.has(dep))) {
        // A real Cordis child context resolves the injected services directly on
        // itself, so the callback sees `webCtx.webServer`, not `webCtx.get(...)`.
        const child = {
          ...ctx,
          effect: ctx.effect,
          get: ctx.get,
        };
        for (const dep of deps) child[dep] = services.get(dep);
        callback(child);
      }
      return () => {};
    },
  };
  const disposeAll = async () => {
    for (const cleanup of registrations.cleanups.reverse()) await cleanup();
  };
  return { ctx, registrations, disposeAll };
}

const defaultConfig = Config({});

test('the host half declares the services and the name it needs', () => {
  assert.equal(name, 'model-rate-limit');
  assert.deepEqual(inject, ['llm']);
});

test('the config schema accepts an empty config and applies defaults', () => {
  assert.deepEqual(defaultConfig.models, {});
  assert.equal(defaultConfig.reservedOutputTokens, 8192);
  assert.equal(defaultConfig.retry.maxAttempts, 6);
  assert.equal(defaultConfig.persistence.enabled, true);
});

test('the config schema speaks the Standard Schema protocol Cordis validates through', () => {
  const standard = Config['~standard'];
  assert.equal(standard.version, 1);
  const ok = standard.validate({ models: { 'p/m': { requests: { perMinute: '30' } } } });
  assert.equal(ok.issues, undefined);
  assert.deepEqual(ok.value.models, { 'p/m': { requests: { perMinute: '30' } } });
  assert.equal(ok.value.wakeMarginMs, 80, 'defaults are applied by the protocol entry point');
  const bad = standard.validate({ wakeMarginMs: 'soon' });
  assert.equal(bad.value, undefined);
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0].message, /expected a number/);
});

test('the config schema accepts the documented per-model shape', () => {
  const parsed = Config({
    models: {
      'deepseek-account/deepseek-flash': {
        requests: { perSecond: 0, perMinute: 30, perHour: 0, perDay: 0 },
        tokens: { perMinute: '500k' },
      },
    },
  });
  assert.equal(parsed.models['deepseek-account/deepseek-flash'].requests.perMinute, 30);
  assert.equal(parsed.models['deepseek-account/deepseek-flash'].tokens.perMinute, '500k');
});

test('activating without a web server still registers stream admission', () => {
  const { ctx, registrations } = fakeHostContext({ services: { tokenMeter: { estimateMessage: () => 3 } } });
  apply(ctx, defaultConfig);
  assert.deepEqual(registrations.events, ['llm/stream']);
  assert.deepEqual(registrations.routes, []);
  assert.ok(registrations.effects.some((label) => label.includes('llm stream admission')));
});

test('activating with a web server registers exactly one prefix route', () => {
  const { ctx, registrations, disposeAll } = fakeHostContext({ withWebServer: true });
  apply(ctx, defaultConfig);
  assert.equal(registrations.routes.length, 1);
  assert.equal(registrations.routes[0].kind, 'prefix');
  assert.equal(registrations.routes[0].path, '/model-rate-limit');
  assert.equal(typeof registrations.routes[0].handler, 'function');
  void disposeAll();
});

test('the registered route answers a state read', async () => {
  const { ctx, registrations } = fakeHostContext({ withWebServer: true });
  apply(ctx, Config({ models: { 'p/m': { requests: { perMinute: 3 } } } }));
  const handler = registrations.routes[0].handler;
  /** @type {Record<string, unknown>} */
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    end(chunk) {
      this.body += chunk ?? '';
    },
  };
  await handler({ method: 'GET', url: '/model-rate-limit/state' }, response);
  assert.equal(response.statusCode, 200);
  const document = JSON.parse(String(response.body));
  assert.equal(document.models.length, 1);
  assert.equal(document.models[0].policy.requests.perMinute, 3);
});

test('disposal releases every registration it made', async () => {
  const { ctx, registrations, disposeAll } = fakeHostContext({ withWebServer: true });
  apply(ctx, defaultConfig);
  assert.equal(registrations.routes.length, 1);
  await disposeAll();
  // The route disposer is owned by the injected child effect; the plugin's own
  // teardown effect must at minimum run without throwing.
  assert.ok(registrations.cleanups.length >= 2);
});

test('findOwnEntry refuses an ambiguous profile row', () => {
  const unique = { entries: () => [{ options: { id: 'model-rate-limit' } }] };
  assert.equal(findOwnEntry(unique)?.options.id, 'model-rate-limit');
  const none = { entries: () => [{ options: { id: 'something-else' } }] };
  assert.equal(findOwnEntry(none), undefined);
  const ambiguous = {
    entries: () => [
      { options: { id: 'model-rate-limit' } },
      { options: { name: 'model-rate-limit' } },
    ],
  };
  assert.equal(findOwnEntry(ambiguous), undefined, 'an ambiguous row is reported instead of guessed');
});

test('the client bundle registers its factory under the package name', async () => {
  const source = await readFile(join(ROOT, 'client', 'client.js'), 'utf8');
  /** @type {any} */
  let registration;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  };
  const globalScope = globalThis;
  globalScope.window = {
    __ModuleLoader__: {
      load: (entry) => {
        registration = entry;
      },
    },
  };
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', source)(globalScope.window);
  } finally {
    delete globalScope.window;
  }
  assert.equal(registration.id, 'dsh-llm-model-rate-limit', 'the id must equal the package name');

  const surface = registration.factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  });
  assert.ok(surface.inject.includes('slots'));
  assert.ok(surface.inject.includes('locale'));

  /** @type {Array<{ spec: Record<string, unknown>, component: Function }>} */
  const registered = [];
  const styles = [];
  const ctx = {
    get: (key) => (key === 'styles' ? { insert: (css) => { styles.push(css); return () => {}; } } : undefined),
    effect: (callback) => {
      callback();
      return () => {};
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
      getLocale: () => ({ id: 'uk' }),
    },
    slots: {
      inject: (key, callback) => {
        callback();
        return () => {};
      },
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
  };
  surface.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].spec.name, 'conversation.input.right');
  assert.equal(registered[0].spec.id, 'model-rate-limit');
  assert.equal(typeof registered[0].component, 'function');
  assert.equal(styles.length, 1, 'the control registers its stylesheet once');
  assert.match(styles[0], /\.mrl-trigger/);
  // The composer renders this seat without a Session too (the no-session inert
  // state), so the component must return something rather than throw.
  const withoutSession = registered[0].component({ sessionId: undefined });
  assert.ok(withoutSession !== undefined && withoutSession !== null, 'the control renders without a session');
  const withSession = registered[0].component({ sessionId: 'session-1' });
  assert.ok(withSession !== undefined && withSession !== null, 'the control renders with a session');
});

/**
 * Collect every element a rendered tree contains.
 * @param {any} node
 * @param {any[]} [out]
 * @returns {any[]}
 */
function elements(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children ?? []) elements(child, out);
  return out;
}

/**
 * Load the client bundle and register its component against a stub context.
 *
 * `useState` here is real enough to be driven: the returned setter records the
 * value, so a test can render the collapsed control, invoke the trigger's click,
 * and render again with the popup open.
 */
async function loadClientControl() {
  const source = await readFile(join(ROOT, 'client', 'client.js'), 'utf8');
  /** @type {any} */
  let registration;
  // State and refs are keyed by call order and allocated once, so a value set
  // by an asynchronous callback (the state fetch) survives a later render the
  // way it does under real React, and effects run on mount like real React.
  /** @type {any[]} */
  const stateSlots = [];
  /** @type {Array<{ current: unknown }>} */
  const refSlots = [];
  let nextSlot = 0;
  let refSlot = 0;
  /** @type {Array<Function>} */
  const effects = [];
  /** @type {Array<Function>} */
  const cleanups = [];
  let mounted = false;
  // Slot allocation must restart for every render, the way React re-runs the
  // component body and matches each hook by call order. Without this the second
  // render would allocate brand new slots and never see the fetched state.
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = nextSlot;
      nextSlot += 1;
      if (!(index in stateSlots)) {
        stateSlots[index] = typeof initial === 'function' ? initial() : initial;
      }
      return [stateSlots[index], (next) => {
        stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
      }];
    },
    useEffect: (callback) => {
      if (mounted) return;
      effects.push(callback);
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    useRef: (value) => {
      const index = refSlot;
      refSlot += 1;
      if (!(index in refSlots)) refSlots[index] = { current: value };
      return refSlots[index];
    },
  };
  const previousWindow = globalThis.window;
  // The control registers window listeners for Escape and outside-click, so the
  // harness needs a window that accepts them.
  const windowStub = {
    __ModuleLoader__: { load: (entry) => { registration = entry; } },
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  };
  globalThis.window = windowStub;
  try {
    new Function('window', source)(windowStub);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  const surface = registration.factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  });
  /** @type {Array<{ spec: Record<string, unknown>, component: Function }>} */
  const registered = [];
  /** @type {string[]} */
  const styles = [];
  const ctx = {
    get: (key) => (key === 'styles' ? { insert: (css) => { styles.push(css); return () => {}; } } : undefined),
    effect: (callback) => {
      callback();
      return () => {};
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
      getLocale: () => ({ id: 'uk' }),
    },
    slots: {
      inject: (key, callback) => {
        callback();
        return () => {};
      },
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
  };
  surface.apply(ctx);
  /** @type {any[]} */
  const stateLog = [];
  /**
   * Render the control as a re-render would: hook slots restart from the top and
   * effects do not re-run, so state written between renders is visible.
   *
   * Effects run on the first render, which installs the control's timers, so the
   * returned handle also exposes `dispose` to release them.
   */
  const render = (componentProps) => {
    nextSlot = 0;
    refSlot = 0;
    // Render the control itself, not the slot wrapper: the wrapper supplies its
    // own props (session id, model readers) and would mask the ones under test.
    return surface.ModelRateLimitControl(componentProps);
  };
  return {
    registered,
    styles,
    surface,
    render,
    stateSlots,
    stateLog,
    /** Effects observed, read live because the count grows per mount. */
    get effectsRun() {
      return effects.length;
    },
    /**
     * Let the state fetch settle.
     *
     * The fetch resolves through several promise turns, so microtask draining
     * alone is not enough; a short real delay gives the chain a chance to
     * complete, and the short timeout stays well inside the test budget.
     */
    async flush() {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Release every effect disposer, as unmounting would. */
    dispose() {
      for (const cleanup of cleanups.reverse()) cleanup();
      cleanups.length = 0;
    },
    /** Mark the component mounted so later renders do not re-run effects. */
    sealMount() {
      mounted = true;
    },
  };
}
test('the limit fields are editable and active even before any limit exists', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  const { render } = live;
  t.after(() => live.dispose());
  assert.equal(typeof live.surface.ModelRateLimitControl, 'function', 'the bundle exposes its control component');
  /** @type {Array<{ url: string, init?: RequestInit }>} */
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    requests.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/state')
        ? { version: 1, models: [], warnings: [] }
        : { ok: true, model: { key: 'unorouter/kimi-k3:free' }, adjustments: [] }),
    };
  });
  try {
    const props = {
      sessionId: 'session-1',
      t: (key) => key,
      locale: 'uk',
      currentModel: () => ({ provider: 'unorouter', model: 'kimi-k3:free' }),
      availableModels: () => [{ provider: 'unorouter', model: 'kimi-k3:free' }],
    };

    // 1. Collapsed: a trigger and no menu.
    const collapsed = render(props);
    const trigger = elements(collapsed).find((node) => node?.props?.className === 'mrl-trigger');
    assert.ok(trigger !== undefined, 'the control renders its trigger');
    assert.equal(elements(collapsed).some((node) => node?.props?.className === 'mrl-menu'), false);

    // 2. Open the menu the way the user does, then render the open state.
    trigger.props.onClick();
    const opened = render(props);
    const menu = elements(opened).find((node) => node?.props?.className === 'mrl-menu');
    assert.ok(menu !== undefined, 'the menu renders when open');

    // 3. Expand both sections with their + toggles, the way the user does, so the
    //    four window fields of each kind become visible.
    for (const section of elements(opened).filter((node) => node?.props?.className === 'mrl-section-head')) {
      section.props.onClick();
    }
    const expanded = render(props);
    const inputs = elements(expanded).filter((node) => node?.props?.className === 'mrl-input');
    assert.equal(inputs.length, 8, 'four request windows and four token windows');
    for (const input of inputs) {
      assert.notEqual(input.props.disabled, true, 'a field with no policy yet is still editable');
      assert.equal(input.props.type, 'text');
      assert.equal(typeof input.props.onChange, 'function');
      assert.equal(typeof input.props.onBlur, 'function');
    }
    // The placeholder comes from the product's own `unlimitedWord(locale)`, so
    // this checks that every field shows the same non-empty localized word
    // without duplicating Cyrillic text in the test.
    const placeholders = new Set(inputs.map((input) => input.props.placeholder));
    assert.equal(placeholders.size, 1, 'every field shows the same unlimited word');
    const word = placeholders.values().next().value;
    assert.equal(typeof word, 'string', 'the placeholder is a string');
    assert.ok(word.length > 0, 'the placeholder is not empty');

    // 4. Committing a value posts it to the plugin's own route.
    await inputs[0].props.onBlur({ target: { value: '30' } });
    const post = requests.find((request) => request.url.endsWith('/limit'));
    assert.ok(post !== undefined, 'the commit posts the new value');
    const sent = JSON.parse(String(post.init?.body));
    assert.equal(sent.value, 30);
    assert.equal(sent.model, 'unorouter/kimi-k3:free');
    assert.equal(sent.kind, 'requests');
    assert.equal(sent.window, 'perSecond');

    // 5. An invalid value is refused locally, without a request.
    const postsBefore = requests.filter((request) => request.url.endsWith('/limit')).length;
    await inputs[1].props.onBlur({ target: { value: '-5' } });
    assert.equal(
      requests.filter((request) => request.url.endsWith('/limit')).length,
      postsBefore,
      'a negative value never reaches the host',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a session model that cannot be resolved still leaves the fields usable', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  const { render } = live;
  t.after(() => live.dispose());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/state')
      ? { version: 1, models: [], warnings: [] }
      : { ok: true, model: { key: 'unorouter/kimi-k3:free' }, adjustments: [] }),
  }));
  try {
    // The projection read failed (an addressed session, or a store shape this
    // plugin cannot see), but the catalog knows a model.
    const opened = render({
      sessionId: 'session-1',
      initialOpen: true,
      t: (key) => key,
      locale: 'uk',
      currentModel: () => undefined,
      availableModels: () => [{ provider: 'unorouter', model: 'kimi-k3:free' }],
    });
    const inputs = elements(opened).filter((node) => node?.props?.className === 'mrl-input');
    assert.equal(inputs.length, 8);
    for (const input of inputs) {
      assert.notEqual(input.props.disabled, true, 'the first catalog model is used instead of a dead end');
    }
    // The picker now shows display names, not raw ids.
    const headModel = elements(opened).find((node) => node?.props?.className === 'mrl-head-model');
    assert.equal(
      headModel?.children?.[0],
      'kimi-k3:free',
      'the header shows the model name being edited',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model-selection values from every projection shape resolve to one key', async () => {
  const { surface } = await loadClientControl();
  const { selectionOf } = surface;
  const expected = { provider: 'deepseek-account', model: 'deepseek-flash' };
  // The durable projection view.
  assert.deepEqual(selectionOf({ lastUsed: null, next: expected }), expected);
  // A session that has only ever used one model.
  assert.deepEqual(selectionOf({ lastUsed: expected, next: null }), expected);
  // A pending intent under its own name.
  assert.deepEqual(selectionOf({ pending: expected }), expected);
  // A bare selection.
  assert.deepEqual(selectionOf(expected), expected);
  // Nothing usable.
  assert.equal(selectionOf(undefined), undefined);
  assert.equal(selectionOf(null), undefined);
  assert.equal(selectionOf({ lastUsed: null, next: null }), undefined);
  assert.equal(selectionOf({ lastUsed: { provider: '', model: 'x' }, next: null }), undefined);
  assert.equal(selectionOf({ lastUsed: { provider: 'p' }, next: null }), undefined);
});

test('an input selects all of its text on focus, so a keystroke replaces it', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  const { render } = live;
  t.after(() => live.dispose());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: 1, models: [], warnings: [] }),
  }));
  try {
    const opened = render({
      sessionId: 's1',
      initialOpen: true,
      t: (k) => k,
      locale: 'uk',
      currentModel: () => ({ provider: 'p', model: 'm' }),
      availableModels: () => [{ provider: 'p', model: 'm' }],
    });
    const inputs = elements(opened).filter((node) => node?.props?.className === 'mrl-input');
    assert.equal(inputs.length, 8);
    for (const input of inputs) {
      assert.equal(typeof input.props.onFocus, 'function', 'every input has an onFocus handler');
      let selected = false;
      input.props.onFocus({ target: { select: () => { selected = true; } } });
      assert.equal(selected, true, 'onFocus selects all text so the first keystroke replaces it');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the model picker shows display names, not raw ids', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  const { render } = live;
  t.after(() => live.dispose());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: 1,
      models: [],
      warnings: [],
    }),
  }));
  try {
    const opened = render({
      sessionId: 's1',
      initialOpen: true,
      t: (k) => k,
      locale: 'uk',
      currentModel: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
      availableModels: () => [{
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        providerName: 'DeepSeek Account',
        modelName: 'DeepSeek-Flash',
      }],
    });
    const headModel = elements(opened).find((node) => node?.props?.className === 'mrl-head-model');
    assert.equal(headModel?.children?.[0], 'DeepSeek-Flash', 'the header shows the display name, not the raw id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a collapsed control still loads state so its toolbar timers can appear', { timeout: 20_000 }, async () => {
  /** @type {Array<string>} */
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        warnings: [],
        models: [{
          key: 'p/m',
          provider: 'p',
          model: 'm',
          policy: { requests: { perMinute: 1 }, tokens: {} },
          // The state document always reports all four windows per kind, so the
          // fixture mirrors the real API shape rather than a partial object.
          usage: {
            requests: {
              perSecond: { limit: 0, used: 1 },
              perMinute: { limit: 1, used: 1 },
              perHour: { limit: 0, used: 1 },
              perDay: { limit: 0, used: 1 },
            },
            tokens: {
              perSecond: { limit: 0, used: 0 },
              perMinute: { limit: 0, used: 0 },
              perHour: { limit: 0, used: 0 },
              perDay: { limit: 0, used: 0 },
            },
          },
          queueDepth: 1,
          cooldownMs: 0,
          requestsResumeMs: 42_000,
          tokensResumeMs: 0,
        }],
      }),
    };
  });
  /** @type {{ dispose: () => void, render: (props: unknown) => any } | undefined} */
  let live;
  try {
    live = await loadClientControl();
    const { render } = live;
    const collapsed = render({
      sessionId: 's1',
      t: (key) => key,
      locale: 'uk',
      currentModel: () => ({ provider: 'p', model: 'm' }),
      availableModels: () => [],
    });
    assert.ok(
      elements(collapsed).some((node) => node?.props?.className === 'mrl-menu') === false,
      'the menu stays closed',
    );
    assert.ok(live.effectsRun > 0, 'effects ran while the control was collapsed');
    await live.flush();
    assert.ok(
      requested.some((url) => url.endsWith('/state')),
      'a collapsed control still reads the state document, which is what the toolbar timers render from',
    );
  } finally {
    live?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('a countdown counts down locally between server pushes', { timeout: 20_000 }, async () => {
  const { surface } = await loadClientControl();
  const { remainingMs, countdown } = surface;
  const receivedAt = 1_000_000;

  // Nothing to count down when the plugin reports no wait.
  assert.equal(remainingMs(0, receivedAt, receivedAt), 0);
  assert.equal(remainingMs(undefined, receivedAt, receivedAt), 0);
  assert.equal(remainingMs(Number.NaN, receivedAt, receivedAt), 0);

  // On arrival the countdown is exactly the plugin value.
  assert.equal(remainingMs(30_000, receivedAt, receivedAt), 30_000);
  assert.equal(countdown(remainingMs(30_000, receivedAt, receivedAt)), '00:30');

  // Ten seconds later with no further push it has counted down.
  assert.equal(remainingMs(30_000, receivedAt + 10_000, receivedAt), 20_000);
  assert.equal(countdown(remainingMs(30_000, receivedAt + 10_000, receivedAt)), '00:20');

  // It reaches zero rather than going negative.
  assert.equal(remainingMs(30_000, receivedAt + 30_000, receivedAt), 0);
  assert.equal(remainingMs(30_000, receivedAt + 99_000, receivedAt), 0);

  // A clock correction that moves time backwards never inflates the countdown.
  assert.equal(remainingMs(30_000, receivedAt - 5_000, receivedAt), 30_000);

  // A missing arrival time degrades to the plugin value, not to a wrong one.
  assert.equal(remainingMs(30_000, receivedAt, undefined), 30_000);

  // Hours grow the string, so a long day-window wait stays readable.
  // 3 h + 1 min + 1 s is 10 861 seconds.
  assert.equal(countdown((3 * 3600_000) + (60_000) + 1_000), '3:01:01');
  assert.equal(countdown(59 * 60_000), '59:00');
  assert.equal(countdown(24 * 3600_000), '24:00:00');
});

test('both client dictionaries cover every key the control composes', async () => {
  const source = await readFile(join(ROOT, 'client', 'client.js'), 'utf8');

  // Load the bundle and read the two dictionaries straight out of it, so the
  // check is against the shipped values rather than a textual approximation.
  let registration;
  const React = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  };
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
  try {
    new Function('window', source)(globalThis.window);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  const surface = registration.factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  });

  // Keys the component builds by composition rather than by literal.
  const windowKeys = ['perSecond', 'perMinute', 'perHour', 'perDay'];
  const kindKeys = ['requests', 'tokens'];
  const errorKeys = ['negative', 'notWhole', 'tooLarge', 'notPersisted'];
  const composed = [];
  for (const kind of kindKeys) {
    composed.push(`section.${kind}`);
    composed.push(`window.short.${windowKeys[0]}`);
  }
  for (const windowKey of windowKeys) {
    composed.push(`window.${windowKey}`);
    composed.push(`window.short.${windowKey}`);
  }
  for (const error of errorKeys) composed.push(`error.${error}`);

  // Read the dictionaries by evaluating them out of the factory source.
  const dictionaries = {};
  for (const locale of ['en', 'uk']) {
    const start = source.indexOf(`var ${locale.toUpperCase()} = {`);
    assert.ok(start > 0, `the ${locale} dictionary is declared`);
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = source.slice(open, end + 1);
    dictionaries[locale] = new Function(`return ${body}`)();
  }

  for (const key of composed) {
    assert.ok(key in dictionaries.en, `the English dictionary defines "${key}"`);
    assert.ok(key in dictionaries.uk, `the Ukrainian dictionary defines "${key}"`);
  }

  // Every language must define exactly the same key set, so no language can
  // silently fall back to a raw key at runtime.
  const enKeys = Object.keys(dictionaries.en).sort();
  const ukKeys = Object.keys(dictionaries.uk).sort();
  assert.deepEqual(ukKeys, enKeys, 'both dictionaries define the same keys');

  // The keys the control reads statically are covered by that same check.
  for (const key of ['trigger.title', 'menu.title', 'menu.foot', 'timer.requests', 'timer.tokens', 'summary.unlimited']) {
    assert.ok(key in dictionaries.en, `"${key}" is defined in English`);
    assert.ok(key in dictionaries.uk, `"${key}" is defined in Ukrainian`);
  }
  assert.equal(dictionaries.en['error.notWhole'], 'Enter a whole number (k/m suffixes OK)');
  assert.equal(surface.inject.includes('slots'), true);
});

// ── P1-5: the notice is the host's answer, never a client-side guess ────────

/**
 * Drive the control far enough to commit one field, and return the rendered tree.
 *
 * @param {any} live
 * @param {any} props
 * @param {string} value
 */
async function commitFirstField(live, props, value) {
  const trigger = elements(live.render(props)).find((node) => node?.props?.className === 'mrl-trigger');
  assert.ok(trigger !== undefined, 'the control renders its trigger');
  trigger.props.onClick();
  let tree = live.render(props);
  for (const section of elements(tree).filter((node) => node?.props?.className === 'mrl-section-head')) {
    section.props.onClick();
  }
  tree = live.render(props);
  const first = elements(tree).filter((node) => node?.props?.className === 'mrl-input')[0];
  first.props.onChange({ target: { value } });
  tree = live.render(props);
  const current = elements(tree).filter((node) => node?.props?.className === 'mrl-input')[0];
  await current.props.onBlur({ target: { value } });
  await settle(12);
  return live.render(props);
}

test('P1-5: a reply with no adjustments shows the neutral notice', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  t.after(() => live.dispose());
  /** @type {Array<Record<string, unknown>>} */
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    if (String(url).endsWith('/state')) {
      return { ok: true, status: 200, json: async () => ({ version: 1, models: [], warnings: [] }) };
    }
    posts.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, model: { key: 'p/m' }, adjustments: [] }),
    };
  });
  try {
    const props = {
      sessionId: 's',
      t: /** @type {any} */ ((key) => key),
      locale: 'en',
      currentModel: () => ({ provider: 'p', model: 'm' }),
      availableModels: () => [{ provider: 'p', model: 'm' }],
    };
    const tree = await commitFirstField(live, props, '30');
    assert.equal(posts.length, 1, 'exactly one write');
    assert.equal(posts[0].value, 30);
    const notice = elements(tree).find((node) => node?.props?.className === 'mrl-notice');
    assert.ok(notice !== undefined, 'a notice is shown');
    assert.equal(notice.children.join(''), 'notice.saved', 'no adjustment was invented');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P1-5: a reply that reports an adjustment is shown verbatim', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  t.after(() => live.dispose());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url) => {
    if (String(url).endsWith('/state')) {
      return { ok: true, status: 200, json: async () => ({ version: 1, models: [], warnings: [] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        model: { key: 'p/m' },
        adjustments: [{ kind: 'requests', window: 'perMinute', from: 1, to: 5 }],
      }),
    };
  });
  try {
    const props = {
      sessionId: 's',
      t: /** @type {any} */ ((key) => key),
      locale: 'en',
      currentModel: () => ({ provider: 'p', model: 'm' }),
      availableModels: () => [{ provider: 'p', model: 'm' }],
    };
    const tree = await commitFirstField(live, props, '5');
    const notice = elements(tree).find((node) => node?.props?.className === 'mrl-notice');
    assert.equal(notice?.children.join(''), 'notice.raised', 'the host raised a window, and the notice says so');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P1-5: a lowering adjustment is not reported as a raise', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  t.after(() => live.dispose());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url) => {
    if (String(url).endsWith('/state')) {
      return { ok: true, status: 200, json: async () => ({ version: 1, models: [], warnings: [] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        model: { key: 'p/m' },
        adjustments: [{ kind: 'requests', window: 'perSecond', from: 10, to: 3 }],
      }),
    };
  });
  try {
    const props = {
      sessionId: 's',
      t: /** @type {any} */ ((key) => key),
      locale: 'en',
      currentModel: () => ({ provider: 'p', model: 'm' }),
      availableModels: () => [{ provider: 'p', model: 'm' }],
    };
    const tree = await commitFirstField(live, props, '3');
    const notice = elements(tree).find((node) => node?.props?.className === 'mrl-notice');
    assert.equal(notice?.children.join(''), 'notice.lowered', 'a cascaded decrease reads as a decrease');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── P2-4: a per-row used figure only where it belongs ───────────────────────

test('P2-4: only the tightest window row carries a used figure', { timeout: 20_000 }, async (t) => {
  const live = await loadClientControl();
  t.after(() => live.dispose());
  const row = {
    key: 'p/m',
    provider: 'p',
    model: 'm',
    limited: true,
    policy: {
      requests: { perSecond: 0, perMinute: 30, perHour: 0, perDay: 0 },
      tokens: { perSecond: 0, perMinute: 0, perHour: 0, perDay: 0 },
    },
    usage: {
      requests: {
        perSecond: { limit: 0, used: 0 },
        perMinute: { limit: 30, used: 7 },
        perHour: { limit: 0, used: 0 },
        perDay: { limit: 0, used: 0 },
      },
      tokens: {
        perSecond: { limit: 0, used: 0 },
        perMinute: { limit: 0, used: 0 },
        perHour: { limit: 0, used: 0 },
        perDay: { limit: 0, used: 0 },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: 1, models: [row], warnings: [] }),
  }));
  try {
    const props = {
      sessionId: 's',
      t: /** @type {any} */ ((key) => key),
      locale: 'en',
      currentModel: () => ({ provider: 'p', model: 'm' }),
      availableModels: () => [{ provider: 'p', model: 'm' }],
    };
    const trigger = elements(live.render(props)).find((node) => node?.props?.className === 'mrl-trigger');
    // The state read is a real async fetch, so let it land before asserting.
    await settle(12);
    trigger.props.onClick();
    let tree = live.render(props);
    for (const section of elements(tree).filter((node) => node?.props?.className === 'mrl-section-head')) {
      section.props.onClick();
    }
    tree = live.render(props);
    const used = elements(tree)
      .filter((node) => node?.props?.className === 'mrl-row-used')
      .map((node) => node.children.join(''));
    // Four request rows and four token rows; only the per-minute request row has
    // a live figure, because that is the tightest bounded window of that kind.
    assert.equal(used.length, 8);
    assert.equal(used[1], '7', 'the tightest window row shows its own used figure');
    assert.deepEqual([used[0], used[2], used[3]].filter((value) => value !== ''), [], 'no repetition');
    assert.deepEqual(used.slice(4), ['', '', '', ''], 'an unlimited kind shows nothing');

    // The section header keeps the compact used/limit indicator.
    const summary = elements(tree)
      .filter((node) => node?.props?.className === 'mrl-section-summary')
      .map((node) => node.children)
      .flat()
      .join('');
    assert.match(summary, /7\/30/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── P2-8: the state file is only rewritten when the counters moved ─────────

test('P2-8: an unchanged counter set is not rewritten by the flush loop', async () => {
  const previousProfile = process.env.DSH_PROFILE_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'mrl-flush-'));
  process.env.DSH_PROFILE_DIR = dir;
  const { ctx, registrations, disposeAll } = fakeHostContext({ withWebServer: true });
  try {
    apply(ctx, Config({
      models: { 'p/m': { requests: { perMinute: 3000 }, tokens: { perMinute: 2_000_000 } } },
      // The floor is 250 ms, so this is the fastest the loop can run.
      persistence: { flushIntervalMs: 250 },
    }));
    const statePath = join(dir, '.dsh', 'model-rate-limit', 'state.json');

    // Charge the model through the plugin's own stream listener, so the file has
    // something to carry rather than an empty row set.
    const listener = registrations.listeners['llm/stream'][0];
    const chunks = successChunks({ usage: { inputTokens: 120, outputTokens: 30 } });
    await collect(listener({ provider: 'p', model: 'm' }, () => (async function* () {
      for (const chunk of chunks) yield chunk;
    })()));

    // The first flush writes the document.
    await delay(500);
    const first = await stat(statePath);
    const document = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(document.anchor && typeof document.anchor.mono === 'number');
    assert.deepEqual(Object.keys(document.models), ['p/m'], 'the charged model has a row set');
    assert.ok(document.models['p/m'].length > 0, 'the charged buckets were persisted');

    // Nothing has been charged since, so two more cycles must not touch it.
    await delay(700);
    const second = await stat(statePath);
    assert.equal(second.mtimeMs, first.mtimeMs, 'an unchanged counter set is not rewritten');
    assert.equal(second.size, first.size);
  } finally {
    await disposeAll();
    process.env.DSH_PROFILE_DIR = previousProfile;
  }
});

