/**
 * Rolling-window semantics: the four boundaries, the exact moment an event
 * falls out, and clock jumps that must not lose or duplicate traffic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUCKET_COUNT, WINDOW_MS } from '../lib/constants.js';
import { ModelRateLimiter } from '../lib/limiter.js';
import { FakeClock } from '../lib/clock.js';
import { RollingWindows } from '../lib/windows.js';
import { harness, policy, settle } from './helpers.js';

/** Milliseconds since the monotonic epoch used by the fake clock. */
const T0 = 1_000;

test('an event counts in every window that still covers it', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  const now = T0 + 10;
  assert.equal(windows.countIn('perSecond', now), 1, 'still inside the second');
  assert.equal(windows.countIn('perMinute', now), 1);
  assert.equal(windows.countIn('perHour', now), 1);
  assert.equal(windows.countIn('perDay', now), 1);
});

test('an event leaves the second window exactly one second later', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  assert.equal(windows.countIn('perSecond', T0 + 999), 1, 'inside the window');
  assert.equal(windows.countIn('perSecond', T0 + 1_000), 0, 'the boundary is exclusive');
  assert.equal(windows.countIn('perMinute', T0 + 1_000), 1, 'the larger window still holds it');
});

test('an event leaves the minute window exactly one minute later', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  assert.equal(windows.countIn('perMinute', T0 + WINDOW_MS.perMinute - 1), 1);
  assert.equal(windows.countIn('perMinute', T0 + WINDOW_MS.perMinute), 0);
  assert.equal(windows.countIn('perHour', T0 + WINDOW_MS.perMinute), 1);
});

test('an event leaves the hour window exactly one hour later', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  assert.equal(windows.countIn('perHour', T0 + WINDOW_MS.perHour - 1), 1);
  assert.equal(windows.countIn('perHour', T0 + WINDOW_MS.perHour), 0);
  assert.equal(windows.countIn('perDay', T0 + WINDOW_MS.perHour), 1);
});

test('an event leaves the day window exactly one day later', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  assert.equal(windows.countIn('perDay', T0 + WINDOW_MS.perDay - 1), 1);
  assert.equal(windows.countIn('perDay', T0 + WINDOW_MS.perDay), 0);
});

test('token totals follow the same boundaries as request counts', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  windows.charge(T0, 500);
  assert.equal(windows.tokensIn('perSecond', T0 + 500), 500);
  assert.equal(windows.tokensIn('perSecond', T0 + 1_000), 0);
  assert.equal(windows.tokensIn('perMinute', T0 + 1_000), 500);
});

test('a negative charge the next second does not corrupt another window', () => {
  const windows = new RollingWindows();
  windows.charge(T0, 100);
  windows.charge(T0 + 1_000, -40);
  assert.equal(windows.tokensIn('perSecond', T0 + 1_000), -40, 'the correction lands in its own bucket');
  assert.equal(windows.tokensIn('perMinute', T0 + 1_000), 60, 'the minute total nets out');
});

test('a request need waits for room strictly below the limit', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  // One request is in the window. Another request may join while the projected
  // total would stay strictly below the limit; at the limit it waits for the
  // event to roll out of the window.
  assert.equal(windows.nextFreeAt('perMinute', T0 + 10, 3, 1, 'requests'), 0, 'room below the limit needs no wait');
  assert.equal(windows.nextFreeAt('perMinute', T0 + 10, 2, 1, 'requests'), 0, 'the last free slot needs no wait');
  assert.equal(
    windows.nextFreeAt('perMinute', T0 + 10, 1, 1, 'requests'),
    T0 + WINDOW_MS.perMinute,
    'a full window waits for the event to leave it',
  );
  assert.equal(
    windows.nextFreeAt('perSecond', T0 + 10, 1, 1, 'requests'),
    T0 + WINDOW_MS.perSecond,
    'the same rule applies to the shortest window',
  );
});

test('a need that reaches the limit waits for a completely empty window', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  windows.charge(T0, 100);
  assert.equal(windows.nextFreeAt('perMinute', T0 + 10, 100, 100, 'tokens'), T0 + WINDOW_MS.perMinute);
  assert.equal(windows.nextFreeAt('perSecond', T0 + 10, 1, 1, 'requests'), T0 + WINDOW_MS.perSecond);
});

test('a need larger than the whole window waits for that window to empty', () => {
  const windows = new RollingWindows();
  windows.charge(T0, 10);
  assert.equal(
    windows.nextFreeAt('perMinute', T0 + 1, 5, 50, 'tokens'),
    T0 + WINDOW_MS.perMinute,
    'an impossible need resolves to an empty window instead of hanging',
  );
});

test('a wide jump forward expires everything without a scan of history', () => {
  const windows = new RollingWindows();
  windows.record(T0);
  windows.charge(T0, 1_000);
  const far = T0 + WINDOW_MS.perDay * 3;
  assert.equal(windows.countIn('perDay', far), 0);
  assert.equal(windows.tokensIn('perDay', far), 0);
  assert.deepEqual(windows.exportState(far), []);
});

test('exportState writes at most one row per active second', () => {
  const windows = new RollingWindows();
  for (let i = 0; i < 5; i += 1) windows.record(T0);
  windows.record(T0 + 1_000);
  windows.charge(T0 + 1_000, 42);
  const rows = windows.exportState(T0 + 2_000);
  assert.deepEqual(rows, [[Math.floor(T0 / 1_000), 5, 0], [Math.floor(T0 / 1_000) + 1, 1, 42]]);
  assert.ok(rows.length <= BUCKET_COUNT);
});

test('importState drops rows older than the longest window and future rows', () => {
  const windows = new RollingWindows();
  const now = T0 + WINDOW_MS.perDay;
  const second = Math.floor(now / 1_000);
  const restored = windows.importState(now, [
    [second, 3, 30],
    [second - 1, 1, 10],
    [second - 200_000, 9, 90],
    [second + 5, 4, 40],
    ['nonsense', 1, 1],
    [second - 2, -1, 0],
  ]);
  assert.equal(restored, 2, 'only the two live rows are restored');
  assert.equal(windows.countIn('perMinute', now), 4);
  assert.equal(windows.tokensIn('perMinute', now), 40);
});

test('a restart restores counters through the clock anchor', async () => {
  const first = harness();
  first.limiter.updatePolicy('p/m', policy({ requests: { perMinute: 2 } }));
  await first.limiter.admit({ provider: 'p', model: 'm' }, 0);
  const dumped = first.limiter.exportState();

  // A new process: the wall clock moved on by 5 s, and monotonic time restarts.
  const wallLater = { ...dumped, savedWall: Number(dumped.savedWall) + 5_000 };
  const second = harness({ clock: new FakeClock(Number(dumped.savedWall) + 5_000, 50_000) });
  second.limiter.updatePolicy('p/m', policy({ requests: { perMinute: 2 } }));
  const restored = second.limiter.importState(/** @type {any} */ (wallLater));
  assert.equal(restored.restored, 1, 'the counter survived the restart');
  const status = second.limiter.describe('p', 'm');
  assert.equal(status.usage.requests.perMinute.used, 1);
  assert.equal(status.lastRequestAgoMs, 5_000, 'the interval is measured from the wall-clock gap');
});

test('a limiter with no policy records nothing at all', async () => {
  const { limiter } = harness();
  const decision = await limiter.admit({ provider: 'p', model: 'm' }, 1_000);
  assert.equal(decision.admitted, true);
  assert.equal(decision.lease, undefined, 'the unlimited fast path allocates no lease');
  assert.equal(limiter.describe('p', 'm').usage.requests.perMinute.used, 0);
});

test('the fast path does not observe a clock or touch a window', async () => {
  let reads = 0;
  const clock = new FakeClock();
  const limiter = new ModelRateLimiter({
    clock: { mono: () => { reads += 1; return clock.mono(); }, wall: () => clock.wall() },
    wakeMarginMs: 1,
    wakeJitterMs: 0,
  });
  const afterConstruction = reads;
  await limiter.admit({ provider: 'p', model: 'm' }, 9_999);
  assert.equal(reads - afterConstruction, 0, 'an unlimited model costs one map lookup and nothing else');
});

test('a wall-clock jump backward cannot wedge a window', async () => {
  const { limiter, clock, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perSecond: 1 } }));
  const first = await limiter.admit({ provider: 'p', model: 'm' }, 0);
  assert.equal(first.admitted, true);

  // NTP correction far into the past: the limiter keeps using monotonic time,
  // so the window still rolls forward normally.
  clock.shiftWall(-WINDOW_MS.perDay);
  const waiting = limiter.admit({ provider: 'p', model: 'm' }, 0);
  await settle();
  assert.equal(scheduler.pendingCount, 1, 'exactly one timer is armed');
  scheduler.advance(1_100);
  const second = await waiting;
  assert.equal(second.admitted, true, 'the request resumed after the window rolled');
});

test('a wall-clock jump forward cannot make the window wait forever', async () => {
  const { limiter, clock, scheduler } = harness();
  limiter.updatePolicy('p/m', policy({ requests: { perHour: 1 } }));
  await limiter.admit({ provider: 'p', model: 'm' }, 0);
  clock.shiftWall(WINDOW_MS.perDay * 2);
  const waiting = limiter.admit({ provider: 'p', model: 'm' }, 0);
  await settle();
  scheduler.advance(WINDOW_MS.perHour + 10);
  const second = await waiting;
  assert.equal(second.admitted, true);
});

test('describing an unknown model is safe and reports unlimited', () => {
  const { limiter } = harness();
  const status = limiter.describe('nobody', 'nothing');
  assert.equal(status.limited, false);
  assert.equal(status.configured, false);
  assert.equal(status.usage.requests.perSecond.limit, 0);
  assert.equal(status.lastRequestAgoMs, null);
});
