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
import { toCsv, csvFilename } from "../services/seo/csv-export";

const EXPORT_ROW_CAP = 10_000;

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

  // Comma-delimited and BOM-less, unlike the crawl/on-page exports: this file
  // is round-tripped through `parseRedirectsCsv` on import, and the format is
  // what merchants already have in their tooling. The shared serializer only
  // replaces the local `csvEscape` copy — the bytes are unchanged.
  const csv = toCsv(
    all,
    [
      { header: "path", value: (r) => r.path },
      { header: "target", value: (r) => r.target },
    ],
    { delimiter: ",", bom: false },
  );

  return json({ csv, filename: csvFilename("redirects", session.shop), rowCount: all.length });
};
