/**
 * Direct translations ("Direktübersetzungen").
 *
 * Merchant-managed storefront text that is NOT in translatable Shopify fields
 * (e.g. third-party app widgets: review widgets, badges, page builders). A theme
 * app embed replaces this text client-side using a merchant-curated dictionary.
 *
 * Data model: an ITEM is the identity of one rendered source string; its
 * translations hang off it by FK (DirectTranslation), so editing the source text
 * keeps the translations attached. Matching is EXACT on the normalized source —
 * no fuzzy/partial matching. The admin (CRUD) and the storefront (lookup) MUST
 * normalize source text identically, so the rendered DOM text matches a stored
 * key. `normalizeSource` here mirrors the normalization in
 * `extensions/storefront/assets/direct-translation.js`.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** Collapse whitespace + trim so rendered DOM text matches stored sources. */
export function normalizeSource(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stable identity hash for the normalized source (per shop, via unique index). */
export function sourceHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

type Db = Pick<
  PrismaClient,
  | "directTranslationItem"
  | "directTranslation"
  | "directTranslationSettings"
  | "directTranslationCandidate"
>;

/**
 * Direct translations are a Max-plan feature — admin tab AND the whole storefront
 * layer (dictionary, collector, theme-editor capture). The effective plan lives
 * on AISettings.subscriptionPlan (kept in sync by billing). Used to gate the
 * app-proxy endpoints server-side so non-Max shops get nothing, and the admin
 * loader/action so a non-Max merchant can't bypass the client-side
 * PlanAccessGate via a direct POST.
 *
 * Uses meetsPlan so a future tier above max automatically inherits access
 * (the linear hierarchy convention used everywhere else in planUtils).
 */
export async function isDirectTranslationsAvailable(
  db: Pick<PrismaClient, "aISettings">,
  shop: string,
): Promise<boolean> {
  const { meetsPlan } = await import("../utils/planUtils");
  const s = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  const plan = (s?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
  return meetsPlan(plan, "max");
}

/** Max candidate strings accepted per collect request (defense against abuse). */
export const MAX_CANDIDATES_PER_REQUEST = 100;
/** Max distinct candidate rows kept per shop (oldest-untouched pruned). */
export const MAX_CANDIDATES_PER_SHOP = 1000;
/** Max source strings translated per AI prompt (keeps prompts within limits). */
export const AI_BATCH_SIZE = 50;

/**
 * Heuristic: is a rendered string worth collecting as a translation candidate?
 * Conservative on purpose — reduces noise AND lowers the chance of capturing
 * PII / dynamic data (prices, emails, names, long content). The merchant still
 * reviews every candidate before anything is stored as an item.
 */
export function isCollectibleString(text: string): boolean {
  const s = normalizeSource(text);
  if (s.length < 2 || s.length > 1500) return false; // long enough for widget paragraphs
  if (!/[a-zA-ZÀ-ɏ]/.test(s)) return false; // must contain a letter
  if (/^\d/.test(s) && /\d/.test(s) && !/[a-zA-Z]{3,}/.test(s)) return false; // mostly numeric
  if (/^[$€£¥]|\d[.,]\d{2}\s*[$€£¥%]?$/.test(s)) return false; // prices
  if (/@|https?:\/\/|www\./i.test(s)) return false; // emails / urls
  if (/^[+]?[\d\s().-]{6,}$/.test(s)) return false; // phone-like
  return true;
}

// BCP-47 (Shopify locale) → ISO 639-3 (franc) mapping for the languages we
// realistically see on Shopify storefronts. franc returns ISO 639-3; everything
// outside this map falls through as "unknown" → we don't filter (safer to keep
// a candidate than to drop a real one).
const BCP47_TO_ISO639_3: Record<string, string> = {
  de: "deu", en: "eng", es: "spa", fr: "fra", it: "ita", pt: "por",
  nl: "nld", pl: "pol", ru: "rus", tr: "tur", cs: "ces", da: "dan",
  sv: "swe", no: "nor", fi: "fin", el: "ell", hu: "hun", ro: "ron",
  bg: "bul", uk: "ukr", he: "heb", ar: "arb", ja: "jpn", ko: "kor",
  zh: "cmn", th: "tha", vi: "vie", id: "ind", ms: "msa", hi: "hin",
};
function bcp47ToIso6393(locale: string): string | null {
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return BCP47_TO_ISO639_3[base] ?? null;
}

// ---------------------------------------------------------------------------
// Settings + cache version
// ---------------------------------------------------------------------------

/** Bump the per-shop cache version so the storefront re-fetches the dictionary. */
async function bumpVersion(db: Db, shop: string): Promise<void> {
  await db.directTranslationSettings.upsert({
    where: { shop },
    create: { shop, version: 2 }, // 1 is the default "initial"; first change → 2
    update: { version: { increment: 1 } },
  });
}

export async function getSettings(db: Db, shop: string) {
  return (
    (await db.directTranslationSettings.findUnique({ where: { shop } })) ?? {
      shop,
      collect: false,
      ignoreTranslateNo: false,
      filterByLanguage: false,
      version: 1,
      updatedAt: new Date(0),
    }
  );
}

/** Partial update on the boolean settings; only the passed keys are touched. */
export async function updateSettings(
  db: Db,
  shop: string,
  patch: { collect?: boolean; ignoreTranslateNo?: boolean; filterByLanguage?: boolean },
) {
  const cleaned: Record<string, boolean> = {};
  if (typeof patch.collect === "boolean") cleaned.collect = patch.collect;
  if (typeof patch.ignoreTranslateNo === "boolean") cleaned.ignoreTranslateNo = patch.ignoreTranslateNo;
  if (typeof patch.filterByLanguage === "boolean") cleaned.filterByLanguage = patch.filterByLanguage;
  if (Object.keys(cleaned).length === 0) return;
  await db.directTranslationSettings.upsert({
    where: { shop },
    create: { shop, ...cleaned },
    update: cleaned,
  });
  // `collect` and `ignoreTranslateNo` both change storefront behaviour and
  // travel in the dictionary payload — bump the cache version so cached
  // clients refetch instead of waiting for the 60s edge TTL. `filterByLanguage`
  // is server-only (storefront posts the same payload either way) so no bump
  // needed for that one.
  if ("collect" in cleaned || "ignoreTranslateNo" in cleaned) await bumpVersion(db, shop);
}

/** @deprecated — kept so callers that just toggle `collect` keep working. */
export async function setCollect(db: Db, shop: string, collect: boolean) {
  return updateSettings(db, shop, { collect });
}

// ---------------------------------------------------------------------------
// Item CRUD
// ---------------------------------------------------------------------------

/** List all items for a shop with their translations (for the admin list/editor). */
export async function listItems(db: Db, shop: string) {
  return db.directTranslationItem.findMany({
    where: { shop },
    include: { translations: true },
    orderBy: { updatedAt: "desc" },
  });
}

/** Load one item (shop-scoped) with its translations. */
export async function getItem(db: Db, shop: string, itemId: string) {
  return db.directTranslationItem.findFirst({
    where: { id: itemId, shop },
    include: { translations: true },
  });
}

/**
 * Create an item from a source string (idempotent on shop + normalized source).
 * Returns the existing item if the same source already exists.
 */
export async function createItem(db: Db, shop: string, sourceText: string) {
  const normalized = normalizeSource(sourceText);
  if (!normalized) throw new Error("Source text is empty");
  const hash = sourceHash(normalized);
  const item = await db.directTranslationItem.upsert({
    where: { shop_sourceHash: { shop, sourceHash: hash } },
    create: { shop, sourceHash: hash, sourceText: normalized },
    update: {}, // already exists → keep it (and its translations)
    include: { translations: true },
  });
  await bumpVersion(db, shop);
  return item;
}

/**
 * Rewrite an item's source text (+ rehash). The translations stay attached (FK
 * on the item id, not the text), so the storefront then matches the NEW source.
 */
export async function updateItemSource(db: Db, shop: string, itemId: string, newSource: string) {
  const normalized = normalizeSource(newSource);
  if (!normalized) throw new Error("Source text is empty");
  const hash = sourceHash(normalized);
  const result = await db.directTranslationItem.updateMany({
    where: { id: itemId, shop },
    data: { sourceText: normalized, sourceHash: hash },
  });
  if (result.count > 0) await bumpVersion(db, shop);
  return result.count;
}

/** Delete an item (cascades its translations). */
export async function deleteItem(db: Db, shop: string, itemId: string) {
  const result = await db.directTranslationItem.deleteMany({ where: { id: itemId, shop } });
  if (result.count > 0) await bumpVersion(db, shop);
  return result.count;
}

// ---------------------------------------------------------------------------
// Translation CRUD (per locale, per item)
// ---------------------------------------------------------------------------

/**
 * Create or update one item's translation for a locale, optionally scoped to a
 * market. `marketId` "" = global (applies in all markets); a non-empty
 * gid://shopify/Market/<id> stores a market-specific override that the storefront
 * layers over the global value for buyers in that market.
 */
export async function setTranslation(
  db: Db,
  shop: string,
  itemId: string,
  locale: string,
  targetText: string,
  source: "user" | "ai" = "user",
  marketId: string = "",
) {
  // Guard tenant isolation: the item must belong to this shop.
  const item = await db.directTranslationItem.findFirst({ where: { id: itemId, shop }, select: { id: true } });
  if (!item) throw new Error("Item not found");

  const row = await db.directTranslation.upsert({
    where: { itemId_locale_marketId: { itemId, locale, marketId } },
    create: { itemId, locale, targetText, source, marketId },
    update: { targetText, source },
  });
  await bumpVersion(db, shop);
  return row;
}

/**
 * Delete one item's translation for a locale + market. Scoped by `marketId` so a
 * market-specific clear falls back to the global value (and clearing the global
 * value leaves market overrides intact).
 */
export async function deleteTranslation(db: Db, shop: string, itemId: string, locale: string, marketId: string = "") {
  const item = await db.directTranslationItem.findFirst({ where: { id: itemId, shop }, select: { id: true } });
  if (!item) return 0;
  const result = await db.directTranslation.deleteMany({ where: { itemId, locale, marketId } });
  if (result.count > 0) await bumpVersion(db, shop);
  return result.count;
}

// ---------------------------------------------------------------------------
// Storefront dictionary
// ---------------------------------------------------------------------------

/**
 * Build the storefront dictionary for one locale: a flat map of
 * normalizedSource → target. The storefront JS normalizes each rendered text
 * node and looks it up. Returns the cache `version` + `collect` flag too.
 */
export async function getDictionary(db: Db, shop: string, locale: string, marketId: string = "") {
  // Load BOTH layers for this locale in a single query: the global row
  // (marketId "") plus, when a market is requested, that market's override.
  // The market-specific value wins; otherwise the global value applies
  // (storefront fallback, mirroring the other content types).
  const marketFilter = marketId ? ["", marketId] : [""];
  const [settings, items] = await Promise.all([
    getSettings(db, shop),
    db.directTranslationItem.findMany({
      where: { shop },
      select: {
        sourceText: true,
        translations: {
          where: { locale, marketId: { in: marketFilter } },
          select: { targetText: true, marketId: true },
        },
      },
    }),
  ]);

  const entries: Record<string, string> = {};
  for (const it of items) {
    // Prefer the market-specific override, fall back to the global row.
    const market = marketId
      ? it.translations.find((t: { targetText: string; marketId?: string }) => (t.marketId ?? "") === marketId)
      : undefined;
    const global = it.translations.find((t: { targetText: string; marketId?: string }) => (t.marketId ?? "") === "");
    // A market row wins only if it actually has text; an (unexpected) empty
    // market row must not blank out a real global value on the storefront.
    const chosen = market && market.targetText ? market : global;
    if (chosen) entries[it.sourceText] = chosen.targetText;
  }

  return {
    version: settings.version,
    collect: settings.collect,
    ignoreTranslateNo: settings.ignoreTranslateNo,
    entries,
  };
}

// ---------------------------------------------------------------------------
// AI auto-translation
// ---------------------------------------------------------------------------

/**
 * AI-translate a batch of items into one or more locales and persist each as a
 * `source: "ai"` translation. The AI call is injected (a thin wrapper around
 * AIService.translateBatchValues) so this stays unit-testable without the AI
 * stack.
 *
 * Source-language is auto-detected per value (the merchant's "source" can be in
 * any language — e.g. a 3rd-party widget label written in English on a
 * German-primary store). When the detected source matches the target locale,
 * the AI returns a 1:1 copy and we persist it as such (so the storefront has a
 * concrete entry for every configured locale, not a silent fallback).
 *
 * Large inputs are split into fixed-size chunks (one AI prompt each) per locale
 * and persisted incrementally, so a big "translate all" never produces one giant
 * prompt that exceeds the model's token budget. `onProgress` is invoked after
 * each chunk for Task progress.
 */
export async function aiAutoTranslateItems(
  db: Db,
  shop: string,
  params: { items: Array<{ id: string; sourceText: string }>; locales: string[]; marketId?: string },
  translateBatch: (values: string[], from: string, to: string, context: string) => Promise<string[]>,
  onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<Array<Awaited<ReturnType<typeof setTranslation>>>> {
  const marketId = params.marketId || "";
  // Normalize item sources; drop empties and duplicates (keep first per source).
  const seen = new Set<string>();
  const items: Array<{ id: string; source: string }> = [];
  for (const it of params.items) {
    const norm = normalizeSource(it.sourceText);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      items.push({ id: it.id, source: norm });
    }
  }
  const locales = params.locales.filter((l) => !!l);
  if (items.length === 0 || locales.length === 0) return [];

  const total = items.length * locales.length;
  let done = 0;
  const rows: Array<Awaited<ReturnType<typeof setTranslation>>> = [];

  // Quality gate for the same-as-source case: with fromLang="auto" the model
  // is supposed to return the input unchanged ONLY when the source is already
  // in the target locale. A refused or echoed prompt looks identical, so we
  // verify with franc when we can (and accept it when detection is uncertain).
  // Loaded lazily because franc-min adds ~500 KB to the import graph.
  const { franc } = await import("franc-min");

  for (const locale of locales) {
    const targetLangIso = bcp47ToIso6393(locale);
    for (let start = 0; start < items.length; start += AI_BATCH_SIZE) {
      const chunk = items.slice(start, start + AI_BATCH_SIZE);
      const targets = await translateBatch(
        chunk.map((c) => c.source),
        "auto",
        locale,
        "storefront UI strings",
      );
      for (let i = 0; i < chunk.length; i++) {
        const target = targets[i];
        // Empty/missing model output → skip (would otherwise wipe an existing
        // translation).
        if (!target) continue;
        // Same-as-source quality gate: when the model returns the input
        // unchanged, only refuse to persist if franc CONFIDENTLY disagrees
        // (input long enough for a reliable detection AND detected language
        // differs from the target). minLength 30 is the threshold below
        // which franc becomes a coin-flip; we'd rather trust the AI's 1:1
        // than reject a legitimate UI label that just happens to be short.
        if (normalizeSource(target) === chunk[i].source && targetLangIso) {
          const detected = franc(chunk[i].source, { minLength: 30 });
          if (detected !== "und" && detected !== targetLangIso) continue;
        }
        rows.push(await setTranslation(db, shop, chunk[i].id, locale, target, "ai", marketId));
      }
      done += chunk.length;
      if (onProgress) await onProgress(Math.min(done, total), total);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Candidates (collector)
// ---------------------------------------------------------------------------

/**
 * Record untranslated strings discovered on the storefront as review candidates.
 * Heuristically filtered + capped; increments a seen-count on repeats.
 *
 * Dedupe rules:
 *  - strings that already exist as an item are skipped (not re-collected);
 *  - a `rejected` candidate only has its count/lastSeen bumped — it is NEVER
 *    resurrected to `new` (so it stops raising notifications).
 * Never creates items/translations — the merchant reviews these.
 */
export async function recordCandidates(
  db: Db,
  shop: string,
  items: Array<{ text: string }>,
  options: { visitorLocale?: string; filterByLanguage?: boolean } = {},
): Promise<number> {
  const batch = items.slice(0, MAX_CANDIDATES_PER_REQUEST);

  // Normalize + filter + de-dupe within the request.
  const byHash = new Map<string, string>(); // hash → normalized source
  for (const item of batch) {
    const normalized = normalizeSource(item.text);
    if (!isCollectibleString(normalized)) continue;
    byHash.set(sourceHash(normalized), normalized);
  }
  if (byHash.size === 0) return 0;

  // Optional: drop strings whose detected language already matches the visitor
  // locale (they're served correctly → no direct translation needed). franc
  // returns "und" for too-short / undetectable input; we keep those as-is
  // because dropping a real candidate is worse than carrying one noisy row.
  if (options.filterByLanguage && options.visitorLocale) {
    const visitorIso = bcp47ToIso6393(options.visitorLocale);
    if (visitorIso) {
      const { franc } = await import("franc-min");
      for (const [hash, normalized] of byHash) {
        const detected = franc(normalized, { minLength: 10 });
        if (detected === visitorIso) byHash.delete(hash);
      }
      if (byHash.size === 0) return 0;
    }
  }

  const hashes = Array.from(byHash.keys());
  // Skip strings that already exist as items.
  const existingItems = await db.directTranslationItem.findMany({
    where: { shop, sourceHash: { in: hashes } },
    select: { sourceHash: true },
  });
  const itemHashes = new Set(existingItems.map((r) => r.sourceHash));

  let recorded = 0;
  for (const [hash, normalized] of byHash) {
    if (itemHashes.has(hash)) continue;
    // Upsert never touches `status`, so a rejected candidate stays rejected
    // (only its count/lastSeen advance) and a new one stays new.
    await db.directTranslationCandidate.upsert({
      where: { shop_sourceHash: { shop, sourceHash: hash } },
      create: { shop, sourceHash: hash, sourceText: normalized },
      update: { count: { increment: 1 }, lastSeenAt: new Date() },
    });
    recorded++;
  }

  // Prune so a shop can't grow unbounded (keep the most recently seen).
  const total = await db.directTranslationCandidate.count({ where: { shop } });
  if (total > MAX_CANDIDATES_PER_SHOP) {
    const stale = await db.directTranslationCandidate.findMany({
      where: { shop },
      orderBy: { lastSeenAt: "asc" },
      take: total - MAX_CANDIDATES_PER_SHOP,
      select: { id: true },
    });
    if (stale.length) {
      await db.directTranslationCandidate.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }
  return recorded;
}

/** Wipe every candidate (new + rejected) for the shop. */
export async function deleteAllCandidates(db: Db, shop: string): Promise<number> {
  const { count } = await db.directTranslationCandidate.deleteMany({ where: { shop } });
  return count;
}

export async function listCandidates(db: Db, shop: string, status?: "new" | "rejected") {
  return db.directTranslationCandidate.findMany({
    where: { shop, ...(status ? { status } : {}) },
    orderBy: [{ count: "desc" }, { lastSeenAt: "desc" }],
    take: 500,
  });
}

/** Count `new` candidates — drives the "Gefundene Texte" notification badge. */
export async function countNewCandidates(db: Db, shop: string): Promise<number> {
  return db.directTranslationCandidate.count({ where: { shop, status: "new" } });
}

export async function setCandidateStatus(
  db: Db,
  shop: string,
  id: string,
  status: "new" | "rejected",
): Promise<number> {
  const res = await db.directTranslationCandidate.updateMany({ where: { id, shop }, data: { status } });
  return res.count;
}

/**
 * Promote candidates to items: create an item from each candidate's source text
 * and delete the candidate (it is now an item). Returns the created items.
 */
export async function addCandidatesAsItems(db: Db, shop: string, ids: string[]) {
  if (ids.length === 0) return [];
  const candidates = await db.directTranslationCandidate.findMany({ where: { id: { in: ids }, shop } });
  const created: Array<Awaited<ReturnType<typeof createItem>>> = [];
  for (const c of candidates) {
    created.push(await createItem(db, shop, c.sourceText));
  }
  if (candidates.length > 0) {
    await db.directTranslationCandidate.deleteMany({ where: { id: { in: candidates.map((c) => c.id) }, shop } });
  }
  return created;
}
