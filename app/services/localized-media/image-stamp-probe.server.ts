/**
 * Image-stamp probe: does an ALT-only edit change a MediaImage's `image.url`
 * (its `?v=` query)? See image-stamp-probe.shared.ts for the question.
 *
 * Run from api.translation-probe.tsx (`kind=imageStamp`, dev only,
 * `confirm=true`). It writes ONE product image's alt (original + marker) and
 * ALWAYS puts the original back (try/finally, echo-verified). An image that is
 * a replacement or an original of a replacement entry is never touched. If the
 * restore cannot be confirmed the report says so loudly with the original text.
 *
 * Guards: one run at a time per process (a second concurrent run would read the
 * first one's marker as the "original" alt); an image whose alt already ends
 * with the marker is never a candidate (a crashed earlier run); a product with
 * ANY custom.localized_media value is skipped whole; the cached ProductImage
 * row is shielded (altTextModifiedAt) so the products/update sync does not
 * adopt the marker, and put back if it did. An image with no alt (null) is
 * restored as "" - Shopify reads both back the same, the report says so.
 */
import { data as json } from "react-router";
import { logger } from "~/utils/logger.server";
import {
  LOCALIZED_MEDIA_KEY,
  LOCALIZED_MEDIA_NAMESPACE,
  parseLocalizedMediaValue,
} from "./localized-media.shared";
import {
  compareImageUrls,
  computeStampVerdict,
  type ImageStampProbeReport,
} from "./image-stamp-probe.shared";

type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

const MARKER = " [probe]";

type ProbeDb = {
  productImage: {
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  };
};

// Module-level single flight: a concurrent second run would snapshot the first
// run's marker alt as its "original" and write it back for good.
let probeRunning = false;

// Prose stays out of the documents (CLAUDE.md: #graphql literals are sent verbatim).
const CANDIDATES = `#graphql
  query imageStampCandidates($namespace: String!, $key: String!) {
    products(first: 25) {
      nodes {
        id
        metafield(namespace: $namespace, key: $key) { value }
        media(first: 10) {
          nodes {
            id
            mediaContentType
            ... on MediaImage { alt status image { url } }
          }
        }
      }
    }
  }
`;

const READ_IMAGE = `#graphql
  query imageStampRead($id: ID!) {
    node(id: $id) {
      id
      ... on MediaImage { alt image { url } }
    }
  }
`;

const SET_ALT = `#graphql
  mutation imageStampSetAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { id alt }
      mediaUserErrors { field message }
    }
  }
`;

async function call<T>(graphql: Graphql, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  logger.info("[image-stamp-probe] raw answer", { variables, body: JSON.stringify(body).slice(0, 1500) });
  return body.data ?? null;
}

interface Candidate { productId: string; mediaId: string; alt: string | null; url: string }

async function pickCandidate(graphql: Graphql): Promise<Candidate | null> {
  const data = await call<{
    products: { nodes: Array<{
      id: string;
      metafield: { value: string } | null;
      media: { nodes: Array<{ id: string; mediaContentType: string; alt?: string | null; status?: string; image?: { url: string } | null }> };
    }> };
  }>(graphql, CANDIDATES, { namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY });
  const withoutAlt: Candidate[] = [];
  const products = data?.products?.nodes ?? [];
  // Built over EVERY scanned product first: a replacement file of one product
  // may be an image of another.
  const taken = new Set<string>();
  for (const p of products) {
    for (const e of parseLocalizedMediaValue(p.metafield?.value ?? null)) {
      if (e.m) taken.add(e.m);
      if (e.f) taken.add(e.f);
    }
  }
  for (const p of products) {
    // Any value at all (even one this app cannot parse) means the product
    // belongs to the localized-media feature or to the merchant: hands off.
    if ((p.metafield?.value ?? "").trim()) continue;
    for (const m of p.media?.nodes ?? []) {
      if (m.mediaContentType !== "IMAGE" || m.status !== "READY" || !m.image?.url) continue;
      if (taken.has(m.id)) continue;
      // A leftover marker means an earlier run died before restoring it.
      if ((m.alt ?? "").endsWith(MARKER)) continue;
      const c = { productId: p.id, mediaId: m.id, alt: m.alt ?? null, url: m.image.url };
      if (c.alt && c.alt.trim()) return c;
      withoutAlt.push(c);
    }
  }
  return withoutAlt[0] ?? null;
}

async function readImage(graphql: Graphql, id: string): Promise<{ alt: string | null; url: string | null } | null> {
  const data = await call<{ node: { alt?: string | null; image?: { url: string } | null } | null }>(graphql, READ_IMAGE, { id });
  if (!data?.node) return null;
  return { alt: data.node.alt ?? null, url: data.node.image?.url ?? null };
}

async function setAlt(graphql: Graphql, productId: string, mediaId: string, alt: string): Promise<boolean> {
  const data = await call<{
    productUpdateMedia: { media: Array<{ id: string; alt: string | null }> | null; mediaUserErrors: unknown[] } | null;
  }>(graphql, SET_ALT, { productId, media: [{ id: mediaId, alt }] });
  const r = data?.productUpdateMedia;
  if (!r || (r.mediaUserErrors ?? []).length > 0) return false;
  const echoed = (r.media ?? []).find((m) => m.id === mediaId);
  return !!echoed && (echoed.alt ?? "") === alt;
}

export async function runImageStampProbe(
  graphql: Graphql,
  opts: ProbeOpts = {},
): Promise<ImageStampProbeReport> {
  if (probeRunning) {
    const r = emptyReport();
    r.error = "already running";
    r.verdict = ["INCONCLUSIVE: the image-stamp probe is already running; wait for it to finish."];
    return r;
  }
  probeRunning = true;
  try {
    return await runImageStampProbeInner(graphql, opts);
  } finally {
    probeRunning = false;
  }
}

interface ProbeOpts {
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollMs?: number;
  shop?: string;
  db?: ProbeDb;
}

function emptyReport(): ImageStampProbeReport {
  return {
    ranAt: new Date().toISOString(),
    productId: null, mediaId: null, originalAlt: null, markerAlt: null,
    urlBefore: null, urlAfterAltChange: null, urlAfterRestore: null,
    altChangeConfirmed: false, restoreConfirmed: false,
    pathChanged: null, queryChanged: null, restoreQueryChanged: null,
    attemptsAfterChange: 0, verdict: [], restoreFailed: false, error: null,
  };
}

async function runImageStampProbeInner(graphql: Graphql, opts: ProbeOpts): Promise<ImageStampProbeReport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.pollAttempts ?? 5;
  const pollMs = opts.pollMs ?? 2000;
  const report = emptyReport();
  let cacheDb: ProbeDb | null = opts.db ?? null;
  const cacheWhere = (mediaId: string, extra: Record<string, unknown> = {}) => ({
    mediaId,
    ...(opts.shop ? { product: { shop: opts.shop } } : {}),
    ...extra,
  });
  const cacheUpdate = async (mediaId: string, where: Record<string, unknown>, data: Record<string, unknown>) => {
    try {
      cacheDb ??= (await import("~/db.server")).db as unknown as ProbeDb;
      await cacheDb.productImage.updateMany({ where: cacheWhere(mediaId, where), data });
    } catch (error) {
      logger.warn("[image-stamp-probe] cache update failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  let candidate: Candidate | null = null;
  try {
    candidate = await pickCandidate(graphql);
  } catch (error) {
    report.error = `candidate lookup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!candidate) {
    report.error = report.error ?? "no READY product image that is not part of a replacement was found";
    report.verdict = ["INCONCLUSIVE: " + report.error];
    return report;
  }
  report.productId = candidate.productId;
  report.mediaId = candidate.mediaId;
  report.originalAlt = candidate.alt;
  const originalAlt = candidate.alt ?? "";
  report.markerAlt = originalAlt + MARKER;

  let touched = false;
  try {
    const before = await readImage(graphql, candidate.mediaId);
    report.urlBefore = before?.url ?? candidate.url;

    // Shield the cached row first: the marker write fires products/update, and
    // the sync would otherwise adopt the marker as the primary alt (the 5-min
    // preserve window keys on altTextModifiedAt; altText stays the original).
    await cacheUpdate(candidate.mediaId, {}, { altTextModifiedAt: new Date() });

    touched = true;
    report.altChangeConfirmed = await setAlt(graphql, candidate.productId, candidate.mediaId, report.markerAlt);

    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(pollMs);
      report.attemptsAfterChange = i + 1;
      const read = await readImage(graphql, candidate.mediaId);
      report.urlAfterAltChange = read?.url ?? report.urlAfterAltChange;
      if (read?.url && read.url !== report.urlBefore) break;
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (touched) {
      // One retry after a short pause when the restore THROWS (a throttle or a
      // dropped connection is the likely cause, and the marker must not stay).
      for (let attempt = 0; attempt < 2 && !report.restoreConfirmed; attempt++) {
        try {
          if (attempt > 0) await sleep(pollMs);
          report.restoreConfirmed = await setAlt(graphql, candidate.productId, candidate.mediaId, originalAlt);
          if (!report.restoreConfirmed) {
            const read = await readImage(graphql, candidate.mediaId);
            report.restoreConfirmed = !!read && (read.alt ?? "") === originalAlt;
          }
          break;
        } catch (error) {
          const msg = `restore threw: ${error instanceof Error ? error.message : String(error)}`;
          if (attempt === 1) report.error = (report.error ? report.error + "; " : "") + msg;
          else logger.warn("[image-stamp-probe] restore threw, retrying once", { error: msg });
        }
      }
      // If the sync adopted the marker into the cache anyway, put the original back.
      await cacheUpdate(candidate.mediaId, { altText: report.markerAlt }, { altText: originalAlt });
      report.restoreFailed = !report.restoreConfirmed;
      try {
        for (let i = 0; i < 2; i++) {
          if (i > 0) await sleep(pollMs);
          const read = await readImage(graphql, candidate.mediaId);
          if (read?.url) report.urlAfterRestore = read.url;
        }
      } catch (error) {
        logger.warn("[image-stamp-probe] final read failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const cmp = compareImageUrls(report.urlBefore, report.urlAfterAltChange);
  report.pathChanged = cmp?.pathChanged ?? null;
  report.queryChanged = cmp?.queryChanged ?? null;
  report.restoreQueryChanged = compareImageUrls(report.urlBefore, report.urlAfterRestore)?.queryChanged ?? null;
  report.verdict = computeStampVerdict({
    altChangeConfirmed: report.altChangeConfirmed,
    urlBefore: report.urlBefore,
    urlAfterAltChange: report.urlAfterAltChange,
  });
  if (report.restoreFailed) {
    report.verdict.unshift(
      `RESTORE FAILED: set the alt of ${report.mediaId} (product ${report.productId}) back by hand to exactly: ${JSON.stringify(report.originalAlt)}`,
    );
  }
  if (candidate.alt === null) {
    report.verdict.push("NOTE: the image had no alt text (null); it was restored as an empty string, which Shopify reads back the same.");
  }
  return report;
}

export async function runImageStampProbeRoute({
  admin,
  formData,
  shop,
}: {
  admin: { graphql: unknown };
  formData: FormData | null;
  shop?: string;
}) {
  // Directly POST-reachable and it writes: same dev-only gate as the Probes tab.
  if (process.env.APP_ENV !== "development") {
    return json({ error: "Not available." }, { status: 403 });
  }
  if (formData?.get("confirm") !== "true") {
    return json({ error: "confirm=true required (this probe edits one image alt and restores it)." }, { status: 400 });
  }
  const report = await runImageStampProbe(admin.graphql as unknown as Graphql, { shop });
  return json({ report });
}
