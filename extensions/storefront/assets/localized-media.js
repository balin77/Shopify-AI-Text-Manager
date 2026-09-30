/**
 * "Images per language" — the storefront swap (blocks/localized-media.liquid
 * feeds it). Rewrites every image URL on the page that shows an ORIGINAL the
 * merchant replaced for the visitor's language/market, and marks the element
 * (`data-cp-lm`) so the pre-paint style stops hiding it.
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
  var map = {};
  (data.e || []).forEach(function (e) {
    if (!e || !e.o || !e.u || String(e.l || "").toLowerCase() !== locale) return;
    var k = e.k ? String(e.k) : "";
    if (k && k !== market) return;
    var key = String(e.o).toLowerCase();
    if (!map[key] || k) map[key] = e.u;
  });
  if (!Object.keys(map).length) return unhide();
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

  var URL_ATTRS = ["src", "data-src", "data-zoom", "data-zoom-src", "data-master", "href"];
  var SET_ATTRS = ["srcset", "data-srcset"];

  function apply(el) {
    if (!el || el.nodeType !== 1) return;
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

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches("img,source,a")) apply(root);
    root.querySelectorAll("img,source,a").forEach(apply);
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
