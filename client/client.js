/**
 * Browser half of dsh-llm-model-rate-limit.
 *
 * Registered into conversation.input.right (left of the model selector).
 * Shows two countdown timers when limits are exhausted, and a small button
 * that opens a limits configuration panel.
 *
 * The module is a plain CJS factory; React arrives through the loader.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-model-rate-limit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'model-rate-limit';
    const BASE = '/model-rate-limit';
    var LIMIT_KINDS = ['requests', 'tokens'];
    var WINDOW_KEYS = ['perSecond', 'perMinute', 'perHour', 'perDay'];
    var UNLIMITED = 0;

    /* ── helpers ──────────────────────────────────────────────────── */

    function unlimitedWord(locale) {
      return String(locale || 'uk').toLowerCase().indexOf('en') === 0 ? 'unlimited' : 'не обмежено';
    }

    var groupers = new Map();
    function groupDigits(value, locale) {
      var key = locale || 'uk';
      var f = groupers.get(key);
      if (!f) {
        try { f = new Intl.NumberFormat(key, { maximumFractionDigits: 0, useGrouping: true }); }
        catch (e) { f = new Intl.NumberFormat('en', { maximumFractionDigits: 0, useGrouping: true }); }
        groupers.set(key, f);
      }
      return f.format(value);
    }

    function formatValue(value, locale) {
      if (value === UNLIMITED) return unlimitedWord(locale);
      return groupDigits(value, locale);
    }

    function countdown(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '--:--';
      var total = Math.ceil(ms / 1000);
      var s = total % 60;
      var m = Math.floor(total / 60) % 60;
      var hours = Math.floor(total / 3600);
      // Minutes alone stop being readable exactly when the wait is longest: a
      // day-limit wait printed as `1440:00`. Past an hour, grow the string
      // instead of the minute field.
      if (hours > 0) return hours + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    /**
     * Countdown remaining for one limit kind.
     *
     * The plugin's `requestsResumeMs` / `tokensResumeMs` are authoritative: they
     * are the exact instants its rolling windows free, measured on its clock.
     * This anchors them to the moment the snapshot arrived (`receivedAt`) and
     * subtracts locally elapsed time, so the seconds tick down between server
     * pushes while every push re-anchors them. It is never an independent guess,
     * only the plugin's own measurement counted from a fixed point.
     *
     * @param {unknown} rawMs - the plugin's remaining milliseconds.
     * @param {number} now - current wall-clock milliseconds.
     * @param {number} receivedAt - wall-clock milliseconds when the snapshot arrived.
     * @returns {number} remaining milliseconds, never negative.
     */
    function remainingMs(rawMs, now, receivedAt) {
      if (typeof rawMs !== 'number' || !isFinite(rawMs) || rawMs <= 0) return 0;
      var elapsed = typeof receivedAt === 'number' && isFinite(receivedAt) ? now - receivedAt : 0;
      if (elapsed < 0) elapsed = 0;
      return Math.max(0, rawMs - elapsed);
    }

    function parseValue(text) {
      var trimmed = String(text || '').trim();
      if (trimmed === '' || /^(не обмежено|необмежено|без обмежень|unlimited|none|off|∞)$/i.test(trimmed))
        return { ok: true, value: 0 };
      var norm = trimmed.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
      if (/^-/.test(norm)) return { ok: false, error: 'negative' };
      var match = /^(\d+(?:\.\d+)?)([kmKM])?$/.exec(norm);
      if (!match) return { ok: false, error: 'notWhole' };
      var factor = !match[2] ? 1 : match[2].toLowerCase() === 'k' ? 1000 : 1000000;
      var scaled = Number(match[1]) * factor;
      if (!Number.isInteger(scaled)) return { ok: false, error: 'notWhole' };
      if (scaled > 1e9) return { ok: false, error: 'tooLarge' };
      return { ok: true, value: scaled };
    }

    function blankWindows() {
      var w = {};
      for (var i = 0; i < WINDOW_KEYS.length; i++) w[WINDOW_KEYS[i]] = UNLIMITED;
      return w;
    }

    /* ── model-selection reading ─────────────────────────────────── */

    function projectionValue(projections, key) {
      if (!projections) return undefined;
      if (typeof projections.get === 'function') {
        var v = projections.get(key);
        if (v !== undefined) return v;
      }
      if (typeof projections.faceOf === 'function') {
        var face = projections.faceOf(key);
        if (face && typeof face.getSnapshot === 'function') return face.getSnapshot();
      }
      return undefined;
    }

    function selectionOf(value) {
      if (!value || typeof value !== 'object') return undefined;
      var candidates = [value.next, value.lastUsed, value.pending, value];
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (!c || typeof c !== 'object') continue;
        if (typeof c.provider === 'string' && c.provider.length > 0 &&
            typeof c.model === 'string' && c.model.length > 0)
          return { provider: c.provider, model: c.model };
      }
      return undefined;
    }

    function currentModelReader(ctx, sessionId) {
      return function () {
        try {
          var sessions = ctx.get('sessions');
          if (!sessions || typeof sessions.binding !== 'function') return undefined;
          var binding = sessions.binding(sessionId);
          if (!binding || !binding.session) return undefined;
          var proj = binding.session.projections;
          var fromProj = selectionOf(projectionValue(proj, 'modelSelection'));
          if (fromProj) return fromProj;
          var dirs = ctx.get('modelDirectories');
          if (!dirs || typeof dirs.directoryFor !== 'function') return undefined;
          var snap = dirs.directoryFor(sessionId).store.getSnapshot();
          return selectionOf(snap.current) || selectionOf(snap.pending) || undefined;
        } catch (e) {
          return undefined;
        }
      };
    }

    function availableModelsReader(ctx, sessionId) {
      return function () {
        var list = [];
        try {
          var dirs = ctx.get('modelDirectories');
          if (!dirs || typeof dirs.directoryFor !== 'function') return list;
          var snap = dirs.directoryFor(sessionId).store.getSnapshot();
          var groups = snap.groups || [];
          for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            var models = g.models || [];
            for (var j = 0; j < models.length; j++) {
              var m = models[j];
              list.push({
                provider: g.id,
                model: m.id,
                providerName: g.name || g.id,
                modelName: m.name || m.id,
              });
            }
          }
        } catch (e) {
          // no scope — return whatever we have
        }
        return list;
      };
    }

    /* ── locale dictionaries ─────────────────────────────────────── */

    var EN = {
      'trigger.title': 'Rate limits',
      'trigger.idle': 'no limits',
      'trigger.unlimited': 'no limits',
      'trigger.waiting': 'waiting',
      'menu.title': 'Rate limits',
      'menu.subtitle': 'Each limit belongs to this model alone.',
      'menu.newModel': 'No limits yet. Type a value below to start.',
      'menu.noModel': 'no model',
      'menu.foot': 'Over-limit requests wait and are sent unchanged.',
      'section.requests': 'Request limit',
      'section.tokens': 'Token limit',
      'window.perSecond': 'Per second',
      'window.perMinute': 'Per minute',
      'window.perHour': 'Per hour',
      'window.perDay': 'Per day',
      'window.short.perSecond': 's',
      'window.short.perMinute': 'min',
      'window.short.perHour': 'h',
      'window.short.perDay': 'day',
      'timer.requests': 'Requests',
      'timer.tokens': 'Tokens',
      'notice.saved': '{window} set to {value}',
      'notice.adjusted': '{window} auto-adjusted to {value}',
      'notice.raised': '{window} auto-raised to {value}',
      'notice.lowered': '{window} auto-lowered to {value}',
      'error.negative': 'Negative values are not allowed',
      'error.notWhole': 'Enter a whole number (k/m suffixes OK)',
      'error.tooLarge': 'Value too large',
      'error.notPersisted': 'Applied live, but not saved: {detail}',
      'summary.unlimited': 'unlimited',
      'stats.waits': 'waited {count} times, {total} in total',
      'stats.throttled': 'provider throttled this model {ago} ago',
    };

    var UK = {
      'trigger.title': 'Ліміти',
      'trigger.idle': 'без обмежень',
      'trigger.unlimited': 'без обмежень',
      'trigger.waiting': 'очікування',
      'menu.title': 'Ліміти',
      'menu.subtitle': 'Кожен ліміт стосується лише цієї моделі.',
      'menu.newModel': 'Лімітів ще немає. Введіть значення нижче.',
      'menu.noModel': 'немає моделі',
      'menu.foot': 'Запити понад ліміт зачекають і надсилаються без змін.',
      'section.requests': 'Ліміт запитів',
      'section.tokens': 'Ліміт токенів',
      'window.perSecond': 'За секунду',
      'window.perMinute': 'За хвилину',
      'window.perHour': 'За годину',
      'window.perDay': 'За добу',
      'window.short.perSecond': 'с',
      'window.short.perMinute': 'хв',
      'window.short.perHour': 'год',
      'window.short.perDay': 'доба',
      'timer.requests': 'Запити',
      'timer.tokens': 'Токени',
      'notice.saved': '{window} — встановлено {value}',
      'notice.adjusted': 'Ліміт {window} автоматично змінено на {value}',
      'notice.raised': 'Ліміт {window} автоматично збільшено до {value}',
      'notice.lowered': 'Ліміт {window} автоматично зменшено до {value}',
      'error.negative': "Від'ємні значення не дозволені",
      'error.notWhole': 'Введіть ціле число (можна k або m)',
      'error.tooLarge': 'Значення завелике',
      'error.notPersisted': 'Застосовано, але не збережено: {detail}',
      'summary.unlimited': 'не обмежено',
      'stats.waits': 'очікувань: {count}, разом {total}',
      'stats.throttled': 'провайдер обмежив цю модель {ago} тому',
    };

    function interpolate(template, values) {
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return values && values[name] !== undefined ? values[name] : match;
      });
    }

    /* ── CSS ─────────────────────────────────────────────────────── */

    var CSS = [
      '.mrl-root{position:relative;display:inline-flex;align-items:center;gap:4px;height:28px;}',
      '.mrl-trigger{display:flex;align-items:center;gap:4px;height:28px;max-width:min(200px,35cqw);',
      'padding:0 6px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;outline:none;',
      'color:var(--dsw-alias-label-secondary,#8a8f98);font-size:13px;line-height:20px;cursor:pointer;}',
      '.mrl-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));}',
      '.mrl-trigger[data-open="true"]{color:var(--dsw-alias-label-primary,#f5f6f7);}',
      '.mrl-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#4d6bfe);}',
      '.mrl-trigger-mark{flex:none;}',
      '.mrl-trigger-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mrl-timer-mini{font-size:11px;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-secondary,#8a8f98);padding:0 2px;}',
      '.mrl-timer-mini-active{color:var(--dsw-alias-state-warn-primary,#dd8629);font-weight:500;}',
      '',
      '.mrl-menu{position:fixed;z-index:1100;box-sizing:border-box;width:min(340px,100vw - 24px);',
      'display:flex;flex-direction:column;gap:4px;padding:8px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.24));',
      'border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff)));',
      'color:var(--dsw-alias-label-primary,#0f1115);',
      'box-shadow:0 12px 32px rgba(0,0,0,0.2),0 2px 8px rgba(0,0,0,0.12);}',
      '.mrl-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:2px 4px;}',
      '.mrl-head-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-head-model{font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;}',
      '.mrl-note,.mrl-foot{padding:0 4px;font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-section{border-radius:var(--dsw-radius-sm,6px);}',
      '.mrl-section-head{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:none;',
      'border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left;}',
      '.mrl-section-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));}',
      '.mrl-section-sign{width:14px;text-align:center;flex:none;}',
      '.mrl-section-title{flex:none;font-size:13px;}',
      '.mrl-section-summary{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mrl-rows{display:flex;flex-direction:column;gap:4px;padding:2px 4px 6px 4px;}',
      '.mrl-row{display:flex;align-items:center;gap:8px;}',
      '.mrl-row-label{flex:none;width:64px;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-input{flex:1 1 auto;min-width:0;height:26px;padding:0 6px;font:inherit;font-size:12px;',
      'color:var(--dsw-alias-label-primary,#0f1115);',
      'background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,rgba(127,127,127,0.08)));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.24));',
      'border-radius:var(--dsw-radius-sm,6px);outline:none;text-align:right;}',
      '.mrl-input::placeholder{color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-input:focus-visible{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}',
      '.mrl-input:disabled{opacity:0.5;cursor:not-allowed;}',
      '.mrl-row-used{flex:none;width:72px;font-size:11px;text-align:right;',
      'color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-timer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:4px 8px;border-radius:var(--dsw-radius-sm,6px);font-size:12px;line-height:18px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.1));}',
      '.mrl-timer-row-label{color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-timer-row-value{font-variant-numeric:tabular-nums;font-weight:500;',
      'color:var(--dsw-alias-label-primary,#0f1115);}',
      '.mrl-timer-row-requests{border-left:3px solid var(--dsw-alias-brand-primary,#4d6bfe);}',
      '.mrl-timer-row-tokens{border-left:3px solid var(--dsw-alias-state-success-primary,#30a46c);}',
      '.mrl-notice,.mrl-error{padding:4px 6px;border-radius:var(--dsw-radius-sm,6px);font-size:12px;line-height:16px;}',
      '.mrl-stats{color:var(--dsw-alias-label-secondary,#61666b);font-size:11px;line-height:16px;padding:2px 6px 0;}',
      '.mrl-notice{color:var(--dsw-alias-state-success-primary,#30a46c);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.1));}',
      '.mrl-error{color:var(--dsw-alias-state-error-primary,#e5484d);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.1));}',
      '.mrl-picker{position:relative;}',
      '.mrl-picker-button{display:flex;align-items:center;gap:4px;max-width:200px;padding:2px 6px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.24));',
      'border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;}',
      '.mrl-picker-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));}',
      '.mrl-picker-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-primary,#0f1115);}',
      '.mrl-picker-chevron{flex:none;color:var(--dsw-alias-label-secondary,#8a8f98);font-size:10px;}',
      '.mrl-picker-panel{position:absolute;top:100%;right:0;z-index:1200;margin-top:4px;',
      'min-width:200px;max-width:260px;max-height:240px;overflow-y:auto;padding:4px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.24));',
      'border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff)));',
      'box-shadow:0 8px 24px rgba(0,0,0,0.2);}',
      '.mrl-picker-group-label{padding:4px 8px 2px;font-size:11px;font-weight:600;',
      'color:var(--dsw-alias-label-secondary,#8a8f98);}',
      '.mrl-picker-option{display:block;width:100%;padding:5px 8px;border:none;',
      'border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;text-align:left;cursor:pointer;}',
      '.mrl-picker-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12));}',
      '.mrl-picker-option-active{color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:500;}',
    ].join('\n');

    /* ── component ────────────────────────────────────────────────── */

    function ModelRateLimitControl(props) {
      var p = props || {};
      var t = p.t || function (k) { return k; };
      var locale = p.locale || 'uk';
      var currentModel = p.currentModel || function () { return undefined; };
      var availableModels = p.availableModels || function () { return []; };

      var openState = React.useState(p.initialOpen === true);
      var open = openState[0];
      var setOpen = openState[1];

      var docState = React.useState(null);
      var stateDoc = docState[0];
      var setDoc = docState[1];

      var errState = React.useState(null);
      var error = errState[0];
      var setError = errState[1];

      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      var expState = React.useState(p.initialOpen === true
        ? { requests: true, tokens: true }
        : { requests: false, tokens: false });
      var expanded = expState[0];
      var setExpanded = expState[1];

      var ovrState = React.useState(null);
      var override = ovrState[0];
      var setOverride = ovrState[1];

      var pickState = React.useState(false);
      var pickerOpen = pickState[0];
      var setPickerOpen = pickState[1];

      var draftState = React.useState({});
      var drafts = draftState[0];
      var setDrafts = draftState[1];

      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var nowState = React.useState(Date.now());
      var now = nowState[0];
      var setNow = nowState[1];

      var anchorRef = React.useRef(null);
      var posRef = React.useRef(null);
      var lastDocRef = React.useRef('');
      /* When the current snapshot arrived, so its countdown values can be
       * anchored and ticked down locally between pushes. */
      var docAtState = React.useState(0);
      var docAt = docAtState[0];
      var setDocAt = docAtState[1];

      /* auto-switch on model change */
      var sessionModel = currentModel();
      var sessionKey = sessionModel ? sessionModel.provider + '/' + sessionModel.model : undefined;
      var lastSessionRef = React.useRef(sessionKey);
      if (lastSessionRef.current !== sessionKey) {
        lastSessionRef.current = sessionKey;
        if (override !== null) {
          setTimeout(function () { setOverride(null); }, 0);
        }
      }

      /* selected model */
      var selected;
      if (override !== null) {
        var match = stateDoc ? findInModels(stateDoc.models, override) : undefined;
        if (match) selected = { provider: match.provider, model: match.model };
        else {
          var split = override.indexOf('/');
          if (split > 0) selected = { provider: override.slice(0, split), model: override.slice(split + 1) };
        }
      }
      if (!selected) selected = currentModel();
      var key = selected ? selected.provider + '/' + selected.model : undefined;

      /* choices with display names */
      var nameLookup = new Map();
      var avail = availableModels();
      for (var ai = 0; ai < avail.length; ai++) {
        var am = avail[ai];
        nameLookup.set(am.provider + '/' + am.model, { providerName: am.providerName, modelName: am.modelName });
      }
      var choices = [];
      var seenKeys = new Set();
      if (stateDoc) {
        for (var di = 0; di < stateDoc.models.length; di++) {
          var dm = stateDoc.models[di];
          if (seenKeys.has(dm.key)) continue;
          seenKeys.add(dm.key);
          var dn = nameLookup.get(dm.key) || {};
          choices.push({
            value: dm.key,
            providerName: dm.providerName || dn.providerName || dm.provider,
            modelName: dm.modelName || dn.modelName || dm.model,
          });
        }
      }
      for (var bi = 0; bi < avail.length; bi++) {
        var bm = avail[bi];
        var bk = bm.provider + '/' + bm.model;
        if (seenKeys.has(bk)) continue;
        seenKeys.add(bk);
        choices.push({
          value: bk,
          providerName: bm.providerName || bm.provider,
          modelName: bm.modelName || bm.model,
        });
      }
      if (key && !seenKeys.has(key)) {
        choices.push({ value: key, providerName: key.split('/')[0] || key, modelName: key.split('/')[1] || '' });
      }
      /* group by provider */
      var groups = [];
      var groupMap = new Map();
      for (var ci = 0; ci < choices.length; ci++) {
        var ch = choices[ci];
        var grp = groupMap.get(ch.providerName);
        if (!grp) { grp = { providerName: ch.providerName, models: [] }; groupMap.set(ch.providerName, grp); groups.push(grp); }
        grp.models.push(ch);
      }

      var activeKey = override || key || (choices.length > 0 ? choices[0].value : undefined);
      var known = (stateDoc && activeKey) ? findInModels(stateDoc.models, activeKey) : undefined;
      if (known && !known.providerName && nameLookup.has(known.key)) {
        var nl = nameLookup.get(known.key);
        known = Object.assign({}, known, {
          providerName: known.providerName || nl.providerName,
          modelName: known.modelName || nl.modelName,
        });
      }
      var editable = activeKey !== undefined;
      // A row can be partial: the write reply carries the model that was just
      // saved, and the host is free to trim it. Reading `policy[kind][window]`
      // off a row that has no policy used to throw inside the render, which
      // blanks the whole composer control — the one failure mode this bundle
      // exists to avoid. Fall back to "everything unlimited" instead.
      var policy = known && known.policy ? known.policy : { requests: blankWindows(), tokens: blankWindows() };
      var usage = known && known.usage ? known.usage : undefined;

      /** The used figure for one window, or 0 when the document does not say. */
      function usedOf(kind, window) {
        var slot = usage && usage[kind] ? usage[kind][window] : undefined;
        return slot && typeof slot.used === 'number' ? slot.used : 0;
      }

      /* fetch + SSE
       *
       * The control is mounted for every session, so the state has to stay live
       * even while the menu is collapsed: the two countdowns are rendered in the
       * composer toolbar, next to the model selector, and a collapsed control
       * with no state would never show them.
       *
       * Collapsed, it reads the small state document on a slow poll. Open, it
       * subscribes to the server-sent stream, which pushes at most once per
       * second and only while something is actually waiting.
       */
      React.useEffect(function () {
        var cancelled = false;
        var stream = null;
        var poll = null;
        function applyDoc(next) {
          var text = JSON.stringify(next);
          if (text === lastDocRef.current) return;
          lastDocRef.current = text;
          setDocAt(Date.now());
          setDoc(next);
          setError(null);
        }
        function readOnce() {
          fetch(BASE + '/state', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('state ' + r.status)); })
            .then(function (d) { if (!cancelled) applyDoc(d); })
            .catch(function (e) { if (!cancelled) setError(String(e.message || e)); });
        }
        readOnce();
        if (open) {
          if (typeof EventSource === 'function') {
            stream = new EventSource(BASE + '/events');
            stream.addEventListener('snapshot', function (ev) {
              try { applyDoc(JSON.parse(ev.data)); } catch (e2) {}
            });
            stream.addEventListener('error', function () {});
          } else {
            poll = setInterval(readOnce, 1000);
          }
        } else {
          /* Only poll while a countdown is on screen; otherwise stay idle. */
          poll = setInterval(function () {
            var doc = lastDocRef.current;
            if (doc && doc.indexOf('"queueDepth":0') === -1) readOnce();
          }, 2000);
        }
        return function () {
          cancelled = true;
          if (stream) stream.close();
          if (poll) clearInterval(poll);
        };
      }, [open]);

      /* The visible countdowns tick locally once a second. They run while the
       * control is collapsed too, because that is where the timers live. */
      React.useEffect(function () {
        var timer = setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { clearInterval(timer); };
      }, []);

      React.useEffect(function () {
        if (!open) return;
        function close(ev) {
          if (ev.type === 'keydown' && ev.key !== 'Escape') return;
          if (ev.type === 'mousedown' && anchorRef.current && anchorRef.current.parentElement) {
            if (!anchorRef.current.parentElement.contains(ev.target)) { setOpen(false); return; }
          }
          if (ev.type === 'keydown') setOpen(false);
        }
        window.addEventListener('keydown', close);
        window.addEventListener('mousedown', close);
        return function () {
          window.removeEventListener('keydown', close);
          window.removeEventListener('mousedown', close);
        };
      }, [open]);

      React.useEffect(function () {
        if (!notice) return;
        var timer = setTimeout(function () { setNotice(null); }, 6000);
        return function () { clearTimeout(timer); };
      }, [notice]);

      /* Countdowns. The plugin's own numbers are authoritative:
       * `requestsResumeMs` and `tokensResumeMs` are the exact instants its windows
       * free, measured on its clock, and they are already gated on "is something
       * actually waiting" by the host — a model idle at its cap reports 0, so a
       * countdown only appears when a request is queued or a cooldown is active.
       * The control anchors those to the moment the snapshot arrived and subtracts
       * locally elapsed time, so the seconds tick down smoothly between server
       * pushes while every push re-anchors them. The displayed value is therefore
       * never an independent guess, only the same measurement counted from a
       * fixed point.
       */
      var reqExhausted = known && usage && WINDOW_KEYS.some(function (w) {
        var l = policy.requests[w]; return l !== UNLIMITED && usedOf('requests', w) >= l;
      });
      var tokExhausted = known && usage && WINDOW_KEYS.some(function (w) {
        var l = policy.tokens[w]; return l !== UNLIMITED && usedOf('tokens', w) >= l;
      });
      var reqRaw = (known && reqExhausted) ? Math.max(0, known.requestsResumeMs || 0) : 0;
      var tokRaw = (known && tokExhausted) ? Math.max(0, known.tokensResumeMs || 0) : 0;
      var reqRemaining = remainingMs(reqRaw, now, docAt);
      var tokRemaining = remainingMs(tokRaw, now, docAt);

      /* label */
      var label;
      if (!editable) label = t('trigger.idle');
      else {
        var parts = [];
        for (var ki = 0; ki < LIMIT_KINDS.length; ki++) {
          var kind = LIMIT_KINDS[ki];
          var bounded = WINDOW_KEYS.filter(function (w) { return policy[kind][w] !== UNLIMITED; });
          if (bounded.length === 0) continue;
          label = groupDigits(policy[kind][bounded[0]], locale) + '/' + t('window.short.' + bounded[0]);
          parts.push(label);
        }
        label = parts.length === 0 ? t('trigger.unlimited') : parts.join(' · ');
      }

      /* tightest used/limit indicator */
      function tightest(kind) {
        if (!usage) return undefined;
        for (var i = 0; i < WINDOW_KEYS.length; i++) {
          var w = WINDOW_KEYS[i];
          var l = policy[kind][w];
          if (l !== UNLIMITED) return { window: w, limit: l, used: usedOf(kind, w) };
        }
        return undefined;
      }

      /* P2-3: one line of wait history for the model on screen. */
      function statsLine(row) {
        if (!row || !row.stats) return null;
        var waits = row.stats.waits || 0;
        var throttled = row.stats.lastThrottledAgoMs;
        if (waits === 0 && (throttled === null || throttled === undefined)) return null;
        var parts = [];
        if (waits > 0)
          parts.push(t('stats.waits', { count: groupDigits(waits, locale), total: durationText(row.stats.waitMs) }));
        if (throttled !== null && throttled !== undefined)
          parts.push(t('stats.throttled', { ago: durationText(throttled) }));
        return h('div', { className: 'mrl-stats' }, parts.join(' · '));
      }

      /* commit */
      function commit(kind, window, text) {
        var field = kind + '.' + window;
        if (!activeKey) return;
        var parsed = parseValue(text);
        if (!parsed.ok) { setError(t('error.' + parsed.error)); setDrafts(function (c) { var n = Object.assign({}, c); delete n[field]; return n; }); return; }
        setDrafts(function (c) { var n = Object.assign({}, c); delete n[field]; return n; });
        setBusy(true);
        fetch(BASE + '/limit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: activeKey, kind: kind, window: window,
            value: parsed.value === 0 ? undefined : parsed.value,
            unlimited: parsed.value === 0 || undefined,
          }),
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (!body.ok) throw new Error(body.error || 'limit failed');
            lastDocRef.current = '';
            setDocAt(Date.now());
            setDoc(function (cur) {
              if (!cur) return cur;
              var models = cur.models.slice();
              var found = false;
              for (var i = 0; i < models.length; i++) {
                if (models[i].key === body.model.key) { models[i] = body.model; found = true; break; }
              }
              if (!found) models.push(body.model);
              return Object.assign({}, cur, { models: models });
            });
            setError(null);
            // The host's answer is authoritative. The client used to re-derive
            // the cascade locally and fall back to that guess whenever the host
            // reported none, which could invent a notice that never happened.
            var reported = body.adjustments || [];
            if (reported.length > 0) {
              var first = reported[0];
              // The cascade moves windows in both directions, so the notice says
              // which one happened instead of always claiming a raise.
              var noticeKey = 'notice.adjusted';
              if (typeof first.from === 'number' && typeof first.to === 'number')
                noticeKey = first.to > first.from ? 'notice.raised' : 'notice.lowered';
              setNotice({
                text: t(noticeKey, { window: t('window.' + first.window), value: formatValue(first.to, locale) }),
              });
            } else {
              setNotice({ text: t('notice.saved', { window: t('window.' + window), value: formatValue(parsed.value, locale) }) });
            }
            if (body.persisted && !body.persisted.ok)
              setError(t('error.notPersisted', { detail: String(body.persisted.error || '') }));
          })
          .catch(function (e) { setError(String(e.message || e)); })
          .finally(function () { setBusy(false); });
      }

      /* ── render ── */

      function summaryOf(windows) {
        var bounded = WINDOW_KEYS.filter(function (w) { return windows[w] !== UNLIMITED; });
        if (bounded.length === 0) return t('summary.unlimited');
        return bounded.map(function (w) {
          return groupDigits(windows[w], locale) + '/' + t('window.short.' + w);
        }).join(' · ');
      }

      function section(kind) {
        var isOpen = expanded[kind] === true;
        var readOnly = !editable;
        var windows = policy[kind];
        var ind = tightest(kind);
        return h('div', { className: 'mrl-section', key: kind },
          h('button', {
            type: 'button', className: 'mrl-section-head',
            'aria-expanded': isOpen ? 'true' : 'false',
            onClick: function () { setExpanded(function (c) { var n = Object.assign({}, c); n[kind] = !isOpen; return n; }); },
          },
          h('span', { className: 'mrl-section-sign', 'aria-hidden': 'true' }, isOpen ? '−' : '+'),
          h('span', { className: 'mrl-section-title' }, t('section.' + kind)),
          h('span', { className: 'mrl-section-summary' },
            ind ? groupDigits(ind.used, locale) + '/' + groupDigits(ind.limit, locale) : summaryOf(windows))),
          isOpen ? h('div', { className: 'mrl-rows' },
            WINDOW_KEYS.map(function (window) {
              var field = kind + '.' + window;
              var text = drafts[field] !== undefined ? drafts[field] : formatValue(windows[window], locale);
              var used = usage && ind && ind.window === window ? usedOf(kind, window) : 0;
              return h('label', { className: 'mrl-row', key: window },
                h('span', { className: 'mrl-row-label' }, t('window.' + window)),
                h('input', {
                  className: 'mrl-input', type: 'text', inputMode: 'numeric', spellCheck: false,
                  placeholder: unlimitedWord(locale), disabled: readOnly || busy, value: text,
                  'aria-label': t('section.' + kind) + ': ' + t('window.' + window),
                  onFocus: function (ev) { ev.target.select(); },
                  onChange: function (ev) {
                    setDrafts(function (c) { var n = Object.assign({}, c); n[field] = ev.target.value; return n; });
                  },
                  onBlur: function (ev) { commit(kind, window, ev.target.value); },
                  onKeyDown: function (ev) {
                    if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); }
                    if (ev.key === 'Escape') {
                      setDrafts(function (c) { var n = Object.assign({}, c); delete n[field]; return n; });
                      ev.currentTarget.blur();
                    }
                  },
                }),
                h('span', { className: 'mrl-row-used' },
                  used > 0 ? groupDigits(used, locale) : ''));
            })
          ) : null
        );
      }

      /* trigger button */
      var trigger = h('button', {
        ref: anchorRef, type: 'button', className: 'mrl-trigger',
        'data-open': open ? 'true' : 'false',
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        title: t('trigger.title'),
        onClick: function () {
          var node = anchorRef.current;
          if (node && typeof node.getBoundingClientRect === 'function') {
            var rect = node.getBoundingClientRect();
            posRef.current = { left: rect.left, top: rect.top };
          }
          setOpen(function (c) { return !c; });
        },
      },
        h('span', { className: 'mrl-trigger-mark', 'aria-hidden': 'true' }, '⏱'),
        h('span', { className: 'mrl-trigger-label' },
          (reqRemaining > 0 || tokRemaining > 0)
            ? t('trigger.waiting') + ' ' + countdown(Math.max(reqRemaining, tokRemaining))
            : label)
      );

      /* mini timers (always visible in toolbar, left of model selector) */
      var miniTimers = [];
      if (reqRemaining > 0) {
        miniTimers.push(h('span', { className: 'mrl-timer-mini mrl-timer-mini-active', key: 'req' },
          '⏸' + countdown(reqRemaining)));
      }
      if (tokRemaining > 0) {
        miniTimers.push(h('span', { className: 'mrl-timer-mini mrl-timer-mini-active', key: 'tok' },
          '⏸' + countdown(tokRemaining)));
      }

      if (!open) return h('span', { className: 'mrl-root' }, trigger, miniTimers.length > 0 ? miniTimers : null);

      /* menu position */
      var pos = posRef.current;
      var menuTop = pos ? Math.max(12, pos.top - 12) : undefined;
      var menuLeft = pos ? Math.min(pos.left, Math.max(12, window.innerWidth - 340)) : undefined;

      /* model display name */
      var activeChoice = choices.find(function (c) { return c.value === activeKey; });
      var displayName = activeChoice ? activeChoice.modelName : (activeKey || t('menu.noModel'));

      return h('span', { className: 'mrl-root' },
        trigger,
        miniTimers.length > 0 ? miniTimers : null,
        h('div', {
          className: 'mrl-menu', role: 'dialog',
          style: { left: menuLeft ? menuLeft + 'px' : undefined, top: menuTop ? menuTop + 'px' : undefined, transform: 'translateY(-100%)' },
        },
          /* header with model picker */
          h('div', { className: 'mrl-head' },
            h('span', { className: 'mrl-head-title' }, t('menu.title')),
            choices.length > 1 ? h('div', { className: 'mrl-picker' },
              h('button', {
                type: 'button', className: 'mrl-picker-button',
                'aria-expanded': pickerOpen ? 'true' : 'false',
                onClick: function () { setPickerOpen(function (c) { return !c; }); },
              },
              h('span', { className: 'mrl-picker-label' }, displayName),
              h('span', { className: 'mrl-picker-chevron', 'aria-hidden': 'true' }, pickerOpen ? '▾' : '▸')),
              pickerOpen ? h('div', { className: 'mrl-picker-panel', role: 'listbox' },
                groups.map(function (grp) {
                  return h('div', { className: 'mrl-picker-group', key: grp.providerName },
                    h('div', { className: 'mrl-picker-group-label' }, grp.providerName),
                    grp.models.map(function (ch) {
                      return h('button', {
                        key: ch.value, type: 'button',
                        className: 'mrl-picker-option' + (ch.value === activeKey ? ' mrl-picker-option-active' : ''),
                        onClick: function () { setOverride(ch.value); setPickerOpen(false); },
                      }, ch.modelName);
                    })
                  );
                })
              ) : null
            ) : h('span', { className: 'mrl-head-model' }, displayName)
          ),
          editable ? h('div', { className: 'mrl-note' }, known ? t('menu.subtitle') : t('menu.newModel'))
                   : h('div', { className: 'mrl-note' }, t('menu.noModel')),
          section('requests'),
          section('tokens'),
          /* two separate timer rows inside the menu */
          reqRemaining > 0 ? h('div', { className: 'mrl-timer-row mrl-timer-row-requests' },
            h('span', { className: 'mrl-timer-row-label' }, t('timer.requests')),
            h('span', { className: 'mrl-timer-row-value' }, countdown(reqRemaining))) : null,
          tokRemaining > 0 ? h('div', { className: 'mrl-timer-row mrl-timer-row-tokens' },
            h('span', { className: 'mrl-timer-row-label' }, t('timer.tokens')),
            h('span', { className: 'mrl-timer-row-value' }, countdown(tokRemaining))) : null,
          known && known.warning ? h('div', { className: 'mrl-error' }, String(known.warning)) : null,
          notice ? h('div', { className: 'mrl-notice' }, notice.text) : null,
          error ? h('div', { className: 'mrl-error' }, error) : null,
          statsLine(known),
          h('div', { className: 'mrl-foot' }, t('menu.foot'))
        )
      );
    }

    /* Compact duration for the wait-statistics line: ASCII unit suffixes keep it
       language-neutral, and the sentence around them comes from the dictionary. */
      function durationText(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '0s';
        var total = Math.floor(ms / 1000);
        var h = Math.floor(total / 3600);
        var m = Math.floor(total / 60) % 60;
        var s = total % 60;
        if (h > 0) return h + 'h ' + m + 'm';
        if (m > 0) return m + 'm ' + s + 's';
        return s + 's';
      }

      function findInModels(models, key) {
      if (!models) return undefined;
      for (var i = 0; i < models.length; i++) {
        if (models[i].key === key) return models[i];
      }
      return undefined;
    }

    /* ── factory return ──────────────────────────────────────────── */

    return {
      inject: ['slots', 'locale'],
      ModelRateLimitControl: ModelRateLimitControl,
      /** Model-selection normalization, exported so its shapes can be tested. */
      selectionOf: selectionOf,
      /** Countdown arithmetic, exported so it can be tested without a renderer. */
      remainingMs: remainingMs,
      countdown: countdown,
      /** Compact duration used by the wait-statistics line. */
      durationText: durationText,
      apply: function (ctx) {
        /* styles */
        var styles = ctx.get('styles');
        if (styles && typeof styles.insert === 'function') {
          ctx.effect(function () { return styles.insert(CSS); }, 'model-rate-limit: styles');
        } else if (typeof document !== 'undefined') {
          var tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-llm-model-rate-limit';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          ctx.effect(function () { return function () { tag.remove(); }; }, 'model-rate-limit: styles');
        }
        /* locale */
        var boundT = ctx.locale.bind(NS);
        ctx.effect(function () { return ctx.locale.register(NS, { en: EN, uk: UK }); }, 'model-rate-limit: dict');
        /* slot */
        ctx.slots.inject('conversation.input.right', function () {
          ctx.slots.register({
            name: 'conversation.input.right',
            id: 'model-rate-limit',
            order: 20,
            label: function () { return boundT('menu.title'); },
          }, function (inputProps) {
            var p = inputProps || {};
            var sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined;
            var readCurrent = sessionId ? currentModelReader(ctx, sessionId) : function () { return undefined; };
            var readAvail = sessionId ? availableModelsReader(ctx, sessionId) : function () { return []; };
            var locale = ctx.locale.getLocale().id || 'uk';
            return h(ModelRateLimitControl, {
              t: function (name, values) { return interpolate(boundT(name), values || {}); },
              locale: locale,
              currentModel: readCurrent,
              availableModels: readAvail,
            });
          });
        });
      },
    };
  },
});
