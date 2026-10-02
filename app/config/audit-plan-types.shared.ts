/**
 * SEO audit item type -> plan content type. ONE map for the audit service
 * (which wants only the types the plan includes) and the /api/ai target gate
 * (`ai-target-plan.ts`). Import-free on purpose (type import only): both the
 * server and client-safe modules read it.
 */
import type { ContentType } from "./plans";

export const AUDIT_TYPE_TO_PLAN_CONTENT_TYPE = {
  product: "products",
  collection: "collections",
  article: "articles",
  page: "pages",
} as const satisfies Record<string, ContentType>;
