# DECISIONS

Every assumption and design decision this plugin made on its own, with the
reason. Phase numbers refer to the original request.

## Reconnaissance (phase 0)

**D1 — The limit seam is `llm/stream`, not the agent loop.**
`llm/stream` is the single waterfall every provider request passes through, and
its `next()` is a *function returning an async iterable*, which means one
listener can re-invoke it for a retry. `agent/request` could modify a call but
cannot observe terminal chunks or usage; `agent/request-error` runs a step
later, when the loop has already decided the attempt failed. Admission control
therefore lives in one place: `lib/admission.js`.

**D2 — The plugin is a static installed bundle, not a dynamic Cordis package.**
`cordis-host-runner` definitions are session-scoped and are cleared by a
restart; a rate limiter whose counters are per-process must be persistent. The
package is a workspace bundle installed with `plugin_manager install_bundle`, so
it survives restarts and appears in the profile patch like any other plugin.

**D3 — The UI seam is `conversation.input.right`.**
The reference screenshot circles the "model · effort" summary row of the
composer's model menu. That menu is rendered inside a *single* slot
(`conversation.input.model`), so a second plugin cannot add a row to it without
shadowing the shipped selector — which the UI rules forbid. `conversation.input.right`
is the `list` slot the composer renders in the same `standardControls` row,
immediately before that model seat, so the control sits exactly where the
circle is while following a pattern the harness actually declares for additive
contributions. Its menu copies the shipped menu's material (theme tokens,
`--dsw-elevation-prominent`, `--dsw-radius-md`) rather than importing a Client
package.

**D4 — The plan is scoped per model and keyed `provider/model`.**
The prompt asks for per-model limits and 429 protection, and the harness
addresses a model by the pair `(provider, model)`. Limits are therefore keyed by
`provider/model` and model ids are compared verbatim, so an alias and its target
are independent — exactly as DSH names them.

**D5 — The client half reaches the host over three owned HTTP routes.**
A generated Remote namespace needs a TypeScript declaration and a compiled
codec face, and `api-remotes` mounts a fixed build-time selection of namespaces;
a dynamically defined one would need the dynamic Cordis runner, which is
session-scoped and needs an explicit user approval per run. The host already runs
`ctx.webServer`, so the plugin registers its own prefix route and the browser
half uses `fetch` plus one `EventSource`. The route is loopback-only because the
shipped Web composition binds `127.0.0.1` and the server itself has no global
auth layer; the API mutates only this plugin's own configuration, and its inputs
are validated on the host before they reach the limiter or the config editor.

**D6 — `models` is an object in the plugin's `Config`, edited through `configEditor`.**
`ctx.configEditor.edit()` writes the profile patch, validates the whole candidate,
applies it through the normal Loader path, and survives upgrades. A model policy
therefore has exactly one home, and a menu edit is durable without a second
storage format. If the editor is missing or the row is not uniquely addressable,
the edit still applies live and the response reports that it was not persisted.

## Limits, validation and cascade (phase 1)

**D7 — `0` is the only representation of "unlimited".**
The prompt allows "0 or empty" internally. One canonical value removes a whole
class of bugs: display, config, API, and comparison all read `0`. Empty input,
`не обмежено`, and `unlimited` are accepted *input* spellings and normalize to
`0`.

**D8 — Invalid input is rejected, never clamped.**
Negative, fractional, malformed, and out-of-range values are refused with a short
reason and the previous value stays. Silently rewriting a user's number would hide
the mistake. The upper bound is `1_000_000_000`, comfortably inside
`Number.MAX_SAFE_INTEGER` and rendered as "practically unlimited".

**D9 — The cascade is a pure function with one edited field.**
`editPolicy(policy, kind, window, value)` keeps the edited value and reconciles
the rest: raising a smaller window raises bounded larger windows below it;
lowering a larger window lowers bounded smaller windows above it; clearing a
window (`0`) changes nothing else; an unlimited window never moves. It returns
the adjustments it made so both halves can tell the user which field auto-moved
and to what.

**D10 — The host is authoritative, the client mirrors.**
Both halves implement the same cascade (the client in `client/client.js`, the
host in `lib/policy.js`). The host's answer replaces the client's optimistic one
and its `adjustments` list drives the notice, so a divergence can never leave the
menu showing a value the limiter does not enforce.

**D11 — A value read from a file that violates non-decreasing order is repaired, not refused.**
A hand-written `cordis.patch.yml` is repaired on activation (the wider window is
raised) because refusing to activate over an ordering preference would be worse
than ordering the user's numbers for them.

## Tokens (phase 2)

**D12 — A token window is a ceiling on what may be inside it, so a reservation that reaches the limit waits.**
If the ceiling were a strict upper bound on concurrent load, a request whose own
estimate equals the limit would wait forever. The reservation is clamped to the
limit (`need = min(cost, limit)`), admission proceeds while
`used + need <= limit`, and a request that cannot fit is sent against a
completely empty window — a bounded wait, never a hang. This is the phase-4
"single request larger than the whole limit" rule, implemented once.

**D13 — The reservation is charged when the request is admitted, and reconciled when it settles.**
Provider usage replaces the reservation by charging the difference
(`actual - reserved`) into the same bucket, so a request that overruns is charged
the overrun and one that comes in short gets the difference back. Nothing is
written twice, which is what makes a retry safe without a separate retry ledger.

**D14 — A throttled attempt releases its token reservation but keeps its request count.**
The provider received a call, so the request budget must reflect it; it produced
no completion, so its tokens must not be charged. Usage that a rejection reports
is charged back separately.

**D15 — Suffixes `k`/`m` are accepted and grouping separators are shown.**
`500k` is 500 000, `1M` is 1 000 000, and display uses the locale's grouping. A
comma is read as a decimal separator, so `1,5` is refused as non-whole rather
than silently multiplied by ten.

## Clock, windows, persistence (phase 3)

**D16 — Two clock readings, one abstraction.**
`mono()` is monotonic and drives every interval; `wall()` is wall-clock and is
used only to translate a persisted file into this process's domain. Window
arithmetic never reads the wall clock, so an NTP step or a hibernation cannot
double count an event or keep a window closed.

**D17 — One second per bucket, four windows over one array.**
Memory is fixed at 86 400 slots regardless of traffic. Per-window totals are
materialized for the instant being read and repaired on trim, so a window read is
O(1) in the steady state and an event stops counting at the exact moment it
leaves its window. A read at a moment earlier than a previous read — which the
monotonic clock never produces, but a test or a rebased snapshot can — recomputes
that instant instead of trusting a forward-only delta.

**D18 — The persistence file stores a clock anchor beside the counters.**
Each row is a monotonic second index, meaningless without the origin that
produced it. The file therefore carries `{mono, wall}` and the wall time of the
write; a load translates the rows onto this process's clock and drops anything
outside the 24-hour window, anything dated after "now", and anything malformed. A
damaged or stale file degrades to "no counters" with a warning instead of
blocking activation.

**D19 — The counter file lives under the profile directory.**
`$DSH_PROFILE_DIR/.dsh/model-rate-limit/state.json`, matching the existing
per-profile `.dsh/<plugin>` convention. Without a profile directory the harness
home is used.

**D20 — Atomic write is implemented locally (temp file plus rename with bounded retry).**
The requirement is a temp-file-then-rename write. Implementing it in `lib/store.js`
keeps the plugin dependency-free and makes the Windows `EPERM`/`EACCES`/`EBUSY`
retry explicit and testable, instead of relying on a package the profile may not
resolve.

**D21 — The state schema is versioned with an explicit migration step.**
Version 1 is the current schema; an unversioned document is migrated into it and a
document from a newer schema is refused with a reason rather than guessed at. The
migration table is the extension point for the next version.

## Idle behaviour and 429 (phase 4)

**D22 — One timer per model, not one per waiter.**
The model owns the FIFO queue, the cooldown, and exactly one armed timer. When
nothing can start, the timer is set for the exact instant the limiting window
frees (plus the jittered margin) and nothing else wakes. A limit change, an
admission, or a release cancels and re-arms that single timer.

**D23 — The wake-up margin is 80 ms plus up to 120 ms of jitter.**
A rolling window's edge is exact, but the timer that fires on it may race the
bucket repair. The margin is inside the range the request asked for (50–250 ms)
and is configurable.

**D24 — A retryable throttle withholds the terminal chunk until the retry finishes.**
A terminal `finish` closes the agent's step, so yielding it and then retrying
would deliver the retry to nobody. The throttled attempt's `finish` chunk is held
back; the successful retry's chunk is the only terminal one the consumer sees.
`503` is treated as a throttle too, because it is the standard provider
"temporarily unavailable, retry after" signal.

**D25 — The local attempt budget bounds retrying and the final refusal is reported.**
`retry.maxAttempts` (default 6) stops a provider that keeps refusing, and the
last failure is surfaced as a normal terminal chunk so a higher layer's policy —
`dsh-llm-retry` at the agent's failed-step seam — can still decide. The plugin
never turns a provider refusal into a stream that never ends.

## Quality (phase 5)

**D26 — Tests use Node's built-in runner, the injected clock, and a fake timer queue.**
No test sleeps: every timer goes through the injected `Timers` pair and the fake
clock, and `drive()` advances virtual time until the stream settles. The package
therefore needs no test framework and its suite runs in about a second.

**D27 — `lint` and `typecheck` are dependency-free scripts.**
The package intentionally ships no build step, so `npm run check` runs a hygiene
pass (no markers, no over-long lines, a manifest whose entry points exist), a
static pass (every file parses, every relative import resolves, no bare import
outside the runtime baseline), and the test suite. This is a deliberate trade: no
`tsc` type checking, but also no dependency on a toolchain the target
installation may not have.

**D28 — The client half is hand-written in the loader's factory format.**
`window.__ModuleLoader__.load({id, factory})` with `id` equal to the package name
is what the host expects, and the CJS factory form means no build step, matching
the rest of the package.

**D34 — The configuration schema has a local fallback with the same contract.**
DSH resolves `@deepseek-ai/schemastery` from its own installation, which a profile
plugin cannot reach when DSH runs from the Desktop bundle (the package lives
inside `app.asar`). Cordis validates a row through
`Config['~standard'].validate`, so `lib/schema.js` prefers the harness library and
otherwise builds a schema that exposes the same callable surface and the same
Standard Schema v1 protocol. The first installation attempt proved the need: with
a plain function as `Config`, activation failed at
`Cannot read properties of undefined (reading 'validate')`. The fallback is what
makes the plugin installable from a workspace with no bundler and testable
without the harness, and it validates the same documents with the same defaults.

**D35 — The plugin registers one prefix route and no second Remote namespace.**
`api-remotes` selects its forwarded events at build time and the generated Remote
faces belong to the packages that own them, so a third-party plugin adds neither.
The host's `webServer` is a plain route registry with no harness vocabulary, which
is exactly the seam a self-contained API needs; the browser half reaches it with
`fetch` and one `EventSource`.

**D40 — The popup uses only tokens the live theme actually defines.**
The first version referenced `--dsw-alias-bg-elevated` and `--dsw-alias-bg-l1`,
which do not exist: with no fallback the menu computed to a transparent
background, so its text read as washed out over the transcript and over any
neighbouring surface. The theme's real names are `--dsw-alias-bg-overlay` for a
popup, `--dsw-alias-bg-layer-1/2` for nested surfaces, `--dsw-alias-bg-base` for
the page, and `--dsw-alias-label-primary/secondary` for text. Those, plus literal
fallbacks, are what the stylesheet now uses, and it sets
`--dsw-elevation-stroke-color` so the shared shadow token resolves. Nothing is
translucent, so the surface no longer depends on what is behind it.

**D41 — A model with no policy is editable, not disabled.**
The first version disabled every field unless the model already appeared in the
state document. On a fresh installation that is *every* model, so the control
looked broken: the menu opened but nothing could be typed. The control now starts
from an all-unlimited policy for the selected model key, and the first committed
value creates the budget through the same `POST /limit` path. Only a session whose
model cannot be read at all leaves the fields inactive.

**D42 — A pushed snapshot is compared before it is applied.**
The host pushes at most once per second while anything waits. Replacing the state
object unconditionally re-rendered the whole menu every second, which is wasteful
and can interrupt an edit in progress. The serialized document is compared first,
so an unchanged push is a no-op.

**D43 — The per-model control cannot be a row inside the shipped model menu.**
`conversation.input.model` is a `single` slot claimed by the shipped
`ui-model-selection` entry: reusing that key replaces that entry rather than adding
to it, which would remove model search, provider grouping, effort levels and the
session's own selection logic. The control therefore sits in
`conversation.input.right` — the `list` slot rendered in the same composer toolbar
row, immediately before the model seat — and grows a model picker of its own so
every model's budget is reachable from one place.

## Localisation and documentation (phase 6)

**D29 — Ukrainian and English ship in the client dictionary, and the host stays language-neutral.**
Every user-visible string is in the client's `ctx.locale` dictionaries (`uk` and
`en`), including "не обмежено". Host-side diagnostics are structured log records
with stable `event` names rather than sentences, because the session log is read
by maintainers and, in part, by the model — localising it would add cost without
adding clarity.

**D30 — Package metadata carries both language titles.**
`locale/en.json` and `locale/uk.json` provide the title and description the
Plugin Manager shows without activating the plugin.

## Review follow-up (post-implementation audit)

A read-only audit of this repository by a different agent recorded a candidate
backlog in `IMPROVEMENTS.md` (5 P0 correctness items, 10 P1 robustness items,
8 P2 architecture/product gaps). None of it has been applied; the notes below
record only the decisions taken *about* that audit, not fixes to the engine.

**D44 — The audit is a candidate backlog, not a work order.**
The audit's provenance note says plainly that its fixes are unapplied and that the
findings were never agreed with this plugin's author. Until the user asks for one
of the items specifically, the engine stays as shipped, because the existing
suite pins the current behaviour and several items would change it (P0-1 cascade,
P0-2 resume gating, P1-10 settle bucket).

**D45 — Two audit findings are accepted as real defects, and one is retracted.**
1. **P0-1 — RETRACTED; the audit misread the specification.** The claim was that
   `editPolicy({perSecond:10,perMinute:100}, 'perMinute', 3)` should leave
   `perSecond` at 10, because 10 was legal before the edit, and that direction
   should come from the edited field's *previous* value. That rule is directly
   contradicted by the prompt, which states the order as
   `second <= minute <= hour <= day` among bounded windows, that the edited field
   always keeps the typed value, and gives the worked example "per minute = 5, the
   user sets per day = 3, then per minute and per second become 3" — i.e. lowering
   a *larger* window deliberately lowers the *smaller* ones. After a `perMinute`
   of 3 a `perSecond` of 10 is not legal, it is the very violation the rule
   forbids; `{perSecond:3, perMinute:3}` is the required result, and that is what
   the code returns. The audit's own counterexample therefore proves the code
   correct. Pinned by `test/limits.test.js` — "the audit counterexample is the
   correct cascade, not a defect" — alongside the two prompt examples, which
   already passed. No code change; the finding is withdrawn.
2. **P0-3** (`lib/windows.js:397`, `:422`) — `#dropOutside` and `#computeTotals`
   scan all 86 400 slots per call, and `#write` (i.e. every `admit`) pays a scan
   that grows with live buckets: 86 400 records at 1 rps takes ~60 s wall, with
   per-call cost rising from 1.45 ms to 4.65 ms. This is a latency defect on the
   admission path that grows with traffic — the audit's re-measured numbers for
   `describe()` (2.07 ms/model) and a blocked admission (4.16 ms) are the
   *amortised* figures; the cold-first-call 275 ms claim was disproved (5
   consecutive blocked admissions measured 4.16 ms each).
3. **P0-2** (`lib/limiter.js:227-228`) — `describe()` reports
   `requestsResumeMs`/`tokensResumeMs` for a model that is idle at its cap with an
   empty queue (reproduced: `queueDepth=0, requestsResumeMs=1000`), and the
   client duplicates the correct gate at `client/client.js:591-599`. One side
   must own the gate, and it should be the host, because `/state` is a public
   surface.

**D46 — Four audit findings are recorded but deliberately not scheduled.**
- **P1-8** (no auth on `lib/api.js`): real, but the plugin's routes are
  loopback-only by construction (D5) and adding a token means threading a secret
  through the client bundle; revisit only if the web surface is ever exposed.
- **P2-2** (burstown/concurrency limits): the prompt asked for exactly four
  windows; changing the policy shape is a schema change with a migration cost, and
  the audit itself rates it a future extension.
- **P2-5** (`client/client.js` is one 890-line ES5 factory): rewriting the client
  is what produced the last three rounds of "nothing renders" bugs; the file is
  ugly but working, so it is not worth the regression risk now.
- **P2-6** (no CI/coverage floor): no CI runner exists in this environment (the
  npm registry is unreachable, D26), so a config file would be decoration.

**D47 — Audit items that are already covered by existing decisions.**
P1-1 (clock-jump skew reporting) extends D22/D23; P1-2 (sticky oversize warning)
extends D20; P1-5 (duplicate client cascade) is the client half of D10; P1-9
(cooldown after final refusal) interacts with D37's deliberate token-release
rule; P2-1 (custom model key) is the UI half of D18. Each is worth doing **only
together with** its base decision, so applying one without the other would leave
the code inconsistent with these notes.

**D48 — The backlog was then applied in full, with two retractions and three
refusals.** D44–D47 record the first-pass rulings; the user then asked for the
whole list (`m02482`, repeated afterwards: "Застосуй все, що написано в
IMPROVEMENTS.md та DECISIONS.md до коду"). The authoritative outcome is the
disposition table at the top of `IMPROVEMENTS.md`:
applied — P0-2, P0-3, P0-4, P0-5, P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, P1-8,
P1-9, P1-10, P2-1, P2-3, P2-4, P2-8; retracted — P0-1 (D45.1: the code matches
the prompt's own worked example) and P2-7 (the clamp was written and withdrawn:
`MAX_LIMIT` is the validation ceiling for every window, and a per-second-specific
cap would have to be invented and would reject a legal configuration); refused —
P2-2, P2-5, P2-6 (D46). Where a finding gave a "minimal fix" that conflicted with
an existing decision (D47), the base decision won and the change was made in its
terms.

**D49 — A blocked head is not overtaken, because that is what starves it.**
`#pump` stops admitting at the first request that does not fit instead of
skipping it and trying the next. Reason: a later, cheaper request that overtakes
an oversized head refills the window the head is waiting to empty — the head
needs a *completely* empty window (D36) — so it would wait forever while cheaper
traffic kept the window busy. Stopping also makes `#headCost`, which
`#nextFreeMs` uses to compute the wake time, the cost of the request that will
actually go next. This is a deliberate change to the observable FIFO order and is
pinned by a test that asserts a cheap request does not overtake a blocked one.

**D50 — A burst of pumps is coalesced into one document build.**
`llm`'s pump calls `api.notify()` on every admission decision, and building the
snapshot calls `describe()` once per model. `notify()` therefore schedules one
push per tick (`setImmediate`) instead of building immediately; several changes
inside one tick share a single build. The one-second push timer and the write
routes still publish directly, so the spec's "no more than one update per second"
allowance is unchanged, the snapshot comparison still suppresses an unchanged
payload, and a real change still reaches the stream before the next I/O turn.

**D51 — The composer control survives a partial model row.**
The reply to `POST /model-rate-limit/limit` carries the model that was just saved.
The control used to read `policy[kind][window]` off it directly, so a row without
`policy` (or without `usage`) threw inside the render and blanked the whole
control — the one failure mode this bundle exists to prevent, and one that
happened. The render now falls back to "everything unlimited" and reads every
used figure through `usedOf(kind, window)`, which returns `0` for a window the
document does not describe.

**D52 — The test suite must never point at a live profile.**
`test/helpers.js` redirects `DSH_PROFILE_DIR` to a scratch directory at import
time, and `test/persistence.test.js` pins the redirect. Reason: `node --test` is
routinely started from inside a running harness session, where that variable names
the *real* profile; a test that boots the plugin and lets one flush through then
overwrites the running application's `state.json`. This is not hypothetical — the
counter file was rewritten with an empty counter set during a suite run. The
plugin's own behaviour is unchanged; this is a rule about tests.

**D53 — `Sec-Fetch-Site` is decisive when present; the authority comparison is
the fallback.** P1-8's fix compares an `Origin` against the `Host` it was sent to,
but it checks the browser's fetch-site declaration *first* and trusts it outright.
Reason: that header is forbidden to page scripts, so a cross-site caller cannot
claim `same-origin`, while a desktop shell that serves the page from its own
scheme legitimately has a matching address-space but an `Origin` that can never
equal the loopback `Host`. Rejecting that combination would disable the control
silently in the very environment it targets — the failure mode this bundle has
already been through twice. The `Origin`/`Host` comparison therefore applies to
callers that send no fetch-site header at all (curl, scripts, older clients).

## Known limitations accepted deliberately

**D31 — Process-local budgets.**
Sharing a budget across processes would need a distributed store; the plugin
states the limitation instead of pretending to solve it.

**D32 — Flush-window accounting loss.**
A crash can lose up to one flush interval of counters. The conservative
reservation biases the error towards *waiting slightly longer*, which is the safe
direction for a rate limiter.

**D33 — No session-log events.**
The prompt suggested an `llm/admission-wait`-style durable event. The harness
refuses a stored event type it does not know unless the envelope carries
`ignorable: true`, which a live `Session.append()` cannot set, so writing one
could make a session refuse to reopen. The waiting state is therefore exposed
through the control and the host log, and no session event is invented.

**D36 — A limit is a ceiling on what may be inside the window.**
An earlier draft used a strict "projected total stays below the limit" rule and a
test caught the contradiction: a request whose own reservation equals the window
limit could then never be sent, because even an empty window could not satisfy it.
The rule is now `used + need <= limit`, and a request that still cannot fit waits
for a completely empty window. This is the smallest consistent reading of a
window value, and it is the same rule the cascade and the UI assume.

**D37 — A throttled attempt releases its tokens but keeps its request count.**
Charging the failed attempt's tokens would make a retry look like new traffic
against the token budget; dropping the request count would let a provider that
throttles every call consume an unbounded request rate. Releasing the reservation
keeps the token budget honest and the request budget protective.

**D38 — A terminal throttle chunk is withheld until the retry settles.**
A terminal `finish` closes the agent's step, so emitting it before a retry would
leave the retry's chunks with no consumer. The suite asserts that the caller sees
exactly one terminal chunk per request.

**D39 — `findOwnEntry` refuses an ambiguous profile row.**
`configEditor.edit` needs the one row that carries the profile override. When
several rows share the plugin's name, guessing could silently rewrite another
plugin's configuration, so the edit applies live and reports that it was not
persisted.
