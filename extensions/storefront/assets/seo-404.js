/* 404 beacon for blocks/structured-data.liquid: reports the missing path + referrer
   to the app-proxy collector (Seo404Hit). Best-effort, never throws. */
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
