/**
 * Resource route: full CSV export of GSC top queries and quick wins.
 *
 * Split out from `app.seo.search-console.tsx` because a top-level navigation
 * (or a raw `fetch(...)` without the App Bridge session token) lands on the
 * embedded-app HTML shell instead of the CSV body. Loading this route via
 * `useFetcher().load()` reuses Remix's authenticated-fetch flow and returns
 * the CSV as a JSON string that the client Blob-downloads.
 */
import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getGscAccessToken,
  defaultDateRange,
  querySearchAnalytics,
  findCtrOpportunities,
  GscReconnectRequiredError,
  type SearchAnalyticsFilters,
} from "../services/google-search-console.server";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";

const EXPORT_ROW_CAP = 1000;

// Leading '=', '+', '-', '@', tab or CR would make Excel/Sheets evaluate the
// cell as a formula even inside quotes (CSV injection) — query strings come
// from real Google searches, i.e. externally controllable input. Prefix a "'"
// to force text interpretation before quoting.
function csvEscape(value: string): string {
  const deFormulaed = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${deFormulaed.replace(/"/g, '""')}"`;
}

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

// Country validation: lowercase alpha-3 (ISO-3166-1)
const GSC_COUNTRY_RE = /^[a-z]{3}$/i;
const GSC_DEVICES = ["DESKTOP", "MOBILE", "TABLET"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  // Pro-plan gate (server-side)
  const plan = await loadPlan(db, session.shop);
  if (!meetsPlan(plan, "pro")) {
    return json({ error: "gated" }, { status: 403 });
  }

  const url = new URL(request.url);
  const dataset = url.searchParams.get("dataset");

  // Validate dataset param
  if (!dataset || !["top", "quickwins"].includes(dataset)) {
    return json({ error: "invalid_dataset" }, { status: 400 });
  }

  // Parse and validate optional filters
  const rawCountry = url.searchParams.get("gscCountry");
  const filterCountry = rawCountry && GSC_COUNTRY_RE.test(rawCountry) ? rawCountry.toLowerCase() : null;
  const rawDevice = url.searchParams.get("gscDevice")?.toUpperCase() || null;
  const filterDevice = rawDevice && (GSC_DEVICES as readonly string[]).includes(rawDevice) ? rawDevice : null;

  const analyticsFilters: SearchAnalyticsFilters = {
    country: filterCountry ?? undefined,
    device: (filterDevice as "DESKTOP" | "MOBILE" | "TABLET" | undefined) ?? undefined,
  };

  try {
    const { accessToken, propertyUrl } = await getGscAccessToken(db, session.shop);
    const { startDate, endDate } = defaultDateRange(new Date());

    let csv: string;
    let filename: string;
    let rowCount: number;

    if (dataset === "top") {
      // Top queries: query, clicks, impressions, ctr, position
      const rows = await querySearchAnalytics(accessToken, propertyUrl, {
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit: EXPORT_ROW_CAP,
        filters: analyticsFilters,
      });

      const header = "query,clicks,impressions,ctr,position\n";
      const body = rows
        .map((r) => {
          const query = csvEscape(r.keys[0] ?? "");
          const clicks = r.clicks;
          const impressions = r.impressions;
          const ctr = r.ctr.toString();
          const position = r.position.toString();
          return `${query},${clicks},${impressions},${ctr},${position}`;
        })
        .join("\n");
      csv = header + body + (body ? "\n" : "");
      rowCount = rows.length;
      const shopSlug = session.shop.replace(/\.myshopify\.com$/, "").replace(/[^a-z0-9-]/gi, "-");
      filename = `gsc-top-queries-${shopSlug}.csv`;
    } else {
      // Quick wins: query, page, impressions, position, ctr
      const pageRows = await querySearchAnalytics(accessToken, propertyUrl, {
        startDate,
        endDate,
        dimensions: ["query", "page"],
        rowLimit: EXPORT_ROW_CAP,
        filters: analyticsFilters,
      });

      const opportunities = findCtrOpportunities(pageRows, 100);
      const header = "query,page,impressions,position,ctr\n";
      const body = opportunities
        .map((r) => {
          const query = csvEscape(r.query);
          const page = csvEscape(r.page);
          const impressions = r.impressions;
          const position = r.position.toString();
          const ctr = r.ctr.toString();
          return `${query},${page},${impressions},${position},${ctr}`;
        })
        .join("\n");
      csv = header + body + (body ? "\n" : "");
      rowCount = opportunities.length;
      const shopSlug = session.shop.replace(/\.myshopify\.com$/, "").replace(/[^a-z0-9-]/gi, "-");
      filename = `gsc-quick-wins-${shopSlug}.csv`;
    }

    return json({ csv, filename, rowCount });
  } catch (e) {
    if (e instanceof GscReconnectRequiredError) {
      return json({ error: "reconnect" }, { status: 400 });
    }
    return json({ error: "export_failed" }, { status: 400 });
  }
};
