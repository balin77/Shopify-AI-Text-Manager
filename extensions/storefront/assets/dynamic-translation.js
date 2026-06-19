/**
 * ContentPilot — dynamic storefront translation.
 *
 * Replaces rendered text nodes on the storefront with merchant-defined
 * translations for the active (non-primary) locale. Covers content not stored
 * in translatable Shopify fields (e.g. third-party app widgets).
 *
 * Strategy:
 *  - Fetch the locale dictionary from the app proxy; cache in localStorage with
 *    a version (stale-while-revalidate: apply cached instantly, revalidate in
 *    the background, re-apply if the version changed).
 *  - Initial full DOM pass + a MutationObserver for content injected later.
 *  - Whitespace-normalized matching (mirrors the server's normalizeSource).
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

  // No locale, or we're on the primary language → nothing to translate.
  if (!locale || (primary && locale === primary)) {
    log("inactive (primary or no locale)", locale, primary);
    return;
  }

  var endpoint = cfg.endpoint || "/apps/contentpilot/dynamic-translations";
  var template = cfg.template || "";
  var cacheKey = "contentpilot_dt_" + locale;

  // Whitespace-collapse + trim. MUST match server normalizeSource().
  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  // Merge global + template-scoped entries (template overrides global).
  function buildMap(entries) {
    var map = new Map();
    if (!entries) return map;
    var add = function (obj) {
      if (!obj) return;
      for (var src in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, src)) map.set(src, obj[src]);
      }
    };
    add(entries.global);
    if (template) add(entries["template:" + template]);
    return map;
  }

  var dictMap = new Map();

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

  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var norm = normalize(raw);
    if (!norm) return;
    var target = dictMap.get(norm);
    if (target === undefined || target === norm) return;
    if (shouldSkip(node.parentNode)) return;
    // Preserve original leading/trailing whitespace around the replaced text.
    var lead = raw.match(/^\s*/)[0];
    var trail = raw.match(/\s*$/)[0];
    node.nodeValue = lead + target + trail;
  }

  function walk(root) {
    if (dictMap.size === 0 || !root) return;
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

  // ---- MutationObserver: re-apply to content injected after load ----------
  var observer = null;
  var pending = [];
  var scheduled = false;

  function flush() {
    scheduled = false;
    if (dictMap.size === 0) return;
    // Detach while we mutate so our own changes don't re-trigger the observer.
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
    try {
      var raw = localStorage.getItem(cacheKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(data));
    } catch (e) {}
  }

  function apply(data) {
    if (!data || data.enabled === false) {
      dictMap = new Map();
      return;
    }
    dictMap = buildMap(data.entries);
    log("dictionary applied", dictMap.size, "entries, version", data.version);
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
    if (cached) apply(cached); // instant from cache

    fetchDict().then(function (fresh) {
      if (!fresh) return;
      // Re-apply only when something actually changed (version or first load).
      if (!cached || cached.version !== fresh.version || cached.enabled !== fresh.enabled) {
        writeCache(fresh);
        apply(fresh);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
