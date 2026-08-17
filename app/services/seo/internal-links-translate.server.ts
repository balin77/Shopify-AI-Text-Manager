/**
 * Internal linking — "Übersetzungen mitführen" (carry translations along).
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Accepting a suggestion rewrites PRIMARY content (the body gets one `<a>`
 * around an existing word). Every primary save in this app purges the foreign
 * translations of the fields it changed (update.actions.ts / updateContent —
 * the source text changed, so the translation is stale). For an internal link
 * that rule is wrong: the sentence did not change at all, only its markup. The
 * merchant lost hand-written translations for a formatting-level edit.
 *
 * ── How it is fixed ────────────────────────────────────────────────────────
 * With the toggle on, the accept path simply does NOT send `changedFields`, so
 * no purge runs and the translations stay exactly where they are (established
 * pattern — the accept-and-translate flows already omit it; see
 * content-update.action.ts). This module then does the second half: it puts the
 * SAME link into each foreign translation, pointing at the localized URL, and
 * re-registers it against the new primary digest so Shopify stops flagging the
 * translation as outdated.
 *
 * That ordering is the safety property: nothing is deleted first and restored
 * afterwards. Every step below is best-effort — if the digest cannot be read,
 * if the anchor cannot be located in a translation, or if AI is unavailable,
 * the translation is left untouched (worst case: present but link-free), never
 * removed. Losing a translation is not a failure mode this path can reach.
 *
 * ── Finding the anchor in another language ─────────────────────────────────
 * Every translation is searched on its own terms, never for the primary
 * wording. "Stifthalter" is looked for in the Spanish body as the phrase the
 * SPANISH text uses, which is why the AI step is handed that text instead of
 * just the anchor: a dictionary translation ("portalápiz") loses against the
 * inflection the text actually contains ("portalápices"), and the whole-word
 * matcher would find nothing. Whatever comes back still has to survive the
 * same matcher, so a wrong wording costs a link, never content.
 *
 * ── Localized URL ──────────────────────────────────────────────────────────
 * `/de/products/<handle>` — the locale's URL prefix comes from the shop's
 * market web presences (`rootUrls`, the same field loadMarkets() reads), which
 * is authoritative for subfolder markets; the plain `/<locale>` fallback is
 * what a single-domain multi-language shop uses anyway. The handle is the
 * target's TRANSLATED handle when one exists, because that is the URL Shopify
 * actually serves in that language.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * Global translations only (`marketId: ""`). Market overrides are never purged
 * by a primary save either, so they are not at risk here; they keep their
 * existing text and simply do not gain the link.
 */

import type { PrismaClient } from "@prisma/client";
import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { logger } from "../../utils/logger.server";
import {
  fetchDigestsForResource,
  registerAndVerify,
} from "../bulk-editor/translations.server";
import {
  eligibleAnchorText,
  htmlAlreadyLinksTo,
  insertLinkIntoHtml,
  targetUrlPath,
} from "./internal-links.service";

/** Locales handled in one accept. Beyond this the aliased GraphQL queries grow
 *  without bound; a shop with more published languages than this simply carries
 *  the first N (the rest keep their untouched translation). */
export const MAX_CARRY_LOCALES = 20;

export interface CarryOutcome {
  /** Locales whose translation was re-registered WITH the localized link. */
  linked: string[];
  /** Locales that kept their translation without gaining a link — the anchor
   *  could not be located in that language, the translation already linked to
   *  the target, or the write did not go through. Either way the translation
   *  is still live; only the link is missing. */
  unlinked: string[];
}

export interface CarryParams {
  gateway: ShopifyApiGateway;
  db: PrismaClient;
  shop: string;
  /** Source item the link was inserted into (the resource just saved). */
  source: { resourceId: string; resourceType: string };
  /** Link target — its handle/title drive the localized href and anchor. */
  target: { resourceId: string; resourceType: "Product" | "Collection"; handle: string; title: string };
  /** Shopify translatable-content key of the edited field ("body_html"). */
  translationKey: string;
  /** The exact anchor substring that was linked in the primary content. */
  anchorText: string;
  primaryLocale: string;
  /** Published, non-primary locales of the shop. */
  foreignLocales: string[];
  /**
   * Optional AI hook: given the anchor and the TRANSLATED text of each locale
   * that still needs one, return locale → the wording that text uses (missing
   * entries are fine). Injected rather than imported so this module stays
   * provider-agnostic, exactly like internal-links.service.ts's
   * `synonymProvider`.
   */
  translateAnchor?: (
    anchor: string,
    fromLocale: string,
    samples: { locale: string; text: string }[],
  ) => Promise<Record<string, string>>;
}

// ── Locale URL prefixes ─────────────────────────────────────────────────────

const MARKET_ROOT_URLS = `#graphql
  query internalLinksMarketRootUrls($first: Int!) {
    markets(first: $first) {
      edges {
        node {
          status
          webPresences(first: 5) {
            edges {
              node {
                rootUrls {
                  locale
                  url
                }
              }
            }
          }
        }
      }
    }
  }`;

interface RootUrlEntry {
  locale: string;
  url: string;
}

/**
 * locale → URL path prefix ("" for the locale served at the domain root,
 * "/de" for a language subfolder).
 *
 * A global translation is one value for every market, so when several markets
 * serve the same locale under different roots there is exactly one href to
 * pick: we take the host that serves the MOST locales (the main storefront)
 * and read the prefixes off its root URLs. Locales that host does not list
 * fall back to `/<locale>`, which is Shopify's default language subfolder.
 *
 * Never throws: `read_markets` may be missing, in which case every locale
 * takes the fallback (which is what a single-domain shop needs anyway).
 */
export async function loadLocalePathPrefixes(
  gateway: ShopifyApiGateway,
  locales: string[],
  primaryLocale: string,
): Promise<Map<string, string>> {
  const prefixes = new Map<string, string>();
  const fallback = (locale: string) => (locale === primaryLocale ? "" : `/${locale.toLowerCase()}`);

  let byHost: Map<string, RootUrlEntry[]> | null = null;
  try {
    const response = await gateway.graphql(MARKET_ROOT_URLS, { variables: { first: 50 } });
    const data = (await response.json()) as {
      data?: {
        markets?: {
          edges?: Array<{
            node?: {
              status?: string;
              webPresences?: { edges?: Array<{ node?: { rootUrls?: RootUrlEntry[] } }> };
            };
          }>;
        };
      };
    };
    byHost = new Map();
    for (const marketEdge of data.data?.markets?.edges ?? []) {
      // Same gate as loadMarkets (CLAUDE.md): ACTIVE, not the deprecated `enabled`.
      if (marketEdge.node?.status && marketEdge.node.status !== "ACTIVE") continue;
      for (const wpEdge of marketEdge.node?.webPresences?.edges ?? []) {
        for (const rootUrl of wpEdge.node?.rootUrls ?? []) {
          if (!rootUrl?.url || !rootUrl.locale) continue;
          let parsed: URL;
          try {
            parsed = new URL(rootUrl.url);
          } catch {
            continue;
          }
          const list = byHost.get(parsed.host) ?? [];
          if (!list.some((e) => e.locale === rootUrl.locale)) list.push(rootUrl);
          byHost.set(parsed.host, list);
        }
      }
    }
  } catch (err: unknown) {
    logger.warn("[SEO-Links] Market root URLs unavailable — using /<locale> prefixes", {
      context: "SEO",
      error: err instanceof Error ? err.message : String(err),
    });
    byHost = null;
  }

  let mainHostUrls: RootUrlEntry[] = [];
  for (const entries of byHost?.values() ?? []) {
    if (entries.length > mainHostUrls.length) mainHostUrls = entries;
  }

  for (const locale of locales) {
    const entry = mainHostUrls.find((e) => e.locale.toLowerCase() === locale.toLowerCase());
    if (!entry) {
      prefixes.set(locale, fallback(locale));
      continue;
    }
    let pathname: string;
    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      prefixes.set(locale, fallback(locale));
      continue;
    }
    // "/" (domain root) and "/de/" both normalize to a prefix that can be
    // concatenated with "/products/<handle>" without doubling the slash.
    prefixes.set(locale, pathname.replace(/\/+$/, ""));
  }
  return prefixes;
}

// ── Per-locale translation reads ────────────────────────────────────────────

/**
 * key → value per locale for ONE resource, in a single request (aliased
 * sub-selections, because `translations(locale:)` takes exactly one locale).
 * Global translations only — no `marketId` argument.
 */
async function fetchTranslationsByLocale(
  gateway: ShopifyApiGateway,
  resourceId: string,
  locales: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (locales.length === 0) return out;

  const varDefs = locales.map((_, i) => `$l${i}: String!`).join(", ");
  const selections = locales
    .map((_, i) => `t${i}: translations(locale: $l${i}) { key value }`)
    .join("\n        ");
  const query = `#graphql
    query internalLinksTranslations($resourceId: ID!, ${varDefs}) {
      translatableResource(resourceId: $resourceId) {
        ${selections}
      }
    }`;
  const variables: Record<string, string> = { resourceId };
  locales.forEach((locale, i) => {
    variables[`l${i}`] = locale;
  });

  const response = await gateway.graphql(query, { variables });
  const data = (await response.json()) as {
    data?: { translatableResource?: Record<string, Array<{ key: string; value: string | null }>> | null };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const resource = data.data?.translatableResource;
  if (!resource) return out;
  locales.forEach((locale, i) => {
    const entries = resource[`t${i}`];
    if (!Array.isArray(entries)) return;
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (entry?.key && typeof entry.value === "string" && entry.value.length > 0) {
        map.set(entry.key, entry.value);
      }
    }
    out.set(locale, map);
  });
  return out;
}

// ── Anchor resolution (pure) ────────────────────────────────────────────────

function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * Wordings to try, in descending reliability, for the phrase that stands in
 * for `anchorText` inside a translated body:
 *   1. the target's TRANSLATED title — exact and free, and the anchor IS the
 *      target's title in the highest-confidence match kind;
 *   2. the wording the AI read out of that very translation (only looked up
 *      for the locales where 1 and 3 found nothing);
 *   3. the anchor verbatim — brand and product names are frequently identical
 *      across languages, so this is a real hit, not a fallback formality.
 * De-duplicated so an identical candidate is not searched twice.
 */
export function localizedAnchorCandidates(input: {
  anchorText: string;
  targetTitle: string;
  translatedTitle?: string;
  aiAnchor?: string;
}): string[] {
  const out: string[] = [];
  const push = (candidate: string | undefined) => {
    const value = (candidate || "").trim();
    if (!value) return;
    if (out.some((existing) => sameText(existing, value))) return;
    out.push(value);
  };
  if (input.translatedTitle && sameText(input.anchorText, input.targetTitle)) push(input.translatedTitle);
  push(input.aiAnchor);
  push(input.anchorText);
  return out;
}

// ── The carry step ──────────────────────────────────────────────────────────

/**
 * Insert the accepted link into every existing foreign translation of the
 * edited field and re-register it against the CURRENT primary digest.
 *
 * Runs AFTER the primary save. Never throws — a caller must be able to treat
 * an accepted suggestion as accepted regardless of what happens here, because
 * the merchant's translations are already safe (nothing was purged).
 */
export async function carryLinkIntoTranslations(params: CarryParams): Promise<CarryOutcome> {
  const {
    gateway,
    db,
    shop,
    source,
    target,
    translationKey,
    anchorText,
    primaryLocale,
    translateAnchor,
  } = params;

  const outcome: CarryOutcome = { linked: [], unlinked: [] };
  const locales = params.foreignLocales.slice(0, MAX_CARRY_LOCALES);
  if (locales.length === 0) return outcome;

  try {
    const [sourceTranslations, targetTranslations, prefixes, digests] = await Promise.all([
      fetchTranslationsByLocale(gateway, source.resourceId, locales),
      fetchTranslationsByLocale(gateway, target.resourceId, locales),
      loadLocalePathPrefixes(gateway, locales, primaryLocale),
      // The digest of the value we JUST wrote — a translation registered against
      // an older digest is rejected, and one registered against this digest is
      // no longer flagged "outdated" in Shopify's translation editor.
      fetchDigestsForResource(gateway, source.resourceId, [translationKey]),
    ]);

    const digest = digests.get(translationKey);
    const withTranslation = locales.filter((locale) => sourceTranslations.get(locale)?.get(translationKey));
    if (withTranslation.length === 0) return outcome;
    if (!digest) {
      // Nothing was deleted, so the translations simply stay as they are —
      // Shopify marks them outdated until the merchant edits them.
      logger.warn("[SEO-Links] No digest for the edited field — translations left untouched", {
        context: "SEO",
        resourceId: source.resourceId,
        translationKey,
      });
      outcome.unlinked.push(...withTranslation);
      return outcome;
    }

    // Pass 1: free candidates (translated target title, anchor verbatim).
    const pending = new Map<string, string>(); // locale -> foreign HTML
    const resolved = new Map<string, string>(); // locale -> foreign HTML WITH link
    for (const locale of withTranslation) {
      const html = sourceTranslations.get(locale)!.get(translationKey)!;
      const linked = tryInsert({
        html,
        locale,
        prefixes,
        target,
        targetTranslations,
        anchorText,
        aiAnchor: undefined,
      });
      if (linked) resolved.set(locale, linked);
      else pending.set(locale, html);
    }

    // Pass 2: ONE AI request for whatever is left. It gets each translation's
    // own text, not just the anchor, so it can return the wording that text
    // really uses ("portalápices"), not a dictionary translation of the anchor
    // ("portalápiz") that the whole-word matcher would never find.
    if (pending.size > 0 && translateAnchor) {
      const samples = Array.from(pending.entries()).map(([locale, html]) => ({
        locale,
        text: eligibleAnchorText(html),
      }));
      const aiAnchors = await translateAnchor(anchorText, primaryLocale, samples).catch((err: unknown) => {
        logger.warn("[SEO-Links] Anchor lookup failed — links skipped for those locales", {
          context: "SEO",
          error: err instanceof Error ? err.message : String(err),
        });
        return {} as Record<string, string>;
      });
      for (const [locale, html] of Array.from(pending.entries())) {
        const aiAnchor = aiAnchors[locale];
        if (!aiAnchor) continue;
        const linked = tryInsert({
          html,
          locale,
          prefixes,
          target,
          targetTranslations,
          anchorText,
          aiAnchor,
        });
        if (linked) {
          resolved.set(locale, linked);
          pending.delete(locale);
        }
      }
    }

    // Every locale is re-registered against the NEW digest, linked or not: the
    // primary text is unchanged apart from the markup, so a translation that
    // did not get the link is still a correct translation — re-registering it
    // verbatim keeps Shopify from flagging it "outdated" for an edit that
    // changed nothing the translator would have to redo.
    for (const locale of withTranslation) {
      const linkedHtml = resolved.get(locale);
      const html = linkedHtml ?? pending.get(locale)!;
      try {
        const { confirmedKeys, userErrors } = await registerAndVerify(gateway, source.resourceId, [
          { key: translationKey, value: html, locale, translatableContentDigest: digest },
        ]);
        if (!confirmedKeys.has(translationKey)) {
          // Not echoed = not stored (CLAUDE.md). The pre-existing translation is
          // still live, so this is "no link", not "lost translation" — and the
          // local row keeps whatever it had, no DB write.
          logger.warn("[SEO-Links] Translation not echoed back — left as it was", {
            context: "SEO",
            resourceId: source.resourceId,
            locale,
            userErrors: userErrors.length,
          });
          outcome.unlinked.push(locale);
          continue;
        }
        await db.contentTranslation.upsert({
          where: {
            shop_resourceId_key_locale_marketId: {
              shop,
              resourceId: source.resourceId,
              key: translationKey,
              locale,
              marketId: "",
            },
          },
          create: {
            shop,
            resourceId: source.resourceId,
            resourceType: source.resourceType,
            key: translationKey,
            locale,
            marketId: "",
            value: html,
            digest,
          },
          update: { value: html, digest },
        });
        (linkedHtml ? outcome.linked : outcome.unlinked).push(locale);
      } catch (err: unknown) {
        logger.warn("[SEO-Links] Could not write the translation back", {
          context: "SEO",
          resourceId: source.resourceId,
          locale,
          error: err instanceof Error ? err.message : String(err),
        });
        outcome.unlinked.push(locale);
      }
    }
  } catch (err: unknown) {
    logger.warn("[SEO-Links] Carrying the link into translations failed — translations untouched", {
      context: "SEO",
      resourceId: source.resourceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return outcome;
}

/** First candidate wording that can actually be linked in this locale's HTML,
 *  wrapped in the LOCALIZED href, or null when none of them occurs in it. */
function tryInsert(args: {
  html: string;
  locale: string;
  prefixes: Map<string, string>;
  target: CarryParams["target"];
  targetTranslations: Map<string, Map<string, string>>;
  anchorText: string;
  aiAnchor?: string;
}): string | null {
  const { html, locale, prefixes, target, targetTranslations, anchorText, aiAnchor } = args;

  const localized = targetTranslations.get(locale);
  // Shopify serves a translated resource under its translated handle when one
  // exists, so the link must use it — the primary handle would redirect at best.
  const handle = localized?.get("handle") || target.handle;

  // A translation that already points at the target keeps its own link; adding
  // a second one to the same page is noise, not internal linking. Both handles
  // are checked because the translation may predate the handle translation.
  for (const known of new Set([handle, target.handle])) {
    if (htmlAlreadyLinksTo(html, { resourceType: target.resourceType, handle: known })) return null;
  }

  const href = `${prefixes.get(locale) ?? ""}${targetUrlPath({ resourceType: target.resourceType, handle })}`;

  const candidates = localizedAnchorCandidates({
    anchorText,
    targetTitle: target.title,
    translatedTitle: localized?.get("title"),
    aiAnchor,
  });

  for (const candidate of candidates) {
    const result = insertLinkIntoHtml(html, candidate, href);
    if (result.inserted) return result.html;
  }
  return null;
}
