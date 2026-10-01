/**
 * ContentPilot Web Vitals (RUM) — real-user Core Web Vitals collector.
 *
 * Observes LCP, CLS, INP, FCP and TTFB for the current pageview using the
 * browser's PerformanceObserver APIs and sends a single beacon on pageview
 * end (visibilitychange -> hidden, or pagehide, whichever fires first) to
 * the app proxy configured in window.__cpWebVitals.endpoint.
 *
 * Everything here is best-effort and defensive: every entry-type observer is
 * feature-detected via PerformanceObserver.supportedEntryTypes, every block
 * is wrapped in try/catch, and nothing here may ever throw into the
 * storefront page. Missing APIs simply mean fewer metrics are reported (or
 * none, in which case no beacon is sent at all).
 *
 * No visitor identifiers, no cookies — see web-vitals.liquid for the privacy
 * note and web-vitals.types.ts for the exact payload contract.
 */
(function () {
  "use strict";

  try {
    if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;

    var config = window.__cpWebVitals || {};
    var endpoint = config.endpoint || "/apps/contentpilot/web-vitals";
    var template = typeof config.template === "string" ? config.template : "";

    var supportedEntryTypes = PerformanceObserver.supportedEntryTypes || [];
    function supports(type) {
      return supportedEntryTypes.indexOf(type) !== -1;
    }

    // Collected metrics / responsible-element labels, filled in as observers fire.
    var metrics = {};
    var elements = {};

    /** tagname + (#id | .first-class), truncated — never throws. */
    function labelForElement(node) {
      try {
        if (!node || !node.tagName) return undefined;
        var label = node.tagName.toLowerCase();
        if (node.id) {
          label += "#" + node.id;
        } else if (typeof node.className === "string" && node.className.trim()) {
          var firstClass = node.className.trim().split(/\s+/)[0];
          if (firstClass) label += "." + firstClass;
        }
        return label.slice(0, 120);
      } catch (e) {
        return undefined;
      }
    }

    // ---- LCP (largest-contentful-paint) ----------------------------------
    // Keep updating with the latest entry until the first user input, per
    // the standard LCP finalization rule.
    try {
      if (supports("largest-contentful-paint")) {
        var lcpFinalized = false;
        var finalizeLcp = function () {
          lcpFinalized = true;
        };
        var lcpObserver = new PerformanceObserver(function (list) {
          if (lcpFinalized) return;
          var entries = list.getEntries();
          var last = entries[entries.length - 1];
          if (last) {
            metrics.lcpMs = last.startTime;
            var label = labelForElement(last.element);
            if (label) elements.lcp = label;
          }
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
        ["keydown", "click", "pointerdown"].forEach(function (evt) {
          addEventListener(evt, finalizeLcp, { once: true, capture: true });
        });
      }
    } catch (e) {
      /* never break the storefront */
    }

    // ---- CLS (layout-shift, session-windowed) -----------------------------
    // Session window closes on a >1s gap since the last shift or once the
    // window spans >5s; CLS is the max window sum observed so far. The
    // largest-value entry's first source node (best-effort) is attributed.
    try {
      if (supports("layout-shift")) {
        var clsValue = 0;
        var sessionValue = 0;
        var sessionEntries = [];

        var clsObserver = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (entry.hadRecentInput) return;

            var firstSessionEntry = sessionEntries[0];
            var lastSessionEntry = sessionEntries[sessionEntries.length - 1];

            if (
              sessionEntries.length &&
              entry.startTime - lastSessionEntry.startTime < 1000 &&
              entry.startTime - firstSessionEntry.startTime < 5000
            ) {
              sessionValue += entry.value;
              sessionEntries.push(entry);
            } else {
              sessionValue = entry.value;
              sessionEntries = [entry];
            }

            if (sessionValue > clsValue) {
              clsValue = sessionValue;
              metrics.cls = clsValue;
              try {
                var maxEntry = sessionEntries.reduce(function (max, e) {
                  return !max || e.value > max.value ? e : max;
                }, null);
                var source = maxEntry && maxEntry.sources && maxEntry.sources[0];
                var node = source && source.node;
                var label = labelForElement(node);
                if (label) elements.cls = label;
              } catch (e2) {
                /* element attribution is best-effort only */
              }
            }
          });
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      }
    } catch (e) {
      /* never break the storefront */
    }

    // ---- INP (approximated via the "event" timeline) ----------------------
    // Tracks the single longest interaction observed (an adequate INP
    // approximation for this use case, not a strict spec implementation).
    try {
      if (supports("event")) {
        var maxInpDuration = 0;
        var inpObserver = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (!entry.interactionId) return;
            if (entry.duration > maxInpDuration) {
              maxInpDuration = entry.duration;
              metrics.inpMs = entry.duration;
              var label = labelForElement(entry.target);
              if (label) elements.inp = label;
            }
          });
        });
        inpObserver.observe({ type: "event", buffered: true, durationThreshold: 40 });
      }
    } catch (e) {
      /* never break the storefront */
    }

    // ---- FCP (paint) --------------------------------------------------------
    try {
      if (supports("paint")) {
        var fcpObserver = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (entry.name === "first-contentful-paint") {
              metrics.fcpMs = entry.startTime;
            }
          });
        });
        fcpObserver.observe({ type: "paint", buffered: true });
      }
    } catch (e) {
      /* never break the storefront */
    }

    // ---- TTFB (navigation timing) -------------------------------------------
    try {
      if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
        var navEntries = performance.getEntriesByType("navigation");
        var nav = navEntries && navEntries[0];
        if (nav && typeof nav.responseStart === "number" && nav.responseStart > 0) {
          metrics.ttfbMs = nav.responseStart;
        }
      }
    } catch (e) {
      /* never break the storefront */
    }

    // ---- Beacon send, once per pageview -------------------------------------
    var sent = false;
    function sendBeaconOnce() {
      if (sent) return;
      sent = true;

      try {
        var outMetrics = {};
        var hasMetric = false;

        if (typeof metrics.lcpMs === "number") {
          outMetrics.lcpMs = Math.round(metrics.lcpMs);
          hasMetric = true;
        }
        if (typeof metrics.cls === "number") {
          outMetrics.cls = Math.round(metrics.cls * 10000) / 10000;
          hasMetric = true;
        }
        if (typeof metrics.inpMs === "number") {
          outMetrics.inpMs = Math.round(metrics.inpMs);
          hasMetric = true;
        }
        if (typeof metrics.fcpMs === "number") {
          outMetrics.fcpMs = Math.round(metrics.fcpMs);
          hasMetric = true;
        }
        if (typeof metrics.ttfbMs === "number") {
          outMetrics.ttfbMs = Math.round(metrics.ttfbMs);
          hasMetric = true;
        }

        // Nothing observed at all (very old browser, or the page closed
        // before any metric fired) — skip sending entirely.
        if (!hasMetric) return;

        var payload = {
          path: location.pathname,
          template: template,
          device: window.innerWidth < 768 ? "mobile" : "desktop",
          metrics: outMetrics
        };

        var outElements = {};
        var hasElement = false;
        if (elements.lcp) {
          outElements.lcp = elements.lcp;
          hasElement = true;
        }
        if (elements.cls) {
          outElements.cls = elements.cls;
          hasElement = true;
        }
        if (elements.inp) {
          outElements.inp = elements.inp;
          hasElement = true;
        }
        if (hasElement) payload.elements = outElements;

        var body = JSON.stringify(payload);

        if (navigator.sendBeacon) {
          navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
        } else {
          fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body,
            keepalive: true
          }).catch(function () {
            /* beacon delivery is best-effort */
          });
        }
      } catch (e) {
        /* never break the storefront */
      }
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") sendBeaconOnce();
    });
    addEventListener("pagehide", sendBeaconOnce);
  } catch (e) {
    /* never break the storefront */
  }
})();

/**
 * ContentPilot AI-referral beacon — report a visit that arrived from an AI
 * assistant (ChatGPT, Perplexity, Claude, Gemini, Copilot, ...) to the app
 * proxy collector, so ContentPilot -> SEO -> KI-Suche can show whether AEO
 * work produces arrivals at all.
 *
 * It rides in this asset rather than in structured-data.liquid because it is a
 * MEASUREMENT, like the vitals above — the JSON-LD block is markup a merchant
 * may legitimately turn off, and switching off structured data must not
 * silently switch off the visit counter. Its own IIFE on purpose: the vitals
 * collector returns early where PerformanceObserver is missing, and a referral
 * is still worth counting on such a browser.
 *
 * Fires ONLY when the referrer host (or the landing URL's utm_source, which
 * ChatGPT appends to the links it hands out) looks like one of those hosts, so
 * an ordinary pageview sends nothing. The token list here is a cheap PREFILTER
 * to keep normal traffic off the endpoint — the server re-classifies and is
 * the authority, so a token missing here costs a missed visit, never a wrong
 * one.
 *
 * Privacy: the beacon sends the landing path plus the referrer for
 * classification; the server stores only the resulting source key and an
 * aggregate day counter. No cookie, no identifier, nothing that is read back.
 */
(function () {
  "use strict";
  try {
    var cfg = window.__cpWebVitals || {};
    var url = cfg.referralEndpoint || "/apps/contentpilot/ai-referral";
    var ref = document.referrer || "";
    var utm = "";
    try {
      utm = new URLSearchParams(window.location.search).get("utm_source") || "";
    } catch (e) {
      /* no URLSearchParams: utm stays empty, the referrer still decides */
    }
    if (!ref && !utm) return;

    var TOKENS = /chatgpt|openai|perplexity|claude\.ai|gemini\.google|copilot\.microsoft|grok\.com|x\.ai|deepseek|you\.com|poe\.com|mistral/i;
    var refHost = "";
    try {
      refHost = ref ? new URL(ref).hostname : "";
    } catch (e) {
      /* unparseable referrer counts as none */
    }
    // Same-host navigation is the merchant's own storefront, never an arrival.
    if (refHost && refHost === window.location.hostname) return;
    if (!TOKENS.test(refHost) && !TOKENS.test(utm)) return;

    var payload = JSON.stringify({
      path: window.location.pathname,
      referrer: ref,
      utmSource: utm
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    } else {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(function () {
        /* beacon delivery is best-effort */
      });
    }
  } catch (e) {
    /* never break the storefront */
  }
})();
