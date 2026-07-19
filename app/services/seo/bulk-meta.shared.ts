/**
 * Client-safe half of the manual bulk-meta editor (SEO_TAB_IMPLEMENTATION_PLAN.md
 * Anhang C3): types, constants and the pure diff computation.
 *
 * Split out of bulk-meta.service.ts because the route component
 * (app.seo.bulk-meta.tsx) uses computeDiff/MAX_SYNC_SAVE/BULK_META_TYPES in
 * CLIENT code — importing them from the service dragged ShopifyApiGateway →
 * logger.server into the client bundle and broke `remix vite:build`
 * ("Server-only module referenced by client"). This module must stay free of
 * server-only imports; bulk-meta.service.ts re-exports everything here so
 * server-side consumers keep a single import path.
 */

export type BulkMetaType = "product" | "collection" | "article" | "page";

/**
 * All editable field keys across every content type. Not every field is valid
 * for every type — BULK_META_FIELDS_BY_TYPE keeps the per-type allowlist and
 * the server validates diff entries against it (persistRow in
 * bulk-meta.service.ts). The union stays flat because the client edit map
 * uses `${id}:${field}` keys regardless of type.
 */
export type BulkMetaField =
  | "title"
  | "seoTitle"
  | "seoDescription"
  | "handle"
  | "descriptionHtml"
  | "productType"
  | "status"
  | "body"
  | "summary";

export const BULK_META_TYPES: BulkMetaType[] = ["product", "collection", "article", "page"];

export const BULK_META_FIELDS: BulkMetaField[] = [
  "title",
  "seoTitle",
  "seoDescription",
  "handle",
  "descriptionHtml",
  "productType",
  "status",
  "body",
  "summary",
];

/**
 * Per-type allowlist of editable fields. Used both by the UI (column picker
 * modal + which columns to render) and by the server (persistRow rejects any
 * diff entry whose field isn't listed for its type).
 *
 * Order = default column order for that type.
 */
export const BULK_META_FIELDS_BY_TYPE: Record<BulkMetaType, BulkMetaField[]> = {
  product: [
    "title",
    "descriptionHtml",
    "productType",
    "status",
    "handle",
    "seoTitle",
    "seoDescription",
  ],
  collection: ["title", "descriptionHtml", "handle", "seoTitle", "seoDescription"],
  article: ["title", "summary", "body", "handle", "seoTitle", "seoDescription"],
  page: ["title", "body", "handle", "seoTitle", "seoDescription"],
};

/**
 * Read-only meta columns (image thumbnail, blog title). Displayed in the grid
 * but not part of BulkMetaField — never appear in the client edit map or the
 * server diff.
 */
export type BulkMetaReadOnlyColumn = "image" | "blogTitle";

export const BULK_META_READONLY_BY_TYPE: Record<BulkMetaType, BulkMetaReadOnlyColumn[]> = {
  product: ["image"],
  collection: ["image"],
  article: ["image", "blogTitle"],
  page: [],
};

/** Rows shown per page in the grid (A2-style take cap, offset-paged via ?page=). */
export const BULK_META_PAGE_SIZE = 100;

/** More dirty rows than this go through the detached "seoBulkMeta" Task
 * (seo-bulk-meta.handler.ts) instead of a synchronous save. */
export const MAX_SYNC_SAVE = 25;

/** Hard cap on one detached run. There's no per-item AI call here (unlike
 * MAX_BULK_FIX_ITEMS in seo-bulk-fix.handler.ts), so the ceiling can be much
 * higher — this just bounds one runner's worst-case wall-clock time. */
export const MAX_BULK_META_TASK_ITEMS = 500;

export interface BulkMetaRow {
  id: string;
  type: BulkMetaType;
  title: string;
  seoTitle: string;
  seoDescription: string;
  handle: string;
  // Per-type optional editable fields.
  descriptionHtml?: string;
  productType?: string;
  status?: string;
  body?: string;
  summary?: string;
  // Read-only display fields.
  imageUrl?: string;
  imageAlt?: string;
  blogTitle?: string;
}

export interface BulkMetaDiffEntry {
  id: string;
  type: BulkMetaType;
  field: BulkMetaField;
  value: string;
}

export interface BulkMetaFailure {
  id: string;
  type: BulkMetaType;
  message: string;
}

export interface BulkMetaApplyResult {
  saved: number;
  failures: BulkMetaFailure[];
}

/** True if `field` is a valid editable column for `type`. Used server-side as
 * a per-row validation guard AND client-side to skip stale edits when the
 * merchant switches types with pending changes. */
export function isFieldAllowedForType(type: BulkMetaType, field: BulkMetaField): boolean {
  return BULK_META_FIELDS_BY_TYPE[type].includes(field);
}

// ─── Pure diff computation (unit-tested) ──────────────────────────────────

/**
 * Diff-only save-all: only cells whose trimmed value differs from the
 * (trimmed) original row value are returned. `edits` is keyed by
 * `${id}:${field}` — exactly the shape of the route's client-side edit map.
 *
 * Trimming means whitespace-only "changes" never count as dirty, but
 * deliberately clearing a field (typing nothing) still produces a
 * `value: ""` entry whenever the original had content — an explicit clear is
 * a real, save-worthy diff, not a no-op.
 *
 * Split on the LAST ":" rather than the first: Shopify GIDs
 * ("gid://shopify/Product/123") contain their own colon, but none of the
 * field names do, so the separator is always the final one.
 */
export function computeDiff(rows: BulkMetaRow[], edits: Record<string, string>): BulkMetaDiffEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const diff: BulkMetaDiffEntry[] = [];

  for (const key of Object.keys(edits)) {
    const sep = key.lastIndexOf(":");
    if (sep < 0) continue;
    const id = key.slice(0, sep);
    const field = key.slice(sep + 1) as BulkMetaField;
    if (!BULK_META_FIELDS.includes(field)) continue;

    const row = byId.get(id);
    if (!row) continue;
    if (!isFieldAllowedForType(row.type, field)) continue;

    const original = ((row[field] as string | undefined) ?? "").trim();
    const next = (edits[key] ?? "").trim();
    if (next !== original) {
      diff.push({ id: row.id, type: row.type, field, value: next });
    }
  }

  return diff;
}

/** Groups flat diff entries into one patch per (type,id) row, so a row with
 * several dirty cells produces a single Shopify mutation instead of one per
 * field. Exported (alongside computeDiff) since it's pure and easy to test
 * independently of any I/O. */
export function groupDiffByRow(
  diff: BulkMetaDiffEntry[],
): { type: BulkMetaType; id: string; fields: Partial<Record<BulkMetaField, string>> }[] {
  const map = new Map<string, { type: BulkMetaType; id: string; fields: Partial<Record<BulkMetaField, string>> }>();
  for (const entry of diff) {
    const key = `${entry.type}:${entry.id}`;
    let group = map.get(key);
    if (!group) {
      group = { type: entry.type, id: entry.id, fields: {} };
      map.set(key, group);
    }
    group.fields[entry.field] = entry.value;
  }
  return [...map.values()];
}
