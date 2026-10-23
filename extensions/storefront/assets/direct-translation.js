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
 * In the theme editor (Shopify.designMode) a visual capture mode lets the
 * merchant click rendered text to add it directly as an item. It is NEVER
 * shown on a live storefront — real visitors must not see the panel. The
 * designMode gate is UI only: the server refuses every capture that does not
 * carry the short-lived capture token minted by the admin page (see
 * readCaptureToken below and app/services/direct-capture-token.server.ts).
 *
 * Limitations: client-side only (no SEO); cannot reach cross-origin iframes.
 */
(function () {
  "use strict";

  // Capture token on the URL (?cp_capture=<token>, from the admin's deep
  // link): taken off the address bar FIRST, synchronously and unconditionally
  // (live storefront included, config missing or not), so it is never left in
  // the history, a copied link or a Referer — whatever else this script does.
  var CAPTURE_PARAM = "cp_capture";
  var urlCaptureToken = null;
  try {
    var startParams = new URLSearchParams(window.location.search);
    if (startParams.has(CAPTURE_PARAM)) {
      urlCaptureToken = startParams.get(CAPTURE_PARAM);
      startParams.delete(CAPTURE_PARAM);
      var startQs = startParams.toString();
      try {
        history.replaceState(history.state, "", window.location.pathname + (startQs ? "?" + startQs : "") + window.location.hash);
      } catch (e) {}
    }
  } catch (e) {}

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
  // Current market (Shopify localization.market.id, numeric) — drives
  // market-specific direct translations. Empty on shops without markets / older
  // embeds → the server serves the global dictionary (backward compatible).
  var market = cfg.market != null ? String(cfg.market) : "";
  var marketKey = market || "0";
  var debug = !!cfg.debug;
  var log = debug
    ? function () { try { console.log.apply(console, ["[ContentPilot DT]"].concat([].slice.call(arguments))); } catch (e) {} }
    : function () {};

  var endpoint = cfg.endpoint || "/apps/contentpilot/dynamic-translations";
  var collectEndpoint = cfg.collectEndpoint || "/apps/contentpilot/collect-strings";
  var addEndpoint = cfg.addEndpoint || "/apps/contentpilot/direct-add";
  // Market is part of the cache key so a buyer switching market/country in the
  // same browser never sees another market's cached dictionary.
  var cacheKey = "contentpilot_dt_" + localeKey + "_" + marketKey;
  var reportedKey = "contentpilot_dt_reported_" + localeKey;

  // Visual capture tool: shown ONLY in the theme editor preview
  // (Shopify.designMode), gated by the embed's "capture tool" checkbox AND
  // the Max-plan availability reported by the dictionary endpoint. Real
  // storefront visitors never see it.
  var captureTool = cfg.captureTool !== false; // default on
  var designMode = !!(window.Shopify && window.Shopify.designMode);
  var captureRequested = captureTool && designMode;
  var featureAvailable = false; // set from the fetched dictionary

  // Translation runs on every locale (incl. primary): the source string is
  // auto-detected per item, so an EN widget label on a DE-primary store needs
  // a DE entry served on the German storefront. Only "no locale at all" turns
  // translation off (the capture mode may still run on top of that).
  var translateActive = !!locale;
  if (!translateActive) log("translation inactive (no locale)", locale, primary);

  var dictMap = new Map();      // normalizedSource → target
  var targetValues = new Set(); // known targets (never collect our own output)
  var collect = false;          // set from the fetched dictionary (opt-in)
  var ignoreTranslateNo = false; // set from the fetched dictionary (opt-in)

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
    if (s.length < 2 || s.length > 1500) return false;
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
      // translate="no" is normally respected (3rd-party widgets use it to
      // fence off browser auto-translate). The merchant can opt-in via the
      // admin to walk into those subtrees anyway — needed for Judge.me etc.
      if (!ignoreTranslateNo && parent.getAttribute && parent.getAttribute("translate") === "no") return true;
      if (parent.id === "contentpilot-capture-panel" || parent.closest && parent.closest("#contentpilot-capture-panel")) return true;
      parent = parent.parentNode;
    }
    return false;
  }

  // ---- Collector state ----------------------------------------------------
  // The "already reported" set is keyed by string AND piggy-backed on the
  // dictionary's `version`. Whenever the server bumps the version (item added,
  // deleted, settings changed) we throw the local set away — otherwise a
  // string we collected before the merchant deleted its item would never be
  // re-reported, and the merchant would think the collector is broken.
  var reportedVersion = 0;
  function loadReported() {
    try {
      var raw = JSON.parse(localStorage.getItem(reportedKey) || "{}");
      if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
        reportedVersion = Number(raw.version) || 0;
        return new Set(raw.items);
      }
      // Legacy format (plain array) — keep it for one session, will be
      // overwritten on the next persist with the new shape.
      if (Array.isArray(raw)) return new Set(raw);
    } catch (e) {}
    return new Set();
  }
  var reported = loadReported();
  function persistReported() {
    try {
      var arr = Array.from(reported);
      if (arr.length > 2000) arr = arr.slice(arr.length - 2000);
      localStorage.setItem(reportedKey, JSON.stringify({ version: reportedVersion, items: arr }));
    } catch (e) {}
  }
  function maybeResetReportedForVersion(v) {
    var nextVersion = Number(v) || 0;
    if (nextVersion && reportedVersion && nextVersion !== reportedVersion) {
      reported = new Set();
    }
    reportedVersion = nextVersion || reportedVersion;
    persistReported();
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
        // `locale` lets the server-side language filter drop candidates whose
        // detected language already matches the visitor locale (= no
        // translation needed). Server ignores it unless the filter is enabled.
        body: JSON.stringify({ items: items, locale: locale }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
    log("reported", items.length, "candidates");
  }

  function maybeCollect(norm) {
    if (!collect) return;
    // Never collect inside the theme editor: that page renders our own
    // admin-side UI overlays which would otherwise leak into the merchant's
    // candidate list as noise.
    if (designMode) return;
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
    if (target !== undefined) {
      // Any dictionary hit (incl. an intentional 1:1 entry for the locale that
      // matches the source language) means this string is known/translated —
      // never collect it again. Only rewrite the DOM when the value differs.
      if (target !== norm) {
        var lead = raw.match(/^\s*/)[0];
        var trail = raw.match(/\s*$/)[0];
        node.nodeValue = lead + target + trail;
      }
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
    ignoreTranslateNo = !!data.ignoreTranslateNo;
    // Hydrate `featureAvailable` from cached payloads too — otherwise a
    // network-failing first request leaves the capture tool dead on every
    // subsequent page load even though the dictionary itself is cached.
    if (typeof data.available === "boolean") featureAvailable = data.available;
    dictMap = translateActive ? buildMap(data.entries) : new Map();
    // A version change means the merchant changed items/settings — discard
    // the local "reported" cache so freshly-relevant strings can be reported
    // again (e.g. after an item was deleted and the string reappears).
    maybeResetReportedForVersion(data.version);
    log("applied", dictMap.size, "entries; collect", collect, "ignoreTranslateNo", ignoreTranslateNo, "version", data.version);
    if (document.body) applyAll();
  }

  function fetchDict() {
    if (!translateActive && !captureRequested) return Promise.resolve(null);
    return fetch(endpoint + "?locale=" + encodeURIComponent(locale || primary) + "&market=" + encodeURIComponent(market), {
      headers: { Accept: "application/json" },
      credentials: "omit",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ---- Visual capture mode (theme editor) ---------------------------------
  // Capture token: the server refuses every capture without one (the app
  // proxy cannot tell the merchant from an anonymous visitor). The admin page
  // mints it and hands it over through the "open capture mode" deep link
  // (?cp_capture=<token> on the preview URL) or as a code the merchant pastes
  // into the panel. Kept in sessionStorage (this tab only, gone when it
  // closes) until it expires, so navigating inside the editor preview (which
  // drops the query) keeps it — never localStorage, which every storefront
  // script can read and which outlives the editing session.
  var captureTokenKey = "contentpilot_dt_capture_token";

  function tokenExpiry(token) {
    try {
      var body = String(token).split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      while (body.length % 4) body += "=";
      var data = JSON.parse(atob(body));
      return typeof data.e === "number" ? data.e : 0;
    } catch (e) {
      return 0;
    }
  }

  function usableToken(token) {
    return typeof token === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) &&
      token.length <= 512 && tokenExpiry(token) > Date.now();
  }

  function storeToken(token) {
    try { sessionStorage.setItem(captureTokenKey, token); } catch (e) {}
  }

  function clearToken() {
    try { sessionStorage.removeItem(captureTokenKey); } catch (e) {}
  }

  // Earlier builds kept the token in localStorage; drop any such copy.
  try { localStorage.removeItem(captureTokenKey); } catch (e) {}

  function readCaptureToken() {
    // A token on the URL wins (fresh from the app); it was already stripped
    // from the address bar at script start.
    if (usableToken(urlCaptureToken)) {
      storeToken(urlCaptureToken);
      return urlCaptureToken;
    }
    var stored = null;
    try { stored = sessionStorage.getItem(captureTokenKey); } catch (e) {}
    if (usableToken(stored)) return stored;
    if (stored) clearToken();
    return null;
  }

  var captureToken = designMode ? readCaptureToken() : null;

  function postAdd(sourceText, translateAll) {
    return fetch(addEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "omit",
      body: JSON.stringify({ sourceText: sourceText, translateAll: !!translateAll, captureToken: captureToken || "" }),
    }).then(function (r) {
      if (r.status === 403) return { ok: false, tokenRejected: true };
      if (r.status === 429) return { ok: false, rateLimited: true };
      return r.json().catch(function () { return null; });
    });
  }

  // Theme-editor only: when the merchant lands on the editor but the shop
  // isn't on the Max plan, render a one-line notice instead of silently doing
  // nothing — otherwise the embed feels broken ("I enabled it, why does it
  // not work?"). Customers on the live storefront never see this.
  // Texts of the theme-editor capture panel and the plan notice, in the
  // language the preview is showing (`request.locale.iso_code`, the config's
  // `locale`) — the closest thing to the merchant's language that Liquid can
  // see. Kept here rather than in the block, because the block counts against
  // the extension's 100 KiB Liquid budget and this asset does not. Unknown
  // languages fall back to English.
  var UI_STRINGS = {
    de: {
      title: "ContentPilot — Direktübersetzungen",
      planGate: "Diese Funktion erfordert den Max-Plan. Im App-Admin auf einen passenden Plan upgraden, dann lädt das Embed automatisch.",
      hint: "Klicke einen beliebigen Text auf der Seite, um ihn zu erfassen.",
      codePlaceholder: "Erfassungscode einfügen",
      codeApply: "Code übernehmen",
      codeInvalid: "Ungültiger oder abgelaufener Code.",
      needToken: "Öffne den Erfassungsmodus in ContentPilot unter „Direktübersetzungen“ → „Erfassungsmodus öffnen“, oder füge den dort kopierten Code hier ein.",
      tokenExpired: "Der Erfassungscode ist abgelaufen oder ungültig. ",
      source: "Quelle",
      add: "Zur Übersetzungsliste hinzufügen",
      addAll: "Hinzufügen und in alle Sprachen übersetzen",
      sourceEmpty: "Quelle ist leer",
      saving: "Speichern …",
      rateLimited: "Zu viele Anfragen — bitte einen Moment warten.",
      itemLimit: "Die Höchstzahl an Direktübersetzungen ist erreicht.",
      addedAll: "✓ Hinzugefügt — Übersetzung in alle Sprachen läuft …",
      added: "✓ Hinzugefügt",
      saveError: "Fehler beim Speichern",
    },
    en: {
      title: "ContentPilot — Direct translations",
      planGate: "This feature requires the Max plan. Upgrade to a suitable plan in the app admin, and the embed loads automatically.",
      hint: "Click any text on the page to capture it.",
      codePlaceholder: "Paste capture code",
      codeApply: "Use code",
      codeInvalid: "Invalid or expired code.",
      needToken: "Open capture mode in ContentPilot under “Direct translations” → “Open capture mode”, or paste the code copied there.",
      tokenExpired: "The capture code has expired or is invalid. ",
      source: "Source",
      add: "Add to translation list",
      addAll: "Add and translate into all languages",
      sourceEmpty: "Source is empty",
      saving: "Saving …",
      rateLimited: "Too many requests — please wait a moment.",
      itemLimit: "The maximum number of direct translations has been reached.",
      addedAll: "✓ Added — translating into all languages …",
      added: "✓ Added",
      saveError: "Could not save",
    },
    es: {
      title: "ContentPilot — Traducciones directas",
      planGate: "Esta función requiere el plan Max. Cambia a un plan adecuado en el panel de la app y el embed se cargará automáticamente.",
      hint: "Haz clic en cualquier texto de la página para capturarlo.",
      codePlaceholder: "Pega el código de captura",
      codeApply: "Usar código",
      codeInvalid: "Código no válido o caducado.",
      needToken: "Abre el modo captura en ContentPilot en «Traducciones directas» → «Abrir modo captura», o pega aquí el código copiado allí.",
      tokenExpired: "El código de captura ha caducado o no es válido. ",
      source: "Origen",
      add: "Añadir a la lista de traducciones",
      addAll: "Añadir y traducir a todos los idiomas",
      sourceEmpty: "El origen está vacío",
      saving: "Guardando …",
      rateLimited: "Demasiadas solicitudes: espera un momento.",
      itemLimit: "Se ha alcanzado el número máximo de traducciones directas.",
      addedAll: "✓ Añadido: traduciendo a todos los idiomas …",
      added: "✓ Añadido",
      saveError: "Error al guardar",
    },
  };
  var T = UI_STRINGS[localeKey.split("-")[0]] || UI_STRINGS.en;

  function maybeShowPlanGateNotice() {
    if (!designMode || featureAvailable) return;
    if (document.getElementById("contentpilot-plan-gate")) return;
    var notice = document.createElement("div");
    notice.id = "contentpilot-plan-gate";
    notice.setAttribute("translate", "no");
    notice.style.cssText = [
      "position:fixed", "top:16px", "right:16px", "z-index:2147483646",
      "background:#fff4e5", "color:#3a2d00", "border:1px solid #f0b400",
      "font:13px/1.4 -apple-system,system-ui,sans-serif",
      "border-radius:8px", "box-shadow:0 4px 20px rgba(0,0,0,.15)",
      "padding:10px 12px", "max-width:320px", "box-sizing:border-box",
    ].join(";");
    notice.innerHTML =
      '<div style="font-weight:600;margin-bottom:4px">' + T.title + '</div>' +
      '<div style="opacity:.85">' + T.planGate + '</div>';
    document.body.appendChild(notice);
  }

  function initCaptureMode() {
    maybeShowPlanGateNotice();
    if (!captureRequested || !featureAvailable) return;

    var panel = document.createElement("div");
    panel.id = "contentpilot-capture-panel";
    panel.setAttribute("translate", "no");
    panel.style.cssText = [
      "position:fixed", "bottom:16px", "right:16px", "z-index:2147483646",
      "background:#1a1a1a", "color:#fff", "font:13px/1.4 -apple-system,system-ui,sans-serif",
      "border-radius:10px", "box-shadow:0 4px 20px rgba(0,0,0,.35)", "padding:12px",
      "width:300px", "box-sizing:border-box",
    ].join(";");

    // Always-on selection: no start step. Clicking any text on the page captures
    // it. The merchant turns the whole tool off via the embed checkbox.
    panel.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px">' + T.title + '</div>' +
      '<div id="cp-cap-token" style="display:none"></div>' +
      '<div id="cp-cap-hint" style="opacity:.7;font-size:12px">' + T.hint + '</div>' +
      '<div id="cp-cap-form" style="display:none;margin-top:10px"></div>';

    document.body.appendChild(panel);

    var tokenEl = panel.querySelector("#cp-cap-token");
    var hint = panel.querySelector("#cp-cap-hint");
    var formEl = panel.querySelector("#cp-cap-form");

    // designMode is already enforced by the captureRequested gate above; the
    // panel + cursor + click interception only ever run in the theme editor,
    // and the click capture only while a capture token is present.
    function setCaptureActive(active) {
      document.documentElement.style.cursor = active ? "crosshair" : "";
      tokenEl.style.display = active ? "none" : "block";
      hint.style.display = active ? "block" : "none";
      if (!active) formEl.style.display = "none";
    }

    function showTokenPrompt(message) {
      tokenEl.innerHTML =
        '<div style="opacity:.85;font-size:12px">' + escapeHtml(message) + '</div>' +
        '<input id="cp-cap-code" type="text" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(T.codePlaceholder) + '" ' +
        'style="width:100%;box-sizing:border-box;margin-top:8px;border-radius:6px;border:0;padding:6px;color:#111">' +
        btn("cp-cap-code-ok", T.codeApply, true) +
        '<div id="cp-cap-code-status" style="margin-top:6px;font-size:12px;opacity:.85"></div>';
      setCaptureActive(false);
      tokenEl.querySelector("#cp-cap-code-ok").addEventListener("click", function () {
        var code = String(tokenEl.querySelector("#cp-cap-code").value || "").trim();
        if (!usableToken(code)) {
          tokenEl.querySelector("#cp-cap-code-status").textContent = T.codeInvalid;
          return;
        }
        captureToken = code;
        storeToken(code);
        setCaptureActive(true);
      });
    }

    var NEED_TOKEN_TEXT = T.needToken;

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function btn(id, label, primaryStyle) {
      return '<button id="' + id + '" style="display:block;width:100%;margin-top:8px;padding:8px;border:0;border-radius:6px;cursor:pointer;font-weight:600;background:' +
        (primaryStyle ? "#008060" : "#3a3a3a") + ';color:#fff">' + label + "</button>";
    }

    function showForm(source) {
      hint.style.display = "none";
      formEl.style.display = "block";
      formEl.innerHTML =
        '<label style="display:block;opacity:.7;margin-bottom:4px">' + T.source + '</label>' +
        '<textarea id="cp-cap-src" rows="2" style="width:100%;box-sizing:border-box;border-radius:6px;border:0;padding:6px;color:#111">' + escapeHtml(source) + "</textarea>" +
        btn("cp-cap-add", T.add, true) +
        btn("cp-cap-add-all", T.addAll, false) +
        '<div id="cp-cap-status" style="margin-top:8px;font-size:12px;opacity:.85"></div>';

      var statusEl = formEl.querySelector("#cp-cap-status");

      function run(translateAll) {
        var src = formEl.querySelector("#cp-cap-src").value;
        if (!normalize(src)) { statusEl.textContent = T.sourceEmpty; return; }
        statusEl.textContent = T.saving;
        postAdd(src, translateAll)
          .then(function (res) {
            if (res && res.tokenRejected) {
              captureToken = null;
              clearToken();
              showTokenPrompt(T.tokenExpired + NEED_TOKEN_TEXT);
              return;
            }
            if (res && res.rateLimited) {
              statusEl.textContent = T.rateLimited;
              return;
            }
            if (res && res.error === "itemLimitReached") {
              statusEl.textContent = T.itemLimit;
              return;
            }
            statusEl.textContent = res && res.ok
              ? (translateAll ? T.addedAll : T.added)
              : T.saveError;
          })
          .catch(function () { statusEl.textContent = T.saveError; });
      }

      formEl.querySelector("#cp-cap-add").addEventListener("click", function () { run(false); });
      formEl.querySelector("#cp-cap-add-all").addEventListener("click", function () { run(true); });
    }

    document.addEventListener(
      "click",
      function (e) {
        if (panel.contains(e.target)) return;
        if (!captureToken) return; // no proof yet → the page behaves normally
        e.preventDefault();
        e.stopPropagation();
        var text = normalize(e.target.textContent || "");
        if (text) showForm(text);
      },
      true,
    );

    if (captureToken) setCaptureActive(true);
    else showTokenPrompt(NEED_TOKEN_TEXT);

    log("capture mode ready (designMode)", captureToken ? "with token" : "waiting for token");
  }

  function start() {
    var cached = readCache();
    if (cached) apply(cached);

    fetchDict().then(function (fresh) {
      if (fresh) {
        featureAvailable = !!fresh.available;
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
