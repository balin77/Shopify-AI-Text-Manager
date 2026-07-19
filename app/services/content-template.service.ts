/**
 * Content-Template Service (Feature: Content Templates / Vorlagen)
 *
 * Shop-scoped CRUD for reusable AI prompt templates plus the resolver that
 * turns a stored template into a sanitized instruction block injected into the
 * AI prompt right before generation.
 *
 * Plan gating: Pro/Max only. The route enforces it for CRUD; resolution also
 * re-checks the plan (defence in depth) so a downgraded shop's stored
 * templates stop affecting prompts immediately, without a cleanup job.
 *
 * Security: template bodies are merchant-authored and trusted exactly like the
 * existing custom AI instructions (injected raw). The *substituted values*
 * come from merchant content (product titles/descriptions, …) and ARE run
 * through the existing prompt-injection sanitizer before substitution, so a
 * crafted product title cannot smuggle instructions into the prompt.
 */

import type { ContentTemplate } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db.server";
import {
  substituteTemplateVariables,
  extractTemplateVariables,
} from "../utils/template-substitution.utils";
import { sanitizePromptInput } from "../utils/prompt-sanitizer";
import { canUseContentTemplates } from "../utils/planUtils";
import type { Plan } from "../config/plans";

/**
 * Thrown when two concurrent writes both try to become the single `isDefault`
 * template for the same (shop, contentType, fieldType) slot. The partial
 * unique index (migration) catches the second commit as P2002; the caller
 * translates this to a merchant-friendly "reload the page" message.
 */
export class ContentTemplateDefaultRaceError extends Error {
  constructor() {
    super("Another window changed the default for this slot at the same time.");
    this.name = "ContentTemplateDefaultRaceError";
  }
}

function isDefaultUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

/** Content types a template can target (mirrors CONTENT_CONFIGS keys). */
export const TEMPLATE_CONTENT_TYPES = [
  "products",
  "collections",
  "blogs",
  "pages",
  "policies",
] as const;
export type TemplateContentType = (typeof TEMPLATE_CONTENT_TYPES)[number];

const MAX_NAME_LEN = 100;
const MAX_TEMPLATE_LEN = 8000;

export function isTemplateContentType(v: string): v is TemplateContentType {
  return (TEMPLATE_CONTENT_TYPES as readonly string[]).includes(v);
}

export interface TemplateInput {
  name: string;
  contentType: string;
  fieldType: string;
  template: string;
  isDefault?: boolean;
}

export interface TemplateValidationError {
  field: "name" | "contentType" | "fieldType" | "template";
  message: string;
}

/**
 * Validates merchant-supplied template input. Returns a list of problems
 * (empty = valid). Kept synchronous/pure for easy unit testing.
 */
export function validateTemplateInput(
  input: Partial<TemplateInput>,
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  const name = (input.name ?? "").trim();
  if (!name) {
    errors.push({ field: "name", message: "Name is required." });
  } else if (name.length > MAX_NAME_LEN) {
    errors.push({
      field: "name",
      message: `Name must be at most ${MAX_NAME_LEN} characters.`,
    });
  }

  if (!input.contentType || !isTemplateContentType(input.contentType)) {
    errors.push({ field: "contentType", message: "Invalid content type." });
  }

  const fieldType = (input.fieldType ?? "").trim();
  if (!fieldType) {
    errors.push({ field: "fieldType", message: "Field type is required." });
  }

  const template = (input.template ?? "").trim();
  if (!template) {
    errors.push({ field: "template", message: "Template body is required." });
  } else if (template.length > MAX_TEMPLATE_LEN) {
    errors.push({
      field: "template",
      message: `Template must be at most ${MAX_TEMPLATE_LEN} characters.`,
    });
  }

  return errors;
}

export function listTemplates(shop: string): Promise<ContentTemplate[]> {
  return db.contentTemplate.findMany({
    where: { shop },
    orderBy: [
      { contentType: "asc" },
      { fieldType: "asc" },
      { name: "asc" },
    ],
  });
}

export function getTemplate(
  shop: string,
  id: string,
): Promise<ContentTemplate | null> {
  // shop is part of the where clause so one shop can never read another's row.
  return db.contentTemplate.findFirst({ where: { id, shop } });
}

/**
 * Creates a template. When `isDefault` is set, any other default for the same
 * (shop, contentType, fieldType) is unset atomically so there is always at
 * most one auto-applied template per slot.
 */
export async function createTemplate(
  shop: string,
  input: TemplateInput,
): Promise<ContentTemplate> {
  const data = {
    shop,
    name: input.name.trim(),
    contentType: input.contentType,
    fieldType: input.fieldType.trim(),
    template: input.template,
    isDefault: !!input.isDefault,
  };

  if (!data.isDefault) {
    return db.contentTemplate.create({ data });
  }

  return db.$transaction(async (tx) => {
    await tx.contentTemplate.updateMany({
      where: {
        shop,
        contentType: data.contentType,
        fieldType: data.fieldType,
        isDefault: true,
      },
      data: { isDefault: false },
    });
    return tx.contentTemplate.create({ data });
  });
}

/**
 * Updates a template (shop-scoped). Returns null if the row does not belong to
 * the shop. Keeps the single-default invariant when `isDefault` becomes true.
 */
export async function updateTemplate(
  shop: string,
  id: string,
  input: TemplateInput,
): Promise<ContentTemplate | null> {
  const data = {
    name: input.name.trim(),
    contentType: input.contentType,
    fieldType: input.fieldType.trim(),
    template: input.template,
    isDefault: !!input.isDefault,
  };

  try {
    return await db.$transaction(async (tx) => {
      // Ownership check INSIDE the transaction so the read and the write see a
      // consistent snapshot (no TOCTOU between findFirst and update).
      const existing = await tx.contentTemplate.findFirst({
        where: { id, shop },
      });
      if (!existing) return null;

      if (data.isDefault) {
        await tx.contentTemplate.updateMany({
          where: {
            shop,
            contentType: data.contentType,
            fieldType: data.fieldType,
            isDefault: true,
            id: { not: id },
          },
          data: { isDefault: false },
        });
      }
      return tx.contentTemplate.update({ where: { id }, data });
    });
  } catch (err) {
    if (isDefaultUniqueViolation(err)) throw new ContentTemplateDefaultRaceError();
    throw err;
  }
}

/**
 * Deletes a template. Returns false if it does not belong to the shop (so a
 * forged id from another tenant is a no-op, not an error leak).
 */
export async function deleteTemplate(
  shop: string,
  id: string,
): Promise<boolean> {
  const res = await db.contentTemplate.deleteMany({ where: { id, shop } });
  return res.count > 0;
}

/**
 * Marks one template as the auto-applied default for its (contentType,
 * fieldType) slot and unsets any sibling default. Shop-scoped; returns null
 * if the row does not belong to the shop.
 */
export async function setDefaultTemplate(
  shop: string,
  id: string,
): Promise<ContentTemplate | null> {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.contentTemplate.findFirst({
        where: { id, shop },
      });
      if (!existing) return null;

      await tx.contentTemplate.updateMany({
        where: {
          shop,
          contentType: existing.contentType,
          fieldType: existing.fieldType,
          isDefault: true,
          id: { not: id },
        },
        data: { isDefault: false },
      });
      return tx.contentTemplate.update({
        where: { id },
        data: { isDefault: true },
      });
    });
  } catch (err) {
    if (isDefaultUniqueViolation(err)) throw new ContentTemplateDefaultRaceError();
    throw err;
  }
}

/**
 * Resolves the auto-applied template for a content type + field and returns a
 * sanitized, variable-substituted instruction block ready to append to the AI
 * prompt — or null when templates are not entitled, none is configured, or the
 * result is empty.
 */
export async function resolveTemplateInstruction(opts: {
  shop: string;
  plan: Plan;
  contentType: string;
  fieldType: string;
  /** Raw, UNSANITIZED content values keyed by placeholder name. */
  vars: Record<string, string | null | undefined>;
}): Promise<{ instruction: string; missingVars: string[] } | null> {
  if (!canUseContentTemplates(opts.plan)) return null;

  const tpl = await db.contentTemplate.findFirst({
    where: {
      shop: opts.shop,
      contentType: opts.contentType,
      fieldType: opts.fieldType,
      isDefault: true,
    },
  });
  if (!tpl || !tpl.template.trim()) return null;

  // Defensive length cap: stored rows are capped at create/update time, but a
  // row written before a future limit change (or directly in the DB) must not
  // produce an unbounded prompt.
  const body = tpl.template.slice(0, MAX_TEMPLATE_LEN);

  // First pass — sanitize every substituted value individually through the
  // SAME prompt-injection sanitizer the rest of the AI pipeline uses.
  const sanitizedVars: Record<string, string> = {};
  for (const [key, raw] of Object.entries(opts.vars)) {
    if (raw === null || raw === undefined) continue;
    const longForm = /desc|body|content|summary/i.test(key);
    sanitizedVars[key] = sanitizePromptInput(String(raw), {
      allowNewlines: longForm,
    });
  }

  const { result, missingVars } = substituteTemplateVariables(
    body,
    sanitizedVars,
  );

  // Second pass — sanitize the ASSEMBLED string. A value placed adjacent to
  // template text can reconstruct an injection pattern that the per-value pass
  // cannot see (e.g. a title ending in "…ignore" next to " previous
  // instructions" in the template). Re-running the sanitizer over the spliced
  // result closes that boundary-straddling bypass. Newlines are kept so
  // multi-line prompt templates survive.
  const instruction = sanitizePromptInput(result, {
    allowNewlines: true,
  }).trim();
  if (!instruction) return null;

  return { instruction, missingVars };
}

export { extractTemplateVariables };
