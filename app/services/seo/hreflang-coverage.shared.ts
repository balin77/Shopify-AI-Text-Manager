/**
 * The pure half of the hreflang audit's language coverage (roadmap entry
 * `translation-dashboard`): given the scanned catalog and the translation keys
 * that exist in one locale, say what is missing — overall, per content TYPE and
 * per FIELD.
 *
 * It lives beside hreflang.service.ts rather than inside it so it is testable
 * without a Prisma stub and importable from the route (labels, ordering)
 * without pulling a server module into the client bundle.
 *
 * Three rules are load-bearing, and each of them is a way to report work that
 * does not exist:
 *
 *  - A key is only DEMANDED where the PRIMARY value is really there. A product
 *    whose meta description is empty in the primary locale can never have a
 *    translated one, so listing it as a missing translation invents work nobody
 *    can do. This is the same trap as `translatableContent` only listing keys
 *    that carry a value (CLAUDE.md): absence of a key is not a defect.
 *  - AN EMPTY CACHE IS NEVER EVIDENCE. A type with no cached row at all is
 *    UNKNOWN — "not scanned" — never "0 missing" or "100% done". Same rule as
 *    `attributesSyncedAt` and `indexabilityKnown`.
 *  - A green 100% never stands next to a non-empty missing list. The percentage
 *    is capped at 99 while anything is still incomplete — per type AND overall,
 *    so the two halves of one card cannot contradict each other.
 */

export type HreflangType = "product" | "collection" | "article" | "page";

/**
 * Fixed reading order for every per-type list. Never locale-sorted: this is a
 * vocabulary, not merchant text, and an order that depends on the UI language
 * would reorder rendered children between server and client (§Hydration).
 */
export const HREFLANG_TYPES: readonly HreflangType[] = [
  "product",
  "collection",
  "article",
  "page",
] as const;

/**
 * The Shopify translation keys the pipeline writes for the audited resource
 * types (A5). (`body` is only written for ShopPolicy, which we do not audit, so
 * it is deliberately omitted; `summary_html` is an article-only key this audit
 * has never covered and stays out of scope here.)
 */
export const TRANSLATION_KEYS = [
  "title",
  "body_html",
  "meta_title",
  "meta_description",
] as const;

export type TranslationKey = (typeof TRANSLATION_KEYS)[number];

/** The cached PRIMARY values a key is demanded from. Empty/absent ⇒ not demanded. */
export interface PrimaryValues {
  title?: string | null;
  /** Product/Collection `descriptionHtml`, Article/Page `body`. */
  body?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
}

export interface PublishableItem {
  resourceType: HreflangType;
  id: string; // Shopify GID
  title: string;
  /** Keys whose primary value exists — the only keys this item can be missing. */
  requiredKeys: TranslationKey[];
}

/** What the catalog scan learned about one type, before any locale is applied. */
export interface TypeScan {
  resourceType: HreflangType;
  /** Rows in the cache (count()), which may exceed what was scanned. */
  cachedTotal: number;
  /** Rows actually loaded (at most the scan cap). */
  scanned: number;
  /** cachedTotal > scanned — this type's numbers refer to the scanned subset. */
  capped: boolean;
  /**
   * False when the cache holds NO row of this type AT ALL — asked without the
   * publishable filter, so an all-DRAFT product catalogue counts as known (it
   * is knowledge, not absence) and only a type nobody ever synced is unknown.
   * "Never synced" and "the shop has none of them" stay indistinguishable, so
   * both read as unknown rather than as complete.
   */
  known: boolean;
}

export interface FieldGap {
  key: TranslationKey;
  /** Scanned items whose primary value for this key exists. */
  required: number;
  /** Of those, how many have no translation in this locale. */
  missing: number;
}

export interface TypeCoverage {
  resourceType: HreflangType;
  known: boolean;
  scanned: number;
  /** Publishable rows in the cache — larger than `scanned` when capped. */
  cachedTotal: number;
  /**
   * The type's own numbers cover only the scanned subset. Carried per type, not
   * only as one flag for the page: a 100% beside "2000 of 40000 checked" is a
   * different claim from a 100% over a whole type, and hiding which of the two
   * a bar is makes the smaller one read as the larger.
   */
  capped: boolean;
  /** Items with every required key translated. */
  complete: number;
  incomplete: number;
  coveragePct: number;
  fieldGaps: FieldGap[];
}

export interface MissingItem {
  resourceType: HreflangType;
  resourceId: string; // Shopify GID — editor deep-link
  title: string;
  /** Which fields this item is missing. Never empty. */
  missingKeys: TranslationKey[];
}

export interface LocaleCoverage {
  locale: string;
  name: string;
  publishableScanned: number;
  /** Items complete in this locale (every required key translated). */
  translated: number;
  coveragePct: number;
  missing: MissingItem[]; // capped by the caller's missingListCap
  missingTotal: number;
  /** One entry per audited type, in HREFLANG_TYPES order. */
  byType: TypeCoverage[];
  /** The same gaps summed over every type, in TRANSLATION_KEYS order. */
  fieldGaps: FieldGap[];
}

/** A primary value counts as present only when it holds something. */
function hasValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Which of the tracked keys this resource can be asked for — the keys whose
 * PRIMARY value exists. Everything else would be a translation of nothing.
 */
export function requiredKeysFor(primary: PrimaryValues): TranslationKey[] {
  const keys: TranslationKey[] = [];
  if (hasValue(primary.title)) keys.push("title");
  if (hasValue(primary.body)) keys.push("body_html");
  if (hasValue(primary.seoTitle)) keys.push("meta_title");
  if (hasValue(primary.seoDescription)) keys.push("meta_description");
  return keys;
}

/**
 * The 99% rule, in one place so the overall bar and every per-type bar obey it
 * identically: a rounded 100 beside something still incomplete is a
 * contradiction the merchant has to resolve, so it reads 99 instead.
 */
export function coveragePctOf(complete: number, scanned: number): number {
  if (scanned <= 0) return 0;
  const pct = Math.round((complete / scanned) * 100);
  return pct === 100 && complete < scanned ? 99 : pct;
}

function emptyGaps(): Map<TranslationKey, FieldGap> {
  return new Map(TRANSLATION_KEYS.map((key) => [key, { key, required: 0, missing: 0 }]));
}

function sortedGaps(gaps: Map<TranslationKey, FieldGap>): FieldGap[] {
  return TRANSLATION_KEYS.map((key) => gaps.get(key) ?? { key, required: 0, missing: 0 });
}

/**
 * Fill the capped missing LIST round-robin across the types instead of in scan
 * order. The list is what the merchant can actually click into, and with the
 * all-fields rule the cap is the normal case rather than the exception: filled
 * in scan order, a shop with more incomplete products than the cap spends every
 * slot on products and never offers one page, article or collection — which
 * reads as "those types are fine" while their own bars say otherwise.
 */
function interleaveMissing(lists: MissingItem[][], cap: number): MissingItem[] {
  const out: MissingItem[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let i = 0; i < longest && out.length < cap; i += 1) {
    for (const list of lists) {
      if (i >= list.length) continue;
      out.push(list[i]);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export interface ComputeLocaleCoverageArgs {
  locale: string;
  name: string;
  items: PublishableItem[];
  /** One entry per audited type, including the types that were never synced. */
  typeScans: TypeScan[];
  /**
   * resourceId → the tracked keys that carry a translation in THIS locale.
   * An id the map does not know has nothing translated.
   */
  translatedKeys: ReadonlyMap<string, ReadonlySet<string>>;
  missingListCap: number;
}

export function computeLocaleCoverage({
  locale,
  name,
  items,
  typeScans,
  translatedKeys,
  missingListCap,
}: ComputeLocaleCoverageArgs): LocaleCoverage {
  const scanByType = new Map(typeScans.map((s) => [s.resourceType, s]));
  const buckets = new Map<
    HreflangType,
    { complete: number; scanned: number; gaps: Map<TranslationKey, FieldGap> }
  >(HREFLANG_TYPES.map((type) => [type, { complete: 0, scanned: 0, gaps: emptyGaps() }]));
  const overallGaps = emptyGaps();
  const missingByType = new Map<HreflangType, MissingItem[]>(
    HREFLANG_TYPES.map((type) => [type, []]),
  );

  let missingTotal = 0;
  let translated = 0;

  for (const item of items) {
    const bucket = buckets.get(item.resourceType);
    if (!bucket) continue; // outside the audited vocabulary — ignored, never counted
    bucket.scanned += 1;

    const have = translatedKeys.get(item.id);
    const missingKeys: TranslationKey[] = [];
    for (const key of item.requiredKeys) {
      const gap = bucket.gaps.get(key)!;
      const overall = overallGaps.get(key)!;
      gap.required += 1;
      overall.required += 1;
      if (!have?.has(key)) {
        gap.missing += 1;
        overall.missing += 1;
        missingKeys.push(key);
      }
    }

    if (missingKeys.length === 0) {
      translated += 1;
      bucket.complete += 1;
      continue;
    }

    missingTotal += 1;
    const perType = missingByType.get(item.resourceType)!;
    // Each type collects at most the whole budget on its own; the merge below
    // shares it out. Bounded by the scan cap either way.
    if (perType.length < missingListCap) {
      perType.push({
        resourceType: item.resourceType,
        resourceId: item.id,
        title: item.title,
        missingKeys,
      });
    }
  }

  const byType: TypeCoverage[] = HREFLANG_TYPES.map((type) => {
    const bucket = buckets.get(type)!;
    const scan = scanByType.get(type);
    // `known` comes from the SCAN, not from how many items reached this loop:
    // zero scanned rows is exactly the state that must not decide this.
    const known = scan?.known ?? false;
    return {
      resourceType: type,
      known,
      scanned: bucket.scanned,
      cachedTotal: scan?.cachedTotal ?? 0,
      capped: scan?.capped ?? false,
      complete: bucket.complete,
      incomplete: bucket.scanned - bucket.complete,
      coveragePct: known ? coveragePctOf(bucket.complete, bucket.scanned) : 0,
      fieldGaps: sortedGaps(bucket.gaps),
    };
  });

  const missing = interleaveMissing(
    HREFLANG_TYPES.map((type) => missingByType.get(type)!),
    missingListCap,
  );

  return {
    locale,
    name,
    publishableScanned: items.length,
    translated,
    coveragePct: coveragePctOf(translated, items.length),
    missing,
    missingTotal,
    byType,
    fieldGaps: sortedGaps(overallGaps),
  };
}
