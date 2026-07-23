/**
 * Resource route: CSV import PREVIEW for the bulk editor (docs/plans/
 * PLAN_BULK_EDITOR.md §8.2) — Pro-gated in the UI AND here (Plan §10.7: "the
 * most destructive entrance doesn't belong on the entry tier"; this action is
 * directly POSTable, so hiding the button is not a gate).
 *
 * This route only PARSES + DIFFS — it never writes. The returned diff is what
 * typing the same values into the grid would produce (csv-import.server.ts);
 * after the merchant confirms the preview, the CLIENT submits that diff
 * through the normal pipeline (route action ≤ MAX_SYNC_SAVE cells, otherwise
 * the /api/ai seoBulkMeta task), where every entry is re-validated against
 * the server-built column universe. Hard limits (§8.2): 5 MB, 10.000 rows —
 * both enforced here (the client pre-checks the file size only for UX).
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { isValidLocale, isValidShopifyGID } from "../utils/validation";
import type { BulkRowType } from "../services/bulk-editor/columns.shared";
import {
  allowedRowTypesForPlan,
  buildServerColumnsByType,
  loadProductMetafieldColumnSpecs,
  productColumnCapsForPlan,
} from "../services/bulk-editor/columns.server";
import { CSV_IMPORT_MAX_BYTES } from "../services/bulk-editor/csv.shared";
import {
  buildCsvImportPreview,
  type CsvImportPreviewResult,
} from "../services/bulk-editor/csv-import.server";

export type CsvImportActionResult =
  | CsvImportPreviewResult
  | { ok: false; error: "gated" | "invalid" | "tooLarge" };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  // Pro gate (§10.7) — checked before even parsing the payload.
  if (!meetsPlan(plan, "pro")) {
    return json<CsvImportActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();
  if (getFormString(form, "actionType") !== "csvImportPreview") {
    return json<CsvImportActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  const allowedTypes = allowedRowTypesForPlan(plan);
  const rawType = getFormString(form, "type");
  if (!(allowedTypes as string[]).includes(rawType)) {
    return json<CsvImportActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  const type = rawType as BulkRowType;

  // Same segment rules as the diff validation (columns.shared.ts): primary is
  // always global; a foreign locale must be well-formed and a market override
  // must be a Market GID. (The published-locale/ACTIVE-market check runs at
  // SAVE time via findInvalidLocaleOrMarket — this route only reads.)
  const locale = getFormString(form, "locale");
  const marketId = locale === "" ? "" : getFormString(form, "market");
  if (locale !== "" && !isValidLocale(locale)) {
    return json<CsvImportActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (marketId !== "" && !isValidShopifyGID(marketId)) {
    return json<CsvImportActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  const csvText = getFormString(form, "csv");
  if (csvText === "") {
    return json<CsvImportActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  // Hard 5-MB cap (§8.2), measured in BYTES — multi-byte content counts.
  if (Buffer.byteLength(csvText, "utf8") > CSV_IMPORT_MAX_BYTES) {
    return json<CsvImportActionResult>({ ok: false, error: "tooLarge" }, { status: 400 });
  }

  // Server-built column universe (§8.2): what THIS shop's plan may edit for
  // this row type — the header mapping runs against it, never against client
  // claims.
  const columnsByType = await buildServerColumnsByType(db, shop, plan);
  const productCaps = productColumnCapsForPlan(plan);
  const metafieldSpecs =
    type === "product" && productCaps.metafields
      ? await loadProductMetafieldColumnSpecs(db, shop)
      : [];

  const preview = await buildCsvImportPreview(db, shop, {
    type,
    locale,
    marketId,
    csvText,
    columns: columnsByType[type],
    productCells: { metafieldSpecs, caps: productCaps },
  });
  return json<CsvImportActionResult>(preview);
};
