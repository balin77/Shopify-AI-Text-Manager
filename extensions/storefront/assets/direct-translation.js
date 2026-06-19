/**
 * ContentPilot — direct storefront translation ("Direktübersetzungen")
 * (+ optional string collector + optional visual capture mode).
 *
 * Replaces rendered text nodes on the storefront with merchant-defined
 * translations for the active (non-primary) locale. Covers content not stored in
 * translatable Shopify fields (e.g. third-party app widgets). The theme app
 * embed being active is the on/off switch — there is no separate enable flag.
 * Direct translations are global (no scope).
 *
 * When the merchant has enabled collection (opt-in), strings that are rendered
 * but NOT yet translated are reported (heuristically filtered, de-duped, capped)
 * to the app so the merchant can review them in the admin. Nothing is ever
 * auto-applied.
 *
 * In the theme editor (Shopify.designMode) — or on the live page with
 * ?cp-translate=1 — a visual capture mode lets the merchant click rendered text
 * to add it directly as an item (+ optional translation).
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

  // Keep the CANONICAL Shopify casing (e.g. "pt-BR", "zh-CN") for everything
  // sent to / matched on the server — the admin stores translations under the
  // canonical locale and the proxy's isValidLocale() requires the uppercase
  // region subtag. Only a lower-cased copy is used for client storage keys.
  var locale = cfg.locale || "";
  var primary = cfg.primaryLocale || "";
  var localeKey = locale.toLowerCase();
  var isPrimaryLocale = !!locale && !!primary && localeKey === primary.toLowerCase();
  var debug = !!cfg.debug;
  var log = debug
    ? function () { try { console.log.apply(console, ["[ContentPilot DT]"].concat([].slice.call(arguments))); } catch (e) {} }
    : function () {};

  var endpoint = cfg.endpoint || "/apps/contentpilot/dynamic-translations";
  var collectEndpoint = cfg.collectEndpoint || "/apps/contentpilot/collect-strings";
  var addEndpoint = cfg.addEndpoint || "/apps/contentpilot/direct-add";
  var cacheKey = "contentpilot_dt_" + localeKey;
  var reportedKey = "contentpilot_dt_reported_" + localeKey;

  // Visual capture mode: only in the theme editor, or explicit ?cp-translate=1.
  var designMode = !!(window.Shopify && window.Shopify.designMode);
  var forceCapture = /[?&]cp-translate=1\b/.test(window.location.search);
  var captureEnabled = designMode || forceCapture;

  // Translation is inactive on the primary locale (or no locale), but the
  // visual capture mode may still run (to add source strings while previewing
  // the primary language).
  var translateActive = !!locale && !isPrimaryLocale;
  if (!translateActive) log("translation inactive (primary or no locale)", locale, primary);

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
    for (var src in entries) {
      if (Object.prototype.hasOwnProperty.call(entries, src)) {
        map.set(src, entries[src]);
        targetValues.add(normalize(entries[src]));
      }
    }
    return map;
  }

  // Conservative heuristic — mirrors server isCollectibleString(). Reduces noise
  // and the chance of capturing PII / dynamic data. The merchant reviews anyway.
  function isCollectible(s) {
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
      if (parent.id === "contentpilot-capture-panel" || parent.closest && parent.closest("#contentpilot-capture-panel")) return true;
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
      if (items.length < 50) { items.push({ text: k }); reported.add(k); }
    });
    pendingCandidates.clear();
    persistReported();
    try {
      fetch(collectEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "omit",
        body: JSON.stringify({ items: items }),
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
    dictMap = translateActive ? buildMap(data.entries) : new Map();
    log("applied", dictMap.size, "entries; collect", collect, "version", data.version);
    if (document.body) applyAll();
  }

  function fetchDict() {
    if (!translateActive && !captureEnabled) return Promise.resolve(null);
    return fetch(endpoint + "?locale=" + encodeURIComponent(locale || primary), {
      headers: { Accept: "application/json" },
      credentials: "omit",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ---- Visual capture mode (theme editor) ---------------------------------
  function applyOneTranslation(source, target) {
    if (!target) return;
    dictMap.set(normalize(source), target);
    targetValues.add(normalize(target));
    applyAll();
  }

  function postAdd(sourceText, captureLocale, targetText) {
    return fetch(addEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "omit",
      body: JSON.stringify({ sourceText: sourceText, locale: captureLocale, targetText: targetText }),
    }).then(function (r) { return r.ok ? r.json() : null; });
  }

  function initCaptureMode() {
    if (!captureEnabled) return;

    var panel = document.createElement("div");
    panel.id = "contentpilot-capture-panel";
    panel.setAttribute("translate", "no");
    panel.style.cssText = [
      "position:fixed", "bottom:16px", "right:16px", "z-index:2147483646",
      "background:#1a1a1a", "color:#fff", "font:13px/1.4 -apple-system,system-ui,sans-serif",
      "border-radius:10px", "box-shadow:0 4px 20px rgba(0,0,0,.35)", "padding:12px",
      "width:300px", "box-sizing:border-box",
    ].join(";");

    var selecting = false;
    panel.innerHTML =
      '<div style="font-weight:600;margin-bottom:8px">ContentPilot — Direktübersetzungen</div>' +
      '<button id="cp-cap-toggle" style="width:100%;padding:8px;border:0;border-radius:6px;cursor:pointer;background:#008060;color:#fff;font-weight:600">Auswahlmodus starten</button>' +
      '<div id="cp-cap-hint" style="margin-top:8px;opacity:.7;font-size:12px">Klicke einen Text auf der Seite, um ihn zu erfassen.</div>' +
      '<div id="cp-cap-form" style="display:none;margin-top:10px"></div>';

    document.body.appendChild(panel);

    var toggleBtn = panel.querySelector("#cp-cap-toggle");
    var hint = panel.querySelector("#cp-cap-hint");
    var formEl = panel.querySelector("#cp-cap-form");

    function setSelecting(on) {
      selecting = on;
      toggleBtn.textContent = on ? "Auswahlmodus stoppen" : "Auswahlmodus starten";
      toggleBtn.style.background = on ? "#bf0711" : "#008060";
      hint.style.display = on ? "block" : "none";
      document.documentElement.style.cursor = on ? "crosshair" : "";
    }

    toggleBtn.addEventListener("click", function () { setSelecting(!selecting); });

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function showForm(source) {
      setSelecting(false);
      formEl.style.display = "block";
      formEl.innerHTML =
        '<label style="display:block;opacity:.7;margin-bottom:4px">Quelle</label>' +
        '<textarea id="cp-cap-src" rows="2" style="width:100%;box-sizing:border-box;border-radius:6px;border:0;padding:6px">' + escapeHtml(source) + "</textarea>" +
        '<label style="display:block;opacity:.7;margin:8px 0 4px">Übersetzung (' + escapeHtml(locale || primary) + ")</label>" +
        '<textarea id="cp-cap-tgt" rows="2" style="width:100%;box-sizing:border-box;border-radius:6px;border:0;padding:6px"></textarea>' +
        '<button id="cp-cap-save" style="width:100%;margin-top:8px;padding:8px;border:0;border-radius:6px;cursor:pointer;background:#008060;color:#fff;font-weight:600">Zur Übersetzung hinzufügen</button>' +
        '<div id="cp-cap-status" style="margin-top:6px;font-size:12px;opacity:.8"></div>';

      var saveBtn = formEl.querySelector("#cp-cap-save");
      var statusEl = formEl.querySelector("#cp-cap-status");
      saveBtn.addEventListener("click", function () {
        var src = formEl.querySelector("#cp-cap-src").value;
        var tgt = formEl.querySelector("#cp-cap-tgt").value;
        statusEl.textContent = "Speichern …";
        postAdd(src, locale, tgt)
          .then(function (res) {
            if (res && res.ok) {
              statusEl.textContent = "✓ Hinzugefügt";
              if (tgt) applyOneTranslation(src, tgt);
            } else {
              statusEl.textContent = "Fehler beim Speichern";
            }
          })
          .catch(function () { statusEl.textContent = "Fehler beim Speichern"; });
      });
    }

    document.addEventListener(
      "click",
      function (e) {
        if (!selecting) return;
        if (panel.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        var text = normalize(e.target.textContent || "");
        if (text) showForm(text);
      },
      true,
    );

    log("capture mode ready");
  }

  function start() {
    var cached = readCache();
    if (cached) apply(cached);

    fetchDict().then(function (fresh) {
      if (fresh) {
        if (!cached || cached.version !== fresh.version || cached.collect !== fresh.collect) {
          writeCache(fresh);
          apply(fresh);
        }
      }
      initCaptureMode();
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
