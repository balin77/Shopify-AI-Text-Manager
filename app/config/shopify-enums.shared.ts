/**
 * Shopify enum vocabularies, as leaf constants.
 *
 * ── Why these do not live in `create-fields.config.ts` any more ─────────────
 * They did, and that file is where they are USED most — but it also imports
 * `metaobject-fields.shared`, which imports the bulk editor's
 * `columns.shared`. So the moment the grid needed the same vocabularies for its
 * select columns, importing them pulled a CYCLE into existence: the constants
 * were still `undefined` when the module that spreads them evaluated, and
 * `[...COLLECTION_SORT_ORDERS]` threw "is not iterable" from inside an import
 * chain — a failure that looks nothing like its cause.
 *
 * This module therefore imports NOTHING, which is the only property that makes
 * it safe for every side of that graph. It is the same reason
 * `translation-change-policy.shared.ts` and `translation-locks.shared.ts` exist
 * as their own files: a constant two modules must agree on cannot live inside
 * either of them.
 *
 * A value that is wrong here fails at the GraphQL SCHEMA level — a top-level
 * `errors` array with `data: null` that never reaches `userErrors`, i.e. a save
 * that reads as a success while nothing was written. That is why the create
 * form, the single editor, the bulk grid and every server-side validator read
 * one list rather than each carrying their own.
 */

/** Shopify `ProductStatus`. FOUR values occur in real data, not three:
 *  UNLISTED means "active but reachable only by direct link" and code that
 *  enumerates three is what made unlisted products invisible to several
 *  features in this app already. Create defaults to DRAFT, which is why that
 *  one leads the list. */
export const CREATE_PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "UNLISTED", "ARCHIVED"] as const;

/** Shopify `CollectionSortOrder`, measured against 2026-07 (PLAN §1.2a). */
export const COLLECTION_SORT_ORDERS = [
  "MANUAL",
  "BEST_SELLING",
  "ALPHA_ASC",
  "ALPHA_DESC",
  "PRICE_ASC",
  "PRICE_DESC",
  "CREATED",
  "CREATED_DESC",
  "MOST_RELEVANT",
] as const;

/** Shopify `BlogCommentPolicy`. */
export const BLOG_COMMENT_POLICIES = ["CLOSED", "MODERATED", "AUTO_PUBLISHED"] as const;
