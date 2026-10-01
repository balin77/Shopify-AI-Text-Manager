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

async function gql(fetchFn, shopifyApiUrl, headers, query, variables, label) {
  const res = await fetchFn(shopifyApiUrl, { method: "POST", headers, body: JSON.stringify({ query, variables }) }, label);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(`${label} errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

/**
 * Never throws. Returns a short outcome string for the log.
 * `fetchUrl` resolves the new medium's CDN URL (null while still processing);
 * it is only called when the product really holds entries for the old medium.
 */
export async function rekeyLocalizedMediaAfterConversion({
  fetchFn, shopifyApiUrl, headers, productId, oldMediaId, newMediaId, fetchUrl, sleep, attempts = 4, delayMs = 2500,
}) {
  try {
    if (!productId || !oldMediaId || !newMediaId) return "skipped: missing ids";
    const read = await gql(
      fetchFn, shopifyApiUrl, headers,
      `query($id: ID!) { product(id: $id) { metafield(namespace: "custom", key: "localized_media") { value } } }`,
      { id: productId }, "localized media read",
    );
    const raw = read?.product?.metafield?.value ?? null;
    const probe = rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, "https://cdn.shopify.com/x/probe.webp");
    if (!probe.changed) return `skipped: ${probe.reason}`;

    let url = null;
    for (let i = 0; i < attempts && !url; i++) {
      url = await fetchUrl();
      if (!url && i < attempts - 1) await (sleep ? sleep(delayMs) : new Promise((r) => setTimeout(r, delayMs)));
    }
    if (!url) return "orphaned: new media URL unavailable";
    const next = rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, url);
    if (!next.changed) return `orphaned: ${next.reason}`;

    const data = await gql(
      fetchFn, shopifyApiUrl, headers,
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { ownerId namespace key value } userErrors { field message } } }`,
      { m: [{ ownerId: productId, namespace: NS, key: KEY, type: "json", value: next.value }] },
      "localized media write",
    );
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) return `failed: userErrors ${JSON.stringify(errs).slice(0, 300)}`;
    const echoed = (data?.metafieldsSet?.metafields ?? []).find(
      (m) => m && m.ownerId === productId && m.namespace === NS && m.key === KEY,
    );
    if (!echoed || echoed.value !== next.value) return "failed: not confirmed by echo";
    return `rekeyed ${next.count} entr${next.count === 1 ? "y" : "ies"}`;
  } catch (err) {
    return `failed: ${err && err.message ? err.message : String(err)}`;
  }
}
