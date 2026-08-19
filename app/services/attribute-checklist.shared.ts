/**
 * PLAN_CONTENT_CREATION §2.2 — the attribute sidebar's checklist.
 *
 * Pure and client-safe, because the interesting part is a judgement and
 * judgements deserve tests: which rows exist per type, and — the load-bearing
 * one — when a row may say "missing" at all.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 * A column of the Phase-0 attribute block is only readable once the row's
 * `attributesSyncedAt` is set. Before that, `vendor: null` / `tags: []` /
 * `isPublished: true` are the MIGRATION'S defaults, not the merchant's data.
 * Reporting those as "missing" would light up the whole sidebar red for every
 * shop that has not re-synced yet — a day of confident, wrong findings, which
 * is worse than a day of honest "unknown".
 *
 * So `attributesKnown` gates every attribute-derived row, and `unknown` is a
 * first-class status with its own affordance ("reload this item"), never a
 * quiet fallback to `missing`.
 *
 * Deliberately disjoint from the SEO score (§0.6): that one judges title
 * length, SEO title, description, meta description and alt-text coverage.
 * Nothing here overlaps it.
 */

export type AttributeStatus =
  /** Set, and nothing to say about it. */
  | "ok"
  /** Genuinely absent, and we KNOW that. */
  | "missing"
  /** Present but worth a second look (a draft, no sales channel). */
  | "warning"
  /** We have not fetched this yet. NOT a finding. */
  | "unknown";

export interface AttributeRow {
  /** i18n key under `t.seo.attributes.rows.*`. */
  key: string;
  status: AttributeStatus;
  /** Rendered next to the label — a count, a value, a status word. */
  value?: string;
  /** Field to focus when the row is clicked (Phase 3). */
  jumpToField?: string;
  /** Set when the row can only be resolved in the Shopify admin. */
  adminOnly?: boolean;
}

/** What the sidebar knows about the selected item. Every field optional: a
 *  caller that cannot supply one gets `unknown`, which is the honest answer. */
export interface AttributeInput {
  resource: "product" | "collection" | "article" | "page";
  /** THE discriminator. Falsy ⇒ every attribute row below is "unknown". */
  attributesSyncedAt?: Date | string | null;

  // Product
  status?: string | null;
  vendor?: string | null;
  productType?: string | null;
  categoryName?: string | null;
  tags?: string[] | null;
  /** Membership count; `hasMoreCollections` marks a truncated window. */
  collectionCount?: number | null;
  hasMoreCollections?: boolean;
  /** Price of the default variant, as a string. Loaded separately (§2.3). */
  defaultVariantPrice?: string | null;

  // Collection
  sortOrder?: string | null;

  // Article
  author?: string | null;

  // Article / Page
  isPublished?: boolean | null;

  // All types
  featuredImageUrl?: string | null;
  templateSuffix?: string | null;
  /** Whether a keyword is assigned. Comes from the keyword tables, not the
   *  attribute block, so it is NOT gated on attributesSyncedAt. */
  hasKeyword?: boolean | null;
  /**
   * How many SALES CHANNELS the product is published on — markets and B2B
   * catalogs deliberately excluded, because a product that sits in a market
   * catalog but on no channel is invisible exactly as if it sat nowhere.
   *
   * Two sources answer it (Phase 4): the live commerce load, which is what the
   * merchant is looking at while the panel is open, and the `ProductPublication`
   * mirror it writes, which is what answers on a foreign locale and before the
   * live call lands. `null` from BOTH ⇒ "unknown" with an admin link, never a
   * red finding for something we simply cannot see (§2.3).
   */
  publicationCount?: number | null;
  /**
   * The publication window was cut off, so the count is a FLOOR.
   *
   * Load-bearing in one direction only: a truncated `0` cannot claim "on no
   * channel" — the one row that would have said otherwise may be exactly the
   * one that did not arrive. The same rule the panel's "invisible" badge keeps.
   */
  publicationCountTruncated?: boolean;
}

/** The Phase-0 discriminator, in the one place readers should ask. */
export function attributesKnown(input: Pick<AttributeInput, "attributesSyncedAt">): boolean {
  return !!input.attributesSyncedAt;
}

function presence(value: string | null | undefined, known: boolean, jumpToField?: string): AttributeRow["status"] {
  if (!known) return "unknown";
  return value && value.trim().length > 0 ? "ok" : "missing";
}

export function buildAttributeChecklist(input: AttributeInput): AttributeRow[] {
  const known = attributesKnown(input);
  const rows: AttributeRow[] = [];
  const unknownOr = (status: AttributeStatus): AttributeStatus => (known ? status : "unknown");

  if (input.resource === "product") {
    // A DRAFT is not an error — it is a state worth surfacing, because the
    // merchant may simply have forgotten to publish it.
    rows.push({
      key: "status",
      status: known ? (input.status === "ACTIVE" ? "ok" : "warning") : "unknown",
      value: input.status ?? undefined,
      jumpToField: "status",
    });

    // §2.3 — status and channels are SEPARATE rows on purpose. ACTIVE alone
    // does not make a product visible; that needs a publication. Merging them
    // into one "published" line is exactly the confusion the plan warns about.
    const channelCount = input.publicationCount ?? null;
    const channelsTruncated = input.publicationCountTruncated === true;
    // A truncated window that found nothing has found nothing YET — it is the
    // one case where a number exists and still may not be judged.
    const channelsUnknown = channelCount == null || (channelCount === 0 && channelsTruncated);
    rows.push({
      key: "channels",
      status: channelsUnknown ? "unknown" : channelCount > 0 ? "ok" : "warning",
      value: channelsUnknown
        ? undefined
        : channelsTruncated
          ? `${channelCount}+`
          : String(channelCount),
      adminOnly: channelsUnknown,
    });

    rows.push({
      key: "tags",
      status: known ? ((input.tags?.length ?? 0) > 0 ? "ok" : "missing") : "unknown",
      value: known ? String(input.tags?.length ?? 0) : undefined,
      jumpToField: "tags",
    });
    rows.push({ key: "vendor", status: presence(input.vendor, known), value: input.vendor ?? undefined, jumpToField: "vendor" });
    rows.push({ key: "category", status: presence(input.categoryName, known), value: input.categoryName ?? undefined, jumpToField: "category" });
    rows.push({ key: "productType", status: presence(input.productType, known), value: input.productType ?? undefined, jumpToField: "productType" });

    rows.push({
      key: "collections",
      status: input.collectionCount == null ? "unknown" : input.collectionCount > 0 ? "ok" : "missing",
      // A truncated membership window must not read as a complete count.
      value:
        input.collectionCount == null
          ? undefined
          : input.hasMoreCollections
            ? `${input.collectionCount}+`
            : String(input.collectionCount),
      jumpToField: "collections",
    });

    rows.push({
      key: "price",
      // Loaded separately from the item (§2.3) — absent means not loaded, not
      // "free".
      status: input.defaultVariantPrice == null ? "unknown" : input.defaultVariantPrice ? "ok" : "missing",
      value: input.defaultVariantPrice ?? undefined,
      // No `jumpToField`: pricing is per VARIANT and lives in the variants
      // card, not in a field of the Details card this checklist can point at.
    });
  }

  if (input.resource === "collection") {
    rows.push({ key: "sortOrder", status: presence(input.sortOrder, known), value: input.sortOrder ?? undefined, jumpToField: "sortOrder" });
  }

  if (input.resource === "article") {
    rows.push({ key: "author", status: presence(input.author, known), value: input.author ?? undefined, jumpToField: "author" });
    rows.push({
      key: "tags",
      status: known ? ((input.tags?.length ?? 0) > 0 ? "ok" : "missing") : "unknown",
      value: known ? String(input.tags?.length ?? 0) : undefined,
      jumpToField: "tags",
    });
  }

  if (input.resource === "article" || input.resource === "page") {
    rows.push({
      key: "published",
      status: known ? (input.isPublished ? "ok" : "warning") : "unknown",
      jumpToField: "isPublished",
    });
  }

  // Featured image: NOT part of the attribute block (it comes from the item's
  // own columns, which every sync has always written), so it is not gated.
  if (input.resource !== "page") {
    rows.push({
      key: "featuredImage",
      status: input.featuredImageUrl ? "ok" : "missing",
      jumpToField: "images",
    });
  }

  rows.push({
    key: "template",
    status: unknownOr("ok"),
    // "Default" is the normal case and deliberately not a finding — a theme
    // template suffix only helps someone who knows their theme's names.
    value: known ? (input.templateSuffix || "default") : undefined,
  });

  // Keyword lives in its own tables, so it is answerable even when the
  // attribute block is not.
  rows.push({
    key: "keyword",
    status: input.hasKeyword == null ? "unknown" : input.hasKeyword ? "ok" : "missing",
  });

  return rows;
}

/** True when anything in the list is a real finding — used for the tab badge. */
export function countFindings(rows: AttributeRow[]): number {
  return rows.filter((r) => r.status === "missing" || r.status === "warning").length;
}

/** True when the list is mostly "we have not looked yet" — the sidebar then
 *  offers a reload instead of a checklist that says nothing. */
export function needsAttributeSync(rows: AttributeRow[]): boolean {
  const gated = rows.filter((r) => r.status === "unknown" && !r.adminOnly);
  return gated.length > rows.length / 2;
}
