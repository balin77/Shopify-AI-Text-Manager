/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — writing a collection's rule sources.
 *
 * ── Why this is a DIFF and not a replace ───────────────────────────────────
 * Shopify keys sources by id. Re-sending them all would churn every membership
 * on every save, and would delete-and-recreate rules the merchant never
 * touched. `diffRuleSources` produces the three lists `collectionUpdate`
 * actually takes, and it is where §2.4's guarantee lives: a source this editor
 * cannot render is invisible to the diff in every direction, so a collection
 * using a feature the editor does not speak survives a save untouched.
 *
 * ── Why the BEFORE side comes from the cache, not the client ───────────────
 * The client sends what it now holds. What it USED to hold has to come from
 * somewhere the merchant cannot edit — otherwise a manipulated payload could
 * name any source id as "removed" and delete a rule that governs another
 * collection's membership. The cache's envelope is that source of truth, and
 * it also carries the unrenderable sources the client never saw.
 *
 * ── Never fails the save ───────────────────────────────────────────────────
 * The content update has already happened. A rule change that does not land
 * comes back as a warning CODE (the app ships in three languages), never as an
 * error that would tell the merchant their text edits were lost too.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
import { resolveApiVersionString } from "~/utils/api-version";
import { COLLECTION_SOURCES_FIELDS, collectionSourcesAreRuleBased } from "./attribute-sync.shared";
import {
  diffRuleSources,
  editableSourcesFromEnvelope,
  rulesAvailableOn,
  validateRuleSources,
  type RuleSource,
} from "~/config/collection-rules.shared";

/** Warning codes, resolved to sentences by the client (`t.content.ruleWarnings`). */
export type CollectionRuleWarning =
  | "rulesRequireNewerApi"
  | "rulesUnreadable"
  | "rulesInvalid"
  | "rulesNotConfirmed"
  | "rulesFailed";

export async function applyCollectionRuleChange(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { collectionId: string; submitted: string },
): Promise<CollectionRuleWarning | undefined> {
  // `sources[]` does not exist below 2026-07. Refused rather than attempted:
  // an unknown input field fails at the SCHEMA level, which returns
  // `data: null` and never reaches `userErrors` — the whole call would read as
  // a success while nothing was written.
  if (!rulesAvailableOn(resolveApiVersionString())) return "rulesRequireNewerApi";

  let after: RuleSource[];
  try {
    const parsed = JSON.parse(params.submitted || "[]");
    if (!Array.isArray(parsed)) return "rulesUnreadable";
    after = parsed as RuleSource[];
  } catch {
    return "rulesUnreadable";
  }

  // Validated server-side, not only in the form: this handler is reachable by
  // POST, and a bad relation for a kind is another schema-level failure.
  if (validateRuleSources(after).length > 0) return "rulesInvalid";

  try {
    const row = await db.collection.findFirst({
      where: { shop, id: params.collectionId },
      select: { sourcesJson: true },
    });
    const before = editableSourcesFromEnvelope(row?.sourcesJson);
    if (!before) {
      // Nothing trustworthy to diff against — an unsynced collection, a row
      // still holding the old model, or a cache written before condition ids
      // were read. Writing the client's list as a full replacement here is
      // exactly the membership change §2.4 forbids.
      return "rulesUnreadable";
    }

    const diff = diffRuleSources(before, after);
    if (
      diff.sourcesToCreate.length === 0 &&
      diff.sourcesToUpdate.length === 0 &&
      diff.sourcesToDelete.length === 0
    ) {
      return undefined;
    }

    // The NEW argument, not the deprecated "input: CollectionInput". The
    // sources* fields live on CollectionUpdateInput only (PLAN §1.2 point 4),
    // and the same version gate above is what makes naming it safe: below
    // 2026-07 this mutation shape does not exist and is never sent.
    // The echoed collection uses the SAME selection the sync uses. A narrower
    // echo mirrored into "sourcesJson" would turn every source into an empty
    // renderable one — the merchant's rules would read as deleted, and the
    // next diff could delete a real source this editor may not touch.
    //
    // The prose stays out here on purpose: a `#` comment inside the document
    // travels to Shopify (see the GraphQL-comment gotcha in CLAUDE.md).
    const response = await admin.graphql(
      `#graphql
        mutation updateCollectionRules($collection: CollectionUpdateInput!) {
          collectionUpdate(collection: $collection) {
            collection { id ${COLLECTION_SOURCES_FIELDS} }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          collection: {
            id: params.collectionId,
            ...(diff.sourcesToCreate.length > 0 ? { sourcesToCreate: diff.sourcesToCreate } : {}),
            ...(diff.sourcesToUpdate.length > 0 ? { sourcesToUpdate: diff.sourcesToUpdate } : {}),
            ...(diff.sourcesToDelete.length > 0 ? { sourcesToDelete: diff.sourcesToDelete } : {}),
          },
        },
      },
    );

    const body = (await response.json()) as {
      data?: {
        collectionUpdate?: {
          collection?: { id: string; sources?: Parameters<typeof collectionSourcesAreRuleBased>[0] } | null;
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    // A schema-level error arrives as a top-level `errors` array with
    // `data: null` and never as a userError — checking only the latter would
    // read this as a success and mirror rules Shopify never stored.
    if (body.errors?.length) {
      logger.warn("[CollectionRules] Schema-level error", {
        context: "CollectionRules", shop, error: body.errors[0]?.message,
      });
      return "rulesFailed";
    }
    const payload = body.data?.collectionUpdate;
    if (payload?.userErrors?.length) {
      logger.warn("[CollectionRules] userErrors", {
        context: "CollectionRules", shop, error: payload.userErrors[0].message,
      });
      return "rulesFailed";
    }
    // The echo rule: without the collection back, nothing is known to have
    // changed — and the cache below must not claim otherwise.
    if (!payload?.collection?.id) return "rulesNotConfirmed";

    // Mirror what Shopify ECHOED, not what was sent: it assigns ids to new
    // sources and normalises what it stores, and the editor reads this back.
    await db.collection
      .update({
        where: { shop_id: { shop, id: params.collectionId } },
        data: {
          // A CONDITION makes a collection rule-based, never the presence of
          // a source: a manual collection carries one too, with its picks in
          // `selections` (measured — see `collectionSourcesAreRuleBased`).
          // The echo above uses the shared selection, so the shape is there to
          // answer with.
          isSmart: collectionSourcesAreRuleBased(payload.collection.sources),
          sourcesJson: {
            shape: "sources",
            apiVersion: resolveApiVersionString(),
            data: (payload.collection.sources ?? []) as never,
          },
        },
      })
      .catch(() => undefined);

    logger.info("[CollectionRules] Applied", {
      context: "CollectionRules",
      shop,
      created: diff.sourcesToCreate.length,
      updated: diff.sourcesToUpdate.length,
      deleted: diff.sourcesToDelete.length,
    });
    return undefined;
  } catch (error) {
    logger.warn("[CollectionRules] Failed", {
      context: "CollectionRules",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return "rulesFailed";
  }
}
