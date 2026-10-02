// FROZEN: the inline 404 beacon of blocks/structured-data.liquid at commit a8da7d1, before it moved to assets/seo-404.js. Never edit.
(function () {
  try {
    var payload = JSON.stringify({
      path: window.location.pathname + window.location.search,
      referrer: document.referrer || ''
    });
    var url = '/apps/contentpilot/seo-404';
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
    }
  } catch (e) { /* never break the storefront */ }
})();
