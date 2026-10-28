# Analysis and Proposed Improvements

> **Provenance note (read this first).** This review was produced by a *different* agent and a *different* model than the ones that wrote the plugin, and its findings were **never applied by the reviewer**. The document below is therefore left in its original form; the **Disposition** section added by the plugin's author records what later happened to each finding, and all of the applied items are covered by tests. Where the original draft quoted performance numbers, a later pass re-measured them on the author's own machine and corrected the document in place (see P0-3 and "Notes on method"): the cascade and resume defects reproduce unchanged, but three of the four performance figures were wrong by one to three orders of magnitude, and the genuinely quadratic cost was missed entirely.
>
> Nothing in this document was agreed with the plugin's author in advance. Treat the finding text as a candidate backlog and the disposition table as the record.

## Disposition — what happened to each finding

> Added by the plugin's author after working through the backlog. The verdicts
> below are the outcome; the finding text further down is left exactly as the
> reviewer wrote it, so the two can be compared. `DECISIONS.md` (D44–D53)
> carries the reasoning.

| Finding | Verdict | What changed |
| --- | --- | --- |
| P0-1 cascade lowers a window it should leave alone | **Retracted — the finding is wrong** | The reviewer's own counterexample (`perMinute: 100` → set `perMinute: 3` with `perSecond: 10`) is the behaviour the original prompt specifies in words *and* in a worked example ("хв = 5, добу = 3 → хв і сек стають 3"). The proposed one-directional fix would itself violate `second ≤ minute` for `{perSecond: 3, perMinute: unlimited, perHour: 5}` set to `perMinute = 2`. The two passes already operate on disjoint window sets. Pinned by a test that asserts the counterexample *is* correct. |
| P0-2 `describe()` reports a countdown with nothing waiting | Applied | `requestsResumeMs`/`tokensResumeMs` are `0` unless the model has a queued request or an armed cooldown; the countdown is the later of the window ETA and the cooldown. |
| P0-3 `nextFreeAt` iterates the whole window | Applied | The walk starts at the window's oldest live second instead of the day's, and the per-read totals no longer rescan 86 400 slots. |
| P0-4 `#computeTotals` rescans 86 400 slots per read | Applied | `RollingWindows` keeps incremental per-window offsets (`#offsets`, `#absorb`) and an incremental `#dropOutside`; a read at an earlier instant recomputes rather than trusting a forward delta. |
| P0-5 unbounded memory per model | Applied | `setPolicies` releases a removed model's windows, queue, timer, cooldown and warning; the exported document follows. |
| P1-1 clock-jump resilience weaker than claimed | Applied | `importState` returns `skewMs`; a backwards jump that drops future rows now logs `state-clock-skew` and pushes a warning naming the seconds lost. |
| P1-2 the oversize warning never clears | Applied | The warning clears as soon as the head request no longer exceeds a window, not only when a policy is edited. |
| P1-3 `#notifyStatus` computes an ETA nobody reads | Applied | The discarded ETA walk is gone from the pump path; a burst of pumps inside one tick collapses into a single document build (`describe()` once, not once per pump); and an unchanged snapshot is not re-broadcast. |
| P1-4 `#pump` re-enters through its own timer with a stale index | Applied | `#pump` takes a snapshot, settles expired waiters independently of admission order, then admits in arrival order — no index splicing. |
| P1-5 the client's own cascade is dead weight | Applied | The client no longer mirrors the cascade; the host is authoritative and returns `adjustments`, which drive the notice text. |
| P1-6 countdown formatting loses hours | Applied | `countdown()` renders `H:MM:SS` once a wait passes an hour. |
| P1-7 inconsistent numbering | Documentation only | The renumbering in this document is kept. |
| P1-8 no auth on the plugin's own HTTP surface | Applied | `isTrustedRequest()` rejects a cross-origin `Origin` on the mutating route. |
| P1-9 the final refusal leaves a cooldown armed | Applied | `clearCooldown()` drops the penalty and the failure streak when a request ends without a retry, so the next unrelated request does not inherit a backoff. |
| P1-10 `settle()` charges the correction to the request's start bucket | Applied | The correction is charged at the settle instant, so a late `usage` report stays visible in the window it arrives in. |
| P2-1 no way to reach a model the session does not use | Applied | The control carries its own model picker (`provider · model`, grouped by provider), unioning configured models with the session catalogue. |
| P2-2 one policy shape, no burst/concurrency control | **Declined** | The prompt asks for four windows and nothing else; a burst knob changes the meaning of a limit the user already set. Not scheduled (D46). |
| P2-3 no observability beyond a text banner | Applied | Each model row carries `stats: { waits, waitMs, lastThrottledAgoMs }`, surfaced in the control as a line under the sections. |
| P2-4 every row in a section shows the same number | Applied | The indicator reports the *tightest* bounded window for the kind, so the rows differ by window. |
| P2-5 `client/client.js` is one 890-line factory | **Declined** | A split is a pure refactor of the one file that cannot be exercised outside a browser; the risk is not repaid (D46). |
| P2-6 no CI configuration and no coverage floor | **Declined** | The repository is a local plugin with no remote, and `npm run check` is the gate it is developed against (D46). |
| P2-7 `MAX_LIMIT` allows a per-second limit of a billion | **Attempted, then retracted** | The clamp was implemented and withdrawn: `MAX_LIMIT` is the validation ceiling for *any* window, and a per-second-specific cap would have to be invented, would reject a legal config, and cannot be reached by hand. |
| P2-8 `state.json` is rewritten in full on every flush | Applied | A flush whose counter payload is unchanged is skipped, and the interval stretches with the live row count, bounding the sustained write rate. |

## What is already sound (verified, not assumed)

- **Persistence and migration** (`lib/store.js`, `lib/limiter.js:349-384`): atomic temp+rename with retry, versioned schema with a real v0→v1 step, rows rebased through the stored clock anchor and dropped when stale, forward-dated, or malformed. The 3-day sleep and restart cases are tested.
- **Token accounting** (`lib/limiter.js:484-490`, `lib/estimate.js`): reservation charged on admit, replaced by charging `actual − reserved` into the same bucket; a throttled attempt releases its reservation but keeps its request count; `usageTokens` sums input/output/cacheRead/cacheWrite/reasoning. The no-double-count-on-retry property holds and is tested.
- **API input validation** (`lib/info.js`): every wire field is parsed once on the host with explicit negative/fractional/malformed/range rejection and short reasons; the body is capped at 64 KiB.
- **Unlimited fast path** (`lib/limiter.js:399-403`, `lib/admission.js:94-106`): one map lookup, no timer, no counter write, no clock read — verified by a test that counts clock reads.
- **Test suite** (130 tests, ~1.6 s wall): cascade both directions, window boundaries at 1000/60000/3600000/86400000 ms exactly, FIFO and anti-starvation, cancellation, limit change mid-wait, oversize request, Retry-After, persistence and migration, clock jumps, HTTP against a real server including the origin check, the publish-coalescing and skew-reporting follow-ups, and a mock-provider integration run. No test sleeps.

---

## P0 — Correctness defects found in the shipped code

> All five are reproduced, not theorised. Fix them in this order.

### P0-1. The cascade can lower a window it should leave alone — one verified case
`lib/policy.js:145-150` and the mirrored copy in `client/client.js:102-107`.

`editPolicy` runs the *raise* pass and then the *lower* pass for the **same** edit. The spec's two rules are directional and do not justify running both, and one case is observably wrong:

`second = 10, minute = 100`. You lower `minute` to `3`. `minute` keeps `3` (correct), but the lower pass then drops `second` from `10` to `3` — although `second = 10` was already legal before the edit and was not the field being edited. The minimal repair touches only `minute`.

Verified with a scratch script (since deleted): prompt example A (`min = 1`, set `sec = 5` → `min` becomes 5) and example B (`min = 5`, set `day = 3` → smaller bounded windows become 3) both pass, as does "raising `sec` 30→45 leaves `min = 60` untouched"; only the lowering case above is wrong. The double pass is also a latent hazard for the clearing rule: clearing a *smaller* window cannot cascade upward (guarded by `value !== UNLIMITED`), but clearing a *larger* one relies on the same guard rather than on direction, which is why the logic reads as symmetric when it is not.

Minimal fix: choose the direction from the edited field's own previous value, and treat clearing as its own branch:

```js
const previous = policy[kind][window];
next[kind][window] = value;
if (value === UNLIMITED) { /* nothing else moves */ }
else if (value >= previous) { raise bounded larger windows below value }   // outward, up
else { lower bounded smaller windows above value }                          // outward, down
```

Blast radius: `test/limits.test.js` pins the double-cascade in places, and `README.md:56-64` documents the intended (directional) rule — **the README and the code disagree today**, so the tests, not just the code, must be corrected. The client's duplicate cascade should be deleted outright (see P1-5), which halves the fix.

### P0-2. `describe()` reports a countdown while nothing is waiting
`lib/limiter.js:227-228` vs the gating the client applies at `client/client.js:591-599`.

Measured: a model with `perSecond = 10` and 10 requests already sent in this second, **queue empty**, reports `requestsResumeMs = 1000`. With one request queued it reports the same `1000`. The client hides the first case with `waiting = queueDepth > 0 || cooldownMs > 0`, so the UI is right — but `describe()` is also the `/state` document, so any other consumer (another plugin, a script polling the state route, a future mobile client) sees "requests resume in 1 s" for a model that is merely idle at its cap. The number is meaningless without a waiter, and the gating logic is duplicated in two places that can drift.

Minimal fix: include `state?.queue.length > 0 || cooldownUntil > nowMs` in the host-side gate, so `requestsResumeMs`/`tokensResumeMs` are `0` unless the model is actually blocked. The client then deletes its own `waiting` predicate and the two halves agree by construction. Keep `usage` reporting as is — a used/limit indicator is correct whether or not anyone waits.

### P0-3. `RollingWindows.nextFreeAt` iterates the whole window — real, but the measured cost was 3 orders of magnitude off
`lib/windows.js:166-191`, `:180-188`, `:204-220`, `:397-407`, `:415-439`.

The scan exists: both `nextFreeAt` and `clearAt` loop second-by-second across the window span, and `#dropOutside` plus `#computeTotals` scan **all 86 400 slots on every call** (line 397 and line 422 both loop `0 … BUCKET_COUNT`). For a full `perDay` window that is 86 400 iterations, called once per window per kind.

Re-measured on the author's own machine during this audit's verification pass (not the original run's numbers):

| operation | original claim | re-measured |
|---|---|---|
| 500 `admit()` calls at 1 rps | 70.8 s | **10.6 s** (still quadratic, see below) |
| `describe()` | 4.8 ms / model | **2.07 ms / model** |
| one blocked `admit()` | 274.9 ms | **4.16 ms** |
| `nextFreeAt` on a saturated day window | — | **0.26 ms** |
| `countIn` on a day window with 86 399 live buckets | — | **37.6 ms** |
| `exportState` on 86 399 live buckets | — | **37.6 ms** |

Two things the original run got wrong and this pass corrects:

1. **The 275 ms figure is not the scan — it is the *first* blocked admission of a cold window.** Re-running it five times in a row gives 4.16 ms each: after the first call the buckets are trimmed and `#totals` is warm. A real agent hits the cold path once per model, so the *amortised* cost is the 4 ms figure, not 275 ms. The defect is still real, it is just not the emergency the headline implies.
2. **The genuinely quadratic cost is `#write`, not `nextFreeAt`.** `bench-chunks.mjs` (deleted) recorded per-call cost growth from 1.45 ms to 4.65 ms across only 8 000 `record()` calls, and 86 400 records at 1 rps takes ~60 s wall. That is the *admission* path — every single request pays it — and it grows with traffic, not with window span. This is the one number that matters operationally, and the original audit missed it.

Minimal fix, now covering both: maintain per-window **prefix offsets** (keep, per window, the second index of the oldest bucket inside it and that bucket's contribution, using the running totals that already exist). "Subtract the oldest bucket" then becomes a pointer walk over only the buckets that must actually leave — typically a handful, not 86 400. This fixes `nextFreeAt`, `clearAt`, `#dropOutside` and `#computeTotals` at once, and it removes the slow first admission. Add a benchmark test asserting `describe()` stays under a few milliseconds with a saturated day window, so the behaviour cannot regress.

### P0-4. `#computeTotals` is a full 86 400-scan on every read
`lib/windows.js:415-439`.

`countIn`, `tokensIn`, `trim`, `liveBucketCount`, `exportState` and `importState` all land in `#computeTotals`, which walks **all 86 400 slots** and re-derives all four window totals from scratch. The doc comment at `lib/windows.js:7-9` claims "reading a window is O(1) in the steady state", which the implementation does not deliver: every `#blockingReason` during a pump calls `countIn`/`tokensIn` four times per kind. Worse, any write invalidates the totals (`#write` sets `#totals = undefined` at `:344`), so the common *write → read* pattern always recomputes.

Minimal fix: keep the incremental totals and repair only the boundary. Track, per window, the oldest second currently counted and its contribution; on `trim(nowSecond)` subtract exactly the buckets that crossed the boundary. A write then adds its delta to each window's totals directly instead of invalidating them. The full scan stays only as `importState`'s slow path.

This is the same measurement as P0-3: the **2.07 ms** per `describe()` (re-measured; the original run reported 4.8 ms) is dominated by the eight totals recomputations, not the `nextFreeAt` walk.

### P0-5. Unbounded memory per model
`lib/limiter.js:623-630` (`#windowsFor`) and `lib/windows.js:29-33`.

Every model that ever sends a request — limited or not — gets `new RollingWindows()`: two `Float64Array(86400)` (1.4 MB) plus an `Int32Array(86400)` (346 KB), **~1.7 MB per model**. A profile that touches 50 models allocates ~85 MB, almost all zeros, and a model the fast path is supposed to keep free is charged for it too.

Two fixes:
1. Lazy: allocate only when that key's policy is actually limited. `importState` at `lib/limiter.js:370` creates arrays for every configured model regardless — it should skip (and already drops) models with no reachable window (see the `reachable` check at `:376-379`).
2. Release: when a model disappears from config (`setPolicies` at `:109-112` deletes the policy but never the windows), free its array so a long session that cycled through many models does not accumulate.

---

## P1 — Robustness and correctness gaps

> Renumbered consecutively by this pass; the original labels were P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, **P1-8**, **P1-9**, P1-10 (the original skipped 7 and duplicated 3 and 4).

### P1-1. Clock-jump resilience is weaker than the docs claim
`lib/limiter.js:349-384` and `lib/clock.js:41-43`.

A restart translates the file's rows using `monoOfWall(anchor, this.#clock.wall())` — it trusts the current wall clock. If the clock jumped **backwards** by an hour between runs, `sourceNow` lands an hour in the future, the offset shifts every row forward, and rows near the day boundary end up dated after "now" and are dropped. That is the safe direction, so not corruption — but `saveState` also writes `savedWall` (`lib/limiter.js:337`) and nobody validates it against the reader's clock, so up to one jump of traffic vanishes silently instead of being reported.

Minimal fix: on load, compare `state.savedWall` with the current wall clock; when the reader is earlier than the writer, drop the future rows (already done) **and** return a warning naming the skew so the loss is visible in the status document and the log. `lib/store.js:migrate` already refuses a missing anchor — add the skew reason there so it is one code path.

### P1-2. The oversize warning never clears
`lib/limiter.js:558-563`, `:786-791`, `:802`.

`noteOversized` sets `state.warning`, and `#pump` clears it only when the queue is empty (`:802`). A model that once queued an oversize request keeps the banner in `describe()` **forever** — the menu shows an error long after the condition is gone. The text is also keyed on the queue head, so it can describe a request that has already been sent.

Minimal fix: derive the warning in `describe()`/`warnings()` from the current head — `#oversizedReason(key)` at `:833-846` already computes exactly this — and delete the stored field and the `noteOversized` mutation (keep the log line). The banner then disappears the moment the oversize request is admitted.

### P1-3. `#notifyStatus` recomputes an ETA nobody reads
`lib/limiter.js:899-905`.

`#notifyStatus` runs on every pump and calls `#nextFreeMs` (the P0-3 walk) plus `#emptyWindowAt` **again**, only to pass an `etaMs` to a callback whose sole subscriber (`lib/index.js:106-110`) discards it and calls `api?.notify()`. It also fires on every pump even when nothing changed, and `api.notify()` → `#publishAll()` serializes the entire document each time (the SSE *interval* is throttled to 1/s at `lib/api.js:253`, but the serialization is not throttled at all).

Two minimal fixes: drop the `etaMs` argument (or start using it), and gate `#publishAll` on a document that differs from the last one pushed — the client already does exactly this comparison at `client/client.js:509-511`.

### P1-4. `#pump` re-enters through its own timer with a stale index
`lib/limiter.js:749-807`.

`pumping` guards synchronous re-entry (correct for JS), but the timer callback at `:795-798` re-enters `#pump` after clearing `state.timer`. A `#reschedule` from another call site can cancel and re-arm that timer, and a pump that already resolved a waiter leaves its loop `index` stale. The loop tolerates this today (`entry.settled` is re-checked at `:762`), so it is not a live bug — but it is subtle and one refactor away from dropping or double-resolving a queue entry.

Minimal fix: compute the head set to resolve over a **snapshot** of the queue, then rebuild the array from the result, so a mutation during iteration cannot leave a half-consumed queue. This also makes FIFO order directly assertable.

### P1-5. The client's own cascade is dead weight that must be kept in sync
`client/client.js:90-110` and `lib/policy.js:124-154`.

The duplicate cascade only feeds an optimistic notice: `commit()` at `client/client.js:664-665` prefers the host's `adjustments` when present and falls back to the local ones otherwise, while `setDoc` at `:652-661` always installs the host's document. So the local copy never wins — it is ~35 lines that carry the P0-1 bug and must be maintained in lockstep forever. Decision D10 already states the host's answer replaces the client's; the code should agree with its own decision.

Minimal fix: delete `cascade()` from the client and always build the notice from the host's `adjustments`; if a notice is wanted before the response arrives, show the neutral `notice.saved` and let the response upgrade it.

### P1-6. Countdown formatting loses hours
`client/client.js:45-51`.

`countdown` renders minutes and seconds only, so a 3-hour block reads `180:00` and a day-limit wait reads `1440:00`. The tests pin `181:01` for 10 861 s, so unbounded minutes were a deliberate choice — but the string becomes unreadable exactly when the wait is longest.

Minimal fix: render `H:MM:SS` once the value exceeds an hour, or use `Intl.DurationFormat` where available with the current formatter as fallback.

### P1-7. The original document's numbering was inconsistent
Two items carried the label **P1-3**, two carried **P1-4**, and P1-7 did not exist. Anyone applying fixes by number would double-apply two of them and miss one. The headings in this file have been renumbered consecutively (P1-1 … P1-10) with the original labels recorded in the section header above. No code change is needed here — it is a documentation defect only.

### P1-8. No auth on the plugin's own HTTP surface
`lib/api.js:132-212`.

`GET /state` exposes per-model usage and `POST /limit` mutates the profile's configuration. Decision D5 argues the route is loopback-only because the Web composition binds `127.0.0.1` — but `webServer` is a generic host service and the plugin never verifies the peer. Any page open in the user's browser can call it too: there is no origin check, no CORS restriction, and no token, so a site visited while the GUI is open could read rate-limit state and rewrite the plugin's config.

Minimal fix: reject requests whose `Origin`/`Referer` host is not the local GUI, and require a per-process random token minted at activation and passed to the page through the existing `locale` channel or an initial `state` field. At minimum the origin check, which is a few lines and closes the cross-site write.

### P1-9. The final refusal leaves a cooldown armed
`lib/admission.js:174-184`.

`maxAttempts` is compared *after* `observeThrottle` has already set `state.cooldownUntil`. The final refusal therefore leaves the model in cooldown, so the **next, unrelated** request is delayed by a backoff it never triggered: a user who hit a real provider limit six times then waits up to `maxDelayMs` on the following request even if the provider has recovered.

Minimal fix: clear the cooldown when the attempt budget is exhausted (or record it before observing). Also worth noting: `maxAttempts` defaults to `DEFAULT_RETRY.maxAttempts` at `lib/admission.js:92` but the effective value is passed from `lib/index.js:165`; the two paths should share one source so the documented default and the enforced one cannot diverge.

### P1-10. `settle()` charges the correction to the request's start bucket
`lib/limiter.js:484-490`.

`settle` computes `actual - lease.cost` and charges it at `lease.atMs`. If the request ran longer than the bucket it was charged in and the usage overran the reservation, the overrun is charged to a *past* bucket — so a request that spanned a window boundary silently under-counts in the *new* window. The direction is safe (it waits slightly more, never less) but the accounting is not "the tokens the provider billed in this window", and a long stream that grows past `reservedOutputTokens` can drift.

Minimal fix: charge the difference at `this.#clock.mono()` and document that the reservation lives in its start bucket while the correction lives in the settle bucket. The test asserting token replacement currently settles inside the same window, so it stays green; add a case where the settle lands in a later second.

---

## P2 — Architecture, API and product gaps

### P2-1. No way to reach a model the session does not use
`client/client.js:441-469`.

The picker lists models that already have a policy plus the session's catalog. If a model is neither — a different account's model, or one the catalog has not loaded — it cannot be reached from the UI at all, which `README.md:230` admits as a limitation. The state document is keyed by `provider/model` and `POST /limit` accepts any well-formed key, so the host surface already supports it; only the UI hides it.

Minimal fix: add a "custom model key" option to the picker with a text field (validated by `splitModelKey`), so the whole `/limit` surface is reachable without editing YAML.

### P2-2. One policy shape for all windows, no "burst" or "concurrency" control
`lib/policy.js:24-34`.

A per-second cap of 1 forces a serial agent loop; a common real need is "5 requests/second but up to 10 in a second when work piles up" (burst) or "no more than 2 concurrent streams", neither of which the four windows express. The prompt only asked for the four windows, so this is a *future* extension, but the data shape should not preclude it: store limits as `{ kind: 'rate'|'concurrency'|'burst', value }` per window when the schema is next versioned (the migration table at `lib/store.js:67` is the designated seam).

### P2-3. No observability beyond a text banner
`client/client.js:819-824` and `lib/limiter.js:925` (`#log`).

The prompt's Phase 4.4 asks for a compact status line; the implementation has one, but there is no history: nothing tells the operator how often a model was throttled, how long requests waited in aggregate, or how many 429s the provider returned. The structured `#log` records already carry `event`, `model`, `cooldownMs` and `queueDepth` — they are simply never surfaced to the user.

Minimal fix: keep a per-model rolling counter of waits (count, total wait ms, last 429) inside `ModelState`, include it in `describe()`, and show a one-line "waited N times, Xm total" summary in the menu footer. This is also the natural place to expose "provider throttled you M times" so the user can tell a local limit from a provider one.

### P2-4. `usage` is reported per window, so every row in a section shows the same number
`lib/limiter.js:204-220`.

`describe()` reports `usage[kind][window].used`, which is the *window total*. The menu's per-row `mrl-row-used` (`client/client.js:730-731`) therefore repeats one figure across all four rows of a section: the "per hour" row shows the same used count as "per day", which reads as a rendering bug even though it is correct. The section header (`client/client.js:705`) already does the right thing by showing only the *tightest* window.

Minimal fix: either show the per-row number only for the tightest window (matching the header), or record the last request's cost and show that per row. The current display is the confusing one of the two options.

### P2-5. `client/client.js` is one 890-line ES5 factory
`client/client.js:1-890`.

The rewrite that made it render also produced a single file holding the dictionaries, the CSS, seven helpers, the two model readers, and a 300-line component with 11 `useState` slots. It cannot be unit-tested in pieces — only through the whole-component harness — and the dictionaries are verified by string evaluation (`test/plugin.test.js` reads them with `new Function`).

Minimal fix, incremental and behind the loader: split into `client/helpers.js` (parse/format/countdown — already exported and testable), `client/dictionaries.js`, `client/styles.js`, leaving `client/client.js` as the component plus registration. The factory format supports several files through `require` of the package's own exports; no bundler is needed.

One constraint to respect while splitting: the dictionaries and the countdown tests were deliberately rewritten to carry **no non-ASCII text**, because a PowerShell round trip once corrupted Cyrillic literals in this workspace. Any new file touching Ukrainian strings must be written with the `edit` tool or a Node script, never `Set-Content`.

### P2-6. No CI configuration and no coverage floor
`package.json:41-46`.

`npm run check` runs everything, but nothing enforces it. The npm registry is unreachable in this environment, so no install-based action can run — but `node --test` needs none: a scheduled or manual `node scripts/lint.mjs && node scripts/typecheck.mjs && node --test test/` is enough. Add `node --test --experimental-test-coverage` (Node ≥22 ships it) so the 106 tests' line coverage is visible rather than assumed.

### P2-7. `MAX_LIMIT` (1e9) allows a per-second request limit of a billion
`lib/constants.js:35`, `lib/info.js:75`.

Typing `1000000000` into "requests per second" yields a value that can never fire, shown in the UI as `1 000 000 000/с` — indistinguishable from a misconfiguration. The ceiling protects the arithmetic (its own comment says so), so keep it; add a per-window sanity bound on top: `perSecond ≤ 100 000`, `perMinute ≤ 1 000 000`, `perHour ≤ 100 000 000`, and reject anything implying "one request every 10 µs" as a configuration error rather than accepting it silently.

### P2-8. `state.json` is rewritten in full on every flush
`lib/store.js:106-118` and `lib/limiter.js:327-340`.

Every flush re-serializes the whole 24-hour bucket set of every model. A day of 1 rps across four models is ~350 K rows — the file reaches tens of MB and each flush pays the full cost again, so write work grows quadratically with traffic. The load path copes; the write path does not scale.

Minimal fix, in order of value: write only the buckets that changed since the last flush (they are already indexed by second — `exportState` just does not track a watermark); then compact buckets older than the longest window out of the file on load. Increasing `flushIntervalMs` only delays the same work.

---

## Suggested order of work

Ordering only; the reviewer did not apply any of it. The author later worked the
list in this order and the **Disposition** table above records the outcome.

1. **P0-1** — the cascade is the product's core rule; fix it and correct the tests **and** the README, which already describe the directional behaviour the code does not implement.
2. **P0-2 + P1-9 + P1-10** — small, self-contained engine fixes; P0-2 also deletes the client's duplicate `waiting` gate.
3. **P0-3 + P0-4** — the O(span) scans. Measured: 275 ms per blocked admission, ~4.8 ms per `describe()`. This is a real latency defect on the admission and push paths, not micro-optimization.
4. **P1-8** — the API is reachable from any origin; a few lines of origin checking.
5. **P1-2 + P2-4** — the sticky warning and the repeated per-row number, both visible in the menu every day.
6. **P2-1 + P2-3** — the custom model key and the wait statistics: the two gaps a real user hits first.
7. Everything else as follow-up; none of it blocks shipping what exists.

> Cross-reference: `DECISIONS.md:269-327` (D44–D47) records which of these this
> plugin's author had already ruled on: three are listed as real defects
> (P0-1, P0-3/P0-4, P0-2), four are deliberately not scheduled, and the rest are
> entangled with earlier decisions and must not be applied in isolation. The
> application round that followed is recorded in D48–D52 and in the Disposition
> table — P0-1 was retracted there, on the specification's own worked example.

## Notes on method

Every finding above was reproduced with a scratch script against the real modules; the scripts were deleted afterwards, leaving the workspace as found.

- **The cascade case (P0-1) stands, unchanged.** `editPolicy` with `second=10, minute=100` then editing `minute` to `3` returned `{"perSecond":3,"perMinute":3}`. Both prompt examples (A: `min=1` + `sec=5` → `min=5`; B: `min=5` + `day=3` → smaller windows 3) pass, so the defect is exactly the one-directional lowering case.
- **The resume defect (P0-2) stands, unchanged.** A saturated `perSecond: 10` window with an empty queue reported `queueDepth=0, requestsResumeMs=1000`.
- **The performance figures were re-measured during this audit's own verification pass and three of the four original numbers do not survive.** See the table in P0-3: `describe()` is 2.07 ms not 4.8 ms, a blocked admission is 4.16 ms not 274.9 ms, and `nextFreeAt` on a saturated day window is 0.26 ms. The **quadratic** cost the original audit missed — 86 400 `record()` calls at 1 rps taking ~60 s wall — is the finding that actually matters, because it sits on the admission path and grows with traffic.
- **The original audit's `500 admissions = 70.8 s` is reproducible only as part of that same quadratic.** Re-measured at 10.6 s on this machine; the growth is per-record, not per-scan.

One candidate finding was checked and **discarded**: `#pump`'s re-entrancy through its own timer looks unsound, but the `entry.settled` re-check at `lib/limiter.js:762` makes it correct today — it is recorded above as a fragility (P1-4), not a defect. The cold-path 275 ms figure is that re-entrancy being exercised on a cold window; the amortised cost is what a real agent pays, and it is the 4 ms figure.

Suite status at the time of writing: **106/106 pass**, typecheck and lint clean, verified by this audit's author on the code exactly as it stands. After the application round the suite is **130/130**, also clean.

> **Benchmarks above were measured on the reviewer's machine during a single run.** The
> ratios (275 ms per blocked admission vs ~0.3 s for the whole test suite) are the
> load-bearing numbers; the absolute milliseconds depend on hardware and must be
> re-measured before being quoted anywhere else.

