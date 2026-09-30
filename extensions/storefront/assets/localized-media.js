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
 * our own variant gallery, lazy loaders). A rewritten URL points at a
 * different filename, so it can never match again — the observer cannot loop.
 */
(function () {
  "use strict";
  var dataEl = document.getElementById("cp-lm-data");
  if (!dataEl) return;
  var data;
  try {
    data = JSON.parse(dataEl.textContent || "{}");
  } catch (e) {
    return;
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
  if (!Object.keys(map).length) return;

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
    var segs = url.pathname.split("/");
    var file = segs[segs.length - 1] || "";
    var legacy = file.match(LEGACY_SIZE);
    var base = legacy ? file.replace(LEGACY_SIZE, "") : file;
    var target = map[base.toLowerCase()];
    if (!target) return null;
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
    return out.toString();
  }

  function rewriteSrcset(value) {
    var changed = false;
    var next = value
      .split(",")
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
  var style = document.getElementById("cp-lm-prehide");
  if (style) style.remove();

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
