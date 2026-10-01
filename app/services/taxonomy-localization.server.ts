/**
 * The merchant's own language for Shopify's product taxonomy.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * The Admin API answers `taxonomy.categories` in ENGLISH and offers no way to
 * ask otherwise. MEASURED twice on a live shop (Settings → Probes → Taxonomy,
 * 2026-08-19): `@inContext` is not defined in the Admin schema at all, and an
 * `Accept-Language` header is ACCEPTED and changes nothing — for every locale
 * of the shop, its primary one included. "Accepted but identical" is reported
 * apart from "refused" on purpose; it is the outcome that would otherwise read
 * as success.
 *
 * So a German shop's picker offered "Home & Garden > Decor > Vases" next to an
 * admin saying "Heim & Garten > Dekoration > Vasen" — and, worse, a product
 * type DERIVED from a category would have written an English word into that
 * shop's data, where its own collection rules and theme filters read it.
 *
 * The names exist: Shopify publishes the taxonomy per locale as open data,
 * keyed by the very same GIDs the API returns. This module imports that file.
 *
 * ── When it is fetched ──────────────────────────────────────────────────────
 * Not on a timer, and not on every request: when a category GID shows up that
 * the table has no row for. That is the exact signal — the taxonomy grew (or
 * this locale was never imported) — and it costs nothing to notice, because
 * the lookup that renders the picker is the same query that reveals the gap.
 * The import then runs DETACHED: 14 608 rows must never sit between a merchant
 * and their category list, and the request meanwhile falls back to the English
 * name, which is a real label rather than a blank.
 *
 * ── The rules that keep a bad import out ────────────────────────────────────
 * A file that parses to fewer than `MIN_PLAUSIBLE_ENTRIES` categories is
 * REFUSED, never written: a truncated download, an error page served with 200,
 * or a moved dist folder all parse into a handful of lines, and importing that
 * would replace a good table with a broken one. A 404 is a DEFINITIVE "this
 * locale has no file" and is remembered; a network failure is not remembered
 * at all, because one bad minute must not become an hour of "this shop has no
 * translations" — the same rule `taxonomy-values.server.ts` follows.
 *
 * ── One residual, stated rather than hidden ─────────────────────────────────
 * The table is a PINNED release; the live taxonomy is not. A category Shopify
 * retired since the pin is still offered by the localized SEARCH (the browse
 * half cannot be stale — it asks the API for the structure and only borrows
 * names from here), and picking one ends in a refused `productUpdate`. Closing
 * it means verifying a search hit against the live API, and whether
 * `TaxonomyCategory` resolves through `nodes(ids:)` is UNMEASURED — so it is
 * named here instead of guessed at. The other half is already covered: a
 * category ADDED since the pin has no localized row, so the search falls
 * through to Shopify's own and finds it.
 *
 * ── One row set for every shop ──────────────────────────────────────────────
 * `TaxonomyCategoryName` is deliberately NOT scoped by shop. It is Shopify's
 * public taxonomy, identical for every merchant and carrying nothing a shop
 * owns; per-shop it would be 14 608 rows per locale per shop for data that
 * cannot differ. See the migration for the same note.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
import {
  MIN_PLAUSIBLE_ENTRIES,
  needsLocalization,
  parseTaxonomyCategoriesFile,
  taxonomyFolderCandidates,
  taxonomyLocaleFolder,
  type ParsedTaxonomyName,
} from "./taxonomy-localization.shared";

/**
 * A PINNED release, never `main`.
 *
 * `main` carries a version marked "-unstable" and can reorganise underneath
 * us; a tag cannot. The cost of a pin going stale is bounded and graceful: a
 * category Shopify adds after this release simply has no row, and falls back
 * to the API's English name for that one entry. Bump it deliberately, the way
 * an API version is bumped.
 */
const TAXONOMY_TAG = "v2026-05";

const fileUrl = (folder: string) =>
  `https://raw.githubusercontent.com/Shopify/product-taxonomy/${TAXONOMY_TAG}/dist/${folder}/categories.txt`;

/**
 * How long an import counts as "already tried", per outcome.
 *
 * THE guard that keeps a missing GID from becoming a download loop. The pin
 * goes stale by design (see `TAXONOMY_TAG`), so some category will eventually
 * have no row no matter how often the file is fetched — and the trigger is
 * exactly "a GID with no row". Without a cooldown, every single picker request
 * on such a shop would start a 2 MB download and a 14 608-row rewrite, for a
 * gap that re-importing cannot close.
 *
 * A SUCCESS is trusted for hours: the file cannot have changed under a pinned
 * tag, so a miss after a fresh import is a fact about the release, not a stale
 * table. A refusal or a failure is retried much sooner — those can be a bad
 * minute rather than a bad answer.
 */
const COOLDOWN_MS = {
  imported: 6 * 60 * 60 * 1000,
  refused: 10 * 60 * 1000,
  failed: 10 * 60 * 1000,
} as const;

/** The file is ~2 MB; a stalled fetch must not hold a runner open forever. */
const FETCH_TIMEOUT_MS = 30_000;

/** Postgres has a parameter ceiling per statement, and 14 608 rows x 6 columns
 *  is well past it. Batched rather than chunk-by-luck. */
const INSERT_BATCH = 2_000;

/**
 * Imports already running, by locale — one per process.
 *
 * Without it, the first page load of a shop whose table is empty fires one
 * 2 MB download per rendered request. The map holds the PROMISE, so a second
 * caller joins the first instead of starting a second.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Locales Shopify does not publish. Remembered because a 404 on a PINNED tag
 * is a fact rather than a mood — it cannot become a 200 without the tag
 * changing, and the tag is a constant above. Network failures are deliberately
 * absent from this set.
 */
const noFileForLocale = new Set<string>();

/** When each locale was last attempted, and how it went. Process-local: a
 *  redeploy re-asking once is cheap, and holding it anywhere else would make a
 *  cache into a schema. */
const lastAttempt = new Map<string, { at: number; outcome: keyof typeof COOLDOWN_MS }>();

function withinCooldown(folder: string): boolean {
  const attempt = lastAttempt.get(folder);
  if (!attempt) return false;
  return Date.now() - attempt.at < COOLDOWN_MS[attempt.outcome];
}

export interface LocalizedName {
  fullName: string;
  name: string;
}

/**
 * The localized names for the GIDs given, plus which of them were MISSING.
 *
 * The two travel together because the caller needs both and the same query
 * answers both: it renders what it has and, on a miss, knows the table is
 * behind without a second round trip.
 */
export interface LocalizedNames {
  byGid: Map<string, LocalizedName>;
  missing: string[];
  /** False ⇒ this locale is not localized at all (English shop, or no file). */
  localized: boolean;
}

const EMPTY: LocalizedNames = { byGid: new Map(), missing: [], localized: false };

export async function lookupLocalizedNames(
  db: PrismaClient,
  locale: string,
  gids: string[],
): Promise<LocalizedNames> {
  const folder = taxonomyLocaleFolder(locale);
  if (!folder || !needsLocalization(locale) || noFileForLocale.has(folder)) return EMPTY;
  if (gids.length === 0) return { byGid: new Map(), missing: [], localized: true };

  try {
    const rows = await db.taxonomyCategoryName.findMany({
      where: { locale: folder, gid: { in: gids } },
      select: { gid: true, fullName: true, name: true },
    });
    const byGid = new Map<string, LocalizedName>(
      rows.map((r) => [r.gid, { fullName: r.fullName, name: r.name }]),
    );
    return { byGid, missing: gids.filter((g) => !byGid.has(g)), localized: true };
  } catch (error) {
    // A failed lookup is not "this locale has no names". Falling back to the
    // English the API already returned is a real label; an empty picker is not.
    logger.warn("[TaxonomyL10n] Lookup failed", {
      context: "TaxonomyL10n",
      locale: folder,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY;
  }
}

/**
 * Bring a locale up to date, in the background.
 *
 * Fire-and-forget on purpose — the caller is rendering a category list and
 * must not wait for a 2 MB download. Every failure is logged and swallowed:
 * the fallback (English, which the API already delivered) is in place either
 * way, so throwing here could only turn a cosmetic gap into a broken request.
 */
export function scheduleTaxonomyImport(db: PrismaClient, locale: string): void {
  const folder = taxonomyLocaleFolder(locale);
  if (!folder || !needsLocalization(locale) || noFileForLocale.has(folder)) return;
  if (inFlight.has(folder) || withinCooldown(folder)) return;

  const run: Promise<void> = importTaxonomyLocale(db, folder, taxonomyFolderCandidates(locale))
    .then(() => undefined)
    .catch((error) => {
      // A thrown import is a FAILURE, and it has to be recorded as one — else
      // the next request starts another download of the file that just broke.
      lastAttempt.set(folder, { at: Date.now(), outcome: "failed" });
      logger.error("[TaxonomyL10n] Import failed", {
        context: "TaxonomyL10n",
        locale: folder,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      inFlight.delete(folder);
    });

  inFlight.set(folder, run);
}

/** The same work, awaited — for a probe or a test that wants the outcome. */
export async function importTaxonomyLocale(
  db: PrismaClient,
  folder: string,
  /** Which folders to try, best first. Defaults to the folder itself; the
   *  scheduler passes the regional-then-base list. */
  candidates: string[] = [folder],
): Promise<{ imported: number; version: string } | null> {
  let text: string | null = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(fileUrl(candidate), { signal: controller.signal });
      if (response.status === 404) {
        // Definitive on a pinned tag — but only for THIS folder. A regional
        // locale still has its base language to try, which is why the 404 is
        // not the end of the loop.
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (text === null) {
    // Every candidate answered 404: Shopify does not publish this language at
    // all. Remembered, because a pinned tag cannot start publishing it.
    noFileForLocale.add(folder);
    lastAttempt.set(folder, { at: Date.now(), outcome: "refused" });
    logger.info("[TaxonomyL10n] No published file for locale", {
      context: "TaxonomyL10n", locale: folder, tried: candidates, tag: TAXONOMY_TAG,
    });
    return null;
  }

  const { version, entries } = parseTaxonomyCategoriesFile(text);

  // The verification rule: a short file is a broken download, not a small
  // taxonomy. Refused BEFORE anything is deleted, so a bad fetch leaves the
  // good table exactly where it was.
  if (entries.length < MIN_PLAUSIBLE_ENTRIES) {
    lastAttempt.set(folder, { at: Date.now(), outcome: "refused" });
    logger.warn("[TaxonomyL10n] Refused an implausibly small file", {
      context: "TaxonomyL10n",
      locale: folder,
      entries: entries.length,
      minimum: MIN_PLAUSIBLE_ENTRIES,
    });
    return null;
  }

  await replaceLocale(db, folder, version, entries);
  lastAttempt.set(folder, { at: Date.now(), outcome: "imported" });

  logger.info("[TaxonomyL10n] Imported", {
    context: "TaxonomyL10n", locale: folder, entries: entries.length, version,
  });
  return { imported: entries.length, version };
}

/**
 * Replace one locale wholesale, inside ONE transaction.
 *
 * A full replace rather than per-row upserts: 14 608 upserts is minutes of
 * round trips, and a release that REMOVES a category has to remove its row too
 * — an upsert-only import would keep labelling a category Shopify retired.
 * The transaction is what keeps a concurrent reader from seeing the empty
 * middle of it.
 */
async function replaceLocale(
  db: PrismaClient,
  folder: string,
  version: string,
  entries: ParsedTaxonomyName[],
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      await tx.taxonomyCategoryName.deleteMany({ where: { locale: folder } });
      for (let i = 0; i < entries.length; i += INSERT_BATCH) {
        await tx.taxonomyCategoryName.createMany({
          data: entries.slice(i, i + INSERT_BATCH).map((e) => ({
            locale: folder,
            gid: e.gid,
            fullName: e.fullName,
            name: e.name,
            isLeaf: e.isLeaf,
            version,
          })),
          skipDuplicates: true,
        });
      }
    },
    // The default 5s is not enough for 14 608 rows on a cold connection, and a
    // timeout mid-transaction would roll the delete back too — which is safe,
    // but leaves the merchant on English for another page load for nothing.
    { timeout: 120_000, maxWait: 20_000 },
  );
}

/**
 * Search the localized paths — the merchant's language, not Shopify's.
 *
 * Without this the search half was unusable for anyone not searching in
 * English: a German merchant types "Vasen", Shopify matches against "Vases",
 * and the answer is "no category matches that" for a category that is right
 * there. Returns null when this locale has no rows, so the caller can fall
 * back to the API's own search rather than showing an empty list.
 */
export async function searchLocalizedNames(
  db: PrismaClient,
  locale: string,
  query: string,
  limit: number,
): Promise<Array<{ gid: string; fullName: string; name: string; isLeaf: boolean }> | null> {
  const folder = taxonomyLocaleFolder(locale);
  if (!folder || !needsLocalization(locale) || noFileForLocale.has(folder)) return null;

  try {
    const rows = await db.taxonomyCategoryName.findMany({
      where: { locale: folder, fullName: { contains: query, mode: "insensitive" } },
      select: { gid: true, fullName: true, name: true, isLeaf: true },
      // Deliberately WIDER than the limit, because the ranking below is what
      // decides which ones matter and it cannot rank what it never saw. A
      // database-side `orderBy` would have to be alphabetical, and alphabetical
      // is exactly the order that buries the answer: "kleid" matches every
      // "Bekleidung & Accessoires > …" path in the shop, and 20 of those would
      // arrive before "Kleider" ever did.
      take: Math.max(limit * 10, 200),
    });
    // An empty TABLE and an empty RESULT are different answers. With no rows
    // at all the locale is simply not imported yet, and Shopify's own search
    // is the better answer than "nothing matches".
    if (rows.length === 0) {
      const any = await db.taxonomyCategoryName.findFirst({
        where: { locale: folder },
        select: { id: true },
      });
      if (!any) return null;
    }
    return rankLocalizedHits(rows, query).slice(0, limit);
  } catch (error) {
    logger.warn("[TaxonomyL10n] Localized search failed", {
      context: "TaxonomyL10n",
      locale: folder,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * What the merchant meant, ahead of what merely contains their letters.
 *
 * A substring match over full PATHS is generous by nature: every descendant of
 * a matching branch matches too. Ranked by path alphabetically, a query lands
 * on twenty children of one branch and never reaches the category actually
 * named that. So the LEAF decides first — the leaf is what the merchant typed
 * — and a shallower path wins ties, because a branch is the more likely
 * intention than one of its fifty children.
 */
function rankLocalizedHits<T extends { fullName: string; name: string }>(rows: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  const score = (row: T): number => {
    const leaf = row.name.toLowerCase();
    if (leaf === needle) return 0;
    if (leaf.startsWith(needle)) return 1;
    if (leaf.includes(needle)) return 2;
    return 3;
  };
  const depth = (row: T): number => row.fullName.split(">").length;
  return [...rows].sort(
    (a, b) => score(a) - score(b) || depth(a) - depth(b) || a.fullName.localeCompare(b.fullName),
  );
}
