/**
 * The ONE echo-verified writer for metaobject FIELD values.
 *
 * Before this, the bulk editor knew how to write several fields of one entry in
 * a single `metaobjectUpdate` with a per-field echo check, and the single
 * editor knew how to write exactly one -- the label -- with none. Two write
 * paths for one mutation is the shape CLAUDE.md forbids, and the half that was
 * used more often was the one without the echo.
 *
 * So this module carries the semantics and both editors call it. It is the
 * `writeMediaAltText` pattern, not a third path:
 *
 * - ONE `metaobjectUpdate` for every field of the entry that changed.
 * - A SCHEMA error (top-level `errors`, `data: null`) and a `userErrors` entry
 *   are different failures and are reported as such; neither is silently
 *   folded into "saved".
 * - **The echo decides, per FIELD.** `userErrors: []` is not success: Shopify
 *   can accept the call and store nothing. Only fields that come back with OUR
 *   value count as written, and only those are mirrored into the cache. A
 *   partial result is normal and is reported per field, never as a failed row.
 * - The cache row is looked up FIRST, which doubles as the tenancy check: a
 *   metaobject of another shop does not resolve, so it cannot be written.
 *
 * What this module deliberately does NOT do is invalidate the foreign
 * translations. Both callers do that themselves with their own echo-verified
 * removal, because they differ in which locales they have already resolved --
 * the shared part is the mutation and the echo, not the caller's bookkeeping.
 */

import type { PrismaClient } from "@prisma/client";
import { METAOBJECT_UPDATE } from "~/graphql/content.mutations";
import { logger } from "~/utils/logger.server";
import type { ShopifyApiGateway } from "./shopify-api-gateway.service";

/** One field of one entry, as the caller addresses it. */
export interface MetaobjectFieldWrite {
  /**
   * The CALLER's handle for this write -- a bulk column id, or the single
   * editor's `<gid>#<fieldKey>`. Failures come back keyed by it so each editor
   * can mark the control the merchant is looking at, without this module
   * knowing either id shape.
   */
  ref: string;
  /** The Shopify field key. */
  key: string;
  /** The value as Shopify stores it (a list is already JSON here). */
  value: string;
}

export type MetaobjectWriteFailureReason =
  | "notCached"
  | "schemaError"
  | "userError"
  | "noEcho"
  | "transport";

export interface MetaobjectWriteResult {
  /** The definition type of the cached row -- null when it was not cached. */
  cachedType: string | null;
  /** Refs whose value Shopify echoed back. ONLY these were saved. */
  confirmedRefs: string[];
  /** The field KEYS behind `confirmedRefs`, for the caller's invalidation. */
  confirmedKeys: string[];
  /** Per-field failures. A write is in exactly one of the two lists. */
  failures: Array<{ ref: string; message: string; reason: MetaobjectWriteFailureReason }>;
  /**
   * Set when the whole call failed for a reason that is not about one field
   * (cache miss, transport, a rejected document). Every write is in `failures`
   * as well, so a caller that only reads `failures` still reports everything.
   */
  fatal?: { message: string; reason: MetaobjectWriteFailureReason };
  /** Shopify's view of the entry after the write, when it returned one. */
  echoedFields?: Array<{ key: string; value: string | null; type: string }>;
  displayName?: string | null;
}

interface MetaobjectUpdateResponse {
  data?: {
    metaobjectUpdate?: {
      metaobject?: {
        id: string;
        handle?: string;
        displayName?: string;
        type?: string;
        fields?: Array<{ key: string; value: string | null; type: string }> | null;
      } | null;
      userErrors?: Array<{ field?: string[] | string; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function writeMetaobjectFields(params: {
  gateway: ShopifyApiGateway;
  db: PrismaClient;
  shop: string;
  /** The metaobject GID. */
  id: string;
  writes: MetaobjectFieldWrite[];
}): Promise<MetaobjectWriteResult> {
  const { gateway, db, shop, id, writes } = params;

  const cached = await db.metaobject.findUnique({
    where: { shop_id: { shop, id } },
    select: { type: true },
  });
  if (!cached) {
    const message = "This metaobject is not in the local cache — resync content first.";
    return {
      cachedType: null,
      confirmedRefs: [],
      confirmedKeys: [],
      failures: writes.map((w) => ({ ref: w.ref, message, reason: "notCached" as const })),
      fatal: { message, reason: "notCached" },
    };
  }

  if (writes.length === 0) {
    return { cachedType: cached.type, confirmedRefs: [], confirmedKeys: [], failures: [] };
  }

  const failAll = (message: string, reason: MetaobjectWriteFailureReason): MetaobjectWriteResult => ({
    cachedType: cached.type,
    confirmedRefs: [],
    confirmedKeys: [],
    failures: writes.map((w) => ({ ref: w.ref, message, reason })),
    fatal: { message, reason },
  });

  let data: MetaobjectUpdateResponse;
  try {
    const response = await gateway.graphql(METAOBJECT_UPDATE, {
      variables: { id, metaobject: { fields: writes.map((w) => ({ key: w.key, value: w.value })) } },
    });
    data = (await response.json()) as MetaobjectUpdateResponse;
  } catch (err: unknown) {
    return failAll(err instanceof Error ? err.message : String(err), "transport");
  }

  if (data.errors && data.errors.length > 0) {
    return failAll(data.errors[0].message, "schemaError");
  }
  const payload = data.data?.metaobjectUpdate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    return failAll(userErrors[0].message, "userError");
  }

  const echoedFields = payload?.metaobject?.fields ?? [];
  const confirmedRefs: string[] = [];
  const confirmedKeys: string[] = [];
  const failures: MetaobjectWriteResult["failures"] = [];
  for (const write of writes) {
    const echo = echoedFields.find((f) => f.key === write.key);
    if (!echo || (echo.value ?? "") !== write.value) {
      failures.push({
        ref: write.ref,
        message: "Shopify did not confirm the field write.",
        reason: "noEcho",
      });
      continue;
    }
    confirmedRefs.push(write.ref);
    confirmedKeys.push(write.key);
  }

  if (confirmedRefs.length > 0 && payload?.metaobject) {
    // Mirror the ECHOED state wholesale -- the fields blob and the displayName
    // (the label field may have been one of the writes). Same shape the sync
    // writes, so the two cannot disagree about what a cached entry looks like.
    await db.metaobject.update({
      where: { shop_id: { shop, id } },
      data: {
        fields: echoedFields as object[],
        ...(payload.metaobject.displayName !== undefined
          ? { displayName: payload.metaobject.displayName ?? "" }
          : {}),
        lastSyncedAt: new Date(),
      },
    });
  }

  if (failures.length > 0) {
    logger.warn("[MetaobjectWrite] Shopify did not echo every written field", {
      context: "MetaobjectWrite",
      shop,
      id,
      sent: writes.length,
      confirmed: confirmedRefs.length,
    });
  }

  return {
    cachedType: cached.type,
    confirmedRefs,
    confirmedKeys,
    failures,
    echoedFields,
    displayName: payload?.metaobject?.displayName ?? null,
  };
}
