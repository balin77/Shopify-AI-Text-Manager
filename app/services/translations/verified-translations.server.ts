/**
 * Verified translation writes — THE module for echo-checked Shopify
 * translation register / remove and the ContentTranslation mirror that follows
 * (docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md §2.1, Phase A).
 *
 * Moved out of the bulk editor (which re-exports every name, so existing
 * imports keep working). The invariants (CLAUDE.md):
 *
 *   1. A save only counts when Shopify ECHOES the key back — `userErrors: []`
 *      alone is the silent-no-op bug (registerAndVerify).
 *   2. A clear only deletes the local DB row when Shopify CONFIRMS the
 *      removal (echo, or the single-locale re-read) — removeAndVerify.
 *   3. Digests are mandatory for translationsRegister (registerWithDigests
 *      reads them and never sends a key that has none).
 *
 * The helpers take a minimal `GraphqlClient`, which both `ShopifyApiGateway`
 * (background / bulk callers) and `admin` (request-bound callers; no gateway
 * retry sleeps on a schema refusal) satisfy.
 */

import type { PrismaClient } from "@prisma/client";
import {
  TRANSLATE_CONTENT_VERIFIED,
  REMOVE_TRANSLATIONS,
} from "../../graphql/content.mutations";
import { logger } from "../../utils/logger.server";
import { DIGEST_BATCH_CHUNK } from "../bulk-editor/columns.shared";
import { echoComparisonKey, findEchoFor } from "./translation-echo.shared";

/** Minimal client: `ShopifyApiGateway` and `admin` both satisfy it. */
export type GraphqlClient = {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
};

// ─── Digest loading ────────────────────────────────────────────────────────

interface TranslatableContentEntry {
  key: string;
  digest: string | null;
}

/**
 * Digests for ONE resource, restricted to `keys` (empty `keys` = all).
 * The single-item building block — loadDigestsForRows uses it as the
 * per-item fallback, and the §6.3 re-fetch rule uses it directly.
 */
export async function fetchDigestsForResource(
  gateway: GraphqlClient,
  resourceId: string,
  keys?: string[],
): Promise<Map<string, string>> {
  return (await fetchDigestsForResourceDetailed(gateway, resourceId, keys)).digests;
}

/**
 * `fetchDigestsForResource` that also says whether the resource ANSWERED. An
 * absent `translatableResource` (wrong or deleted id, a type that cannot be
 * translated) yields no digests exactly like a resource whose keys are all
 * empty -- the `translatableContent` trap -- and a caller that treats "no
 * digest" as permission to mirror locally must be able to tell them apart.
 */
export async function fetchDigestsForResourceDetailed(
  gateway: GraphqlClient,
  resourceId: string,
  keys?: string[],
): Promise<{ digests: Map<string, string>; found: boolean }> {
  const response = await gateway.graphql(
    `#graphql
      query bulkEditorTranslatableContent($resourceId: ID!) {
        translatableResource(resourceId: $resourceId) {
          translatableContent { key digest }
        }
      }`,
    { variables: { resourceId } },
  );
  const data = (await response.json()) as {
    data?: { translatableResource?: { translatableContent?: TranslatableContentEntry[] } | null };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);
  const resource = data.data?.translatableResource;
  const wanted = keys && keys.length > 0 ? new Set(keys) : null;
  const map = new Map<string, string>();
  for (const entry of resource?.translatableContent ?? []) {
    if (!entry.digest) continue;
    if (wanted && !wanted.has(entry.key)) continue;
    map.set(entry.key, entry.digest);
  }
  return { digests: map, found: !!resource && Array.isArray(resource.translatableContent) };
}

/**
 * Batch-fetch translation digests for many resources × several keys at once
 * (Plan §6.2 — the multi-key generalization of the seo-bulk-fix
 * loadTranslatableDigests). Aliased `a0..aN` sub-selections because Shopify
 * has no `translatableResourcesByIds`; chunked at DIGEST_BATCH_CHUNK,
 * deduplicated, and with a PER-ITEM fallback when a whole chunk fails.
 *
 * Returns resourceId → (key → digest). A resource that was queried but has no
 * digest for a key simply lacks that key in its inner map — the §6.3 rule
 * (one re-fetch, then cell error) is applied by the CALLER, not here. A
 * resource whose chunk AND per-item fallback both failed is absent from the
 * outer map entirely.
 */
export async function loadDigestsForRows(
  gateway: GraphqlClient,
  resourceIds: string[],
  keys: string[],
): Promise<Map<string, Map<string, string>>> {
  const result = new Map<string, Map<string, string>>();
  if (resourceIds.length === 0 || keys.length === 0) return result;

  const unique = Array.from(new Set(resourceIds));
  const wanted = Array.from(new Set(keys));

  for (let i = 0; i < unique.length; i += DIGEST_BATCH_CHUNK) {
    const chunk = unique.slice(i, i + DIGEST_BATCH_CHUNK);

    // Variable names $r0..$rN match alias names a0..aN, so parsing is
    // index-driven. The query TEXT depends only on chunk.length, never on the
    // GIDs — identical batch sizes stay cacheable server-side.
    const varDefs = chunk.map((_, idx) => `$r${idx}: ID!`).join(", ");
    const selections = chunk
      .map(
        (_, idx) =>
          `a${idx}: translatableResource(resourceId: $r${idx}) { translatableContent { key digest } }`,
      )
      .join("\n        ");
    const query = `#graphql
      query bulkEditorBatchDigests(${varDefs}) {
        ${selections}
      }`;
    const variables: Record<string, string> = {};
    for (let idx = 0; idx < chunk.length; idx++) variables[`r${idx}`] = chunk[idx];

    let parsed:
      | Record<string, { translatableContent?: TranslatableContentEntry[] } | null>
      | null = null;
    try {
      const response = await gateway.graphql(query, { variables });
      const data = (await response.json()) as {
        data?: Record<string, { translatableContent?: TranslatableContentEntry[] } | null>;
      };
      parsed = data.data ?? null;
    } catch (err: unknown) {
      logger.warn("[BULK] Digest batch failed — falling back per item", {
        context: "Bulk",
        chunkStart: i,
        chunkSize: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (parsed) {
      for (let idx = 0; idx < chunk.length; idx++) {
        const node = parsed[`a${idx}`];
        const map = new Map<string, string>();
        for (const entry of node?.translatableContent ?? []) {
          if (entry.digest && wanted.includes(entry.key)) map.set(entry.key, entry.digest);
        }
        result.set(chunk[idx], map);
      }
      continue;
    }

    // Per-item fallback: one bad chunk must not sink the run — each resource
    // gets its own attempt; individual failures leave the id absent so the
    // caller's re-fetch/cell-error rule takes over.
    for (const id of chunk) {
      try {
        result.set(id, await fetchDigestsForResource(gateway, id, wanted));
      } catch (err: unknown) {
        logger.warn("[BULK] Per-item digest fetch failed", {
          context: "Bulk",
          resourceId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

// ─── Verified register / remove ────────────────────────────────────────────

export interface TranslationInput {
  key: string;
  value: string;
  locale: string;
  translatableContentDigest: string;
  /** Market GID for a market-specific override; omit for global. */
  marketId?: string;
}

export interface TranslationUserError {
  field?: string[] | string;
  message: string;
}

/** A removal confirms KEYS and nothing else — there is no stored value left to
 *  echo, which is why it is its own type rather than a write with a hole. */
export interface VerifiedRemoveResult {
  /**
   * Keys whose removal is CONFIRMED — only these may be mirrored into the DB.
   *
   * Two things confirm it, and the second is not a weakening of the echo rule
   * but the stronger form of it: Shopify echoed the key back, OR a fresh read
   * of the resource shows the key carries no translation in that locale any
   * more. "It is gone" is what the rule is actually about; the echo is just
   * the cheap way to learn it.
   */
  confirmedKeys: Set<string>;
  /** Of those, the ones confirmed only by the re-read. Reported so a caller
   *  can log the difference rather than have it disappear. */
  confirmedByRead?: Set<string>;
  userErrors: TranslationUserError[];
}

export interface VerifiedWriteResult extends VerifiedRemoveResult {
  /**
   * key → the value Shopify echoed back, where it sent one.
   *
   * The same rule the theme path already follows ("mirror the PUSHED value to
   * DB, not the raw one"): what Shopify STORED is the truth, and it is what a
   * URL built from a `handle` translation has to be built from. Absent for a
   * key whose echo carried no value, so callers fall back to what they sent.
   */
  confirmedValues: Map<string, string>;
}

/**
 * ONE translationsRegister call for ONE resource, with echo verification
 * (Plan §6.2 — the generalization of templates-update.action.ts:294-315).
 *
 * Shopify can answer without userErrors yet register NOTHING (App-Embed keys
 * silently no-op this way; the same class of bug hit CookieBanner and
 * ThemeContent). The mutation echoes the translations it actually stored —
 * only echoed (key, locale) pairs land in confirmedKeys. §14 no. 7: the echo
 * selection requests `market { id }` (an object — flat marketId does not
 * exist); the market ASSIGNMENT is still tracked by the app itself, so a
 * missing market in the echo does not un-confirm a key.
 *
 * Throws on transport/GraphQL errors — the caller attributes the failure to
 * every input cell.
 */
export async function registerAndVerify(
  gateway: GraphqlClient,
  resourceId: string,
  inputs: TranslationInput[],
): Promise<VerifiedWriteResult> {
  if (inputs.length === 0) return { confirmedKeys: new Set(), confirmedValues: new Map(), userErrors: [] };

  const response = await gateway.graphql(TRANSLATE_CONTENT_VERIFIED, {
    variables: { resourceId, translations: inputs },
  });
  const data = (await response.json()) as {
    data?: {
      translationsRegister?: {
        translations?:
          | { key: string; locale: string; value: string; market?: { id: string } | null }[]
          | null;
        userErrors?: TranslationUserError[];
      };
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const userErrors = data.data?.translationsRegister?.userErrors ?? [];
  const echoed = data.data?.translationsRegister?.translations ?? [];

  const confirmedKeys = new Set<string>();
  const confirmedValues = new Map<string, string>();
  for (const input of inputs) {
    const confirmed = findEchoFor(echoed, input, { checkMarket: true });
    if (confirmed) {
      confirmedKeys.add(input.key);
      // What Shopify STORED, where it said so — the value a URL gets built
      // from, and the value mirrored into the DB.
      if (typeof confirmed.value === "string" && confirmed.value !== "") {
        confirmedValues.set(input.key, confirmed.value);
      }
    }
  }

  if (confirmedKeys.size < inputs.length) {
    logger.warn("[BULK] translationsRegister did not echo every key", {
      context: "Bulk",
      resourceId,
      sent: inputs.length,
      confirmed: confirmedKeys.size,
      userErrors: userErrors.length,
    });
  }
  return { confirmedKeys, confirmedValues, userErrors };
}

/**
 * ONE translationsRemove call for ONE resource, with echo verification —
 * the clear-cell counterpart (Plan §6.2, templates-update.action.ts:378ff).
 *
 * Keys whose removal Shopify does NOT confirm must NOT be deleted from the
 * local DB (CLAUDE.md invariant) — the caller keeps the local row and marks
 * the cell failed. `marketId` scopes the removal: with a market only that
 * market's override is removed (the global translation survives); without,
 * the global translation is removed.
 */
export async function removeAndVerify(
  gateway: GraphqlClient,
  resourceId: string,
  translationKeys: string[],
  locale: string,
  marketId: string,
): Promise<VerifiedRemoveResult> {
  if (translationKeys.length === 0) return { confirmedKeys: new Set(), userErrors: [] };

  const response = await gateway.graphql(REMOVE_TRANSLATIONS, {
    variables: {
      resourceId,
      translationKeys,
      locales: [locale],
      marketIds: marketId ? [marketId] : null,
    },
  });
  const data = (await response.json()) as {
    data?: {
      translationsRemove?: {
        translations?: { key: string; locale: string }[] | null;
        userErrors?: TranslationUserError[];
      };
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const userErrors = data.data?.translationsRemove?.userErrors ?? [];
  const echoed = data.data?.translationsRemove?.translations ?? [];
  const confirmedKeys = new Set<string>();
  for (const key of translationKeys) {
    if (findEchoFor(echoed, { key, locale })) confirmedKeys.add(key);
  }

  // An unechoed key is not yet a failure. `translationsRemove` echoes what it
  // DELETED, so a key that carried no translation on Shopify in the first
  // place — a local mirror row written when the register found no digest, the
  // documented case in CLAUDE.md — comes back empty, and the merchant was then
  // told "the translation was kept" about a field they had just cleared, with
  // no way to clear it.
  //
  // So ASK. A fresh read that shows the key carries nothing in this locale is
  // the removal confirmed, not assumed: it is the state the rule exists to
  // protect, reached by the strongest evidence available.
  const confirmedByRead = new Set<string>();
  const unconfirmed = translationKeys.filter((key) => !confirmedKeys.has(key));
  if (unconfirmed.length > 0) {
    try {
      const present = await translatedKeysForLocale(gateway, resourceId, locale, marketId);
      for (const key of unconfirmed) {
        if (!present.has(key)) {
          confirmedKeys.add(key);
          confirmedByRead.add(key);
        }
      }
    } catch (error) {
      // A failed re-read is NOT a confirmation. The keys stay unconfirmed and
      // their local rows stay, exactly as before this existed.
      logger.warn("[BULK] removal re-read failed — unechoed keys stay unconfirmed", {
        context: "Bulk",
        resourceId,
        locale,
        marketId: marketId || "(global)",
        keys: unconfirmed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (confirmedKeys.size < translationKeys.length) {
    // Names WHAT was not confirmed, and in which scope. Without the locale,
    // the market and the keys, "sent 1, confirmed 0" cannot be told apart from
    // a locale-spelling or market-scope mismatch, and the warning is a dead
    // end for whoever reads the log.
    logger.warn("[BULK] translationsRemove did not confirm every key — local rows kept", {
      context: "Bulk",
      resourceId,
      locale,
      marketId: marketId || "(global)",
      keys: translationKeys.filter((key) => !confirmedKeys.has(key)),
      sent: translationKeys.length,
      confirmed: confirmedKeys.size,
      confirmedByRead: confirmedByRead.size,
      userErrors: userErrors.length,
    });
  }
  return { confirmedKeys, confirmedByRead, userErrors };
}

/**
 * Which keys still CARRY a translation in this locale AND this layer.
 *
 * `marketId` goes into the QUERY, not just into a filter afterwards. That is
 * the whole correctness of this function: `translations(marketId: null)`
 * returns the GLOBAL layer only — the rule `fetchAllTranslations` is built on,
 * one pass per layer — so a client-side filter of a global-only result against
 * a non-empty `marketId` discards every row and reports "nothing present" for
 * ANY market removal. That confirmed every unechoed market key unconditionally
 * and deleted the local row while the storefront kept serving the override:
 * exactly the divergence the echo rule exists to prevent, and guaranteed
 * rather than occasional. The filter below stays as a belt-and-braces check.
 *
 * Two deliberate readings of the answer. A row whose value is `""` counts as
 * ABSENT — the storefront falls back to the primary text either way, so the
 * merchant's intent is reached. And a locale SPELLING this resource does not
 * have (asking `de` where Shopify holds `de-DE`) reads as "nothing there" and
 * confirms; the removal was sent under the same spelling, so the two cannot be
 * told apart from here, and this is stated rather than papered over.
 */
async function translatedKeysForLocale(
  gateway: GraphqlClient,
  resourceId: string,
  locale: string,
  marketId: string,
): Promise<Set<string>> {
  const response = await gateway.graphql(
    `#graphql
      query verifyTranslationRemoval($resourceId: ID!, $locale: String!, $marketId: ID) {
        translatableResource(resourceId: $resourceId) {
          translations(locale: $locale, marketId: $marketId) {
            key
            value
            market { id }
          }
        }
      }`,
    { variables: { resourceId, locale, marketId: marketId || null } },
  );
  const data = (await response.json()) as {
    data?: {
      translatableResource?: {
        translations?: Array<{ key: string; value: string | null; market?: { id: string } | null }>;
      } | null;
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);
  // An ABSENT `translatableResource` is not an empty one. It means the query
  // answered about nothing — a resource that does not exist, is not
  // translatable, or a shape we did not get. Reading that as "the key is gone"
  // would confirm every removal against a failed lookup, which is the
  // `translatableContent` trap in CLAUDE.md wearing a different hat.
  const resource = data.data?.translatableResource;
  if (!resource) throw new Error("translatableResource did not answer");
  // A NULL list is the same ambiguity one level down: it is not "everything is
  // gone", it is "this query carried no list". Only an actual array — empty or
  // not — is an answer.
  if (!Array.isArray(resource.translations)) {
    throw new Error("translatableResource carried no translations list");
  }
  const present = new Set<string>();
  for (const row of resource.translations) {
    const rowMarket = row.market?.id ?? "";
    if (rowMarket !== marketId) continue;
    if (row.value === null || row.value === "") continue;
    present.add(row.key);
  }
  return present;
}

/** Separator for a confirmed `${locale}\u0000${key}` pair (NUL can't occur in a
 * locale or a translation key). Written as an ESCAPE, never as a literal
 * control byte: a raw NUL makes git classify this file as binary, and the
 * module that owns every echo-verified translation write and removal would be
 * unreviewable in a diff. */
export const LOCALE_KEY_SEP = "\u0000";

/**
 * translationsRemove for ONE resource across SEVERAL locales in a single call,
 * with per-(locale, key) echo verification — the multi-locale generalization
 * of removeAndVerify used by the primary-save stale-translation invalidation
 * (Plan §6.6 / Phase 4b). Returns the set of CONFIRMED `${locale}\u0000${key}`
 * pairs Shopify echoed back; ONLY those may be deleted locally (an unconfirmed
 * removal keeps the local row — CLAUDE.md). Throws on transport/GraphQL errors.
 */
export async function removeAndVerifyAcrossLocales(
  gateway: GraphqlClient,
  resourceId: string,
  translationKeys: string[],
  locales: string[],
  marketId: string,
): Promise<{ confirmedPairs: Set<string>; userErrors: TranslationUserError[] }> {
  if (translationKeys.length === 0 || locales.length === 0) {
    return { confirmedPairs: new Set(), userErrors: [] };
  }

  const response = await gateway.graphql(REMOVE_TRANSLATIONS, {
    variables: {
      resourceId,
      translationKeys,
      locales,
      marketIds: marketId ? [marketId] : null,
    },
  });
  const data = (await response.json()) as {
    data?: {
      translationsRemove?: {
        translations?: { key: string; locale: string }[] | null;
        userErrors?: TranslationUserError[];
      };
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const userErrors = data.data?.translationsRemove?.userErrors ?? [];
  const echoed = data.data?.translationsRemove?.translations ?? [];
  // Keyed by the SENT locale spelling, never the echoed one: callers look pairs
  // up with what they sent, and Shopify may echo `pt-br` for `pt-BR`.
  const echoedPairs = new Set((echoed ?? []).map((t) => echoComparisonKey(t.locale, t.key)));
  const confirmedPairs = new Set<string>();
  for (const locale of locales) {
    for (const key of translationKeys) {
      if (echoedPairs.has(echoComparisonKey(locale, key))) {
        confirmedPairs.add(`${locale}${LOCALE_KEY_SEP}${key}`);
      }
    }
  }

  // NO re-read here, deliberately, and the asymmetry with `removeAndVerify`
  // above is the point. This function is the §6.6 invalidation sweep: it runs
  // PER ROW and per sub-resource (metafields, options, option values, image
  // alts), so one re-read per locale per gap is a multiplication — 200 products
  // x 8 sub-resources x 5 locales is ~9000 extra queries at 10 req/s, a
  // quarter of an hour of nothing but verification inside one task.
  //
  // And it buys almost nothing. An unconfirmed removal here leaves a stale
  // LOCAL row that the next sync corrects, with no cell failure and nothing
  // the merchant has to act on. The single-locale path is where an unconfirmed
  // removal is a dead end — the merchant clears a field, is told it was kept,
  // and can never clear it — which is why the re-read lives there and the cost
  // is one query per group that actually has a gap.
  return { confirmedPairs, userErrors };
}

// --- registerWithDigests ------------------------------------------------------

export interface DigestWriteValue {
  key: string;
  value: string;
}

export interface RegisterWithDigestsResult extends VerifiedWriteResult {
  /** key -> digest as read from Shopify (every sent key that had one). */
  digests: Map<string, string>;
  /** Keys that had no digest. They were NOT sent to Shopify. */
  noDigest: string[];
}

/**
 * "Fetch digest -> register -> verify the echo" in one call, for ONE locale
 * (and at most one market): ONE translatableResource query for the digests,
 * then registerAndVerify for the keys that have one. One locale per call
 * because the result is keyed by KEY -- with two locales in one call, a key
 * echoed for one of them would read as confirmed for both, and a per-locale
 * mirror would then write the unechoed one. A value with no digest is never
 * sent (translationsRegister requires it) and is reported in `noDigest` so the
 * caller decides whether to mirror it locally.
 *
 * Throws on transport/GraphQL errors, like the helpers it builds on, AND when
 * the resource itself did not answer: "this resource does not exist" must
 * never read as "these keys have no digest" (which a caller may mirror).
 */
export async function registerWithDigests(
  client: GraphqlClient,
  resourceId: string,
  locale: string,
  values: DigestWriteValue[],
  marketId?: string,
): Promise<RegisterWithDigestsResult> {
  if (values.length === 0) {
    return { confirmedKeys: new Set(), confirmedValues: new Map(), userErrors: [], digests: new Map(), noDigest: [] };
  }
  const { digests, found } = await fetchDigestsForResourceDetailed(client, resourceId, values.map((v) => v.key));
  if (!found) throw new Error(`translatableResource not found: ${resourceId}`);
  const inputs: TranslationInput[] = [];
  const noDigest: string[] = [];
  for (const v of values) {
    const digest = digests.get(v.key);
    if (!digest) {
      if (!noDigest.includes(v.key)) noDigest.push(v.key);
      continue;
    }
    inputs.push({
      key: v.key,
      value: v.value,
      locale,
      translatableContentDigest: digest,
      ...(marketId ? { marketId } : {}),
    });
  }
  const result = await registerAndVerify(client, resourceId, inputs);
  return { ...result, digests, noDigest };
}

// --- mirrorConfirmedContentTranslations -------------------------------------------

export interface MirrorContentTranslationsParams {
  shop: string;
  resourceId: string;
  resourceType: string;
  locale: string;
  /** "" or omitted = global layer. */
  marketId?: string;
  /** What was sent (the fallback value when the echo carried none). */
  sent: { key: string; value: string }[];
  result: Pick<VerifiedWriteResult, "confirmedKeys" | "confirmedValues">;
  digests: Map<string, string>;
  /**
   * Also write rows for sent keys that have NO digest (digest null; they never
   * reached Shopify). Opt-in: the single editor's rule, not a universal one.
   */
  mirrorWithoutDigest?: boolean;
}

export interface MirrorContentTranslationsResult {
  /** Keys mirrored with a confirmed Shopify write. */
  mirrored: string[];
  /** Keys mirrored locally only (no digest, never sent). */
  localOnly: string[];
}

/**
 * Upsert ContentTranslation rows for what Shopify CONFIRMED (value = what it
 * echoed, else what was sent; digest = the one the write used). Keys that were
 * sent and not echoed are NEVER mirrored; keys with no digest only with
 * `mirrorWithoutDigest`. The locale is the SENT spelling.
 */
export async function mirrorConfirmedContentTranslations(
  db: Pick<PrismaClient, "contentTranslation">,
  params: MirrorContentTranslationsParams,
): Promise<MirrorContentTranslationsResult> {
  const { shop, resourceId, resourceType, locale, sent, result, digests } = params;
  const marketId = params.marketId ?? "";
  const mirrored: string[] = [];
  const localOnly: string[] = [];

  const upsert = (key: string, value: string, digest: string | null) =>
    db.contentTranslation.upsert({
      where: { shop_resourceId_key_locale_marketId: { shop, resourceId, key, locale, marketId } },
      update: { value, digest, resourceType },
      create: { shop, resourceId, resourceType, key, value, locale, digest, marketId },
    });

  for (const { key, value } of sent) {
    if (result.confirmedKeys.has(key)) {
      await upsert(key, result.confirmedValues.get(key) ?? value, digests.get(key) ?? null);
      mirrored.push(key);
    } else if (params.mirrorWithoutDigest && !digests.get(key)) {
      await upsert(key, value, null);
      localOnly.push(key);
    }
  }
  return { mirrored, localOnly };
}

// --- removal with the gap re-read, for callers that must reach it ----------------

export interface RemoveWithGapRereadResult {
  /** Confirmed `${locale}${LOCALE_KEY_SEP}${key}` pairs, keyed by the SENT
   *  locale spelling. Only these may be deleted locally. */
  confirmedPairs: Set<string>;
  /**
   * Pairs that are NOT confirmed. With `localPairs` given: only the ones that
   * have a local row (what a caller could act on); without it: every one.
   */
  unconfirmedPairs: string[];
  userErrors: TranslationUserError[];
}

/**
 * The removal pattern of `purgeAltTranslations`, as one call: for ONE locale it
 * is `removeAndVerify` (echo, then the re-read on a gap); for SEVERAL it is ONE
 * `removeAndVerifyAcrossLocales` and then `removeAndVerify` ONLY for a locale
 * that has a gap -- so the re-read costs one query per locale that needs it,
 * never one per locale per key.
 *
 * `localPairs` (optional) are the `${locale}\0${key}` pairs that have a LOCAL
 * mirror row. When given, only a gap pair in it is re-read: a pair with no row
 * has nothing to delete locally, so confirming it buys nothing. Omit it where
 * the caller does not know the local rows -- every gap is then re-read.
 *
 * Why the re-read matters here at all: Shopify echoes what it DELETED, so a
 * key it never held (a DB-only mirror row, written on purpose when the register
 * found no digest) comes back empty with `userErrors: []`. "Delete confirmed
 * only" without the re-read would make such a row impossible to clear.
 *
 * Throws on a transport/GraphQL error of the FIRST call; a failed per-locale
 * re-read leaves that locale's pairs unconfirmed.
 */
export async function removeVerifiedWithGapReread(
  client: GraphqlClient,
  resourceId: string,
  translationKeys: string[],
  locales: string[],
  marketId: string,
  options: { localPairs?: ReadonlySet<string> } = {},
): Promise<RemoveWithGapRereadResult> {
  const confirmedPairs = new Set<string>();
  const userErrors: TranslationUserError[] = [];
  if (translationKeys.length === 0 || locales.length === 0) {
    return { confirmedPairs, unconfirmedPairs: [], userErrors };
  }
  const pair = (locale: string, key: string) => `${locale}${LOCALE_KEY_SEP}${key}`;

  if (locales.length === 1) {
    const single = await removeAndVerify(client, resourceId, translationKeys, locales[0], marketId);
    for (const key of single.confirmedKeys) confirmedPairs.add(pair(locales[0], key));
    userErrors.push(...single.userErrors);
  } else {
    const across = await removeAndVerifyAcrossLocales(client, resourceId, translationKeys, locales, marketId);
    for (const p of across.confirmedPairs) confirmedPairs.add(p);
    userErrors.push(...across.userErrors);
    for (const locale of locales) {
      const gapKeys = translationKeys.filter((key) => {
        const p = pair(locale, key);
        return !confirmedPairs.has(p) && (!options.localPairs || options.localPairs.has(p));
      });
      if (gapKeys.length === 0) continue;
      try {
        const single = await removeAndVerify(client, resourceId, gapKeys, locale, marketId);
        for (const key of single.confirmedKeys) confirmedPairs.add(pair(locale, key));
        userErrors.push(...single.userErrors);
      } catch (error: unknown) {
        // Unconfirmed: the local row stays and the next look corrects it.
        logger.warn("[VERIFIED] removal re-read for a gap locale failed", {
          context: "Verified",
          resourceId,
          locale,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const unconfirmedPairs: string[] = [];
  for (const locale of locales) {
    for (const key of translationKeys) {
      const p = pair(locale, key);
      if (confirmedPairs.has(p)) continue;
      if (options.localPairs && !options.localPairs.has(p)) continue;
      unconfirmedPairs.push(p);
    }
  }
  return { confirmedPairs, unconfirmedPairs, userErrors };
}

/**
 * The `where` fragment ({ key, locale } or an OR of them) that selects exactly
 * the CONFIRMED (locale, key) pairs of a removal, for a `deleteMany` -- or
 * `null` when nothing was confirmed (then there is nothing to delete). The
 * common all-confirmed case keeps the plain `key in / locale in` shape.
 */
export function confirmedPairsWhere(
  confirmedPairs: ReadonlySet<string>,
  translationKeys: string[],
  locales: string[],
):
  | { key: { in: string[] }; locale: { in: string[] } }
  | { OR: Array<{ locale: string; key: { in: string[] } }> }
  | null {
  const perLocale = locales
    .map((locale) => ({
      locale,
      keys: translationKeys.filter((key) => confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}${key}`)),
    }))
    .filter((entry) => entry.keys.length > 0);
  if (perLocale.length === 0) return null;
  if (perLocale.length === locales.length && perLocale.every((entry) => entry.keys.length === translationKeys.length)) {
    return { key: { in: translationKeys }, locale: { in: locales } };
  }
  return { OR: perLocale.map((entry) => ({ locale: entry.locale, key: { in: entry.keys } })) };
}

// --- media alt text (Phase E) --------------------------------------------------------
//
// The alt of a MediaImage / CollectionImage / ArticleImage is ONE key (`alt`) on
// the image's OWN translatable resource. Every alt-translation write site used
// to hand-roll "digest -> register -> userErrors" and then mirror on that;
// this is the shared sequence. The caller mirrors ONLY on `confirmed`, with
// `storedValue`, and never without a digest.

export const MEDIA_ALT_KEY = "alt";

export interface MediaAltRegisterResult {
  /** Shopify echoed the `alt` key back: the ONLY state a mirror may follow. */
  confirmed: boolean;
  /** What Shopify stored (the echoed value, else what was sent). Set when confirmed. */
  storedValue?: string;
  /** The digest the write used. Absent when the resource has none. */
  digest?: string;
  /** The resource answered but carries no `alt` digest: nothing was sent. */
  noDigest: boolean;
  userErrors: TranslationUserError[];
}

/**
 * Register ONE alt translation (one locale, at most one market) on an image
 * resource and verify the echo. Throws on transport/GraphQL errors and when the
 * resource did not answer at all (a wrong or deleted id must not read as
 * "no digest"). `noDigest` and an unechoed write both come back as
 * `confirmed: false` -- the caller reports the locale as failed and writes
 * nothing locally.
 */
export async function registerMediaAltAndVerify(
  client: GraphqlClient,
  imageGid: string,
  locale: string,
  value: string,
  marketId?: string,
  options: {
    /**
     * Per-request memo of the image's `alt` digest (null = no digest). A run
     * that writes one image into many locales reads the digest ONCE instead of
     * once per locale -- the primary alt does not change during the run, and
     * the echo check still decides every locale on its own.
     */
    digestCache?: Map<string, string | null>;
  } = {},
): Promise<MediaAltRegisterResult> {
  const cache = options.digestCache;
  let digest: string | undefined;
  if (cache && cache.has(imageGid)) {
    digest = cache.get(imageGid) ?? undefined;
  } else {
    const read = await fetchDigestsForResourceDetailed(client, imageGid, [MEDIA_ALT_KEY]);
    if (!read.found) throw new Error(`translatableResource not found: ${imageGid}`);
    digest = read.digests.get(MEDIA_ALT_KEY);
    cache?.set(imageGid, digest ?? null);
  }
  if (!digest) {
    return { confirmed: false, noDigest: true, userErrors: [] };
  }
  const result = await registerAndVerify(client, imageGid, [
    {
      key: MEDIA_ALT_KEY,
      value,
      locale,
      translatableContentDigest: digest,
      ...(marketId ? { marketId } : {}),
    },
  ]);
  const confirmed = result.confirmedKeys.has(MEDIA_ALT_KEY);
  return {
    confirmed,
    ...(confirmed ? { storedValue: result.confirmedValues.get(MEDIA_ALT_KEY) ?? value } : {}),
    ...(digest ? { digest } : {}),
    noDigest: false,
    userErrors: result.userErrors,
  };
}

/**
 * Remove ONE alt translation, verified (echo, then the single-locale re-read:
 * a DB-only row Shopify never held is cleared that way). Delete the local row
 * only when `confirmed`.
 */
export async function removeMediaAltAndVerify(
  client: GraphqlClient,
  imageGid: string,
  locale: string,
  marketId = "",
): Promise<{ confirmed: boolean; userErrors: TranslationUserError[] }> {
  const removal = await removeAndVerify(client, imageGid, [MEDIA_ALT_KEY], locale, marketId);
  return { confirmed: removal.confirmedKeys.has(MEDIA_ALT_KEY), userErrors: removal.userErrors };
}

/**
 * Mirror a CONFIRMED product-media alt translation into
 * ProductImageAltTranslation. The cache row is resolved from
 * (productId?, mediaId) NOW -- never captured: a product sync recreates
 * ProductImage rows with fresh ids. `imageGone` = no row to attach to (deleted
 * or not cached): nothing is written under a guessed id, the caller decides
 * how to report it. `value: ""` deletes the global-layer row.
 */
export async function mirrorProductMediaAlt(
  db: Pick<PrismaClient, "productImage" | "productImageAltTranslation">,
  params: { shop: string; mediaId: string; locale: string; value: string; productId?: string; marketId?: string },
): Promise<"mirrored" | "imageGone"> {
  const { shop, mediaId, locale, value } = params;
  const marketId = params.marketId ?? "";
  const image = await db.productImage.findFirst({
    where: { mediaId, product: { shop }, ...(params.productId ? { productId: params.productId } : {}) },
    select: { id: true },
  });
  if (!image) return "imageGone";
  try {
    if (value.trim() === "") {
      await db.productImageAltTranslation.deleteMany({ where: { imageId: image.id, locale, marketId } });
    } else {
      await db.productImageAltTranslation.upsert({
        where: { imageId_locale_marketId: { imageId: image.id, locale, marketId } },
        create: { imageId: image.id, locale, marketId, altText: value },
        update: { altText: value },
      });
    }
  } catch (error: unknown) {
    // The image was deleted between the lookup and the write (concurrent sync).
    if ((error as { code?: string })?.code === "P2003") return "imageGone";
    throw error;
  }
  return "mirrored";
}
