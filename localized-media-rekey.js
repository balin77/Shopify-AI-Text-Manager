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

const VIDEO_MIME = /^(video\/[a-z0-9.+-]+|application\/x-mpegurl|application\/vnd\.apple\.mpegurl)$/i;

function isVideoMime(m) {
  return typeof m === "string" && VIDEO_MIME.test(m);
}

export function isShopifyCdnUrl(url) {
  if (typeof url !== "string" || url.length > 2048) return false;
  if (/["'<>\s\\]/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "cdn.shopify.com";
  } catch {
    return false;
  }
}

function isSafeEmbedUrl(url) {
  return typeof url === "string" && (
    /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(url) ||
    /^https:\/\/player\.vimeo\.com\/video\/\d{6,12}$/.test(url)
  );
}

function isSafeExternalThumbnail(url) {
  return typeof url === "string" && /^https:\/\/img\.youtube\.com\/vi\/[A-Za-z0-9_-]{11}\/hqdefault\.jpg$/.test(url);
}

/** Port of the per-entry rules of TS parseLocalizedMediaValue: true = the app would keep this entry. */
export function isUsableEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (!isSafeFilename(e.o) || typeof e.m !== "string" || !e.m) return false;
  if (typeof e.l !== "string" || !e.l || typeof e.k !== "string") return false;
  if (typeof e.f !== "string") return false;
  const u = typeof e.u === "string" ? e.u : "";
  const posterOk = e.p === undefined || e.p === "" || isSafeFilename(e.p);
  if (e.x === undefined) return isShopifyCdnUrl(u);
  if (e.x === "v") {
    const sources = Array.isArray(e.w) ? e.w.filter((s) => !!s && isShopifyCdnUrl(s.u) && isVideoMime(s.t)) : [];
    if (!posterOk || sources.length === 0) return false;
    return u === "" || isShopifyCdnUrl(u);
  }
  if (e.x === "e") {
    if (!posterOk || !isSafeEmbedUrl(e.r)) return false;
    return u === "" || isSafeExternalThumbnail(u);
  }
  return false;
}

/** Same verdict as TS isForeignLocalizedMediaValue (string input). */
export function isForeignLocalizedMediaValue(raw) {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "string" && raw.trim() === "") return false;
  let data = raw;
  if (typeof raw === "string") {
    try { data = JSON.parse(raw); } catch { return true; }
  }
  const list = data && data.e;
  if (!Array.isArray(list)) return true;
  if (list.length === 0) return false;
  return !list.some(isUsableEntry);
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
  if (isForeignLocalizedMediaValue(data)) return { changed: false, reason: "foreign" };
  const hit = (e) => e && typeof e === "object" && e.x === undefined && e.m === oldMediaId && isUsableEntry(e);
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

// Concurrent conversions of one product are serialised here (the worker runs
// in one process). compareDigest (Metafield / MetafieldsSetInput) is NOT used:
// its existence in 2026-07 could not be confirmed (schema proxy unreachable
// from the build sandbox) and it is not guessed. RESIDUAL: the editor's
// localizedMediaSet/Remove and removeEntriesForDeletedMedia run in the web
// process and can write between this job's read and write; that lost update is
// not prevented. The window is one product's read-to-write (typically < 1 s).
// Each job gets its own timeout, started when the job RUNS; a hung job is
// abandoned (not killed) so the chain advances.
const chains = new Map();
function serialise(productId, job, timeoutMs) {
  const prev = chains.get(productId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timed out after " + timeoutMs + "ms, may still complete in background"), timeoutMs);
    });
    return Promise.race([Promise.resolve().then(job), timeout]).finally(() => clearTimeout(timer));
  });
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

async function gql(fetchFn, shopifyApiUrl, headers, query, variables, label, sleep) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(shopifyApiUrl, { method: "POST", headers, body: JSON.stringify({ query, variables }) }, label);
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors) {
      const throttled = JSON.stringify(body.errors).includes("THROTTLED");
      if (throttled && attempt === 0) { await sleep(1000); continue; }
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
  return serialise(productId, () => doRekey(opts), opts.deadlineMs ?? DEADLINE_MS)
    .catch((err) => `failed: ${err && err.message ? err.message : String(err)}`);
}

async function doRekey({ fetchFn, shopifyApiUrl, headers, productId, oldMediaId, newMediaId, resolvedUrl, fetchUrl, sleep: sleepOpt, delayMs = 2000 }) {
  const sleep = sleepOpt || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    if (!oldMediaId || !newMediaId) return "skipped: missing ids";
    const read = await gql(
      fetchFn, shopifyApiUrl, headers,
      `query($id: ID!) { product(id: $id) { metafield(namespace: "custom", key: "localized_media") { value } } }`,
      { id: productId }, "localized media read", sleep,
    );
    const raw = read?.product?.metafield?.value ?? null;
    const probe = rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, "https://cdn.shopify.com/x/probe.webp");
    if (!probe.changed) return `skipped: ${probe.reason}`;

    let url = resolvedUrl || null;
    if (!url) {
      await sleep(delayMs);
      url = await fetchUrl();
    }
    if (!url) return "orphaned: new media URL unavailable";
    const next = rekeyLocalizedMediaValue(raw, oldMediaId, newMediaId, url);
    if (!next.changed) return `orphaned: ${next.reason}`;

    const data = await gql(
      fetchFn, shopifyApiUrl, headers,
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { namespace key value owner { ... on Product { id } } } userErrors { field message } } }`,
      { m: [{ ownerId: productId, namespace: NS, key: KEY, type: "json", value: next.value }] },
      "localized media write", sleep,
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
