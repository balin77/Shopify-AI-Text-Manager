/**
 * GET /api/shop-image-url?filename=<name> — the CDN URL of a Files image, for
 * previewing a theme image reference (`shopify://shop_images/<name>`) in the
 * editor. Read-only and a preview only: nothing is written from its answer.
 *
 * The Files search is a SEARCH, so every hit is re-checked against the exact
 * filename (the same rule the redirect lookups follow) — a near miss would
 * show the merchant a different picture than the one the theme serves.
 */
import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { filenameFromCdnUrl } from "~/utils/theme-image-reference.shared";

// Prose stays out of the document (CLAUDE.md: #graphql literals are sent verbatim).
const FILES_BY_FILENAME = `#graphql
  query shopImageUrlByFilename($query: String!) {
    files(first: 10, query: $query) {
      nodes {
        ... on MediaImage { image { url } }
      }
    }
  }
`;

function sameFilename(url: string, wanted: string): boolean {
  const got = filenameFromCdnUrl(url);
  if (!got) return false;
  const norm = (s: string) => {
    try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); }
  };
  return norm(got) === norm(wanted);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const filename = (new URL(request.url).searchParams.get("filename") ?? "").trim();
  if (!filename || filename.length > 255 || /[/"\\]/.test(filename)) {
    return json({ url: null }, { status: 400 });
  }
  let decoded = filename;
  try { decoded = decodeURIComponent(filename); } catch { /* keep raw */ }
  try {
    const res = await admin.graphql(FILES_BY_FILENAME, { variables: { query: `filename:${JSON.stringify(decoded)}` } });
    const body = (await res.json()) as { data?: { files?: { nodes?: Array<{ image?: { url?: string } | null }> } } };
    const hit = (body.data?.files?.nodes ?? []).map((n) => n?.image?.url).find((u): u is string => !!u && sameFilename(u, filename));
    return json({ url: hit ?? null });
  } catch {
    return json({ url: null });
  }
}
