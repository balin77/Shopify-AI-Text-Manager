/**
 * Resource route: CSV import PREVIEW for the bulk editor (docs/plans/
 * PLAN_BULK_EDITOR.md §8.2) — Pro-gated in the UI AND here (Plan §10.7: "the
 * most destructive entrance doesn't belong on the entry tier"; this action is
 * directly POSTable, so hiding the button is not a gate).
 *
 * `csvImportPreview` only PARSES + DIFFS — it never writes. The diff is what
 * typing the same values into the grid would produce (csv-import.server.ts).
 * After the merchant confirms, a SMALL import (≤ MAX_SYNC_SAVE cells) is
 * submitted by the client through the grid's own save action; a larger one is
 * posted back here as `csvImportApply`, which recomputes the diff from the
 * file and applies it as a background Task in save-sized batches
 * (csv-import-run.server.ts) — no size limit beyond the file caps. Hard limits (§8.2): 5 MB, 10.000 rows —
 * both enforced here (the client pre-checks the file size only for UX).
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { isValidLocale, isValidShopifyGID } from "../utils/validation";
import { MAX_SYNC_SAVE, type BulkRowType } from "../services/bulk-editor/columns.shared";
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
import {
  chunkImportDiff,
  startCsvImportTask,
  type CsvImportApplyResult,
} from "../services/bulk-editor/csv-import-run.server";
import type { DataResponse } from "~/types/data-response";

export type CsvImportActionResult =
  | CsvImportPreviewResult
  | { ok: false; error: "gated" | "invalid" | "tooLarge" };

/** The answer to `csvImportApply` — a started background Task, or why not. */
export type CsvImportApplyActionResult =
  | CsvImportApplyResult
  | { ok: false; error: "gated" | "invalid" | "tooLarge" };

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
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
  const actionType = getFormString(form, "actionType");
  if (actionType !== "csvImportPreview" && actionType !== "csvImportApply") {
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

  const importArgs = {
    type,
    locale,
    marketId,
    csvText,
    columns: columnsByType[type],
    productCells: { metafieldSpecs, caps: productCaps },
    // Blog rows are live-fetched (Phase 5) — the id-restricted row load needs
    // the client. Import resolution stays id-only for blogs (§8.2).
    admin,
  };

  // A confirmed LARGE import: recomputed from the file and applied as a
  // background Task in save-sized batches (csv-import-run.server.ts). The
  // client posts the file again, never a diff — see that module's head.
  if (actionType === "csvImportApply") {
    const started = await startCsvImportTask(db, shop, {
      ...importArgs,
      admin,
      columnsByType,
      allowedTypes,
    });
    return json<CsvImportApplyActionResult>(started, {
      status: started.ok ? 200 : started.error === "alreadyRunning" ? 409 : 400,
    });
  }

  const preview = await buildCsvImportPreview(db, shop, importArgs);
  if (!preview.ok) return json<CsvImportActionResult>(preview);
  // A small import keeps the grid's own save (immediate, per-cell feedback);
  // anything larger runs in the background, so the client neither needs nor
  // gets the diff — for a large file it would outweigh the file itself.
  const { variantProductIdByRowId, ...rest } = preview;
  if (preview.diff.length <= MAX_SYNC_SAVE) return json<CsvImportActionResult>(rest);
  const batches = chunkImportDiff(preview.diff, columnsByType[type], { variantProductIdByRowId }).length;
  return json<CsvImportActionResult>({ ...rest, diff: [], applyInBackground: true, batches });
};
