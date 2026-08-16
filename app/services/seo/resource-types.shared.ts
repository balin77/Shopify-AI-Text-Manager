/**
 * The resource-type vocabulary the SEO services share.
 *
 * Lives in its own client-safe module rather than in `audit.service.ts` because
 * `crawl.service.ts` needs the `isAuditType` narrowing as a VALUE and
 * audit.service already imports crawl.service — declaring it there would turn a
 * type-only cycle into a real one.
 */

/** The four content types the store-wide SEO audit scores. */
export type AuditType = "product" | "collection" | "article" | "page";

/**
 * What a crawl finding can deep-link into. A strict SUPERSET of `AuditType`:
 * a policy page is editable (/app/policies) but carries no SEO title, meta
 * description or handle, so it is not part of the audit's coverage scoring and
 * must stay out of every `Record<AuditType, …>` map. Findings that reach the
 * merchant as "open in editor" use this type; everything that compares against
 * stored SEO fields (head drift, coverage, translations) keeps `AuditType`.
 */
export type DeepLinkType = AuditType | "policy";

const AUDIT_TYPES = new Set<string>(["product", "collection", "article", "page"]);

/**
 * Narrows a persisted `SeoCrawlPage.resourceType` to the four types the AUDIT
 * understands. Every dashboard bucket goes through this: its `items` feed the
 * "Fix with AI" bulk handler and the dashboard's `Record<AuditType, path>` map,
 * neither of which has anything to do with a policy page. The crawl report
 * itself keeps the wider `DeepLinkType` and links policies to /app/policies.
 *
 * It also still rejects `"unknown"` — the value the crawler persists for a URL
 * that resolves to no resource at all — so it is a drop-in for the
 * `!== "unknown"` guards it replaced.
 */
export function isAuditType(value: string | null | undefined): value is AuditType {
  return !!value && AUDIT_TYPES.has(value);
}
