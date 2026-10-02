/**
 * Which plan content types an /api/ai request really TOUCHES.
 *
 * The SEO pages (dashboard, crawl report, keywords, internal links, AEO) post
 * the placeholder `contentType=products` whatever they act on, and the page
 * routes' own PlanAccessGate only hides a page — so the posted contentType
 * proves nothing about the target. The server therefore reads the target out
 * of the payload (the item's GID, the audit item type, the keyword target
 * type) and judges the plan on THAT, per target. Rule where the SEO feature
 * tier and a content tier disagree: the CONTENT-type gate wins (a plan without
 * `pages` cannot edit a page through the SEO tools either).
 *
 * Pure and import-light: unit-testable without the route.
 */
import type { ContentType, Plan } from "../config/plans";
import { AUDIT_TYPE_TO_PLAN_CONTENT_TYPE } from "../config/audit-plan-types.shared";
import { canAccessContentType } from "./planUtils";

const GID_TYPE_TO_PLAN_TYPE: Record<string, ContentType> = {
  Product: "products",
  Collection: "collections",
  Article: "articles",
  // The blog page is gated as "articles" (app.blog.tsx): articles and their
  // blog container are one rubric.
  Blog: "articles",
  Page: "pages",
  // Older shops / API versions spell the page resource this way.
  OnlineStorePage: "pages",
  ShopPolicy: "policies",
};

/** Plan content type of a Shopify GID, or null for an id this does not know (never gate on a guess). */
export function planTypeOfGid(id: string | null | undefined): ContentType | null {
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\//.exec(id ?? "");
  return m ? (GID_TYPE_TO_PLAN_TYPE[m[1]] ?? null) : null;
}

/** SEO audit item type -> plan content type. */
export const AUDIT_ITEM_TYPE_TO_PLAN_TYPE: Record<string, ContentType> = AUDIT_TYPE_TO_PLAN_CONTENT_TYPE;

/** Keyword target type (Product / Collection / Article / Page) -> plan content type. */
export const KEYWORD_TARGET_TO_PLAN_TYPE: Record<string, ContentType> = {
  Product: "products",
  Collection: "collections",
  Article: "articles",
  Page: "pages",
};

function add(out: Set<ContentType>, t: ContentType | null | undefined) {
  if (t) out.add(t);
}

/**
 * Every plan content type the request's payload targets (deduplicated). An
 * unrecognised value contributes nothing here: the handlers validate their own
 * inputs and fail closed; this only adds the gates the placeholder skipped.
 */
export function targetPlanTypes(actionType: string, get: (key: string) => string): ContentType[] {
  const out = new Set<ContentType>();
  add(out, planTypeOfGid(get("itemId")));
  switch (actionType) {
    case "seoBulkFix":
      add(out, AUDIT_ITEM_TYPE_TO_PLAN_TYPE[get("itemType")]);
      break;
    case "distributeKeywords":
      add(out, KEYWORD_TARGET_TO_PLAN_TYPE[get("targetType")]);
      break;
    default:
      break;
  }
  return [...out];
}

/** First target the plan does not include, or null when all are allowed. */
export function firstGatedTarget(plan: string | null | undefined, types: readonly ContentType[]): ContentType | null {
  const p = (plan || "free") as Plan;
  return types.find((t) => !canAccessContentType(p, t)) ?? null;
}

/**
 * Split audit items by what the plan includes, for runs over many items where
 * one gated type must not refuse the whole run: the allowed items run, the
 * gated ones are handed back to be reported as failed.
 */
export function partitionItemsByPlan<T extends { type: string }>(
  plan: string | null | undefined,
  items: readonly T[],
): { allowed: T[]; gated: T[] } {
  const p = (plan || "free") as Plan;
  const allowed: T[] = [];
  const gated: T[] = [];
  for (const it of items) {
    const t = AUDIT_ITEM_TYPE_TO_PLAN_TYPE[it.type];
    // An unknown item type is not a plan question; the handler's own checks decide.
    (t && !canAccessContentType(p, t) ? gated : allowed).push(it);
  }
  return { allowed, gated };
}
