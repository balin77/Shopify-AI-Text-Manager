/**
 * Image-stamp probe: does an ALT-only edit change a MediaImage's `image.url`
 * (its `?v=` query)? See image-stamp-probe.shared.ts for the question.
 *
 * Run from api.translation-probe.tsx (`kind=imageStamp`, dev only,
 * `confirm=true`). It writes ONE product image's alt (original + marker) and
 * ALWAYS puts the original back (try/finally, echo-verified). An image that is
 * a replacement or an original of a replacement entry is never touched. If the
 * restore cannot be confirmed the report says so loudly with the original text.
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
  for (const p of data?.products?.nodes ?? []) {
    const entries = parseLocalizedMediaValue(p.metafield?.value ?? null);
    const taken = new Set<string>();
    for (const e of entries) {
      if (e.m) taken.add(e.m);
      if (e.f) taken.add(e.f);
    }
    for (const m of p.media?.nodes ?? []) {
      if (m.mediaContentType !== "IMAGE" || m.status !== "READY" || !m.image?.url) continue;
      if (taken.has(m.id)) continue;
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
  opts: { sleep?: (ms: number) => Promise<void>; pollAttempts?: number; pollMs?: number } = {},
): Promise<ImageStampProbeReport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.pollAttempts ?? 5;
  const pollMs = opts.pollMs ?? 2000;
  const report: ImageStampProbeReport = {
    ranAt: new Date().toISOString(),
    productId: null, mediaId: null, originalAlt: null, markerAlt: null,
    urlBefore: null, urlAfterAltChange: null, urlAfterRestore: null,
    altChangeConfirmed: false, restoreConfirmed: false,
    pathChanged: null, queryChanged: null, restoreQueryChanged: null,
    attemptsAfterChange: 0, verdict: [], restoreFailed: false, error: null,
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
      try {
        report.restoreConfirmed = await setAlt(graphql, candidate.productId, candidate.mediaId, originalAlt);
        if (!report.restoreConfirmed) {
          const read = await readImage(graphql, candidate.mediaId);
          report.restoreConfirmed = !!read && (read.alt ?? "") === originalAlt;
        }
      } catch (error) {
        report.error = (report.error ? report.error + "; " : "") + `restore threw: ${error instanceof Error ? error.message : String(error)}`;
      }
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
  return report;
}

export async function runImageStampProbeRoute({
  admin,
  formData,
}: {
  admin: { graphql: unknown };
  formData: FormData | null;
}) {
  // Directly POST-reachable and it writes: same dev-only gate as the Probes tab.
  if (process.env.APP_ENV !== "development") {
    return json({ error: "Not available." }, { status: 403 });
  }
  if (formData?.get("confirm") !== "true") {
    return json({ error: "confirm=true required (this probe edits one image alt and restores it)." }, { status: 400 });
  }
  const report = await runImageStampProbe(admin.graphql as unknown as Graphql);
  return json({ report });
}
