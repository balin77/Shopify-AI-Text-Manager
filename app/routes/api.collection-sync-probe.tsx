/**
 * Collection-Sync Probe — why does `attributesSyncedAt` stay NULL?
 *
 * The product editor's collection picker locks every row with "unknown whether
 * this collection picks its members by rule" when `Collection.attributesSyncedAt`
 * is NULL, and that column is written by exactly ONE thing: a collection sync
 * that got through. When the merchant syncs the Collections tab and the message
 * stays, the question is not "did they sync" — it is "what did the sync hit".
 *
 * This probe answers that, and it is built around three rules the rest of this
 * codebase already lives by:
 *
 * 1. **It reproduces the SYNC, it does not idealise it.** The query comes from
 *    `collectionAttributeSelection(resolveApiVersionString())` — the same
 *    builder, the same pin, through the same `admin.graphql` client. A probe
 *    that asks its own prettier question can come back green while the sync
 *    keeps failing, which is worse than no probe at all.
 * 2. **It BISECTS.** A schema-level error names a type, not always the field
 *    that caused it, and `data: null` takes the whole query down — so one
 *    failure tells you nothing about which of the ~25 selected fields is
 *    wrong. The ladder below asks the same collection for progressively more,
 *    and the first rung that breaks IS the culprit.
 * 3. **A failed call is never a negative answer.** Every step separates "the
 *    API answered and said no" from "we never got an answer" — the same rule
 *    as `attributesSyncedAt`, `indexabilityKnown` and the collection-model
 *    probe next door.
 *
 * The last step runs the REAL `syncCollection()` on one collection and reads
 * the row back, because everything above it only covers `fetchCollectionData`:
 * the sync also fetches locales, markets and translations, and a throw in any
 * of those fails the collection just as silently.
 *
 * Dev-only, whole route: it costs Admin API calls, and the real-sync step
 * writes cache rows. The Settings tab that drives it is gated the same way,
 * but a hidden tab is not a permission check — this route takes a direct POST.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { resolveApiVersionString } from "~/utils/api-version";
import {
  COLLECTION_SOURCES_FIELDS,
  collectionAttributeColumns,
  collectionAttributeSelection,
  collectionSourcesAreRuleBased,
  hasCollectionAttributes,
} from "~/services/attribute-sync.shared";
import { readConditionFragments, rulesAvailableOn } from "~/config/collection-rules.shared";

/**
 * What the SDK threw, as an outcome.
 *
 * Three shapes, and conflating them is exactly the "a failed call is not a
 * negative answer" trap:
 *
 *   - `GraphqlQueryError` — HTTP 200, the API ANSWERED and named its errors in
 *     `body.errors.graphQLErrors`. This is the schema-level failure that takes
 *     a whole query down with `data: null`, and it is the thing this probe
 *     exists to read out loud.
 *   - a thrown `Response` — the app's own client-error handler converts a 401
 *     into a re-auth redirect. Nothing is proven about the query.
 *   - anything else (throttling, 5xx, network) — no answer.
 */
function decodeThrow(error: unknown): CallResult {
  if (error instanceof Response) {
    return {
      ok: false,
      errors: [],
      codes: [],
      gotCollection: false,
      transportError: `the client threw an HTTP ${error.status} Response (usually a re-auth redirect) — the query was never answered`,
    };
  }
  const thrown = error as {
    message?: string;
    response?: { status?: number };
    body?: {
      data?: { collection?: Record<string, unknown> | null } | null;
      errors?:
        | { graphQLErrors?: Array<{ message?: string; extensions?: { code?: string }; path?: unknown[] }> }
        | Array<{ message?: string; extensions?: { code?: string } }>;
    };
  };
  const rawErrors = thrown.body?.errors;
  const graphQLErrors = Array.isArray(rawErrors) ? rawErrors : (rawErrors?.graphQLErrors ?? []);
  if (graphQLErrors.length > 0) {
    const collection = thrown.body?.data?.collection ?? null;
    return {
      ok: false,
      errors: graphQLErrors.map((e) => {
        const path = (e as { path?: unknown[] }).path;
        return `${e.message ?? "(no message)"}${Array.isArray(path) && path.length ? ` @ ${path.join(".")}` : ""}`;
      }),
      codes: graphQLErrors.map((e) => e.extensions?.code ?? "").filter(Boolean),
      gotCollection: !!collection,
      ...(collection ? { keys: Object.keys(collection), collection } : {}),
    };
  }
  const status = thrown.response?.status;
  return {
    ok: false,
    errors: [],
    codes: [],
    gotCollection: false,
    transportError: `${thrown.message ?? String(error)}${status ? ` (HTTP ${status})` : ""}`,
  };
}

/** The response body stays out of the report: it can be large, and the report
 *  is meant to be pasted into a conversation. */
function stripCollection(result: CallOutcome & { collection?: unknown }): CallOutcome {
  const { collection: _collection, ...rest } = result;
  return rest;
}

/** How many collections to run the read half against. Three is enough to tell
 *  "this shop" from "this collection" and cheap enough not to matter. */
const SAMPLE_SIZE = 3;

interface CallOutcome {
  /** The API answered AND carried no `errors` array. */
  ok: boolean;
  /** Verbatim, never summarised — the message is the whole point of the run. */
  errors: string[];
  /** `errors[].extensions.code`, which is where THROTTLED and friends live. */
  codes: string[];
  /** True when `data.collection` came back as an object. */
  gotCollection: boolean;
  /** The keys Shopify actually delivered, for the case where nothing errored
   *  and the block is STILL incomplete. */
  keys?: string[];
  /** We never got an answer (network, auth). Not a negative answer. */
  transportError?: string;
}

/** The response object itself, kept out of the report: it is fed to the real
 *  mapper below rather than re-queried, so the verdict cannot be about a
 *  different response than the one shown. */
type CallResult = CallOutcome & { collection?: Record<string, unknown> | null };

interface LadderRung {
  level: string;
  what: string;
  outcome: CallOutcome;
}

interface SampleReport {
  id: string;
  title: string;
  attributesSyncedAtBefore: string | null;
  /** The sync's own query, verbatim. */
  syncQuery: CallOutcome;
  /** What the mapper would make of that response. */
  blockComplete: boolean;
  wouldStampAttributes: boolean;
  /** Only run when the sync query failed — otherwise there is nothing to bisect. */
  ladder: LadderRung[];
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  if (process.env.APP_ENV !== "development") {
    return json(
      { success: false, error: "The collection-sync probe is a development-only diagnostic." },
      { status: 403 },
    );
  }

  const formData = await request.formData().catch(() => null);
  const runRealSync = formData?.get("realSync") === "true";

  const apiVersion = resolveApiVersionString();
  const { db } = await import("~/db.server");

  /**
   * One call through the SAME client the sync uses.
   *
   * `admin.graphql` is bolted to the pin, which is the point: the collection
   * sync cannot reach any other version either, so a probe that raw-fetches a
   * version of its own would answer a question nobody asked.
   *
   * ── The error arrives as a THROW, not in the body ──────────────────────────
   * MEASURED in the installed SDK: `GraphqlClient.request` calls
   * `throwFailedRequest`, which turns an HTTP 200 carrying `errors` into a
   * thrown `GraphqlQueryError` whose `body.errors.graphQLErrors` holds the
   * real messages. So `await response.json()` NEVER sees an `errors` array —
   * reading one (as several call sites in this app do) is dead code, and a
   * probe that only reads it would report every schema failure as "no answer
   * at all" and refuse to draw the conclusion it was built to draw. The
   * decoder below is therefore the load-bearing part of this file.
   */
  const call = async (query: string, id: string): Promise<CallResult> => {
    try {
      const response = await admin.graphql(query, { variables: { id } });
      const body = (await response.json()) as {
        data?: { collection?: Record<string, unknown> | null } | null;
        errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      };
      const collection = body.data?.collection ?? null;
      return {
        // Kept for the case where a future client version stops throwing:
        // an error in the body is an ANSWER, and must not read as a timeout.
        ok: !body.errors?.length,
        errors: (body.errors ?? []).map((e) => e.message ?? "(no message)"),
        codes: (body.errors ?? []).map((e) => e.extensions?.code ?? "").filter(Boolean),
        gotCollection: !!collection,
        ...(collection ? { keys: Object.keys(collection), collection } : {}),
      };
    } catch (error) {
      return decodeThrow(error);
    }
  };

  const wrap = (selection: string) => `#graphql
    query probeCollection($id: ID!) {
      collection(id: $id) {
        id
        title${selection}
      }
    }`;

  /**
   * The bisect, from "does anything work at all" up to the sync's own query.
   *
   * Each rung ADDS to the one below it, so the first failure names the field
   * that broke — which a single failed query cannot, because an unknown field
   * fails the document as a whole and `data` comes back null either way.
   */
  const ladder: Array<{ level: string; what: string; selection: string }> = [
    { level: "L0", what: "id/title only — does the shop, the id and the token work", selection: "" },
    { level: "L1", what: "+ sortOrder, templateSuffix (the version-independent half)", selection: "\n        sortOrder\n        templateSuffix" },
  ];
  if (rulesAvailableOn(apiVersion)) {
    ladder.push(
      {
        level: "L2",
        what: "+ sources, interface fields only (id/title/description)",
        selection: "\n        sources {\n          __typename\n          id\n          title\n          description\n        }",
      },
      {
        level: "L3",
        what: "+ ... on CollectionConditionsSource { targetType shareable }",
        selection:
          "\n        sources {\n          __typename\n          id\n          ... on CollectionConditionsSource {\n            targetType\n            shareable\n          }\n        }",
      },
      {
        level: "L4",
        what: "+ inclusion matchType and the selections CONNECTION",
        selection:
          "\n        sources {\n          __typename\n          id\n          ... on CollectionConditionsSource {\n            inclusion {\n              matchType\n              selections(first: 1) {\n                nodes {\n                  __typename\n                }\n              }\n            }\n          }\n        }",
      },
      {
        level: "L5",
        what: "+ the generated INCLUSION condition fragments (18 kinds, per-kind aliases)",
        selection: `\n        sources {\n          __typename\n          id\n          ... on CollectionConditionsSource {\n            inclusion {\n              matchType\n              conditions {\n                __typename\n${readConditionFragments("inclusion")}\n              }\n            }\n          }\n        }`,
      },
      {
        level: "L6",
        what: "+ the EXCLUSION half — this is the full COLLECTION_SOURCES_FIELDS",
        selection: `\n        ${COLLECTION_SOURCES_FIELDS}`,
      },
    );
  } else {
    ladder.push({
      level: "L2",
      what: "+ ruleSet (the pre-2026-07 model this version actually has)",
      selection: "\n        ruleSet {\n          appliedDisjunctively\n          rules {\n            column\n            relation\n            condition\n          }\n        }",
    });
  }

  try {
    // The sample is drawn from the rows that HAVE the problem first. Sampling
    // the most recently synced ones would pick exactly the collections that
    // already work and report a healthy shop back to a merchant staring at a
    // locked picker.
    const [total, withAttributes, newestSync, unstamped] = await Promise.all([
      db.collection.count({ where: { shop: session.shop } }),
      db.collection.count({ where: { shop: session.shop, attributesSyncedAt: { not: null } } }),
      db.collection.aggregate({ where: { shop: session.shop }, _max: { lastSyncedAt: true } }),
      db.collection.findMany({
        where: { shop: session.shop, attributesSyncedAt: null },
        select: { id: true, title: true, attributesSyncedAt: true, lastSyncedAt: true },
        orderBy: { lastSyncedAt: "desc" },
        take: SAMPLE_SIZE,
      }),
    ]);
    const cached =
      unstamped.length >= SAMPLE_SIZE
        ? unstamped
        : [
            ...unstamped,
            ...(await db.collection.findMany({
              where: { shop: session.shop, attributesSyncedAt: { not: null } },
              select: { id: true, title: true, attributesSyncedAt: true, lastSyncedAt: true },
              orderBy: { lastSyncedAt: "desc" },
              take: SAMPLE_SIZE - unstamped.length,
            })),
          ];

    // The cache is the better sample — those are the rows the picker reads.
    // A shop that has never synced has none, and then the live list is the
    // only way to have anything to ask about at all.
    let sampleIds = cached.map((c) => ({ id: c.id, title: c.title, attributesSyncedAtBefore: c.attributesSyncedAt?.toISOString() ?? null }));
    let liveListError: string | undefined;
    if (sampleIds.length === 0) {
      try {
        const response = await admin.graphql(`#graphql
          query probeCollectionList {
            collections(first: ${SAMPLE_SIZE}) {
              nodes {
                id
                title
              }
            }
          }`);
        const body = (await response.json()) as {
          data?: { collections?: { nodes?: Array<{ id: string; title: string }> } };
          errors?: Array<{ message?: string }>;
        };
        if (body.errors?.length) liveListError = body.errors.map((e) => e.message ?? "").join("; ");
        sampleIds = (body.data?.collections?.nodes ?? []).map((n) => ({
          id: n.id,
          title: n.title,
          attributesSyncedAtBefore: null,
        }));
      } catch (error) {
        liveListError = error instanceof Error ? error.message : String(error);
      }
    }

    const syncSelection = collectionAttributeSelection(apiVersion);
    const samples: SampleReport[] = [];

    for (const entry of sampleIds) {
      const syncQuery = await call(wrap(`\n        handle\n        descriptionHtml\n        updatedAt${syncSelection}\n        image {\n          id\n          url\n          altText\n        }\n        seo {\n          title\n          description\n        }`), entry.id);

      // The mapper's OWN verdict on the very response above, not a
      // re-implementation of it: "the query worked" and "the block was
      // complete" are different questions, and only the second decides
      // whether the column gets stamped.
      const data = (syncQuery.collection ?? null) as never;
      const sample: SampleReport = {
        ...entry,
        syncQuery: stripCollection(syncQuery),
        blockComplete: hasCollectionAttributes(data, apiVersion),
        wouldStampAttributes: collectionAttributeColumns(data, apiVersion).attributesSyncedAt !== undefined,
        ladder: [],
      };

      if (!syncQuery.ok || !syncQuery.gotCollection) {
        for (const rung of ladder) {
          const outcome = await call(wrap(rung.selection), entry.id);
          sample.ladder.push({ level: rung.level, what: rung.what, outcome: stripCollection(outcome) });
          // Stop at the first break: everything above it inherits the same
          // failure and would only pad the report. An answer that carries NO
          // collection ends it just as surely — the id does not resolve, so
          // every further rung would "pass" without proving anything.
          if (!outcome.ok || !outcome.gotCollection) break;
        }
      }
      samples.push(sample);
    }

    /**
     * `sources` against its own back-projection.
     *
     * The PRODUCT sync learns whether a membership is rule-based from
     * `Collection.ruleSet` (`PRODUCT_COLLECTIONS_SELECTION`), and `ruleSet` is
     * a LOSSY projection of `sources` from 2026-07 on: what it cannot express
     * — exclusions, several named sources, variant targeting — it simply
     * leaves out, and the collection then reads as MANUAL. That is not a
     * cosmetic mismatch: `collectionsToLeave` on a rule-based collection is
     * refused by Shopify, and `productUpdate` is atomic, so the refusal takes
     * the merchant's text edits with it.
     *
     * So this asks the shop for both, per collection, and reports where they
     * disagree. A disagreement is a product save waiting to fail; none means
     * every rule tree on this shop still projects.
     */
    const projection: {
      checked: number;
      ruleBased: number;
      disagreements: Array<{ id: string; title: string; hasSources: boolean; hasRuleSet: boolean }>;
      /**
       * What is actually IN those sources, per collection.
       *
       * The decisive question behind `isSmart`, which this app derives as
       * "has any source at all". PLAN §1.2 point 2 warns that `selections`
       * mixes manual and automatic in the new model — if a MANUAL collection
       * carries a source whose picks live in `selections` and whose condition
       * list is empty, then that derivation calls every collection on the shop
       * rule-based, and the membership picker locks every row it should offer.
       */
      shapes: Array<{
        title: string;
        types: string[];
        inclusionConditions: number;
        exclusionConditions: number;
        hasSelections: boolean;
        shareable: boolean;
      }>;
      /** The window ended before the shop did — "none found" then covers the
       *  first page only, and must not be reported shop-wide. */
      truncated: boolean;
      error?: string;
      skipped?: string;
    } = { checked: 0, ruleBased: 0, disagreements: [], shapes: [], truncated: false };

    if (!rulesAvailableOn(apiVersion)) {
      projection.skipped = `${apiVersion} has no sources model, so there is nothing to project from.`;
    } else {
      try {
        const response = await admin.graphql(`#graphql
          query probeProjection {
            collections(first: 50) {
              pageInfo {
                hasNextPage
              }
              nodes {
                id
                title
                sources {
                  __typename
                  ... on CollectionConditionsSource {
                    shareable
                    inclusion {
                      conditions {
                        __typename
                      }
                      selections(first: 1) {
                        nodes {
                          __typename
                        }
                      }
                    }
                    exclusion {
                      conditions {
                        __typename
                      }
                    }
                  }
                }
                ruleSet {
                  appliedDisjunctively
                }
              }
            }
          }`);
        const body = (await response.json()) as {
          data?: {
            collections?: {
              pageInfo?: { hasNextPage?: boolean };
              nodes?: Array<{
                id: string;
                title: string;
                sources?: Array<{
                  __typename?: string;
                  shareable?: boolean | null;
                  inclusion?: {
                    conditions?: unknown[] | null;
                    selections?: { nodes?: unknown[] | null } | null;
                  } | null;
                  exclusion?: { conditions?: unknown[] | null } | null;
                }> | null;
                ruleSet?: unknown | null;
              }>;
            };
          };
        };
        projection.truncated = body.data?.collections?.pageInfo?.hasNextPage === true;
        for (const node of body.data?.collections?.nodes ?? []) {
          projection.checked += 1;
          const sources = node.sources ?? [];
          const hasSources = sources.length > 0;
          const hasRuleSet = !!node.ruleSet;
          // PRODUCTION's own predicate, called rather than restated: a
          // re-derivation here would judge the code by a rule the code does
          // not use — and this one differs, because a sub-collections source
          // is rule-based without carrying a single condition.
          const ruleBased = collectionSourcesAreRuleBased(sources);
          if (ruleBased) projection.ruleBased += 1;
          // The mismatch that matters: a real rule tree that `ruleSet` does
          // not show. A manual collection legitimately has no `ruleSet`, so
          // comparing bare source PRESENCE would report every one of them.
          if (ruleBased && !hasRuleSet) {
            projection.disagreements.push({ id: node.id, title: node.title, hasSources, hasRuleSet });
          }
          if (hasSources) {
            projection.shapes.push({
              title: node.title,
              types: [...new Set(sources.map((src) => src.__typename ?? "(none)"))],
              inclusionConditions: sources.reduce((n, src) => n + (src.inclusion?.conditions?.length ?? 0), 0),
              exclusionConditions: sources.reduce((n, src) => n + (src.exclusion?.conditions?.length ?? 0), 0),
              hasSelections: sources.some((src) => (src.inclusion?.selections?.nodes?.length ?? 0) > 0),
              shareable: sources.some((src) => src.shareable === true),
            });
          }
        }
      } catch (error) {
        // A failed call is not "they agree" — the same rule as everywhere else
        // in this file.
        projection.error = decodeThrow(error).transportError ?? decodeThrow(error).errors.join(" | ");
      }
    }

    /**
     * The other half of the sync.
     *
     * `fetchCollectionData` is only the first step: `syncCollection` also
     * fetches locales, markets and every translation, and a throw in any of
     * them fails the collection before the upsert — with the same silence.
     * So the last measurement is the real thing, caught.
     */
    const realSync: {
      ran: boolean;
      collectionId?: string;
      error?: string;
      attributesSyncedAtAfter?: string | null;
      /** "No row" and "a row whose column is NULL" are different answers. */
      rowExistsAfter?: boolean;
    } = { ran: false };

    if (runRealSync && samples[0]) {
      realSync.ran = true;
      realSync.collectionId = samples[0].id;
      try {
        const { ContentSyncService } = await import("~/services/content-sync.service");
        await new ContentSyncService(admin, session.shop).syncCollection(samples[0].id, true);
      } catch (error) {
        realSync.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
      }
      const row = await db.collection.findFirst({
        where: { shop: session.shop, id: samples[0].id },
        select: { attributesSyncedAt: true },
      });
      realSync.rowExistsAfter = !!row;
      realSync.attributesSyncedAtAfter = row?.attributesSyncedAt?.toISOString() ?? null;
    }

    const verdicts: string[] = [];
    verdicts.push(
      `The sync runs against **${apiVersion}** (SHOPIFY_API_VERSION=${process.env.SHOPIFY_API_VERSION ?? "unset"}), so it asks for ${rulesAvailableOn(apiVersion) ? "`sources`" : "`ruleSet`"}.`,
    );
    verdicts.push(`Cache: ${withAttributes}/${total} collections carry \`attributesSyncedAt\`. The picker locks every row that does not.`);
    if (total === 0) verdicts.push("No collections are cached at all — nothing has ever been synced successfully on this shop.");
    if (liveListError) verdicts.push(`The live collection list could not be read: ${liveListError} — that is a failed call, not "this shop has no collections".`);

    for (const sample of samples) {
      if (sample.syncQuery.transportError) {
        verdicts.push(`\`${sample.title}\`: no answer at all (${sample.syncQuery.transportError}). Nothing is proven about the query.`);
        continue;
      }
      if (!sample.syncQuery.ok) {
        const broke = sample.ladder.find((r) => !r.outcome.ok);
        verdicts.push(
          broke
            ? `\`${sample.title}\`: the sync query FAILS, and the bisect names **${broke.level}** — ${broke.what}. Error: ${broke.outcome.errors.join(" | ") || broke.outcome.transportError || "(none reported)"}`
            : `\`${sample.title}\`: the sync query fails but every ladder rung passed — the failure is in a field the ladder does not isolate. Errors: ${sample.syncQuery.errors.join(" | ")}`,
        );
        continue;
      }
      if (!sample.syncQuery.gotCollection) {
        verdicts.push(
          `\`${sample.title}\`: the query was ANSWERED and returned no collection for this id — it no longer exists on Shopify (or is not visible to this app). \`syncCollection\` returns early there with "Collection not found" and stamps nothing; the cached row is stale and a stale-delete, not a sync failure.`,
        );
        continue;
      }
      if (!sample.blockComplete) {
        verdicts.push(
          `\`${sample.title}\`: the query WORKED but the attribute block is incomplete, so the mapper writes nothing and \`attributesSyncedAt\` stays NULL. Delivered keys: ${(sample.syncQuery.keys ?? []).join(", ") || "(none)"}`,
        );
        continue;
      }
      verdicts.push(`\`${sample.title}\`: the read half is fine — this collection WOULD be stamped. If it is not, the failure is later in \`syncCollection\` (locales, markets, translations, the upsert).`);
    }

    if (projection.skipped) {
      verdicts.push(`Projection check skipped: ${projection.skipped}`);
    } else if (projection.error) {
      verdicts.push(`The projection check could not be run (${projection.error}) — that proves nothing about it either way.`);
    } else if (projection.checked === 0) {
      // Zero collections looked at is not zero disagreements found — the same
      // rule this whole file is built on.
      verdicts.push("The projection check looked at NO collections, so it says nothing either way.");
    } else if (projection.shapes.length > 0 && projection.shapes.every((s) => s.inclusionConditions + s.exclusionConditions === 0)) {
      // The one that changes a derivation rather than reporting a mismatch.
      verdicts.push(
        `**Every one of the ${projection.shapes.length} collections that HAS a source has NO condition in it** (${projection.shapes.filter((s) => s.hasSelections).length} carry hand-picked selections). In the 2026-07 model a MANUAL collection has a source too — so \`isSmart = sources.length > 0\` calls every collection on this shop rule-based, and the membership picker locks every row it should be offering. The condition count, not the source count, is the signal.`,
      );
    } else if (projection.shapes.some((s) => s.inclusionConditions + s.exclusionConditions === 0)) {
      verdicts.push(
        `${projection.shapes.filter((s) => s.inclusionConditions + s.exclusionConditions === 0).length} of ${projection.shapes.length} collections have a source with NO conditions — those are manual collections that \`isSmart = sources.length > 0\` reports as rule-based.`,
      );
    }
    if (projection.disagreements.length > 0) {
      verdicts.push(
        `**${projection.disagreements.length} of ${projection.checked} collections carry real CONDITIONS that do not project back into \`ruleSet\`** (${projection.disagreements.map((d) => d.title).join(", ")}). The PRODUCT sync reads exactly that field, so it stores those memberships as MANUAL — and a save that tries to leave one is refused by Shopify with the merchant's text edits in the same atomic mutation.`,
      );
    } else if (projection.checked > 0) {
      verdicts.push(
        `Of the ${projection.checked} collections checked, ${projection.ruleBased} carry conditions, and every one of those still projects into \`ruleSet\` — so the product sync's flag agrees today. It is still the lossy field to read.${projection.truncated ? " NOTE: the shop has more collections than the window — this covers the first 50 only." : ""}`,
      );
    }

    if (realSync.ran) {
      verdicts.push(
        realSync.error
          ? `The real \`syncCollection\` THREW: ${realSync.error.split("\n")[0]}`
          : realSync.attributesSyncedAtAfter
            ? `The real \`syncCollection\` went through and stamped \`attributesSyncedAt\` (${realSync.attributesSyncedAtAfter}).`
            : realSync.rowExistsAfter === false
              ? "The real `syncCollection` did NOT throw and wrote NO ROW at all — it returned early, which it does when Shopify has no such collection."
              : "The real `syncCollection` did NOT throw and still left `attributesSyncedAt` NULL — the response arrived and the mapper refused it as incomplete.",
      );
    }

    return json({
      success: true,
      report: {
        shop: session.shop,
        ranAt: new Date().toISOString(),
        apiVersion,
        envApiVersion: process.env.SHOPIFY_API_VERSION ?? null,
        rulesModel: rulesAvailableOn(apiVersion) ? "sources" : "ruleSet",
        db: {
          total,
          withAttributes,
          // Across the SHOP, not across the sample — the sample is drawn from
          // the rows that failed, so its newest date describes the problem,
          // not the shop.
          newestSync: newestSync._max.lastSyncedAt?.toISOString() ?? null,
        },
        samples,
        projection,
        realSync,
        verdicts,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[CollectionSyncProbe] Failed", { context: "CollectionSyncProbe", shop: session.shop, error: message });
    return json({ success: false, error: message }, { status: 500 });
  }
}
