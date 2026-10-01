// Re-keys the replacement entries of custom.localized_media when the WebP
// worker swaps a product image for a new MediaImage. Plain JS, imports nothing:
// the worker runs outside the React Router bundle (see Dockerfile COPY line).
//
// Two halves that must agree with app/services/localized-media/localized-media.shared.ts
// (parity-tested in tests/unit/localized-media-rekey.test.ts):
//   isSafeFilename, storefrontFilename.
// The image source stamp is the media's full image URL (toProductMediaItem).

const SAFE_FILENAME = /^[A-Za-z0-9._~%+-]{1,255}$/;

export function isSafeFilename(name) {
  return typeof name === "string" && SAFE_FILENAME.test(name) && name !== "." && name !== "..";
}

export function storefrontFilename(url) {
  if (!url) return null;
  const path = url.split("#")[0].split("?")[0];
  const last = path.split("/").pop() ?? "";
  return last || null;
}

/**
 * Pure. Returns { changed: false, reason } or { changed: true, value, count }.
 * Only entries of the image kind (no `x`) whose `m` is the old GID are touched;
 * everything else stays as parsed. A value that is not this app's shape is
 * never rewritten.
 */
export function rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, newUrl) {
  if (typeof raw !== "string" || raw.trim() === "") return { changed: false, reason: "empty" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { changed: false, reason: "foreign" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.e)) {
    return { changed: false, reason: "foreign" };
  }
  // Same rule as TS isForeignLocalizedMediaValue: entries present but none of
  // the shape this app writes (o, m, l strings) means someone else's document.
  const usable = (e) => e && typeof e === "object" && isSafeFilename(e.o) && typeof e.m === "string" && e.m && typeof e.l === "string" && e.l && typeof e.k === "string";
  if (data.e.length > 0 && !data.e.some(usable)) return { changed: false, reason: "foreign" };
  const hit = (e) => e && typeof e === "object" && e.x === undefined && e.m === oldMediaId;
  if (!data.e.some(hit)) return { changed: false, reason: "no-entries" };
  if (!oldMediaId || !newMediaId || oldMediaId === newMediaId) return { changed: false, reason: "bad-ids" };
  const name = storefrontFilename(newUrl);
  if (!isSafeFilename(name) || typeof newUrl !== "string") return { changed: false, reason: "unsafe-filename" };
  let count = 0;
  const e = data.e.map((entry) => {
    if (!hit(entry)) return entry;
    count += 1;
    return { ...entry, m: newMediaId, o: name, s: newUrl };
  });
  return { changed: true, value: JSON.stringify({ ...data, e }), count };
}

const NS = "custom";
const KEY = "localized_media";
const DEADLINE_MS = 20000;

// No compareDigest precedent in this repo and the 2026-07 field name is
// unconfirmed, so concurrent conversions of one product are serialised here
// instead (the worker runs in one process). Cross-process races stay open.
const chains = new Map();
function serialise(productId, job) {
  const prev = chains.get(productId) || Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.catch(() => {});
  chains.set(productId, tail);
  tail.then(() => { if (chains.get(productId) === tail) chains.delete(productId); });
  return run;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function sameJson(a, b) {
  try { return canonical(JSON.parse(a)) === canonical(JSON.parse(b)); } catch { return false; }
}

async function gql(fetchFn, shopifyApiUrl, headers, query, variables, label) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(shopifyApiUrl, { method: "POST", headers, body: JSON.stringify({ query, variables }) }, label);
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors) {
      const throttled = JSON.stringify(body.errors).includes("THROTTLED");
      if (throttled && attempt === 0) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      throw new Error(`${label} errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
    }
    return body.data;
  }
}

/**
 * Never throws. Returns a short outcome string for the log. `resolvedUrl` is
 * the worker's already resolved URL (or null); `fetchUrl` is at most ONE extra
 * lookup. Only called into the URL lookup when the product holds entries.
 */
export function rekeyLocalizedMediaAfterConversion(opts) {
  const { productId } = opts;
  if (!productId) return Promise.resolve("skipped: missing ids");
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("failed: deadline exceeded"), DEADLINE_MS); });
  const work = serialise(productId, () => doRekey(opts));
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function doRekey({ fetchFn, shopifyApiUrl, headers, productId, oldMediaId, newMediaId, resolvedUrl, fetchUrl, sleep, delayMs = 2000 }) {
  try {
    if (!oldMediaId || !newMediaId) return "skipped: missing ids";
    const read = await gql(
      fetchFn, shopifyApiUrl, headers,
      `query($id: ID!) { product(id: $id) { metafield(namespace: "custom", key: "localized_media") { value } } }`,
      { id: productId }, "localized media read",
    );
    const raw = read?.product?.metafield?.value ?? null;
    const probe = rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, "https://cdn.shopify.com/x/probe.webp");
    if (!probe.changed) return `skipped: ${probe.reason}`;

    let url = resolvedUrl || null;
    if (!url) {
      await (sleep ? sleep(delayMs) : new Promise((r) => setTimeout(r, delayMs)));
      url = await fetchUrl();
    }
    if (!url) return "orphaned: new media URL unavailable";
    const next = rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, url);
    if (!next.changed) return `orphaned: ${next.reason}`;

    const data = await gql(
      fetchFn, shopifyApiUrl, headers,
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { namespace key value owner { ... on Product { id } } } userErrors { field message } } }`,
      { m: [{ ownerId: productId, namespace: NS, key: KEY, type: "json", value: next.value }] },
      "localized media write",
    );
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) return `failed: userErrors ${JSON.stringify(errs).slice(0, 300)}`;
    const echoed = (data?.metafieldsSet?.metafields ?? []).find(
      (m) => m && m.owner && m.owner.id === productId && m.namespace === NS && m.key === KEY,
    );
    if (!echoed || !sameJson(echoed.value, next.value)) return "failed: not confirmed by echo";
    return `rekeyed ${next.count} entr${next.count === 1 ? "y" : "ies"}`;
  } catch (err) {
    return `failed: ${err && err.message ? err.message : String(err)}`;
  }
}
