/**
 * Resource route: full CSV export of URL redirects.
 *
 * Split out from `app.seo.redirects.tsx` because a top-level navigation to the
 * parent loader (or a raw `fetch(...)` without the App Bridge session token)
 * lands on the embedded-app HTML shell instead of the CSV body. Loading this
 * route via `useFetcher().load()` reuses Remix's authenticated-fetch flow —
 * the same one that works for the page's POST actions — and returns the CSV
 * as a JSON string that the client Blob-downloads.
 */
import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { listRedirects } from "../services/seo/redirects.service";

const EXPORT_ROW_CAP = 10_000;

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";

  const all: Array<{ path: string; target: string }> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200 && all.length < EXPORT_ROW_CAP; i++) {
    const page = await listRedirects(admin, { first: 250, after: cursor, query: q });
    for (const r of page.redirects) {
      all.push({ path: r.path, target: r.target });
      if (all.length >= EXPORT_ROW_CAP) break;
    }
    if (!page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }

  const header = "path,target\n";
  const body = all.map((r) => `${csvEscape(r.path)},${csvEscape(r.target)}`).join("\n");
  const csv = header + body + (body ? "\n" : "");
  const shopSlug = session.shop.replace(/\.myshopify\.com$/, "").replace(/[^a-z0-9-]/gi, "-");

  return json({ csv, filename: `redirects-${shopSlug}.csv`, rowCount: all.length });
};
