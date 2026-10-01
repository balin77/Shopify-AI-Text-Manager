/**
 * Task vocabulary — ONE module, client-safe.
 *
 * Every surface that names a task (the Tasks page, the navigation badge's
 * hover card, the completion toasts in MainNavigation) resolves its words
 * here. The rules below each have a bug behind them:
 *
 *  - An unknown key falls back to a HUMANISED form, never to the raw
 *    identifier. A merchant used to read `imageWebpConversion` as a card
 *    heading; a missing label should cost polish, not comprehension.
 *  - `bulkAIGeneration` and `bulkAiGeneration` are the same task type spelled
 *    two ways (the alt-text paths create the first, the i18n key carries the
 *    second). They resolve from ONE entry — the created type string is never
 *    renamed, because running rows carry the old string and
 *    LONG_RUNNING_TASK_TYPES matches on it.
 *  - Every function is TOTAL: `t` is `any` throughout this codebase and whole
 *    sections can be absent, so a missing bundle must degrade, never throw.
 */

import { extractReadableName } from "../../utils/templates-field-factory";

/**
 * Split camelCase / snake_case / kebab-case into a sentence-cased phrase:
 * `imageWebpConversion` -> `Image webp conversion`. The FIRST letter is
 * capitalised and nothing else — a fallback that invents Title Case reads
 * like a real label, and a merchant then cannot tell a missing translation
 * from a deliberate one.
 */
function humanise(raw: string): string {
  const words = raw
    .replace(/[_-]+/g, " ")
    // camelCase and acronym boundaries: "webpConversion" -> "webp Conversion",
    // "JSONLd" -> "JSON Ld". Both are INTERMEDIATE: the whole phrase is
    // lowercased two lines down and only its first letter is restored, so
    // `seoJSONLdAudit` really comes out as "Seo json ld audit". An acronym
    // does not survive a humanised fallback — the accepted cost of a fallback
    // that must not read like a real label.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Reads `bundle[key]` defensively — the bundle is `any` and may be absent. */
function lookup(bundle: unknown, key: string): string | null {
  if (!bundle || typeof bundle !== "object") return null;
  const value = (bundle as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Task types created under a spelling the i18n bundle does not carry.
 * NEVER add a duplicated i18n key for these — one label, two identifiers.
 *
 * EXPORTED because `task-details.shared.ts` resolves the very same question
 * one layer down: its summariser registry is keyed by task type, and a RAW
 * lookup there would reintroduce this exact one-letter split (a summariser
 * registered under `bulkAiGeneration` never firing for a `bulkAIGeneration`
 * row). A second copy of the map is that bug with an extra step, so there is
 * one map and this module owns it.
 */
export const TASK_TYPE_ALIASES: Record<string, string> = {
  // B2: alt-text paths create `bulkAIGeneration`, the label key is
  // `bulkAiGeneration`. One letter, so every bulk alt-text task fell through
  // to its raw name.
  bulkAIGeneration: "bulkAiGeneration",
};

/**
 * Resource types written in a casing or number the label map does not carry.
 * `"Product"` comes from app.seo.performance.tsx, `"products"` from
 * api.translate-alt-text-template.tsx — both mean the `product` label.
 */
const RESOURCE_TYPE_ALIASES: Record<string, string> = {
  products: "product",
  collections: "collection",
  pages: "page",
  blogs: "blog",
  articles: "blog",
};

export function taskTypeLabel(type: string, t: any): string {
  if (typeof type !== "string" || !type) return "";
  const bundle = t?.tasks?.taskType;
  const canonical = TASK_TYPE_ALIASES[type] ?? type;
  return lookup(bundle, canonical) ?? lookup(bundle, type) ?? humanise(type);
}

export function resourceTypeLabel(
  resourceType: string | null | undefined,
  t: any,
): string | null {
  if (typeof resourceType !== "string") return null;
  const raw = resourceType.trim();
  if (!raw) return null;

  const bundle = t?.tasks?.resourceType;
  const lower = raw.toLowerCase();
  const alias = RESOURCE_TYPE_ALIASES[lower];

  return (
    lookup(bundle, raw) ??
    lookup(bundle, lower) ??
    (alias ? lookup(bundle, alias) : null) ??
    humanise(raw)
  );
}

/**
 * The field a task worked on. Reproduces `toReadableFieldName` from
 * MainNavigation.tsx (L110-117), which is deleted in favour of this.
 */
export function fieldTypeLabel(raw: string | null | undefined, t: any): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const labelled = lookup(t?.tasks?.fieldType, value);
  if (labelled) return labelled;

  if (value === "allAltTexts") {
    return lookup(t?.tasks, "allAltTexts") ?? "all alt-texts";
  }

  const altMatch = value.match(/^altText_(\d+)$/);
  if (altMatch) {
    // The stored number is a zero-based image INDEX; merchants count from 1.
    const n = String(Number(altMatch[1]) + 1);
    const template = lookup(t?.tasks, "imageAltText");
    return template ? template.replace("{n}", n) : `Image ${n} alt-text`;
  }

  // Theme/template keys ("section.product.json.title") carry their own
  // readable-name rule.
  if (value.includes(".") || value.includes(":")) {
    try {
      const extracted = extractReadableName(value);
      if (typeof extracted === "string" && extracted.trim()) return extracted;
    } catch {
      /* fall through to the humanised form */
    }
  }

  return humanise(value);
}

/**
 * The line under the task's heading. For `seoBulkFix` the stored
 * `resourceTitle` is a MACHINE string ("metaDescriptionMissing:fr",
 * "fixAllForItem:product:8123") — readable to the runner, not to a merchant —
 * so the problem it fixed is named instead, with the dashboard's own label.
 */
export function taskSubjectLabel(
  task: { type: string; resourceTitle?: string | null },
  t: any,
): string | null {
  const title = typeof task?.resourceTitle === "string" ? task.resourceTitle.trim() : "";

  if (task?.type === "seoBulkFix") {
    if (!title) return null;
    // "fixAllForItem:…" carries no problem code — it fixed everything.
    const code = title.startsWith("fixAllForItem:") ? "" : title.split(":")[0];
    const problemLabel = code ? lookup(t?.seo?.dashboard?.problems, code) : null;
    return problemLabel ?? null;
  }

  return title || null;
}
