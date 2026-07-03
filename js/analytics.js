/* ═══════════════════════════════════════════════════════════════════════════
 * GoMagic Affiliate — Share Analytics Service
 * ───────────────────────────────────────────────────────────────────────────
 * A small, modular, framework-free tracking layer for the Share Page.
 *
 * Design goals
 *  - Reuse the existing localStorage-based referral infrastructure
 *    (the `gomagic_referrer_code` key set in index.html).
 *  - Record every user interaction exactly once (built-in de-duplication).
 *  - Be future-proof: new event types are added by extending ACTION_TYPES
 *    only — no changes to the recording/reporting logic are required.
 *  - Be backend-ready: events are written through a pluggable "sink" so a
 *    real API endpoint (e.g. navigator.sendBeacon) can be added later without
 *    touching call sites.
 *
 * Public API (window.GoMagicAnalytics)
 *  - ACTION_TYPES            → registry of known action types (extensible)
 *  - track(action, details)  → record a single event
 *  - getEvents()             → all stored events (newest first)
 *  - getSummary()            → aggregated totals keyed by action type
 *  - filter(criteria)        → filtered event list
 *  - clear()                 → wipe stored events (admin utility)
 *  - registerSink(fn)        → add a delivery target (backend, console, …)
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (window) {
  'use strict';

  var STORAGE_KEY = 'gomagic_analytics_events';
  var VISITOR_KEY = 'gomagic_visitor_id';
  var REFERRER_KEY = 'gomagic_referrer_code'; // shared with index.html referral system
  var MAX_EVENTS = 5000; // safety cap to keep localStorage bounded

  /* ─────────────────────────────────────────────────────────────────────────
   * ACTION TYPE REGISTRY
   * Add future event types here. Each entry: id, label (for the dashboard),
   * and an optional `summary` flag to surface it as a headline metric card.
   * Nothing else in the codebase needs to change to support a new event.
   * ─────────────────────────────────────────────────────────────────────── */
  var ACTION_TYPES = {
    IMAGE_DOWNLOAD: { id: 'image_download', label: 'Downloaded an image', summary: true },
    VIDEO_DOWNLOAD: { id: 'video_download', label: 'Downloaded a video', summary: true },
    REFERRAL_COPY:  { id: 'referral_copy',  label: 'Copied referral link', summary: true },

    // ── Future-proofing: pre-registered, not yet emitted anywhere ──
    SHARE_CLICK:    { id: 'share_click',    label: 'Clicked a share button', summary: false },
    ASSET_VIEW:     { id: 'asset_view',     label: 'Viewed an asset',        summary: false },
    QR_SCAN:        { id: 'qr_scan',        label: 'Scanned QR code',        summary: false }
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * IDENTITY HELPERS
   * ─────────────────────────────────────────────────────────────────────── */
  function uid(prefix) {
    var rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    return (prefix || '') + rand;
  }

  // A persistent anonymous identifier for the current visitor (the referred user).
  function getVisitorId() {
    var id;
    try {
      id = window.localStorage.getItem(VISITOR_KEY);
      if (!id) {
        id = uid('u_');
        window.localStorage.setItem(VISITOR_KEY, id);
      }
    } catch (e) {
      id = uid('u_'); // storage unavailable — ephemeral id
    }
    return id;
  }

  // Resolve the referrer id from (in priority order):
  //   1. ?ref= URL parameter
  //   2. referrer code captured/persisted by index.html
  //   3. a code embedded in the ?link= share URL (…?code=XXXX or /r/XXXX)
  function getReferrerId() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fromUrl = params.get('ref');
      if (fromUrl && fromUrl.trim()) return fromUrl.trim();

      var stored = window.localStorage.getItem(REFERRER_KEY);
      if (stored && stored.trim()) return stored.trim();

      var link = params.get('link');
      if (link) {
        var codeMatch = link.match(/[?&]code=([^&]+)/) || link.match(/\/r\/([^/?#]+)/);
        if (codeMatch && codeMatch[1]) return decodeURIComponent(codeMatch[1]);
      }
    } catch (e) { /* ignore */ }
    return 'unknown';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * STORAGE (default sink)
   * ─────────────────────────────────────────────────────────────────────── */
  function readAll() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function persist(event) {
    try {
      var list = readAll();
      list.push(event);
      if (list.length > MAX_EVENTS) list = list.slice(list.length - MAX_EVENTS);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
      // Storage full / unavailable — fail silently so UX is never blocked.
      if (window.console) console.warn('[GoMagicAnalytics] persist failed:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * SINKS
   * A sink is any function(event) that delivers an event somewhere.
   * The localStorage sink is registered by default. A backend can be added via
   * registerSink() without changing any call site, e.g.:
   *   GoMagicAnalytics.registerSink(function (e) {
   *     navigator.sendBeacon('/api/track', JSON.stringify(e));
   *   });
   * ─────────────────────────────────────────────────────────────────────── */
  var sinks = [persist];

  function registerSink(fn) {
    if (typeof fn === 'function') sinks.push(fn);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * DE-DUPLICATION
   * Guarantees an action is recorded once per genuine interaction. A short
   * time window collapses accidental double-fires (double clicks, re-entrant
   * handlers) for the same visitor + action + asset.
   * ─────────────────────────────────────────────────────────────────────── */
  var DEDUP_WINDOW_MS = 1500;
  var recentKeys = {};

  function isDuplicate(key) {
    var now = Date.now();
    var last = recentKeys[key];
    recentKeys[key] = now;
    return last && (now - last) < DEDUP_WINDOW_MS;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * CORE: track()
   * ─────────────────────────────────────────────────────────────────────── */
  function normalizeAction(action) {
    if (!action) return null;
    // Accept an ACTION_TYPES entry, its id string, or a raw custom string.
    if (typeof action === 'object' && action.id) return action.id;
    return String(action);
  }

  function track(action, details) {
    details = details || {};
    var actionId = normalizeAction(action);
    if (!actionId) return null;

    var visitorId = details.userId || getVisitorId();
    var referrerId = details.referrerId || getReferrerId();
    var assetName = details.assetName || null;

    var dedupKey = visitorId + '|' + actionId + '|' + (assetName || '');
    if (details.dedupe !== false && isDuplicate(dedupKey)) return null;

    var event = {
      id: uid('e_'),
      userId: visitorId,
      referrerId: referrerId,
      action: actionId,
      assetName: assetName,
      timestamp: new Date().toISOString(),
      meta: details.meta || {}
    };

    for (var i = 0; i < sinks.length; i++) {
      try { sinks[i](event); } catch (e) { /* one bad sink must not break others */ }
    }
    return event;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * REPORTING API (used by the Share Admin dashboard)
   * ─────────────────────────────────────────────────────────────────────── */
  function getEvents() {
    // Newest first.
    return readAll().slice().sort(function (a, b) {
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
  }

  function labelFor(actionId) {
    for (var k in ACTION_TYPES) {
      if (ACTION_TYPES[k].id === actionId) return ACTION_TYPES[k].label;
    }
    return actionId;
  }

  function getSummary() {
    var events = readAll();
    var totals = { total: events.length };
    // Seed known action types at 0 so cards render even before any events.
    for (var k in ACTION_TYPES) totals[ACTION_TYPES[k].id] = 0;
    events.forEach(function (e) {
      totals[e.action] = (totals[e.action] || 0) + 1;
    });
    return totals;
  }

  function filter(criteria) {
    criteria = criteria || {};
    var from = criteria.from ? new Date(criteria.from).getTime() : null;
    var to = criteria.to ? new Date(criteria.to).getTime() : null;
    var text = criteria.text ? String(criteria.text).toLowerCase() : null;

    return getEvents().filter(function (e) {
      if (criteria.referrerId && e.referrerId !== criteria.referrerId) return false;
      if (criteria.userId && e.userId !== criteria.userId) return false;
      if (criteria.action && e.action !== criteria.action) return false;

      var t = new Date(e.timestamp).getTime();
      if (from !== null && t < from) return false;
      if (to !== null && t > to) return false;

      if (text) {
        var hay = [e.userId, e.referrerId, e.action, e.assetName, labelFor(e.action)]
          .join(' ').toLowerCase();
        if (hay.indexOf(text) === -1) return false;
      }
      return true;
    });
  }

  function clear() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * EXPORT
   * ─────────────────────────────────────────────────────────────────────── */
  window.GoMagicAnalytics = {
    ACTION_TYPES: ACTION_TYPES,
    track: track,
    getEvents: getEvents,
    getSummary: getSummary,
    filter: filter,
    clear: clear,
    labelFor: labelFor,
    getVisitorId: getVisitorId,
    getReferrerId: getReferrerId,
    registerSink: registerSink
  };
})(window);
