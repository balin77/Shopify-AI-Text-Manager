/**
 * "Images and videos per language" — the storefront swap
 * (blocks/localized-media.liquid feeds it). Rewrites every image URL on the
 * page that shows an ORIGINAL the merchant replaced for the visitor's
 * language/market, and marks the element (`data-cp-lm`) so the pre-paint
 * style stops hiding it.
 *
 * Videos are swapped INSIDE the element the theme rendered, never by
 * rebuilding it: a `<video>` whose sources belong to a replaced Shopify video
 * gets the replacement's sources (matched by the video's hash directory), an
 * `<iframe>` showing a replaced YouTube/Vimeo video gets the replacement's
 * embed address with the theme's own query (autoplay, controls…) carried
 * over, and the poster image shown before playback is swapped like any other
 * image. Themes keep the player in a `<template>` until it is clicked
 * (Dawn's deferred media), so template CONTENT is rewritten too — before the
 * player is ever inserted, so the original never starts loading.
 *
 * Matching is by FILENAME, the one key every spelling of a Shopify image URL
 * carries: `/cdn/shop/files/x.jpg?v=1&width=800`,
 * `//cdn.shopify.com/s/files/1/…/files/x.jpg`, and the legacy `img_url`
 * suffix form `x_800x.jpg`. The size the theme asked for (width/height/crop)
 * is carried onto the replacement, so a thumbnail stays a thumbnail.
 *
 * A MutationObserver covers galleries that render later (variant switches,
 * our own variant gallery, lazy loaders). Every URL this script writes is
 * remembered and never rewritten again, so the observer cannot loop even on a
 * map that swaps two originals for each other. Only Shopify image URLs are
 * touched (cdn.shopify.com or the shop's /cdn/shop/ path), so another app's
 * picture that happens to share a filename is left alone.
 */
(function () {
  "use strict";
  var style = document.getElementById("cp-lm-prehide");
  function unhide() {
    if (style) style.remove();
    style = null;
  }
  var dataEl = document.getElementById("cp-lm-data");
  if (!dataEl) return unhide();
  var data;
  try {
    data = JSON.parse(dataEl.textContent || "{}");
  } catch (e) {
    return unhide();
  }
  var market = String(data.k || "");
  var locale = String(data.l || "").toLowerCase();
  // The island carries every entry of the product; only the visitor's
  // language counts, and this market's entry beats the all-markets one.
  var map = {}; // image filename (and video poster filename) -> replacement url
  var videoMap = {}; // Shopify video key -> replacement sources [{u, t}]
  var embedMap = {}; // "youtube.<id>" / "vimeo.<id>" -> replacement embed url
  function put(target, key, value, isMarket) {
    if (!target[key] || isMarket) target[key] = value;
  }
  (data.e || []).forEach(function (e) {
    if (!e || !e.o || String(e.l || "").toLowerCase() !== locale) return;
    var k = e.k ? String(e.k) : "";
    if (k && k !== market) return;
    var key = String(e.o).toLowerCase();
    if (!e.x) {
      if (e.u) put(map, key, e.u, !!k);
      return;
    }
    if (e.p && e.u) put(map, String(e.p).toLowerCase(), e.u, !!k);
    if (e.x === "v" && Array.isArray(e.w) && e.w.length) put(videoMap, String(e.o), e.w, !!k);
    if (e.x === "e" && e.r) put(embedMap, key, e.r, !!k);
  });
  if (!Object.keys(map).length && !Object.keys(videoMap).length && !Object.keys(embedMap).length) return unhide();
  // Every URL this script wrote. A replacement is never rewritten again, even
  // when its filename is itself an original somewhere in the map (the app
  // refuses that, but a hand-edited metafield could still carry A→B and B→A,
  // which would otherwise loop through the observer for ever).
  var written = new Set();
  function isShopifyImageUrl(url) {
    return url.hostname === "cdn.shopify.com" || url.pathname.indexOf("/cdn/shop/") === 0;
  }

  var LEGACY_SIZE =
    /_(pico|icon|thumb|small|compact|medium|large|grande|original|master|\d+x\d*|\d*x\d+)(_crop_[a-z]+)?(@\dx)?(?=\.[a-z0-9]+$)/i;
  var PASS_PARAMS = ["width", "height", "crop"];

  function replacementFor(raw) {
    if (!raw) return null;
    var url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      return null;
    }
    if (written.has(url.toString()) || !isShopifyImageUrl(url)) return null;
    var segs = url.pathname.split("/");
    var file = segs[segs.length - 1] || "";
    // The exact name first: a real filename may END in something that looks
    // like a legacy size suffix ("banner_1200x628.jpg"). Only when the exact
    // name is unknown is the suffix read as the old img_url size form.
    var target = map[file.toLowerCase()];
    var legacy = null;
    if (!target) {
      legacy = file.match(LEGACY_SIZE);
      if (!legacy) return null;
      target = map[file.replace(LEGACY_SIZE, "").toLowerCase()];
      if (!target) return null;
    }
    var out;
    try {
      out = new URL(target, location.href);
    } catch (e) {
      return null;
    }
    PASS_PARAMS.forEach(function (p) {
      var v = url.searchParams.get(p);
      if (v) out.searchParams.set(p, v);
    });
    if (legacy && !out.searchParams.get("width")) {
      var w = /^(\d+)x/.exec(legacy[1]);
      if (w) out.searchParams.set("width", w[1]);
    }
    var result = out.toString();
    written.add(result);
    return result;
  }

  function rewriteSrcset(value) {
    var changed = false;
    // Candidates are separated by a comma FOLLOWED BY WHITESPACE; a bare
    // comma may be part of a URL (image CDNs with transform parameters).
    var next = value
      .split(/,\s+/)
      .map(function (part) {
        var bits = part.trim().split(/\s+/);
        var rep = replacementFor(bits[0]);
        if (rep) {
          changed = true;
          bits[0] = rep;
        }
        return bits.join(" ");
      })
      .join(", ");
    return changed ? next : null;
  }

  var VIDEO_KEY = /\/videos\/c\/(?:vp|o\/v)\/([A-Za-z0-9]{8,64})/;
  function videoKeyOf(raw) {
    var m = raw ? VIDEO_KEY.exec(String(raw).split("?")[0]) : null;
    return m ? m[1] : null;
  }

  // A <video> playing a replaced Shopify video: its sources are swapped for
  // the replacement's, once (data-cp-lm-v), and a live element is reloaded.
  function applyVideo(video) {
    if (video.hasAttribute("data-cp-lm-v")) return;
    var urls = [video.getAttribute("src")];
    var sources = video.querySelectorAll("source");
    sources.forEach(function (sEl) { urls.push(sEl.getAttribute("src")); });
    var target = null;
    for (var i = 0; i < urls.length && !target; i++) {
      var key = videoKeyOf(urls[i]);
      if (key && videoMap[key]) target = videoMap[key];
    }
    if (!target) return;
    video.setAttribute("data-cp-lm-v", "");
    sources.forEach(function (sEl) { sEl.remove(); });
    if (video.hasAttribute("src")) {
      var mp4 = target.filter(function (t) { return /mp4/i.test(t.t); })[0] || target[0];
      video.setAttribute("src", mp4.u);
    } else {
      target.forEach(function (t) {
        var sEl = document.createElement("source");
        sEl.setAttribute("src", t.u);
        sEl.setAttribute("type", t.t);
        video.appendChild(sEl);
      });
    }
    var poster = video.getAttribute("poster");
    var rep = poster && replacementFor(poster);
    if (rep) video.setAttribute("poster", rep);
    if (video.isConnected && typeof video.load === "function") video.load();
  }

  function embedKeyOf(raw) {
    var url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      return null;
    }
    var host = url.hostname.replace(/^www\./, "");
    var m;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      m = /^\/embed\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
      return m ? { key: "youtube." + m[1].toLowerCase(), url: url } : null;
    }
    if (host === "player.vimeo.com") {
      m = /^\/video\/(\d{6,12})/.exec(url.pathname);
      return m ? { key: "vimeo." + m[1], url: url } : null;
    }
    return null;
  }

  // An <iframe> showing a replaced YouTube/Vimeo video: the replacement's
  // embed address, with the theme's own query carried over.
  function applyEmbed(frame) {
    ["src", "data-src"].forEach(function (a) {
      var v = frame.getAttribute(a);
      if (!v || written.has(v)) return;
      var hit = embedKeyOf(v);
      var target = hit && embedMap[hit.key];
      if (!target) return;
      var next = target + (hit.url.search || "");
      written.add(next);
      frame.setAttribute(a, next);
    });
  }

  var URL_ATTRS = ["src", "data-src", "data-zoom", "data-zoom-src", "data-master", "href", "poster"];
  var SET_ATTRS = ["srcset", "data-srcset"];

  function apply(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === "VIDEO") return applyVideo(el);
    if (el.tagName === "SOURCE" && el.parentElement && el.parentElement.tagName === "VIDEO") return applyVideo(el.parentElement);
    if (el.tagName === "IFRAME") return applyEmbed(el);
    var hit = false;
    URL_ATTRS.forEach(function (a) {
      if (a === "href" && el.tagName !== "A") return;
      var v = el.getAttribute(a);
      var rep = v && replacementFor(v);
      if (rep) {
        el.setAttribute(a, rep);
        hit = true;
      }
    });
    SET_ATTRS.forEach(function (a) {
      var v = el.getAttribute(a);
      var rep = v && rewriteSrcset(v);
      if (rep) {
        el.setAttribute(a, rep);
        hit = true;
      }
    });
    if (hit || el.tagName === "IMG") el.setAttribute("data-cp-lm", "");
  }

  var SELECTOR = "img,source,a,video,iframe";
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(SELECTOR)) apply(root);
    if (root.matches && root.matches("template")) scan(root.content);
    root.querySelectorAll(SELECTOR).forEach(apply);
    // A deferred player lives in a <template> until it is clicked; rewrite
    // its content now, so the original never starts loading.
    root.querySelectorAll("template").forEach(function (t) { scan(t.content); });
  }

  scan(document);
  // The pre-paint hide stays in place: its `:not([data-cp-lm])` guard releases
  // every image this script has looked at, and it keeps covering originals a
  // gallery inserts later (variant switches) until the observer rewrites
  // them. The inline 3 s timer still removes it in every case.

  new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === "attributes") apply(r.target);
      else r.addedNodes.forEach(scan);
    });
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: URL_ATTRS.concat(SET_ATTRS),
  });
})();
