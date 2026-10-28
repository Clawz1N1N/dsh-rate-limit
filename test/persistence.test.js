/**
 * Persistence: the versioned state file, its migrations, and the clock jumps a
 * long-running desktop session actually produces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { STATE_VERSION, WINDOW_MS } from '../lib/constants.js';
import { FakeClock } from '../lib/clock.js';
import { loadState, migrate, saveState, resolveStateDir, statePathIn } from '../lib/store.js';
import { harness, policy } from './helpers.js';

/** @returns {Promise<string>} a fresh temporary directory. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'mrl-store-'));
}

test('a saved state round-trips through the file', async () => {
  const dir = await scratch();
  const path = statePathIn(dir);
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 5 } }));
  await limiter.admit({ provider: 'p', model: 'm' }, 0);
  await saveState(path, /** @type {any} */ (limiter.exportState()));

  const loaded = await loadState(path);
  assert.equal(loaded.reason, undefined);
  assert.equal(loaded.state?.version, STATE_VERSION);
  assert.deepEqual(Object.keys(loaded.state?.models ?? {}), ['p/m']);
  const text = await readFile(path, 'utf8');
  assert.ok(text.endsWith('\n'), 'the file is newline terminated');
});

test('the write is atomic: no temporary file survives it', async () => {
  const dir = await scratch();
  const path = statePathIn(dir);
  await saveState(path, { version: STATE_VERSION, savedWall: 1, anchor: { mono: 1, wall: 1 }, models: {} });
  await saveState(path, { version: STATE_VERSION, savedWall: 2, anchor: { mono: 2, wall: 2 }, models: {} });
  const entries = await readdir(dir);
  assert.deepEqual(entries, ['state.json'], 'only the state file remains');
  const loaded = await loadState(path);
  assert.equal(loaded.state?.savedWall, 2, 'the second write replaced the first');
});

test('a missing file is not an error', async () => {
  const dir = await scratch();
  const loaded = await loadState(statePathIn(dir));
  assert.equal(loaded.state, undefined);
  assert.equal(loaded.reason, undefined);
});

test('a damaged file is refused with a reason instead of throwing', async () => {
  const dir = await scratch();
  const path = statePathIn(dir);
  await writeFile(path, '{not json', 'utf8');
  const loaded = await loadState(path);
  assert.equal(loaded.state, undefined);
  assert.match(String(loaded.reason), /not valid JSON/);
});

test('an unversioned document migrates to the current schema', () => {
  const result = migrate({
    anchor: { mono: 10, wall: 1_000 },
    models: { 'p/m': [[1, 2, 3]] },
  }, STATE_VERSION);
  assert.equal(result.reason, undefined);
  assert.equal(result.state?.version, STATE_VERSION);
  assert.deepEqual(result.state?.models['p/m'], [[1, 2, 3]]);
  assert.deepEqual(result.state?.anchor, { mono: 10, wall: 1_000 });
});

test('a document from a newer schema is refused, not guessed at', () => {
  const result = migrate({ version: STATE_VERSION + 5, anchor: { mono: 1, wall: 1 }, models: {} }, STATE_VERSION);
  assert.equal(result.state, undefined);
  assert.match(String(result.reason), /newer plugin version/);
});

test('a document without an anchor or counters is refused', () => {
  assert.match(String(migrate({ version: 1, models: {} }, 1).reason), /anchor/);
  assert.match(String(migrate({ version: 1, anchor: { mono: 1, wall: 1 } }, 1).reason), /no model counters/);
  assert.match(String(migrate({ version: 1, anchor: { wall: 1 }, models: {} }, 1).reason), /monotonic/);
  assert.match(String(migrate('nonsense', 1).reason), /no document/);
});

test('the state directory follows the active profile', () => {
  assert.equal(
    resolveStateDir({ profileDir: 'C:/profiles/web', home: 'C:/home' }),
    'C:\\profiles\\web\\.dsh\\model-rate-limit'.replace(/\//g, '\\'),
  );
  assert.match(resolveStateDir({ home: 'C:/home' }), /profiles/);
  assert.equal(statePathIn('C:/x'), join('C:/x', 'state.json'));
});

test('the suite never resolves counters into a live profile', () => {
  // `node --test` is often started from inside a running harness session, which
  // exports DSH_PROFILE_DIR as the real profile. `test/helpers.js` redirects it
  // to a scratch directory at import time; if that ever stops happening, a test
  // that boots the plugin and flushes would overwrite the application's counter
  // file. Assert the redirect is in force, on the environment the plugin reads.
  const resolved = resolveStateDir({ profileDir: process.env.DSH_PROFILE_DIR, home: homedir() });
  assert.match(resolved, /dsh-mrl-suite-/, 'the suite must not point at a live profile directory');
});

test('a restart translates persisted counters into the new clock domain', async () => {
  // Process one: wall 1 700 000 000 000, monotonically 1 000.
  const first = harness({ clock: new FakeClock(1_700_000_000_000, 1_000) });
  first.limiter.updatePolicy('p/m', policy({ requests: { perMinute: 10 } }));
  await first.limiter.admit({ provider: 'p', model: 'm' }, 0);
  const exported = /** @type {any} */ (first.limiter.exportState());

  // Process two: the same wall clock thirty seconds later, but a monotonic
  // origin that has nothing to do with the first one. The counter is still
  // inside the minute window, so it must survive rather than be dropped.
  const second = harness({ clock: new FakeClock(1_700_000_030_000, 500_000) });
  second.limiter.updatePolicy('p/m', policy({ requests: { perMinute: 10 } }));
  const restored = second.limiter.importState(exported);
  assert.equal(restored.restored, 1);

  const status = second.limiter.describe('p', 'm');
  assert.equal(status.usage.requests.perMinute.used, 1, 'thirty seconds old is inside the minute window');
  assert.equal(status.usage.requests.perHour.used, 1, 'and inside the hour window');
  assert.equal(status.usage.requests.perDay.used, 1, 'and inside the day window');
  assert.equal(status.lastRequestAgoMs, 30_000, 'the interval is measured from the wall-clock gap');
});

test('a counter that aged out of every window is dropped on load', async () => {
  const first = harness({ clock: new FakeClock(1_700_000_000_000, 1_000) });
  first.limiter.updatePolicy('p/m', policy({ requests: { perHour: 10 } }));
  await first.limiter.admit({ provider: 'p', model: 'm' }, 0);
  const exported = /** @type {any} */ (first.limiter.exportState());

  // Two hours later the counter is outside every window it was charged to.
  const second = harness({ clock: new FakeClock(1_700_000_000_000 + 2 * WINDOW_MS.perHour, 400_000) });
  second.limiter.updatePolicy('p/m', policy({ requests: { perHour: 10 } }));
  const restored = second.limiter.importState(exported);
  assert.equal(restored.restored, 0);
  assert.equal(second.limiter.describe('p', 'm').usage.requests.perHour.used, 0);
});

test('a laptop that slept for a day does not resurrect stale counters', async () => {
  const first = harness({ clock: new FakeClock(1_700_000_000_000, 1_000) });
  first.limiter.updatePolicy('p/m', policy({ requests: { perDay: 5 } }));
  await first.limiter.admit({ provider: 'p', model: 'm' }, 0);
  const exported = /** @type {any} */ (first.limiter.exportState());

  // The process was suspended: the wall clock moved three days, monotonic time
  // barely moved at all.
  const second = harness({ clock: new FakeClock(1_700_000_000_000 + WINDOW_MS.perDay * 3, 30_000) });
  second.limiter.updatePolicy('p/m', policy({ requests: { perDay: 5 } }));
  const restored = second.limiter.importState(exported);
  assert.equal(restored.restored, 0, 'every row was outside the longest window');
  assert.deepEqual(restored.dropped, ['p/m']);
  assert.equal(second.limiter.describe('p', 'm').usage.requests.perDay.used, 0);
});

test('importing a forward-dated file is harmless', async () => {
  const { limiter } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perMinute: 1 } }));
  const restored = limiter.importState({
    anchor: { mono: 0, wall: 0 },
    savedWall: 1_000_000,
    models: { 'p/m': [[100_000, 5, 5]] },
  });
  assert.equal(restored.restored, 0, 'a future row is refused');
  assert.equal(limiter.describe('p', 'm').usage.requests.perMinute.used, 0);
});

test('a policy loaded from configuration repairs a non-decreasing violation', () => {
  const { limiter, logs } = harness();
  const adjustments = limiter.setPolicies(new Map([
    ['p/m', policy({ requests: { perSecond: 10, perMinute: 1 }, tokens: { perHour: 5, perDay: 1 } })],
  ]));
  const repaired = limiter.policyOf('p/m');
  assert.equal(repaired.requests.perMinute, 10, 'the wider request window was raised');
  assert.equal(repaired.tokens.perDay, 5, 'the wider token window was raised');
  assert.equal(adjustments.get('p/m')?.length, 2);
  assert.equal(logs.length, 0, 'repairing a file is not an error');
});

test('setPolicies drops models that disappeared from configuration', () => {
  const { limiter } = harness();
  limiter.setPolicies(new Map([
    ['p/a', policy({ requests: { perMinute: 1 } })],
    ['p/b', policy({ requests: { perMinute: 1 } })],
  ]));
  assert.deepEqual(limiter.modelKeys(), ['p/a', 'p/b']);
  limiter.setPolicies(new Map([['p/b', policy({ requests: { perMinute: 2 } })]]));
  assert.deepEqual(limiter.modelKeys(), ['p/b']);
  assert.equal(limiter.limits('p', 'a'), false, 'a removed model becomes unlimited again');
});

test('two models keep independent persisted counters', async () => {
  const dir = await scratch();
  const path = statePathIn(dir);
  const { limiter } = harness();
  limiter.setPolicies(new Map([
    ['p/a', policy({ requests: { perMinute: 5 } })],
    ['p/b', policy({ requests: { perMinute: 5 } })],
  ]));
  await limiter.admit({ provider: 'p', model: 'a' }, 0);
  await limiter.admit({ provider: 'p', model: 'a' }, 0);
  await limiter.admit({ provider: 'p', model: 'b' }, 0);
  await saveState(path, /** @type {any} */ (limiter.exportState()));

  const loaded = await loadState(path);
  const fresh = harness();
  fresh.limiter.setPolicies(new Map([
    ['p/a', policy({ requests: { perMinute: 5 } })],
    ['p/b', policy({ requests: { perMinute: 5 } })],
  ]));
  fresh.limiter.importState(/** @type {any} */ (loaded.state));
  assert.equal(fresh.limiter.describe('p', 'a').usage.requests.perMinute.used, 2);
  assert.equal(fresh.limiter.describe('p', 'b').usage.requests.perMinute.used, 1);
});
