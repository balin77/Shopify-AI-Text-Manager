/**
 * ContentPilot — dynamic storefront translation (+ optional string collector).
 *
 * Replaces rendered text nodes on the storefront with merchant-defined
 * translations for the active (non-primary) locale. Covers content not stored
 * in translatable Shopify fields (e.g. third-party app widgets).
 *
 * When the merchant has enabled collection (opt-in), strings that are rendered
 * but NOT yet translated are reported (heuristically filtered, de-duped, capped)
 * to the app so the merchant can review + translate them in the admin. Nothing
 * is ever auto-applied.
 *
 * Limitations: client-side only (no SEO); cannot reach cross-origin iframes.
 */
(function () {
  "use strict";

  var cfgEl = document.getElementById("contentpilot-dt-config");
  if (!cfgEl) return;

  var cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
  } catch (e) {
    return;
  }

  var locale = (cfg.locale || "").toLowerCase();
  var primary = (cfg.primaryLocale || "").toLowerCase();
  var debug = !!cfg.debug;
  var log = debug
    ? function () { try { console.log.apply(console, ["[ContentPilot DT]"].concat([].slice.call(arguments))); } catch (e) {} }
    : function () {};

  if (!locale || (primary && locale === primary)) {
    log("inactive (primary or no locale)", locale, primary);
    return;
  }

  var endpoint = cfg.endpoint || "/apps/contentpilot/dynamic-translations";
  var collectEndpoint = cfg.collectEndpoint || "/apps/contentpilot/collect-strings";
  var template = cfg.template || "";
  var cacheKey = "contentpilot_dt_" + locale;
  var reportedKey = "contentpilot_dt_reported_" + locale;

  var dictMap = new Map();      // normalizedSource → target
  var targetValues = new Set(); // known targets (never collect our own output)
  var collect = false;          // set from the fetched dictionary (opt-in)

  // Whitespace-collapse + trim. MUST match server normalizeSource().
  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function buildMap(entries) {
    var map = new Map();
    targetValues = new Set();
    if (!entries) return map;
    var add = function (obj) {
      if (!obj) return;
      for (var src in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, src)) {
          map.set(src, obj[src]);
          targetValues.add(normalize(obj[src]));
        }
      }
    };
    add(entries.global);
    if (template) add(entries["template:" + template]);
    return map;
  }

  // Conservative heuristic — mirrors server isCollectibleString(). Reduces noise
  // and the chance of capturing PII / dynamic data. The merchant reviews anyway.
  function isCollectible(s) {
    // Mirrors server isCollectibleString() (same order + ranges).
    if (s.length < 2 || s.length > 100) return false;
    if (!/[a-zA-ZÀ-ɏ]/.test(s)) return false;
    if (/^\d/.test(s) && /\d/.test(s) && !/[a-zA-Z]{3,}/.test(s)) return false;
    if (/^[$€£¥]|\d[.,]\d{2}\s*[$€£¥%]?$/.test(s)) return false;
    if (/@|https?:\/\/|www\./i.test(s)) return false;
    if (/^[+]?[\d\s().-]{6,}$/.test(s)) return false;
    return true;
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };

  function shouldSkip(parent) {
    while (parent && parent.nodeType === 1) {
      if (SKIP_TAGS[parent.tagName]) return true;
      if (parent.isContentEditable) return true;
      if (parent.getAttribute && parent.getAttribute("translate") === "no") return true;
      parent = parent.parentNode;
    }
    return false;
  }

  // ---- Collector state ----------------------------------------------------
  function loadReported() {
    try { return new Set(JSON.parse(localStorage.getItem(reportedKey) || "[]")); }
    catch (e) { return new Set(); }
  }
  var reported = loadReported();
  function persistReported() {
    try {
      var arr = Array.from(reported);
      if (arr.length > 2000) arr = arr.slice(arr.length - 2000);
      localStorage.setItem(reportedKey, JSON.stringify(arr));
    } catch (e) {}
  }

  var pendingCandidates = new Map();
  var candidateTimer = null;

  function scheduleCandidateFlush() {
    if (candidateTimer) return;
    candidateTimer = setTimeout(flushCandidates, 3000);
  }

  function flushCandidates() {
    candidateTimer = null;
    if (pendingCandidates.size === 0) return;
    var items = [];
    pendingCandidates.forEach(function (_v, k) {
      if (items.length < 50) { items.push({ text: k, scope: "global" }); reported.add(k); }
    });
    pendingCandidates.clear();
    persistReported();
    try {
      fetch(collectEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "omit",
        body: JSON.stringify({ locale: locale, items: items }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
    log("reported", items.length, "candidates");
  }

  function maybeCollect(norm) {
    if (!collect) return;
    if (reported.has(norm) || pendingCandidates.has(norm)) return;
    if (targetValues.has(norm)) return; // never collect our own translation output
    if (!isCollectible(norm)) return;
    pendingCandidates.set(norm, true);
    scheduleCandidateFlush();
  }

  // ---- DOM application ----------------------------------------------------
  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var norm = normalize(raw);
    if (!norm) return;
    if (shouldSkip(node.parentNode)) return;
    var target = dictMap.get(norm);
    if (target !== undefined && target !== norm) {
      var lead = raw.match(/^\s*/)[0];
      var trail = raw.match(/\s*$/)[0];
      node.nodeValue = lead + target + trail;
      return;
    }
    maybeCollect(norm);
  }

  function active() {
    return dictMap.size > 0 || collect;
  }

  function walk(root) {
    if (!active() || !root) return;
    if (root.nodeType === 3) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var batch = [];
    var n;
    while ((n = walker.nextNode())) batch.push(n);
    for (var i = 0; i < batch.length; i++) translateTextNode(batch[i]);
  }

  // ---- MutationObserver ---------------------------------------------------
  var observer = null;
  var pending = [];
  var scheduled = false;

  function flush() {
    scheduled = false;
    if (!active()) return;
    if (observer) observer.disconnect();
    var nodes = pending;
    pending = [];
    for (var i = 0; i < nodes.length; i++) walk(nodes[i]);
    reconnect();
  }

  function schedule(node) {
    pending.push(node);
    if (scheduled) return;
    scheduled = true;
    (window.requestIdleCallback || window.requestAnimationFrame || function (cb) { setTimeout(cb, 50); })(flush);
  }

  function onMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === "characterData") {
        schedule(m.target);
      } else if (m.addedNodes && m.addedNodes.length) {
        for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
      }
    }
  }

  function reconnect() {
    if (!observer) observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function applyAll() {
    walk(document.body);
    reconnect();
  }

  // ---- Dictionary fetch + cache (stale-while-revalidate) ------------------
  function readCache() {
    try { var raw = localStorage.getItem(cacheKey); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function writeCache(data) {
    try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch (e) {}
  }

  function apply(data) {
    if (!data) return;
    collect = !!data.collect;
    dictMap = data.enabled === false ? new Map() : buildMap(data.entries);
    log("applied", dictMap.size, "entries; collect", collect, "version", data.version);
    if (document.body) applyAll();
  }

  function fetchDict() {
    return fetch(endpoint + "?locale=" + encodeURIComponent(locale), {
      headers: { Accept: "application/json" },
      credentials: "omit",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function start() {
    var cached = readCache();
    if (cached) apply(cached);

    fetchDict().then(function (fresh) {
      if (!fresh) return;
      if (!cached || cached.version !== fresh.version || cached.enabled !== fresh.enabled || cached.collect !== fresh.collect) {
        writeCache(fresh);
        apply(fresh);
      }
    });

    // Best-effort flush of anything still pending when the page is hidden.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flushCandidates();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
