/**
 * Resource route: CSV export of the bulk editor's CURRENT VIEW (docs/plans/
 * PLAN_BULK_EDITOR.md §8.1) — Basic+ (Plan §10.7: export from Basic, import
 * from Pro).
 *
 * Same delivery pattern as app.seo.redirects.export.tsx: a top-level
 * navigation (or raw fetch without the App Bridge session token) would land
 * on the embedded-app HTML shell, so the client loads this route via
 * `useFetcher().load()` and Blob-downloads the returned CSV string. The BOM
 * is already part of the string (csv.shared.ts).
 *
 * All view state arrives as URL params — the same ones the grid keeps in its
 * own URL (?type=&locale=&market=&q=&f=&sort=) plus `columns` (the visible
 * column ids) and `lang` (the APP language, which picks the delimiter). Every
 * param is validated against the plan/type universe server-side, never
 * trusted.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import {
  parseSortParam,
  buildColumnsForType,
  BULK_FILTER_IDS,
  type BulkFilterId,
  type BulkRowType,
} from "../services/bulk-editor/columns.shared";
import {
  allowedRowTypesForPlan,
  loadMetaobjectColumnSpecs,
  loadProductMetafieldColumnSpecs,
  productColumnCapsForPlan,
} from "../services/bulk-editor/columns.server";
import { delimiterForAppLanguage, CSV_EXPORT_MAX_ROWS } from "../services/bulk-editor/csv.shared";
import { buildBulkCsvExport } from "../services/bulk-editor/csv-export.server";

export interface BulkCsvExportPayload {
  csv?: string;
  filename?: string;
  rowCount?: number;
  /** One-download guard key for the client effect. */
  generatedAt?: number;
  error?: "gated" | "tooLarge";
  total?: number;
  max?: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "basic")) {
    return json<BulkCsvExportPayload>({ error: "gated" }, { status: 403 });
  }

  const url = new URL(request.url);
  const allowedTypes = allowedRowTypesForPlan(plan);
  const rawType = url.searchParams.get("type") || "product";
  const type: BulkRowType = (allowedTypes as string[]).includes(rawType)
    ? (rawType as BulkRowType)
    : allowedTypes[0] ?? "product";

  // Locale/market land unvalidated in a read-only translation QUERY — a bogus
  // value yields empty translation columns, nothing else. Market still
  // requires a foreign locale (primary is always global), same as the grid.
  const locale = url.searchParams.get("locale") || "";
  const marketId = locale !== "" ? url.searchParams.get("market") || "" : "";
  const search = url.searchParams.get("q") || "";
  const filters = (url.searchParams.get("f") || "")
    .split(",")
    .filter((f): f is BulkFilterId => (BULK_FILTER_IDS as string[]).includes(f));
  const sort = parseSortParam(type, url.searchParams.get("sort"));
  const delimiter = delimiterForAppLanguage(url.searchParams.get("lang") || "en");
  const visibleColumnIds = (url.searchParams.get("columns") || "").split(",").filter(Boolean);

  // The same column universe the grid builds — visible ids are validated
  // against it inside buildExportColumns (unknown ids drop out).
  const productCaps = productColumnCapsForPlan(plan);
  const metafieldSpecs =
    type === "product" && productCaps.metafields
      ? await loadProductMetafieldColumnSpecs(db, shop)
      : [];
  const metaobjectSpecs = type === "metaobject" ? await loadMetaobjectColumnSpecs(db, shop) : [];
  const columns = buildColumnsForType(type, metafieldSpecs, productCaps, metaobjectSpecs);
  // Metaobject exports mirror the current view's definition-type filter —
  // validated against the real definitions (unknown value = no filter, which
  // only ever yields MORE rows of the same shop, never foreign data).
  const rawMoType = url.searchParams.get("moType") || "";
  const moType =
    type === "metaobject" && metaobjectSpecs.some((s) => s.type === rawMoType) ? rawMoType : "";

  const result = await buildBulkCsvExport(db, shop, {
    type,
    locale,
    marketId,
    search,
    filters,
    sort,
    visibleColumnIds,
    columns,
    delimiter,
    productCells: { metafieldSpecs, caps: productCaps },
    admin,
    moType,
  });

  if (!result.ok) {
    return json<BulkCsvExportPayload>({
      error: result.error,
      total: result.total,
      max: CSV_EXPORT_MAX_ROWS,
    });
  }

  const shopSlug = shop.replace(/\.myshopify\.com$/, "").replace(/[^a-z0-9-]/gi, "-");
  const localeSuffix = locale ? `-${locale.toLowerCase()}` : "";
  return json<BulkCsvExportPayload>({
    csv: result.csv,
    filename: `bulk-${type}${localeSuffix}-${shopSlug}.csv`,
    rowCount: result.rowCount,
    generatedAt: Date.now(),
  });
};
