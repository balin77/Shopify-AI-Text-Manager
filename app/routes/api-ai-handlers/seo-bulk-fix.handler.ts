/**
 * SEO Audit Dashboard — "Fix with AI" bulk action.
 *
 * Reuses the app's existing bulk-AI pipeline end to end (no new job runner, no
 * new AI logic): a parent Task is created up front (mirrors
 * alt-text.handler.ts's handleGenerateAllAltTexts), a DETACHED runner then
 * walks the affected items one at a time, generating each field the same way
 * text-generation.handler.ts's handleGenerateAIText builds its prompt
 * (character limits, writing-style/format/instructions injection,
 * sanitizePromptInput), persisting through the SAME Shopify mutation paths the
 * single-item editor uses (ShopifyContentService for Collection/Page/Article, a
 * minimal partial productUpdate for Product), and updating the DB content
 * cache so the audit immediately reflects the fix on the next reload.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isAuthError, CONTENT_CONFIGS } from "./shared";
import { getFormString } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { getSeoBulkBatchSize } from "~/utils/planUtils";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { getInstructionWithDefault, getWritingStyleInstructions } from "~/utils/ai-instructions.utils";
import { getCharacterLimitRequirement, type SeoLimits } from "~/utils/character-limits";
import { analyzeStore, type AuditType, type AuditProblemBucket } from "~/services/seo/audit.service";
import { seoTitleEffectiveLimit } from "~/utils/seo-score";
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import type { Plan } from "~/config/plans";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import type { AISettings, PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { DataResponse } from "~/types/data-response";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import { featuredAltLockId } from "~/services/translations/translation-locks.shared";

// Cap how many items ONE run touches. The audit's own MAX_PROBLEM_BUCKET_ITEMS
// (100) already bounds this at the source, but re-asserting it here keeps this
// handler safe even if that cap ever changes independently.
/**
 * Hard ceiling on one bulk-fix run, independent of the plan — one request must
 * never enqueue an unbounded fan-out. The PLAN's `seo.bulkBatchSize` (Free 25 …
 * Max 2500, §Plan-Matrix) applies on top; whichever is lower wins, which is
 * what makes throughput a real Pro→Max difference.
 */
const MAX_BULK_FIX_ITEMS = 2500;

// Allowlist of AI-fixable problem buckets (see audit.service.ts FINDING_TO_BUCKET
// for the full code list).
type FixableField = "seoTitle" | "metaDescription" | "title" | "description" | "altText";

const FIXABLE_CODE_TO_FIELD: Record<string, FixableField> = {
  seoTitleMissing: "seoTitle",
  seoTitleTooLong: "seoTitle",
  metaDescriptionMissing: "metaDescription",
  metaDescriptionLength: "metaDescription",
  // Duplicate SEO buckets regenerate the SAME field (title / description) but
  // trigger sibling-context injection in the prompt (see buildFixPrompt) so
  // the AI doesn't just produce another duplicate. The bucket's `items` list
  // IS the sibling group — the runner iterates it and each item gets the
  // OTHER items' current values as an "avoid these" hint.
  duplicateSeoTitle: "seoTitle",
  duplicateSeoDescription: "metaDescription",
  // Storefront-visible content title (product/collection/page/article name).
  // Merchant-triggered from the SEO dashboard only — never a passive
  // regeneration, since it changes public-facing copy.
  titleLength: "title",
  // Storefront-visible content BODY (descriptionHtml / body). Uses the
  // dedicated description-generation AI path (generateProductDescription)
  // and receives the current description as context so tone/keywords carry
  // over — not a blank-slate rewrite.
  descriptionTooShort: "description",
  // Handled by a separate runner (runAltTextBulkFix) because alt text is
  // per-image, not per-item, and needs productUpdateMedia instead of the
  // regular content mutations.
  imagesMissingAlt: "altText",
};

/** AuditType -> the api-ai-handlers/content-fields.config.tsx contentType key. */
const AUDIT_TYPE_TO_CONTENT_TYPE: Record<AuditType, string> = {
  product: "products",
  collection: "collections",
  article: "blogs",
  page: "pages",
};

export async function handleSeoBulkFix(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, settings, formData, seoTitleMaxChars, seoLimits } = ctx;
  const problemCode = getFormString(formData, "problemCode");
  // Foreign-locale mode: dashboard's language switcher passes ?locale=xx
  // through as a form field, so the same handler covers primary + every
  // foreign locale. "" (or absent) = primary, preserving the pre-locale
  // behavior 1:1. Validated against shopLocales below so a client-supplied
  // stale/unknown locale falls back to primary rather than corrupting DB rows.
  const requestedLocale = getFormString(formData, "locale");

  // Optional single-item mode: the dashboard's per-row KI button POSTs
  // itemId + itemType so only ONE item runs, instead of the whole bucket.
  // Still validated against the server-side audit below (never trust the
  // client — a stale/foreign GID must not slip through).
  const singleItemId = getFormString(formData, "itemId");
  const singleItemType = getFormString(formData, "itemType") as AuditType | "";

  // "Fix all issues for this item" mode — the dashboard's per-row bulk KI
  // button on the worst-offenders card. Server derives every applicable
  // AI-fixable code for the item and runs them sequentially in ONE task.
  // problemCode is ignored in this mode.
  const fixAllForItem = getFormString(formData, "fixAllForItem") === "true";
  if (fixAllForItem) {
    return handleFixAllForItem(ctx, singleItemId, singleItemType, requestedLocale);
  }

  const field = FIXABLE_CODE_TO_FIELD[problemCode];
  if (!field) {
    return json(
      { success: false, error: `SEO bulk-fix isn't available for "${problemCode}" yet.` },
      { status: 400 },
    );
  }

  // Single-flight: only one seoBulkFix run per shop at a time — a second click
  // (or a second bucket) while one is in flight would double-spend AI calls
  // on the same items and race the DB/Shopify writes below.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoBulkFix", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An SEO bulk-fix is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // Re-run the audit server-side — never trust client-supplied ids, which may
  // be stale (edited/deleted) by the time this POST arrives.
  const aiSettingsRow = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true, seoTitleSuffixEnabled: true, seoTitleSuffix: true, seoLimits: true },
  });
  const plan = (aiSettingsRow?.subscriptionPlan || "free") as Plan;
  const suffix =
    aiSettingsRow?.seoTitleSuffixEnabled && aiSettingsRow.seoTitleSuffix ? aiSettingsRow.seoTitleSuffix : "";
  const auditSeoLimits = (aiSettingsRow?.seoLimits ?? null) as Record<string, number> | null;

  // Resolve target locale: validate against shopLocales, resolve target
  // language name for the prompt. An unknown/unpublished foreign locale is a
  // hard 400 — collapsing to primary would silently rewrite the merchant's
  // primary content when they thought they were translating.
  const localeResolution = await resolveTargetLocale(admin, session.shop, requestedLocale);
  if (localeResolution.error) {
    return json({ success: false, error: localeResolution.error }, { status: 400 });
  }

  const planBatchSize = Math.min(MAX_BULK_FIX_ITEMS, getSeoBulkBatchSize(plan));
  const audit = await analyzeStore(session.shop, {
    db,
    seoTitleEffectiveLimit: seoTitleEffectiveLimit(suffix, auditSeoLimits),
    seoLimits: auditSeoLimits,
    plan,
    locale: localeResolution.foreignLocale || undefined,
    // The bucket must be able to HOLD a full batch — its default cap (100) is
    // sized for the dashboard list and would silently truncate Pro's 500 and
    // Max's 2500 to 100.
    maxBucketItems: planBatchSize,
  });

  const bucket: AuditProblemBucket | undefined = audit.problems.find((p) => p.code === problemCode);
  const bucketItems = bucket?.items ?? [];

  // Single-item mode filters the bucket down; verifying against the
  // server-derived bucket is what makes a POSTed GID safe to trust.
  const items = singleItemId
    ? bucketItems.filter((it) => it.id === singleItemId && it.type === singleItemType).slice(0, 1)
    : bucketItems.slice(0, planBatchSize);

  if (items.length === 0) {
    return json(
      {
        success: false,
        error: singleItemId
          ? "This item is no longer affected by this problem — reload the dashboard."
          : "No affected items found — the audit may already be clean. Reload the dashboard.",
      },
      { status: 400 },
    );
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoBulkFix",
      status: "running",
      resourceType: "seo",
      resourceTitle: localeResolution.foreignLocale
        ? `${problemCode}:${localeResolution.foreignLocale}`
        : problemCode,
      fieldType: field,
      // targetLocale (Task column) doubles as the Tasks-tab label so a merchant
      // can tell a foreign-locale fix run apart from a primary one without
      // opening its result blob.
      targetLocale: localeResolution.foreignLocale || null,
      total: items.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as
  // runBulkAltTextGeneration in alt-text.handler.ts. Progress/results are
  // persisted to Task after every item (heartbeat), so a crash only loses the
  // in-flight item and TaskRecoveryService reaps a truly stalled run.
  //
  // altText fans out per image inside the runner and reports its own
  // progress differently — see runAltTextBulkFix.
  const runner =
    field === "altText"
      ? runAltTextBulkFix(task.id, {
          db,
          settings,
          shop: session.shop,
          admin,
          items,
          foreignLocale: localeResolution.foreignLocale,
          writtenLocale: localeResolution.writtenLocale,
          targetLanguageName: localeResolution.targetLanguageName,
        })
      : runSeoBulkFix(task.id, {
          db,
          settings,
          shop: session.shop,
          admin,
          field,
          problemCode,
          items,
          seoTitleMaxChars,
          seoLimits,
          foreignLocale: localeResolution.foreignLocale,
          writtenLocale: localeResolution.writtenLocale,
          targetLanguageName: localeResolution.targetLanguageName,
        });
  void runner.catch(async (err: unknown) => {
    logger.error("[API-AI] SEO bulk-fix crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
    // A crash BEFORE the per-item loop (e.g. loadRows failing) would otherwise
    // leave the task on "running" and the single-flight guard blocking new
    // runs until task-recovery reaps it (review N3). Best-effort mark failed.
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(err).substring(0, 1000) },
      })
      .catch(() => {});
  });

  return json({ success: true, taskId: task.id, total: items.length });
}

// ─── "Fix all issues for one item" mode ────────────────────────────────────

/**
 * Handler for the worst-offenders' per-row bulk KI button. Never trusts the
 * client's list of codes — re-audits and derives applicable codes from the
 * server's own bucket membership, same fail-closed guard the single-item
 * path uses. Runs every applicable AI-fixable code sequentially inside ONE
 * task so the Tasks tab shows one row, not N.
 */
async function handleFixAllForItem(
  ctx: AIActionContext,
  itemId: string,
  itemType: AuditType | "",
  requestedLocale: string,
): Promise<DataResponse> {
  const { session, admin, db, settings, seoTitleMaxChars, seoLimits } = ctx;

  if (!itemId || !itemType) {
    return json(
      { success: false, error: "fixAllForItem requires itemId and itemType." },
      { status: 400 },
    );
  }

  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoBulkFix", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An SEO bulk-fix is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  const aiSettingsRow = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true, seoTitleSuffixEnabled: true, seoTitleSuffix: true, seoLimits: true },
  });
  const plan = (aiSettingsRow?.subscriptionPlan || "free") as Plan;
  const suffix =
    aiSettingsRow?.seoTitleSuffixEnabled && aiSettingsRow.seoTitleSuffix ? aiSettingsRow.seoTitleSuffix : "";
  const auditSeoLimits2 = (aiSettingsRow?.seoLimits ?? null) as Record<string, number> | null;

  const localeResolution = await resolveTargetLocale(admin, session.shop, requestedLocale);
  if (localeResolution.error) {
    return json({ success: false, error: localeResolution.error }, { status: 400 });
  }

  const audit = await analyzeStore(session.shop, {
    db,
    seoTitleEffectiveLimit: seoTitleEffectiveLimit(suffix, auditSeoLimits2),
    seoLimits: auditSeoLimits2,
    plan,
    locale: localeResolution.foreignLocale || undefined,
  });

  // Applicable codes for this item = every AI-fixable bucket that lists it.
  const rawCodes: string[] = [];
  for (const bucket of audit.problems) {
    if (!FIXABLE_CODE_TO_FIELD[bucket.code]) continue;
    if (bucket.items.some((it) => it.id === itemId && it.type === itemType)) {
      rawCodes.push(bucket.code);
    }
  }

  // Order + dedup applicable codes so the run is deterministic and doesn't
  // waste AI calls:
  //  1. Source-field codes (title, description) run BEFORE the derived-SEO
  //     codes so the fresh title becomes the seed for seoTitle regen, and the
  //     fresh description becomes the seed for metaDescription regen.
  //  2. When two codes target the SAME field (e.g. seoTitleTooLong AND
  //     duplicateSeoTitle both regen `seoTitle`), keep the one with the
  //     richer prompt — the duplicate-* variant carries the sibling-avoid
  //     hint, and length codes only carry char limits. Otherwise the second
  //     regen overwrites the first, spending one AI call for nothing.
  const CODE_PRIORITY: Record<string, number> = {
    titleLength: 10,
    descriptionTooShort: 11,
    imagesMissingAlt: 20,
    seoTitleMissing: 100,
    seoTitleTooLong: 101,
    duplicateSeoTitle: 102, // wins tiebreak vs. length/missing on the same field
    metaDescriptionMissing: 200,
    metaDescriptionLength: 201,
    duplicateSeoDescription: 202,
  };
  const bestByField = new Map<FixableField, string>();
  for (const code of rawCodes) {
    const field = FIXABLE_CODE_TO_FIELD[code];
    if (!field) continue;
    const existing = bestByField.get(field);
    if (!existing || (CODE_PRIORITY[code] ?? 0) > (CODE_PRIORITY[existing] ?? 0)) {
      bestByField.set(field, code);
    }
  }
  const applicableCodes = [...bestByField.values()].sort(
    (a, b) => (CODE_PRIORITY[a] ?? 999) - (CODE_PRIORITY[b] ?? 999),
  );

  if (applicableCodes.length === 0) {
    return json(
      {
        success: false,
        error: "This item has no AI-fixable issues remaining — reload the dashboard.",
      },
      { status: 400 },
    );
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoBulkFix",
      status: "running",
      resourceType: "seo",
      resourceTitle: `fixAllForItem:${itemType}:${itemId.split("/").pop()}${
        localeResolution.foreignLocale ? `:${localeResolution.foreignLocale}` : ""
      }`,
      fieldType: "multi",
      targetLocale: localeResolution.foreignLocale || null,
      total: applicableCodes.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  void runFixAllForItem(task.id, {
    db,
    settings,
    shop: session.shop,
    admin,
    itemId,
    itemType: itemType as AuditType,
    codes: applicableCodes,
    seoTitleMaxChars,
    seoLimits,
    foreignLocale: localeResolution.foreignLocale,
    writtenLocale: localeResolution.writtenLocale,
    targetLanguageName: localeResolution.targetLanguageName,
  }).catch(async (err: unknown) => {
    logger.error("[API-AI] SEO fixAllForItem crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(err).substring(0, 1000) },
      })
      .catch(() => {});
  });

  return json({ success: true, taskId: task.id, total: applicableCodes.length });
}

// ─── Runner ────────────────────────────────────────────────────────────────

/** Fields runSeoBulkFix knows how to prompt + persist. altText has its own
 * runner (runAltTextBulkFix) because it's per-image, not per-item. */
type TextField = Exclude<FixableField, "altText">;

/** ContentTranslation key per fixable text field. Primary-locale writes use
 * the corresponding column (title / descriptionHtml / seoTitle /
 * seoDescription); foreign-locale writes go through this key via
 * translationsRegister and a ContentTranslation upsert. Body naming follows
 * ShopifyContentService's inconsistency note: for Product/Collection/Page/
 * Article the translation key is "body_html". */
const FIELD_TO_TRANSLATION_KEY: Record<TextField, string> = {
  title: "title",
  description: "body_html",
  seoTitle: "meta_title",
  metaDescription: "meta_description",
};

/** AuditType -> ContentTranslation.resourceType. Same map audit.service.ts
 * carries privately (kept as a local copy so bulk-fix stays self-contained). */
const AUDIT_TYPE_TO_RESOURCE_TYPE: Record<AuditType, string> = {
  product: "Product",
  collection: "Collection",
  article: "Article",
  page: "Page",
};

interface RunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  admin: AdminApiContext;
  field: TextField;
  /** Original bucket code — used to detect the duplicate-SEO buckets, where
   * every item must receive its siblings' current values as an "avoid these
   * values" hint so the regen doesn't just produce another duplicate. */
  problemCode: string;
  items: { type: AuditType; id: string }[];
  seoTitleMaxChars: number;
  /** Fully-resolved merchant SEO limits (defaults filled in). Threaded so
   * every generated prompt uses the same numbers the merchant sees in the UI. */
  seoLimits: SeoLimits;
  /** "" or empty = primary-locale run. Non-empty = foreign locale code
   * (validated in the outer handler) — every persist call goes through
   * translationsRegister + ContentTranslation instead of the direct content
   * mutations, and the prompt asks the AI to translate the primary value into
   * this locale while adapting to the SEO constraint. */
  foreignLocale: string;
  /** The language the generated text will actually be IN — the foreign locale
   *  when translating, the shop's primary one otherwise. `foreignLocale: ""`
   *  cannot answer that: "" means primary, not "no language". §2.5e's glossary
   *  directive needs the real code. */
  writtenLocale: string;
  /** Human-readable target language name, e.g. "Spanish" — passed through to
   * the prompt. Falls back to the locale code if the name lookup returned
   * nothing. */
  targetLanguageName: string;
}

/** Uniform row shape regardless of which content-cache table it came from. */
interface FixableRow {
  id: string;
  title: string;
  description: string;
  seoTitle: string;
  metaDescription: string;
}

async function runSeoBulkFix(taskId: string, args: RunArgs): Promise<void> {
  const {
    db,
    settings,
    shop,
    admin,
    field,
    problemCode,
    items,
    seoTitleMaxChars,
    seoLimits,
    foreignLocale,
    writtenLocale,
    targetLanguageName,
  } = args;
  const isDuplicateBucket =
    problemCode === "duplicateSeoTitle" || problemCode === "duplicateSeoDescription";
  const isForeign = foreignLocale.length > 0;

  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any);
  const aiService = createAIService(settings, shop, taskId);

  // One shared AI-instructions row + primary-locale name for the whole run —
  // these are per-shop, not per-item, so fetching them once avoids N redundant
  // DB/Shopify round-trips.
  const aiInstructions = (await db.aIInstructions.findUnique({ where: { shop } })) as Record<
    string,
    string | null
  > | null;
  let mainLanguage = "English";
  try {
    const { shopLocales } = await contentService.loadShopLocales();
    const primary = shopLocales.find((l: { primary: boolean; name?: string }) => l.primary);
    if (primary?.name) mainLanguage = primary.name;
  } catch (err: unknown) {
    // Non-fatal — fall back to the default and keep going.
    logger.warn("[API-AI] SEO bulk-fix: failed to load shop locales, defaulting language", {
      context: "AI",
      taskId,
      error: errorMessage(err),
    });
  }
  // The "output language" the AI writes in is the TARGET locale for foreign
  // runs (translation + adaptation) and the PRIMARY locale otherwise.
  const outputLanguage = isForeign ? targetLanguageName : mainLanguage;

  // Batch-load the current field values per content type (no N+1 — one
  // findMany per type, mirroring audit.service.ts's own query shape).
  const byType = new Map<AuditType, string[]>();
  for (const item of items) {
    const ids = byType.get(item.type) ?? [];
    ids.push(item.id);
    byType.set(item.type, ids);
  }
  const rows = new Map<string, FixableRow>();
  for (const [type, ids] of byType.entries()) {
    const loaded = await loadRows(db, shop, type, ids);
    for (const [id, row] of loaded.entries()) rows.set(id, row);
  }

  // Foreign-locale seed values: the CURRENT ContentTranslation row per
  // (item, key) for the four keys we might rewrite. Batch-fetched in one
  // findMany. Missing translations = "". Consumed by the prompt (to know
  // whether to "extend" an existing short translation or produce from
  // scratch) and by the duplicate-sibling hint below.
  const foreignRows = isForeign
    ? await loadForeignTranslations(db, shop, foreignLocale, items)
    : new Map<string, FixableRow>();

  // Foreign-locale digest cache: one aliased-batch call up front replaces N
  // per-item `translatableResource` queries in `persistFieldForLocale`. On a
  // 100-item bucket that's 2 GraphQL requests instead of 100. Missing entries
  // (resource has no such translatable key) fall back to per-item lookup
  // inside persistFieldForLocale, so a partial batch is still correct.
  const digestByResource = isForeign
    ? await loadTranslatableDigests(
        gateway,
        items.map((it) => it.id),
        FIELD_TO_TRANSLATION_KEY[field],
      )
    : new Map<string, string>();

  // Duplicate-bucket siblings: for each item, the OTHER items sharing the same
  // (normalized) current value. That value is passed to the prompt as an
  // "avoid these" hint so the AI produces something distinct instead of
  // regenerating another duplicate. Cheap map lookup, computed once.
  //
  // For foreign locale runs, "current value" means the FOREIGN translation
  // (that's the value the storefront serves for this locale, and it's what
  // Google would see as duplicated). The audit already found these items as
  // duplicates against their foreign values, so we mirror that source here.
  const siblingHintById = new Map<string, string[]>();
  if (isDuplicateBucket) {
    // Normalization contract MUST match audit.service.ts's
    // normalizeForDuplicateCheck (trim + lowercase, seoTitle falls back to
    // title, no fallback for metaDescription).
    const readField = (row: FixableRow): string =>
      problemCode === "duplicateSeoTitle"
        ? (row.seoTitle || row.title || "").trim()
        : (row.metaDescription || "").trim();
    // Foreign locale: read from foreignRows; primary: from rows. Same shape,
    // same normalization.
    const rowSource = isForeign ? foreignRows : rows;
    const groups = new Map<string, string[]>();
    for (const it of items) {
      const row = rowSource.get(it.id);
      if (!row) continue;
      const key = readField(row).toLowerCase();
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(it.id);
      groups.set(key, group);
    }
    for (const [, group] of groups.entries()) {
      if (group.length < 2) continue;
      for (const id of group) {
        const siblings = group
          .filter((sid) => sid !== id)
          .map((sid) => {
            const r = rowSource.get(sid);
            return r ? readField(r) : "";
          })
          .filter((v) => v.length > 0);
        if (siblings.length > 0) siblingHintById.set(id, siblings);
      }
    }
  }

  const succeeded: { type: AuditType; id: string }[] = [];
  const failed: { type: AuditType; id: string; error: string }[] = [];
  const total = items.length;
  let authErrorSeen = false;

  for (let i = 0; i < items.length; i++) {
    const { type, id } = items[i];

    if (!authErrorSeen) {
      const row = rows.get(id);
      if (!row) {
        failed.push({ type, id, error: "Item no longer exists in the content cache" });
      } else {
        try {
          const contentType = AUDIT_TYPE_TO_CONTENT_TYPE[type];
          const fieldDef = CONTENT_CONFIGS[contentType]?.fieldDefinitions.find((f) => f.key === field);
          const aiInstructionsKey = fieldDef?.aiInstructionsKey || field;
          const fieldLabel = fieldDef?.label || field;

          const foreignRow = isForeign ? foreignRows.get(id) : undefined;
          const prompt = buildFixPrompt(field, {
            fieldLabel,
            aiInstructionsKey,
            title: row.title,
            description: row.description,
            seoTitleMaxChars,
            seoLimits,
            mainLanguage,
            outputLanguage,
            aiInstructions,
            avoidValues: siblingHintById.get(id),
            // Foreign-locale mode: the AI's job is "translate the primary
            // value into <outputLanguage>, adapting only as needed to satisfy
            // the SEO constraint" — the primary value is the SOURCE, not the
            // thing being replaced. `currentTranslation` (if any) tells the
            // prompt whether to extend a too-short translation or produce
            // from a blank slate.
            translationSource: foreignRow
              ? {
                  primaryTitle: row.title,
                  primaryDescription: row.description,
                  primarySeoTitle: row.seoTitle,
                  primaryMetaDescription: row.metaDescription,
                  currentTranslation:
                    field === "title"
                      ? foreignRow.title
                      : field === "description"
                        ? foreignRow.description
                        : field === "seoTitle"
                          ? foreignRow.seoTitle
                          : foreignRow.metaDescription,
                }
              : undefined,
          });

          // description is long-form HTML; every other TextField is short
          // plain text. generateProductDescription is the shared long-form
          // path, generateProductTitle the shared short-text one — matches
          // how text-generation.handler.ts routes single-item generation.
          const generated = (
            field === "description"
              ? await aiService.generateProductDescription(row.title, prompt, undefined, {
                  contextTexts: [row.title],
                  locale: writtenLocale,
                })
              : await aiService.generateProductTitle(prompt, undefined, {
                  contextTexts: [row.title],
                  locale: writtenLocale,
                })
          ).trim();

          // Guard against a silent clobber: a provider glitch that returns
          // an empty string would otherwise overwrite the storefront body
          // (or title / seo field) with "" and the "fix" would strictly
          // regress the item's SEO score. Skip and mark failed instead;
          // the merchant can retry from the dashboard.
          if (generated.length === 0) {
            throw new Error("AI returned an empty value — nothing was saved.");
          }

          if (isForeign) {
            await persistFieldForLocale({
              db,
              shop,
              type,
              id,
              field,
              value: generated,
              locale: foreignLocale,
              gateway,
              digest: digestByResource.get(id),
            });
          } else {
            await persistField({
              db,
              shop,
              type,
              id,
              field,
              value: generated,
              contentService,
              gateway,
            });
          }

          succeeded.push({ type, id });
        } catch (err: unknown) {
          const message = errorMessage(err);
          failed.push({ type, id, error: message });
          logger.error("[API-AI] SEO bulk-fix: item failed", {
            context: "AI",
            taskId,
            type,
            id,
            error: message,
          });
          // An invalid/expired provider key fails every remaining item
          // identically — stop burning AI-queue attempts and mark the rest
          // failed immediately instead of retrying item-by-item.
          if (isAuthError(err)) authErrorSeen = true;
        }
      }
    } else {
      failed.push({ type, id, error: "Skipped after provider API key was rejected" });
    }

    // Persist after every item so a crash only loses the current one — same
    // heartbeat contract as runBulkAltTextGeneration.
    const progressPercent = Math.round(((i + 1) / total) * 100);
    await db.task
      .update({
        where: { id: taskId },
        data: {
          progress: progressPercent,
          processed: i + 1,
          result: JSON.stringify({ succeeded, failed }),
        },
      })
      .catch((err: unknown) => {
        logger.error("[API-AI] SEO bulk-fix: failed to persist progress", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      });
  }

  const finalStatus = succeeded.length === 0 ? "failed" : "completed";
  // A machine code, translated at render time by `taskErrorText` (app/utils).
  // The rejected-key note is a FLAG argument, so it is translated with the
  // sentence instead of being English glued onto a German one.
  const failureSummary =
    failed.length > 0 ? `items_failed:${failed.length}:${total}${authErrorSeen ? ":1" : ""}` : null;

  await db.task.update({
    where: { id: taskId },
    data: {
      status: finalStatus,
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify({ succeeded, failed }),
      error: failureSummary ? failureSummary.substring(0, 1000) : null,
    },
  });
}

// ─── Alt-text runner ──────────────────────────────────────────────────────
//
// imagesMissingAlt is per-image, not per-item: one product can contribute
// several missing-alt images. We still use `items` (the affected content rows)
// as the outer loop, then fan out to each item's images that lack alt text
// inside. Uses the same AI-alt-text pipeline as the product-editor bulk
// action (aiService.generateImageAltText), but persistence is the caller's
// own responsibility (productUpdateMedia for gallery images, updateCollection
// / updateArticle for their single featured image).

/**
 * Whether a collection's / article's featured image still needs an alt text
 * for the targeted locale — the enumeration rule for both alt-text runners.
 *
 * A foreign run asks about the TRANSLATION (`ContentTranslation`, key
 * `image_alt_text` on the parent — the same rows the audit scores), never
 * about the primary alt: an image whose primary alt is filled but untranslated
 * is exactly the case a foreign run exists for, and one whose primary alt is
 * empty still needs its own translation. Both runners share this so a job can
 * never be enumerated by one rule and written by another.
 */
async function featuredImageAltIsMissing(
  db: PrismaClient,
  shop: string,
  resourceType: "Collection" | "Article",
  resourceId: string,
  primaryAltText: string | null,
  foreignLocale: string,
): Promise<boolean> {
  if (foreignLocale.length === 0) {
    return !primaryAltText || primaryAltText.trim() === "";
  }
  const row = await db.contentTranslation.findUnique({
    where: {
      shop_resourceId_key_locale_marketId: {
        shop,
        resourceId,
        key: "image_alt_text",
        locale: foreignLocale,
        marketId: "",
      },
    },
    select: { value: true, resourceType: true },
  });
  // resourceType is not part of the unique key (resourceId is a globally
  // unique Shopify GID), so a row can only belong to this resource — but
  // assert it anyway rather than silently trusting a mismatched row.
  if (row && row.resourceType !== resourceType) return true;
  return !row || row.value.trim() === "";
}

interface AltTextRunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  admin: AdminApiContext;
  items: { type: AuditType; id: string }[];
  /** See RunArgs.foreignLocale. */
  foreignLocale: string;
  /** The language the generated text will actually be IN — the foreign locale
   *  when translating, the shop's primary one otherwise. `foreignLocale: ""`
   *  cannot answer that: "" means primary, not "no language". §2.5e's glossary
   *  directive needs the real code. */
  writtenLocale: string;
  targetLanguageName: string;
}

async function runAltTextBulkFix(taskId: string, args: AltTextRunArgs): Promise<void> {
  const { db, settings, shop, admin, items, foreignLocale, writtenLocale, targetLanguageName } = args;
  const isForeign = foreignLocale.length > 0;

  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any);
  const aiService = createAIService(settings, shop, taskId);

  const aiInstructions = (await db.aIInstructions.findUnique({ where: { shop } })) as Record<
    string,
    string | null
  > | null;
  let mainLanguage = "English";
  try {
    const { shopLocales } = await contentService.loadShopLocales();
    const primary = shopLocales.find((l: { primary: boolean; name?: string }) => l.primary);
    if (primary?.name) mainLanguage = primary.name;
  } catch (err: unknown) {
    logger.warn("[API-AI] SEO alt-text bulk-fix: failed to load shop locales, defaulting", {
      context: "AI",
      taskId,
      error: errorMessage(err),
    });
  }
  const outputLanguage = isForeign ? targetLanguageName : mainLanguage;

  const succeeded: { type: AuditType; id: string }[] = [];
  const failed: { type: AuditType; id: string; error: string }[] = [];
  let authErrorSeen = false;

  // First pass: enumerate every missing-alt image across every affected
  // content row so total/progress reflect IMAGES, not items — the same
  // reason handleGenerateAllAltTexts uses a per-image heartbeat.
  interface AltJob {
    type: AuditType;
    id: string;
    productTitle: string;
    imageUrl: string;
    mediaId?: string | null;
    productImageId?: string; // for db.productImage.update
    isFeatured?: boolean; // product featured-image fallback
  }
  const jobs: AltJob[] = [];

  for (const it of items) {
    if (it.type === "product") {
      const product = await db.product.findUnique({
        where: { shop_id: { shop, id: it.id } },
        select: {
          id: true,
          title: true,
          featuredImageUrl: true,
          featuredImageAlt: true,
          images: {
            select: {
              id: true,
              url: true,
              altText: true,
              mediaId: true,
              position: true,
              // Foreign runs: enumerate the current translation so
              // "translated in this locale" filters missing images correctly.
              altTextTranslations: isForeign
                ? {
                    where: { locale: foreignLocale, marketId: "" },
                    select: { altText: true },
                  }
                : false,
            },
            orderBy: { position: "asc" },
          },
        },
      });
      if (!product) continue;
      const missing = isForeign
        ? product.images.filter((img) => {
            const t = (img as { altTextTranslations?: { altText: string }[] }).altTextTranslations ?? [];
            return t.length === 0 || !t[0]?.altText?.trim();
          })
        : product.images.filter((img) => !img.altText || img.altText.trim() === "");
      if (missing.length > 0) {
        for (const img of missing) {
          jobs.push({
            type: "product",
            id: it.id,
            productTitle: product.title,
            imageUrl: img.url,
            mediaId: img.mediaId,
            productImageId: img.id,
          });
        }
      } else if (
        product.images.length === 0 &&
        product.featuredImageUrl &&
        // Foreign locale: skip the featured-image-only fallback — a PRODUCT
        // with no cached ProductImage row has no per-locale alt store (unlike
        // a collection/article featured image, which has one), so we'd have to
        // clobber the primary alt as a side effect. The audit scores this row
        // off the primary alt for the same reason, so nothing is orphaned.
        !isForeign &&
        (!product.featuredImageAlt || product.featuredImageAlt.trim() === "")
      ) {
        // Featured-image fallback (audit uses the same rule). No mediaId
        // available for a bare featuredImageUrl — persistImageAltText will
        // resolve it via the Product.media query at write time.
        jobs.push({
          type: "product",
          id: it.id,
          productTitle: product.title,
          imageUrl: product.featuredImageUrl,
          isFeatured: true,
        });
      }
    } else if (it.type === "collection") {
      const c = await db.collection.findUnique({
        where: { shop_id: { shop, id: it.id } },
        select: { id: true, title: true, imageUrl: true, imageAltText: true },
      });
      if (
        c?.imageUrl &&
        (await featuredImageAltIsMissing(db, shop, "Collection", it.id, c.imageAltText, foreignLocale))
      ) {
        jobs.push({ type: "collection", id: it.id, productTitle: c.title, imageUrl: c.imageUrl });
      }
    } else if (it.type === "article") {
      const a = await db.article.findUnique({
        where: { shop_id: { shop, id: it.id } },
        select: { id: true, title: true, imageUrl: true, imageAltText: true },
      });
      if (
        a?.imageUrl &&
        (await featuredImageAltIsMissing(db, shop, "Article", it.id, a.imageAltText, foreignLocale))
      ) {
        jobs.push({ type: "article", id: it.id, productTitle: a.title, imageUrl: a.imageUrl });
      }
    }
    // page has no images (audit passes totalImages: 0)
  }

  const total = jobs.length;
  if (total === 0) {
    await db.task.update({
      where: { id: taskId },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ succeeded, failed }),
      },
    });
    return;
  }

  // Update the task's total now that we know the true image count
  // (differs from `items.length` used at task create time).
  await db.task
    .update({ where: { id: taskId }, data: { total } })
    .catch(() => {});

  // Foreign-locale digest cache for MediaImage GIDs — same aliased-batch
  // trick as runSeoBulkFix. Featured-image-only PRODUCTS are skipped upstream
  // in the foreign branch, so every product job's `mediaId` is populated. A
  // collection/article job carries none: its CollectionImage/ArticleImage GID
  // is cached nowhere and is resolved per job at write time. On a product with
  // 5 gallery images × 100 items = 500 lookups → 10 requests instead of 500.
  const altDigestByMedia = isForeign
    ? await loadTranslatableDigests(
        gateway,
        jobs.map((j) => j.mediaId ?? "").filter((m) => m.length > 0),
        "alt",
      )
    : new Map<string, string>();

  // Dedupe succeeded items so the per-image loop below doesn't push the same
  // content row multiple times when it has several images.
  const succeededSeen = new Set<string>();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    if (!authErrorSeen) {
      try {
        const sanitizedTitle = sanitizePromptInput(job.productTitle || "", { fieldType: "title" });
        let prompt = `Create an optimized alt text for a product image.\nProduct: ${sanitizedTitle}\nImage URL: ${job.imageUrl}`;
        if (aiInstructions?.productAltTextFormat) {
          prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
        }
        if (aiInstructions?.productAltTextInstructions) {
          prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
        }
        prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${outputLanguage}.`;

        const altText = (
          // §2.5e — the merchant's forced terms apply to the original alt
          // text as much as to its translations.
          await aiService.generateImageAltText(job.imageUrl, sanitizedTitle, prompt, false, {
            contextTexts: [sanitizedTitle],
            locale: writtenLocale,
          })
        ).trim();
        // Same guard the single-item runner has: an empty generation must not
        // be written. On the primary path it would CLEAR the alt text; on the
        // foreign path it would store an empty translation row, which reads
        // back as "still missing" — a fix that silently fixed nothing.
        if (altText.length === 0) throw new Error("AI returned an empty alt text");

        if (isForeign) {
          await persistImageAltTextForLocale({
            db,
            shop,
            job,
            altText,
            locale: foreignLocale,
            gateway,
            digest: job.mediaId ? altDigestByMedia.get(job.mediaId) : undefined,
          });
        } else {
          await persistImageAltText({
            db,
            shop,
            job,
            altText,
            contentService,
            gateway,
          });
        }

        const key = `${job.type}:${job.id}`;
        if (!succeededSeen.has(key)) {
          succeeded.push({ type: job.type, id: job.id });
          succeededSeen.add(key);
        }
      } catch (err: unknown) {
        const message = errorMessage(err);
        failed.push({ type: job.type, id: job.id, error: message });
        logger.error("[API-AI] SEO alt-text bulk-fix: image failed", {
          context: "AI",
          taskId,
          type: job.type,
          id: job.id,
          error: message,
        });
        if (isAuthError(err)) authErrorSeen = true;
      }
    } else {
      failed.push({
        type: job.type,
        id: job.id,
        error: "Skipped after provider API key was rejected",
      });
    }

    const progressPercent = Math.round(((i + 1) / total) * 100);
    await db.task
      .update({
        where: { id: taskId },
        data: {
          progress: progressPercent,
          processed: i + 1,
          result: JSON.stringify({ succeeded, failed }),
        },
      })
      .catch((err: unknown) => {
        logger.error("[API-AI] SEO alt-text bulk-fix: progress persist failed", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      });
  }

  const finalStatus = succeeded.length === 0 ? "failed" : "completed";
  const failureSummary =
    failed.length > 0
      ? `images_failed:${failed.length}:${total}${authErrorSeen ? ":1" : ""}`
      : null;

  await db.task.update({
    where: { id: taskId },
    data: {
      status: finalStatus,
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify({ succeeded, failed }),
      error: failureSummary ? failureSummary.substring(0, 1000) : null,
    },
  });
}

interface PersistImageAltTextArgs {
  db: PrismaClient;
  shop: string;
  job: {
    type: AuditType;
    id: string;
    imageUrl: string;
    mediaId?: string | null;
    productImageId?: string;
    isFeatured?: boolean;
  };
  altText: string;
  contentService: ShopifyContentService;
  gateway: ShopifyApiGateway;
}

async function persistImageAltText(params: PersistImageAltTextArgs): Promise<void> {
  const { db, shop, job, altText, contentService, gateway } = params;

  if (job.type === "product") {
    // Resolve mediaId if we don't have one cached (bare featuredImageUrl case).
    let mediaId = job.mediaId;
    if (!mediaId) {
      const productResponse = await gateway.graphql(
        `#graphql
          query seoAltFixProductMedia($id: ID!) {
            product(id: $id) {
              media(first: 1) { edges { node { ... on MediaImage { id } } } }
            }
          }`,
        { variables: { id: job.id } },
      );
      const productData = (await productResponse.json()) as {
        data?: { product?: { media?: { edges?: { node?: { id?: string } }[] } } };
      };
      mediaId = productData.data?.product?.media?.edges?.[0]?.node?.id ?? null;
    }
    if (!mediaId) throw new Error("No Shopify MediaImage found for this product image");

    const response = await gateway.graphql(
      `#graphql
        mutation seoAltFixProductUpdateMedia($media: [UpdateMediaInput!]!, $productId: ID!) {
          productUpdateMedia(media: $media, productId: $productId) {
            media { alt }
            mediaUserErrors { field message }
          }
        }`,
      { variables: { productId: job.id, media: [{ id: mediaId, alt: altText }] } },
    );
    const data = (await response.json()) as {
      data?: {
        productUpdateMedia?: {
          media?: { alt: string }[];
          mediaUserErrors?: { field?: string[]; message: string }[];
        };
      };
    };
    const mediaUserErrors = data.data?.productUpdateMedia?.mediaUserErrors ?? [];
    if (mediaUserErrors.length > 0) throw new Error(mediaUserErrors[0].message);

    if (job.productImageId) {
      await db.productImage.update({
        where: { id: job.productImageId },
        data: { altText, altTextModifiedAt: new Date() },
      });
    } else if (job.isFeatured) {
      await db.product.update({
        where: { shop_id: { shop, id: job.id } },
        data: { featuredImageAlt: altText, lastSyncedAt: new Date() },
      });
    }
    return;
  }

  if (job.type === "collection") {
    await contentService.updateCollection(job.id, { image: { altText } });
    await db.collection.update({
      where: { shop_id: { shop, id: job.id } },
      data: { imageAltText: altText, lastSyncedAt: new Date() },
    });
    return;
  }

  if (job.type === "article") {
    await contentService.updateArticle(job.id, { image: { altText } });
    await db.article.update({
      where: { shop_id: { shop, id: job.id } },
      data: { imageAltText: altText, lastSyncedAt: new Date() },
    });
    return;
  }
}

async function loadRows(
  db: PrismaClient,
  shop: string,
  type: AuditType,
  ids: string[],
): Promise<Map<string, FixableRow>> {
  const map = new Map<string, FixableRow>();
  if (ids.length === 0) return map;

  switch (type) {
    case "product": {
      const products = await db.product.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, descriptionHtml: true, seoTitle: true, seoDescription: true },
      });
      for (const p of products) {
        map.set(p.id, {
          id: p.id,
          title: p.title,
          description: p.descriptionHtml ?? "",
          seoTitle: p.seoTitle ?? "",
          metaDescription: p.seoDescription ?? "",
        });
      }
      break;
    }
    case "collection": {
      const collections = await db.collection.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, descriptionHtml: true, seoTitle: true, seoDescription: true },
      });
      for (const c of collections) {
        map.set(c.id, {
          id: c.id,
          title: c.title,
          description: c.descriptionHtml ?? "",
          seoTitle: c.seoTitle ?? "",
          metaDescription: c.seoDescription ?? "",
        });
      }
      break;
    }
    case "article": {
      const articles = await db.article.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, body: true, seoTitle: true, seoDescription: true },
      });
      for (const a of articles) {
        map.set(a.id, {
          id: a.id,
          title: a.title,
          description: a.body ?? "",
          seoTitle: a.seoTitle ?? "",
          metaDescription: a.seoDescription ?? "",
        });
      }
      break;
    }
    case "page": {
      const pages = await db.page.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, body: true, seoTitle: true, seoDescription: true },
      });
      for (const pg of pages) {
        map.set(pg.id, {
          id: pg.id,
          title: pg.title,
          description: pg.body ?? "",
          seoTitle: pg.seoTitle ?? "",
          metaDescription: pg.seoDescription ?? "",
        });
      }
      break;
    }
  }
  return map;
}

interface PromptContext {
  fieldLabel: string;
  aiInstructionsKey: string;
  title: string;
  description: string;
  seoTitleMaxChars: number;
  seoLimits: SeoLimits;
  mainLanguage: string;
  /** Language the AI writes the output in. For primary runs this equals
   * mainLanguage; for foreign-locale runs it's the target language name so
   * the AI returns the value in the merchant-selected locale. */
  outputLanguage: string;
  aiInstructions: Record<string, string | null> | null;
  /** Sibling values to steer the AI away from — populated for the duplicate
   * SEO buckets so a regen doesn't just produce another duplicate. */
  avoidValues?: string[];
  /** Foreign-locale runs only. When present, the prompt frames the task as
   * "translate the primary value into outputLanguage, adapting only as needed
   * to satisfy the SEO constraint" rather than "create a new value from
   * scratch". The current translation (may be empty) hints whether we're
   * filling in a missing translation or shortening an oversized one. */
  translationSource?: {
    primaryTitle: string;
    primaryDescription: string;
    primarySeoTitle: string;
    primaryMetaDescription: string;
    currentTranslation: string;
  };
}

/** Mirrors handleGenerateAIText's prompt shape (text-generation.handler.ts) so
 * bulk-generated SEO titles/meta descriptions read the same as ones a
 * merchant generated one-by-one in the editor. */
function buildFixPrompt(field: TextField, ctx: PromptContext): string {
  const sanitizedTitle = sanitizePromptInput(ctx.title, { fieldType: "title" });
  const sanitizedDescription = sanitizePromptInput(ctx.description, {
    fieldType: "description",
    allowNewlines: true,
  });

  // Foreign-locale branch: frame the task as a translation of the PRIMARY
  // value adapted to the SEO constraint, not a from-scratch rewrite. This
  // keeps foreign-locale SEO consistent with the source but still bends the
  // wording as needed to hit the length/uniqueness rules — an exact
  // translation may not satisfy meta_title <= 60 chars, for instance.
  if (ctx.translationSource) {
    const src = ctx.translationSource;
    const pickPrimary =
      field === "title"
        ? src.primaryTitle
        : field === "description"
          ? src.primaryDescription
          : field === "seoTitle"
            ? src.primarySeoTitle || src.primaryTitle
            : src.primaryMetaDescription;
    const sanitizedPrimary = sanitizePromptInput(pickPrimary, {
      fieldType: field === "description" ? "description" : "title",
      allowNewlines: field === "description",
    });
    const sanitizedCurrent = sanitizePromptInput(src.currentTranslation, {
      fieldType: field === "description" ? "description" : "title",
      allowNewlines: field === "description",
    });

    let prompt = `Translate the ${ctx.fieldLabel} of the following content into ${ctx.outputLanguage}.`;
    prompt += `\nAdapt the translation only as much as necessary to satisfy the SEO requirements below — a literal translation is preferred when it already fits.`;
    prompt += `\n\nPrimary-language ${ctx.fieldLabel} (source): ${sanitizedPrimary || "(empty — extrapolate from other context below)"}`;
    // Provide the SIBLING primary fields for grounding — the AI shouldn't
    // hallucinate details that don't exist in the source content.
    if (field !== "title" && sanitizedTitle) {
      prompt += `\nPrimary-language Title: ${sanitizedTitle}`;
    }
    if (field !== "description" && sanitizedDescription) {
      prompt += `\nPrimary-language Description: ${sanitizedDescription}`;
    }
    if (sanitizedCurrent) {
      prompt += `\nCurrent translation in ${ctx.outputLanguage} (needs improvement — extend/shorten as needed, don't just repeat): ${sanitizedCurrent}`;
    }
    prompt += `\nOutput language: ${ctx.outputLanguage}`;

    if (ctx.avoidValues && ctx.avoidValues.length > 0) {
      const sanitizedAvoid = ctx.avoidValues
        .map((v) => sanitizePromptInput(v, { fieldType: field === "metaDescription" ? "metaDescription" : "seoTitle" }))
        .filter((v) => v.length > 0);
      if (sanitizedAvoid.length > 0) {
        prompt += `\n\nAvoid values (already used by other items in ${ctx.outputLanguage} — produce something clearly distinct):`;
        for (const v of sanitizedAvoid) prompt += `\n- ${v}`;
      }
    }

    prompt += `\n\nRequirements:`;
    const charLimit = getCharacterLimitRequirement(ctx.aiInstructionsKey, { seoTitleMaxChars: ctx.seoTitleMaxChars, limits: ctx.seoLimits });
    if (charLimit) prompt += `\n- Length: ${charLimit}`;
    prompt += `\n- Preserve the meaning of the primary text; adapt wording only if the literal translation violates a hard requirement`;
    prompt += `\n- SEO-friendly wording where applicable`;
    prompt += `\n- Customer-focused language`;

    const writingStyle = getWritingStyleInstructions(ctx.aiInstructions);
    if (writingStyle) prompt += `\n\nWriting Style:\n${writingStyle}`;

    const formatExample = getInstructionWithDefault(ctx.aiInstructions, `${ctx.aiInstructionsKey}Format`);
    if (formatExample) prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;

    const fieldInstructions = getInstructionWithDefault(ctx.aiInstructions, `${ctx.aiInstructionsKey}Instructions`);
    if (fieldInstructions) prompt += `\n\nGuidelines:\n${fieldInstructions}`;

    if (charLimit) {
      prompt += `\n\nCRITICAL LENGTH CONSTRAINT: The output MUST be ${charLimit}. This overrides any other length or character count instruction in this prompt.`;
    }

    prompt += `\n\nIMPORTANT: Return ONLY the ${ctx.fieldLabel} in ${ctx.outputLanguage}, nothing else.`;
    return prompt;
  }

  let prompt = `Create an improved ${ctx.fieldLabel} for the following content.`;
  if (field === "title") {
    // Title rewrite: the CURRENT title is what we're replacing, so lead with
    // the description as the primary signal — quoting the old title first
    // would anchor the model to it.
    if (sanitizedDescription) prompt += `\n\nContext - Description: ${sanitizedDescription}`;
    prompt += `\nContext - Current Title (to be rewritten): ${sanitizedTitle}`;
  } else if (field === "description") {
    // Description rewrite: pass the old description as a "carry the tone /
    // key points, but expand it" seed, not as the thing being replaced —
    // otherwise a too-short description gets padded with filler.
    prompt += `\n\nContext - Title: ${sanitizedTitle}`;
    if (sanitizedDescription) {
      prompt += `\nContext - Current Description (too short — extend, don't just repeat): ${sanitizedDescription}`;
    }
  } else {
    prompt += `\n\nContext - Title: ${sanitizedTitle}`;
    if (field === "metaDescription" && sanitizedDescription) {
      prompt += `\nContext - Description: ${sanitizedDescription}`;
    }
  }
  prompt += `\nLanguage: ${ctx.mainLanguage}`;

  // Duplicate-SEO buckets: explicit "avoid these values" hint. Placed BEFORE
  // Requirements so the model treats it as a hard constraint, not a stylistic
  // one. Sanitize each sibling value to prevent prompt-control tokens.
  if (ctx.avoidValues && ctx.avoidValues.length > 0) {
    const sanitizedAvoid = ctx.avoidValues
      .map((v) => sanitizePromptInput(v, { fieldType: field === "metaDescription" ? "metaDescription" : "seoTitle" }))
      .filter((v) => v.length > 0);
    if (sanitizedAvoid.length > 0) {
      prompt += `\n\nAvoid values (already used by other items — produce something clearly distinct):`;
      for (const v of sanitizedAvoid) prompt += `\n- ${v}`;
    }
  }

  prompt += `\n\nRequirements:`;
  const charLimit = getCharacterLimitRequirement(ctx.aiInstructionsKey, { seoTitleMaxChars: ctx.seoTitleMaxChars, limits: ctx.seoLimits });
  if (charLimit) prompt += `\n- Length: ${charLimit}`;
  prompt += `\n- Clear and concise`;
  prompt += `\n- SEO-friendly where applicable`;
  prompt += `\n- Customer-focused language`;

  const writingStyle = getWritingStyleInstructions(ctx.aiInstructions);
  if (writingStyle) prompt += `\n\nWriting Style:\n${writingStyle}`;

  const formatExample = getInstructionWithDefault(ctx.aiInstructions, `${ctx.aiInstructionsKey}Format`);
  if (formatExample) prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;

  const fieldInstructions = getInstructionWithDefault(ctx.aiInstructions, `${ctx.aiInstructionsKey}Instructions`);
  if (fieldInstructions) prompt += `\n\nGuidelines:\n${fieldInstructions}`;

  // Hard length override — placed last so it wins over any conflicting
  // instruction above, same as handleGenerateAIText.
  if (charLimit) {
    prompt += `\n\nCRITICAL LENGTH CONSTRAINT: The output MUST be ${charLimit}. This overrides any other length or character count instruction in this prompt.`;
  }

  prompt += `\n\nIMPORTANT: Return ONLY the ${ctx.fieldLabel}, nothing else. Output in ${ctx.mainLanguage}.`;
  return prompt;
}

interface PersistArgs {
  db: PrismaClient;
  shop: string;
  type: AuditType;
  id: string;
  field: TextField;
  value: string;
  contentService: ShopifyContentService;
  gateway: ShopifyApiGateway;
}

/**
 * Save the generated value to Shopify (where supported) and the DB content
 * cache, mirroring how the single-item editor persists the same field.
 */
async function persistField(params: PersistArgs): Promise<void> {
  const { db, shop, type, id, field, value, contentService, gateway } = params;

  switch (type) {
    case "product": {
      // Minimal partial productUpdate — only the field that changed is sent,
      // so every omitted input is left untouched by Shopify.
      let inputPayload: Record<string, unknown>;
      if (field === "title") {
        inputPayload = { id, title: value };
      } else if (field === "description") {
        inputPayload = { id, descriptionHtml: value };
      } else {
        const seoInput: Record<string, string> = {};
        seoInput[field === "seoTitle" ? "title" : "description"] = value;
        inputPayload = { id, seo: seoInput };
      }
      const response = await gateway.graphql(
        `#graphql
          mutation seoBulkFixProductUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
        { variables: { input: inputPayload } },
      );
      const data = (await response.json()) as {
        data?: { productUpdate?: { userErrors?: { field?: string; message: string }[] } };
      };
      const userErrors = data.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) throw new Error(userErrors[0].message);

      const dbData =
        field === "seoTitle"
          ? { seoTitle: value, lastSyncedAt: new Date() }
          : field === "metaDescription"
            ? { seoDescription: value, lastSyncedAt: new Date() }
            : field === "description"
              ? { descriptionHtml: value, lastSyncedAt: new Date() }
              : { title: value, lastSyncedAt: new Date() };
      await db.product.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "collection": {
      if (field === "title") {
        await contentService.updateCollection(id, { title: value });
        await db.collection.update({
          where: { shop_id: { shop, id } },
          data: { title: value, lastSyncedAt: new Date() },
        });
      } else if (field === "description") {
        await contentService.updateCollection(id, { descriptionHtml: value });
        await db.collection.update({
          where: { shop_id: { shop, id } },
          data: { descriptionHtml: value, lastSyncedAt: new Date() },
        });
      } else {
        const seo = field === "seoTitle" ? { title: value } : { description: value };
        await contentService.updateCollection(id, { seo });
        await db.collection.update({
          where: { shop_id: { shop, id } },
          data:
            field === "seoTitle"
              ? { seoTitle: value, lastSyncedAt: new Date() }
              : { seoDescription: value, lastSyncedAt: new Date() },
        });
      }
      break;
    }
    case "page": {
      // Page body lives in `body` (not descriptionHtml); everything else
      // maps 1:1 to the updatePage signature.
      const pageInput =
        field === "seoTitle"
          ? { seoTitle: value }
          : field === "metaDescription"
            ? { seoDescription: value }
            : field === "description"
              ? { body: value }
              : { title: value };
      await contentService.updatePage(id, pageInput);
      await db.page.update({
        where: { shop_id: { shop, id } },
        data: { ...pageInput, lastSyncedAt: new Date() },
      });
      break;
    }
    case "article": {
      // Article SEO title/description are stored the same way as Page/Blog —
      // as global.title_tag/description_tag metafields, written inline by
      // updateArticle() (see ShopifyContentService.updateArticle). Body
      // uses `body`, matching Page.
      const articleInput =
        field === "seoTitle"
          ? { seoTitle: value }
          : field === "metaDescription"
            ? { seoDescription: value }
            : field === "description"
              ? { body: value }
              : { title: value };
      await contentService.updateArticle(id, articleInput);
      const articleDbData =
        field === "seoTitle"
          ? { seoTitle: value, lastSyncedAt: new Date() }
          : field === "metaDescription"
            ? { seoDescription: value, lastSyncedAt: new Date() }
            : field === "description"
              ? { body: value, lastSyncedAt: new Date() }
              : { title: value, lastSyncedAt: new Date() };
      await db.article.update({ where: { shop_id: { shop, id } }, data: articleDbData });
      break;
    }
  }
}

// ─── "Fix all issues for one item" runner ──────────────────────────────────

interface FixAllRunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  admin: AdminApiContext;
  itemId: string;
  itemType: AuditType;
  codes: string[];
  seoTitleMaxChars: number;
  seoLimits: SeoLimits;
  /** See RunArgs.foreignLocale. */
  foreignLocale: string;
  /** The language the generated text will actually be IN — the foreign locale
   *  when translating, the shop's primary one otherwise. `foreignLocale: ""`
   *  cannot answer that: "" means primary, not "no language". §2.5e's glossary
   *  directive needs the real code. */
  writtenLocale: string;
  targetLanguageName: string;
}

/**
 * Iterate every AI-fixable bucket code for ONE item and dispatch to the
 * right generation + persist path per code (text via runSeoBulkFix's
 * pattern, alt text via runAltTextBulkFix's per-image loop). Everything
 * runs inside ONE Task row so the Tasks tab shows a single "fix all"
 * entry; progress ticks per code.
 */
async function runFixAllForItem(taskId: string, args: FixAllRunArgs): Promise<void> {
  const {
    db,
    settings,
    shop,
    admin,
    itemId,
    itemType,
    codes,
    seoTitleMaxChars,
    seoLimits,
    foreignLocale,
    writtenLocale,
    targetLanguageName,
  } = args;
  const isForeign = foreignLocale.length > 0;

  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any);
  const aiService = createAIService(settings, shop, taskId);

  const aiInstructions = (await db.aIInstructions.findUnique({ where: { shop } })) as Record<
    string,
    string | null
  > | null;
  let mainLanguage = "English";
  try {
    const { shopLocales } = await contentService.loadShopLocales();
    const primary = shopLocales.find((l: { primary: boolean; name?: string }) => l.primary);
    if (primary?.name) mainLanguage = primary.name;
  } catch (err: unknown) {
    logger.warn("[API-AI] SEO fixAllForItem: failed to load shop locales, defaulting", {
      context: "AI",
      taskId,
      error: errorMessage(err),
    });
  }
  const outputLanguage = isForeign ? targetLanguageName : mainLanguage;

  const rowMap = await loadRows(db, shop, itemType, [itemId]);
  const row = rowMap.get(itemId);
  if (!row) {
    await db.task.update({
      where: { id: taskId },
      data: {
        status: "failed",
        progress: 100,
        completedAt: new Date(),
        error: "item_missing",
      },
    });
    return;
  }

  const succeeded: { code: string }[] = [];
  const failed: { code: string; error: string }[] = [];
  const total = codes.length;
  let authErrorSeen = false;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const field = FIXABLE_CODE_TO_FIELD[code];

    if (authErrorSeen) {
      failed.push({ code, error: "Skipped after provider API key was rejected" });
    } else if (!field) {
      failed.push({ code, error: `Not AI-fixable: ${code}` });
    } else if (field === "altText") {
      try {
        await runAltTextForOneItem({
          db,
          shop,
          admin,
          itemType,
          itemId,
          aiInstructions,
          mainLanguage,
          outputLanguage,
          foreignLocale,
          writtenLocale,
          aiService,
          contentService,
          gateway,
        });
        succeeded.push({ code });
      } catch (err: unknown) {
        failed.push({ code, error: errorMessage(err) });
        if (isAuthError(err)) authErrorSeen = true;
      }
    } else {
      try {
        const contentType = AUDIT_TYPE_TO_CONTENT_TYPE[itemType];
        const fieldDef = CONTENT_CONFIGS[contentType]?.fieldDefinitions.find((f) => f.key === field);
        const aiInstructionsKey = fieldDef?.aiInstructionsKey || field;
        const fieldLabel = fieldDef?.label || field;

        // Foreign-locale runs need the CURRENT translation as prompt seed so
        // the AI knows whether to shorten (too-long) or fill in (missing).
        // Single-item scope — one findMany call, no batching worth it.
        const currentTranslation = isForeign
          ? await loadForeignFieldValue(db, shop, foreignLocale, itemType, itemId, field)
          : "";

        const prompt = buildFixPrompt(field, {
          fieldLabel,
          aiInstructionsKey,
          title: row.title,
          description: row.description,
          seoTitleMaxChars,
          seoLimits,
          mainLanguage,
          outputLanguage,
          aiInstructions,
          translationSource: isForeign
            ? {
                primaryTitle: row.title,
                primaryDescription: row.description,
                primarySeoTitle: row.seoTitle,
                primaryMetaDescription: row.metaDescription,
                currentTranslation,
              }
            : undefined,
        });

        const generated = (
          field === "description"
            ? await aiService.generateProductDescription(row.title, prompt, undefined, {
                contextTexts: [row.title],
                locale: writtenLocale,
              })
            : await aiService.generateProductTitle(prompt, undefined, {
                contextTexts: [row.title],
                locale: writtenLocale,
              })
        ).trim();

        if (generated.length === 0) {
          throw new Error("AI returned an empty value — nothing was saved.");
        }

        if (isForeign) {
          await persistFieldForLocale({
            db,
            shop,
            type: itemType,
            id: itemId,
            field,
            value: generated,
            locale: foreignLocale,
            gateway,
          });
        } else {
          await persistField({
            db,
            shop,
            type: itemType,
            id: itemId,
            field,
            value: generated,
            contentService,
            gateway,
          });
          // Refresh the in-memory row so a later code in the loop (e.g.
          // seoTitleMissing after titleLength) reads the new title instead
          // of the pre-fix one. Only for primary — foreign runs don't
          // modify `row` (primary source stays untouched).
          if (field === "title") row.title = generated;
          else if (field === "description") row.description = generated;
          else if (field === "seoTitle") row.seoTitle = generated;
          else if (field === "metaDescription") row.metaDescription = generated;
        }

        succeeded.push({ code });
      } catch (err: unknown) {
        failed.push({ code, error: errorMessage(err) });
        logger.error("[API-AI] SEO fixAllForItem: code failed", {
          context: "AI",
          taskId,
          code,
          error: errorMessage(err),
        });
        if (isAuthError(err)) authErrorSeen = true;
      }
    }

    const progressPercent = Math.round(((i + 1) / total) * 100);
    await db.task
      .update({
        where: { id: taskId },
        data: {
          progress: progressPercent,
          processed: i + 1,
          result: JSON.stringify({ succeeded, failed }),
        },
      })
      .catch((err: unknown) => {
        logger.error("[API-AI] SEO fixAllForItem: progress persist failed", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      });
  }

  const finalStatus = succeeded.length === 0 ? "failed" : "completed";
  const failureSummary =
    failed.length > 0
      ? `fixes_failed:${failed.length}:${total}${authErrorSeen ? ":1" : ""}`
      : null;

  await db.task.update({
    where: { id: taskId },
    data: {
      status: finalStatus,
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify({ succeeded, failed }),
      error: failureSummary ? failureSummary.substring(0, 1000) : null,
    },
  });
}

interface AltTextForOneItemArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  itemType: AuditType;
  itemId: string;
  aiInstructions: Record<string, string | null> | null;
  mainLanguage: string;
  /** Language the AI writes the output in — equals mainLanguage for primary
   * runs, the target language name for foreign runs. */
  outputLanguage: string;
  /** The locale CODE of that language (§2.5e). `outputLanguage` is a display
   *  name and cannot key a glossary lookup. */
  writtenLocale: string;
  /** "" (primary) or a foreign locale code. When non-empty, alt-text is saved
   * via translationsRegister on the image's own translatable resource plus the
   * matching DB mirror — MediaImage + `ProductImageAltTranslation` for product
   * gallery images, CollectionImage/ArticleImage + `ContentTranslation`
   * (key `image_alt_text` on the parent) for a collection's/article's featured
   * image. See persistImageAltTextForLocale. */
  foreignLocale: string;
  aiService: ReturnType<typeof createAIService>;
  contentService: ShopifyContentService;
  gateway: ShopifyApiGateway;
}

/** Single-item alt-text loop — mirrors runAltTextBulkFix's job enumeration
 * and per-image generation, but scoped to ONE item, no task heartbeat.
 * Called by runFixAllForItem, which owns the outer heartbeat. */
async function runAltTextForOneItem(args: AltTextForOneItemArgs): Promise<void> {
  const {
    db,
    shop,
    itemType,
    itemId,
    aiInstructions,
    outputLanguage,
    foreignLocale,
    writtenLocale,
    aiService,
    contentService,
    gateway,
  } = args;
  const isForeign = foreignLocale.length > 0;

  interface Job {
    imageUrl: string;
    mediaId?: string | null;
    productImageId?: string;
    isFeatured?: boolean;
    productTitle: string;
  }
  const jobs: Job[] = [];

  if (itemType === "product") {
    const product = await db.product.findUnique({
      where: { shop_id: { shop, id: itemId } },
      select: {
        title: true,
        featuredImageUrl: true,
        featuredImageAlt: true,
        images: {
          select: {
            id: true,
            url: true,
            altText: true,
            mediaId: true,
            position: true,
            // Foreign-locale mode enumerates images that lack a translation in
            // the target locale, not images with an empty PRIMARY alt. Include
            // the translation rows so we can filter without an N+1.
            altTextTranslations: isForeign
              ? {
                  where: { locale: foreignLocale, marketId: "" },
                  select: { altText: true },
                }
              : false,
          },
          orderBy: { position: "asc" },
        },
      },
    });
    // A missing record here means the content cache is stale relative to
    // the audit that flagged this item — treat as a hard failure so the
    // outer runner marks the code failed instead of silently succeeding.
    if (!product) throw new Error("Product no longer exists in the content cache");
    const missing = isForeign
      ? product.images.filter((img) => {
          const t = (img as { altTextTranslations?: { altText: string }[] }).altTextTranslations ?? [];
          return t.length === 0 || !t[0]?.altText?.trim();
        })
      : product.images.filter((img) => !img.altText || img.altText.trim() === "");
    for (const img of missing) {
      jobs.push({
        imageUrl: img.url,
        mediaId: img.mediaId,
        productImageId: img.id,
        productTitle: product.title,
      });
    }
    if (
      jobs.length === 0 &&
      product.images.length === 0 &&
      product.featuredImageUrl &&
      // Foreign-locale featured-image-only PRODUCTS can't be fixed by this
      // runner: with no cached ProductImage row there is no per-locale store
      // for them, only the primary featuredImageAlt. Skip so we don't clobber
      // the primary alt as a side effect of a foreign fix. (A collection's /
      // article's featured image DOES have one and is handled above.)
      !isForeign &&
      (!product.featuredImageAlt || product.featuredImageAlt.trim() === "")
    ) {
      jobs.push({
        imageUrl: product.featuredImageUrl,
        isFeatured: true,
        productTitle: product.title,
      });
    }
  } else if (itemType === "collection") {
    const c = await db.collection.findUnique({
      where: { shop_id: { shop, id: itemId } },
      select: { title: true, imageUrl: true, imageAltText: true },
    });
    if (!c) throw new Error("Collection no longer exists in the content cache");
    if (
      c.imageUrl &&
      (await featuredImageAltIsMissing(db, shop, "Collection", itemId, c.imageAltText, foreignLocale))
    ) {
      jobs.push({ imageUrl: c.imageUrl, productTitle: c.title });
    }
  } else if (itemType === "article") {
    const a = await db.article.findUnique({
      where: { shop_id: { shop, id: itemId } },
      select: { title: true, imageUrl: true, imageAltText: true },
    });
    if (!a) throw new Error("Article no longer exists in the content cache");
    if (
      a.imageUrl &&
      (await featuredImageAltIsMissing(db, shop, "Article", itemId, a.imageAltText, foreignLocale))
    ) {
      jobs.push({ imageUrl: a.imageUrl, productTitle: a.title });
    }
  }

  // Empty jobs = merchant filled alt text between audit and run (or the audit
  // was over-eager). Not a failure — the code is effectively already fixed.
  if (jobs.length === 0) return;

  // Single-item scope but potentially multiple gallery images — batch one
  // digest lookup covering every image at once instead of N per-image
  // roundtrips inside persistImageAltTextForLocale. Cheap even for jobs.length===1.
  const altDigestByMedia = isForeign
    ? await loadTranslatableDigests(
        gateway,
        jobs.map((j) => j.mediaId ?? "").filter((m) => m.length > 0),
        "alt",
      )
    : new Map<string, string>();

  const failures: string[] = [];
  for (const job of jobs) {
    try {
      const sanitizedTitle = sanitizePromptInput(job.productTitle || "", { fieldType: "title" });
      let prompt = `Create an optimized alt text for a product image.\nProduct: ${sanitizedTitle}\nImage URL: ${job.imageUrl}`;
      if (aiInstructions?.productAltTextFormat) {
        prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
      }
      if (aiInstructions?.productAltTextInstructions) {
        prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
      }
      prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${outputLanguage}.`;

      const altText = (
        await aiService.generateImageAltText(job.imageUrl, sanitizedTitle, prompt, false, {
          contextTexts: [sanitizedTitle],
          locale: writtenLocale,
        })
      ).trim();
      if (altText.length === 0) throw new Error("AI returned an empty alt text");

      // Drop productTitle before handing off — persistImageAltText's
      // interface never reads it and we don't want the extra prop drifting
      // into an implicit contract via object spread.
      const { productTitle: _unused, ...jobForPersist } = job;
      if (isForeign) {
        await persistImageAltTextForLocale({
          db,
          shop,
          job: { type: itemType, id: itemId, ...jobForPersist },
          altText,
          locale: foreignLocale,
          gateway,
          digest: job.mediaId ? altDigestByMedia.get(job.mediaId) : undefined,
        });
      } else {
        await persistImageAltText({
          db,
          shop,
          job: { type: itemType, id: itemId, ...jobForPersist },
          altText,
          contentService,
          gateway,
        });
      }
    } catch (err: unknown) {
      failures.push(errorMessage(err));
    }
  }

  // If every image failed, the outer runner should mark this code as failed
  // rather than a spurious success — throw so the caller catches.
  if (failures.length === jobs.length) {
    throw new Error(`All ${jobs.length} image(s) failed: ${failures[0]}`);
  }
}

// ─── Locale-aware helpers ─────────────────────────────────────────────────
//
// The primary-locale runners keep their own persistence + prompt paths
// unchanged; these helpers implement the foreign-locale variants:
//   • resolveTargetLocale: validate the requested locale against shopLocales
//     and resolve its display name for the prompt.
//   • loadForeignTranslations / loadForeignFieldValue: batch/scalar ContentTranslation
//     lookups for the current foreign values (feed the "avoid" hint + prompt seed).
//   • loadTranslatableDigests: aliased-subquery batch of translatableResource
//     digest lookups; kills the per-item Shopify roundtrip on large buckets.
//   • persistFieldForLocale: translationsRegister on the resource's own GID +
//     ContentTranslation upsert. Digest accepted from the batch cache when
//     available (falls back to a single-item fetch for FixAllForItem).
//   • persistImageAltTextForLocale: translationsRegister on the image's own
//     translatable resource + its DB mirror — MediaImage + ProductImageAltTranslation
//     for product gallery images, CollectionImage/ArticleImage + ContentTranslation
//     (key image_alt_text on the parent) for a featured image.

/** Alias batch cap. Shopify's calculated-cost budget for a single request is
 * generous, but `translatableResource` isn't free — each aliased selection
 * costs ~1 point. 50 stays well inside the per-request budget while cutting
 * a 100-item bucket down to 2 roundtrips instead of 100. */
const DIGEST_BATCH_CHUNK = 50;

/**
 * Batch-fetch translation digests for many resource GIDs at once. Uses
 * aliased sub-selections (Shopify has no `translatableResourcesByIds`) so
 * one HTTP request covers up to DIGEST_BATCH_CHUNK resources. Returns a
 * `resourceId -> digest` map for the requested `key`; missing entries
 * (resource has no such translatable content) simply aren't in the map, so
 * callers can fall back to a single-item fetch or fail-fast per item.
 *
 * `resourceIds` are deduped internally — the same GID passed twice would
 * otherwise waste a slot in the alias batch and cost extra points.
 */
async function loadTranslatableDigests(
  gateway: ShopifyApiGateway,
  resourceIds: string[],
  key: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (resourceIds.length === 0) return map;

  const unique = Array.from(new Set(resourceIds));

  for (let i = 0; i < unique.length; i += DIGEST_BATCH_CHUNK) {
    const chunk = unique.slice(i, i + DIGEST_BATCH_CHUNK);

    // Build the aliased query dynamically. Variable names `$r0..$rN` match
    // the alias names `a0..aN` so response parsing is index-driven and
    // doesn't need a per-request key map. GraphQL doesn't support
    // interpolated variables in query strings, but structured variable
    // definitions are still fine because the query text is derived from
    // `chunk.length` only (not the GIDs themselves) — so Shopify's query
    // cache still keys on identical batch sizes.
    const varDefs = chunk.map((_, idx) => `$r${idx}: ID!`).join(", ");
    const selections = chunk
      .map(
        (_, idx) =>
          `a${idx}: translatableResource(resourceId: $r${idx}) { translatableContent { key digest } }`,
      )
      .join("\n        ");
    const query = `#graphql
      query seoBulkFixBatchDigests(${varDefs}) {
        ${selections}
      }`;
    const variables: Record<string, string> = {};
    for (let idx = 0; idx < chunk.length; idx++) variables[`r${idx}`] = chunk[idx];

    let response;
    try {
      response = await gateway.graphql(query, { variables });
    } catch (err: unknown) {
      // One bad chunk mustn't sink the whole run — log and fall through with
      // an empty result for these ids. Callers will retry per-item via the
      // legacy fetch path in persistFieldForLocale / persistImageAltTextForLocale.
      logger.warn("[API-AI] SEO bulk-fix: digest batch failed, falling back per-item", {
        context: "AI",
        chunkStart: i,
        chunkSize: chunk.length,
        error: errorMessage(err),
      });
      continue;
    }
    const data = (await response.json()) as {
      data?: Record<string, { translatableContent?: { key: string; digest: string }[] } | null>;
    };
    if (!data.data) continue;
    for (let idx = 0; idx < chunk.length; idx++) {
      const node = data.data[`a${idx}`];
      const content = node?.translatableContent ?? [];
      const digest = content.find((c) => c.key === key)?.digest;
      if (digest) map.set(chunk[idx], digest);
    }
  }
  return map;
}

/**
 * Validate `requestedLocale` against shopLocales.
 *
 * DATA-INTEGRITY GATE: an unknown/unpublished foreign locale MUST NOT
 * silently collapse to primary. If it did, the merchant would think they
 * were writing a translation but the runner would instead rewrite the
 * PRIMARY title/description via `persistField` — corrupting live storefront
 * content the merchant never intended to touch. Returns `error` for the
 * caller to surface as a 400 in that case.
 *
 * Empty string / primary code = primary run, historic behavior.
 */
async function resolveTargetLocale(
  admin: AdminApiContext,
  shop: string,
  requestedLocale: string,
): Promise<
  // `writtenLocale` is the language the text will actually be IN — the
  // foreign one when translating, the shop's primary one otherwise. §2.5e's
  // glossary directive needs that, and `foreignLocale: ""` deliberately does
  // not say it: "" means "primary", not "no language".
  | { error: null; foreignLocale: string; targetLanguageName: string; writtenLocale: string }
  | { error: string; foreignLocale: never; targetLanguageName: never; writtenLocale: never }
> {
  // NOT wrapped in `.catch`. `getCachedShopLocales` already swallows non-401
  // errors and resolves with []; it re-throws 401 ON PURPOSE so the request can
  // re-authenticate (CLAUDE.md). The previous `.catch(() => [])` here predated
  // this call being on the primary-locale path, and once it was, an expired
  // session on the ordinary bulk fix turned into a silent run with the glossary
  // off instead of a re-auth.
  const locales = await getCachedShopLocales(admin, shop);
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? "";

  if (!requestedLocale) {
    return { error: null, foreignLocale: "", targetLanguageName: "", writtenLocale: primaryLocale };
  }

  const shopLocales = locales;
  const primary = shopLocales.find((l) => l.primary);
  if (primary?.locale === requestedLocale) {
    return { error: null, foreignLocale: "", targetLanguageName: primary.name ?? "", writtenLocale: primaryLocale };
  }

  const match = shopLocales.find(
    (l) => l.locale === requestedLocale && l.published && !l.primary,
  );
  if (!match) {
    return {
      error: `Locale "${requestedLocale}" isn't a published foreign locale for this shop — refusing to run to avoid rewriting primary content.`,
    } as { error: string; foreignLocale: never; targetLanguageName: never; writtenLocale: never };
  }
  return {
    error: null,
    foreignLocale: match.locale,
    targetLanguageName: match.name ?? match.locale,
    writtenLocale: match.locale,
  };
}

/**
 * Batch-load current foreign translations for every item in `items`. One
 * findMany across all four keys. Missing rows = "" (missing translation),
 * same convention audit.service.ts uses.
 */
async function loadForeignTranslations(
  db: PrismaClient,
  shop: string,
  locale: string,
  items: { type: AuditType; id: string }[],
): Promise<Map<string, FixableRow>> {
  const map = new Map<string, FixableRow>();
  if (items.length === 0) return map;

  const ids = items.map((it) => it.id);
  const rows = await db.contentTranslation.findMany({
    where: {
      shop,
      locale,
      resourceId: { in: ids },
      key: { in: ["title", "body_html", "meta_title", "meta_description"] },
      marketId: "",
    },
    select: { resourceId: true, key: true, value: true },
  });
  // Seed every id with the empty row first so callers don't need to null-check.
  for (const it of items) {
    map.set(it.id, {
      id: it.id,
      title: "",
      description: "",
      seoTitle: "",
      metaDescription: "",
    });
  }
  for (const r of rows) {
    const row = map.get(r.resourceId);
    if (!row) continue;
    switch (r.key) {
      case "title":
        row.title = r.value;
        break;
      case "body_html":
        row.description = r.value;
        break;
      case "meta_title":
        row.seoTitle = r.value;
        break;
      case "meta_description":
        row.metaDescription = r.value;
        break;
    }
  }
  return map;
}

/**
 * Single-field lookup used by runFixAllForItem — one item, one code at a
 * time, so batching the four keys isn't worth it.
 */
async function loadForeignFieldValue(
  db: PrismaClient,
  shop: string,
  locale: string,
  type: AuditType,
  id: string,
  field: TextField,
): Promise<string> {
  const key = FIELD_TO_TRANSLATION_KEY[field];
  const row = await db.contentTranslation.findFirst({
    where: {
      shop,
      locale,
      resourceId: id,
      resourceType: AUDIT_TYPE_TO_RESOURCE_TYPE[type],
      key,
      marketId: "",
    },
    select: { value: true },
  });
  return row?.value ?? "";
}

interface PersistForLocaleArgs {
  db: PrismaClient;
  shop: string;
  type: AuditType;
  id: string;
  field: TextField;
  value: string;
  locale: string;
  gateway: ShopifyApiGateway;
  /** Pre-fetched digest from `loadTranslatableDigests`. When present, skips
   * the per-item `translatableResource` query. Absent = fall back to a
   * single-item fetch (used by `runFixAllForItem`, which only touches one
   * item and doesn't justify a batch). */
  digest?: string;
}

/**
 * Write a foreign-locale value: translationsRegister on the resource GID +
 * ContentTranslation upsert. Follows the same shape text-translation.handler.ts
 * uses for the standard "translate one field" flow.
 *
 * Digest resolution: use the pre-fetched value from the runner's batch cache
 * when available; otherwise fetch inline (single-item paths). userErrors +
 * missing digest = throw so the outer runner marks this fix failed instead
 * of silently writing only to the DB.
 */
async function persistFieldForLocale(params: PersistForLocaleArgs): Promise<void> {
  const { db, shop, type, id, field, value, locale, gateway, digest: prefetchedDigest } = params;
  const key = FIELD_TO_TRANSLATION_KEY[field];
  const resourceType = AUDIT_TYPE_TO_RESOURCE_TYPE[type];

  let digest = prefetchedDigest;
  if (!digest) {
    // Fallback: fetch this resource's translatable digest for the specific key.
    const digestResponse = await gateway.graphql(
      `#graphql
        query seoBulkFixTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            translatableContent { key digest }
          }
        }`,
      { variables: { resourceId: id } },
    );
    const digestData = (await digestResponse.json()) as {
      data?: { translatableResource?: { translatableContent?: { key: string; digest: string }[] } };
    };
    const content = digestData.data?.translatableResource?.translatableContent ?? [];
    digest = content.find((c) => c.key === key)?.digest;
  }
  if (!digest) {
    throw new Error(
      `No translatable digest for key "${key}" on ${resourceType} ${id} — Shopify won't accept the translation.`,
    );
  }

  const registerResponse = await gateway.graphql(
    `#graphql
      mutation seoBulkFixTranslationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
        translationsRegister(resourceId: $resourceId, translations: $translations) {
          translations { key locale value }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        resourceId: id,
        translations: [{ key, value, locale, translatableContentDigest: digest }],
      },
    },
  );
  const registerData = (await registerResponse.json()) as {
    data?: {
      translationsRegister?: {
        translations?: { key: string; locale: string; value: string }[];
        userErrors?: { field?: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  };
  if (registerData.errors && registerData.errors.length > 0) {
    throw new Error(`GraphQL error: ${registerData.errors[0].message}`);
  }
  const userErrors = registerData.data?.translationsRegister?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors[0].message);
  }
  // Verify the echo: a userErrors-clean response with an empty translations
  // array means Shopify silently no-op'd — same bug pattern the memory notes
  // (app-embed-translationsregister-silent-noop) call out for other write
  // paths. Never mirror to DB if Shopify didn't echo the key back.
  const echoed = registerData.data?.translationsRegister?.translations ?? [];
  const accepted = echoed.some((t) => t.key === key && t.locale === locale);
  if (!accepted) {
    throw new Error(
      `Shopify accepted the mutation but did not echo the translation for key "${key}" in ${locale} — nothing was saved.`,
    );
  }

  // Mirror to DB — upsert by the ContentTranslation composite unique. The
  // primary content columns stay untouched.
  await db.contentTranslation.upsert({
    where: {
      shop_resourceId_key_locale_marketId: {
        shop,
        resourceId: id,
        key,
        locale,
        marketId: "",
      },
    },
    update: { value, digest, resourceType },
    create: {
      shop,
      resourceId: id,
      resourceType,
      key,
      value,
      locale,
      marketId: "",
      digest,
    },
  });
}

interface PersistImageAltForLocaleArgs {
  db: PrismaClient;
  shop: string;
  job: {
    type: AuditType;
    id: string;
    imageUrl: string;
    mediaId?: string | null;
    productImageId?: string;
    isFeatured?: boolean;
  };
  altText: string;
  locale: string;
  gateway: ShopifyApiGateway;
  /** Pre-fetched digest for this image's MediaImage GID. See
   * PersistForLocaleArgs.digest. */
  digest?: string;
}

/** The `alt` digest of one translatable image resource (MediaImage,
 * CollectionImage, ArticleImage — all offer the single key `alt`). */
async function loadAltDigest(
  gateway: ShopifyApiGateway,
  resourceId: string,
): Promise<string | undefined> {
  const response = await gateway.graphql(
    `#graphql
      query seoBulkFixAltDigest($resourceId: ID!) {
        translatableResource(resourceId: $resourceId) {
          translatableContent { key digest }
        }
      }`,
    { variables: { resourceId } },
  );
  const data = (await response.json()) as {
    data?: { translatableResource?: { translatableContent?: { key: string; digest: string }[] } };
  };
  return data.data?.translatableResource?.translatableContent?.find((c) => c.key === "alt")?.digest;
}

/**
 * translationsRegister of one `alt` translation on an image resource, ECHO
 * VERIFIED: Shopify can accept the mutation and store nothing, so a caller
 * that only checked `userErrors` would mirror a value into the DB that the
 * storefront never serves. Throws on every failure mode — the alt-text runner
 * turns a throw into a per-image `failed` entry.
 */
async function registerAltTranslation(
  gateway: ShopifyApiGateway,
  imageResourceId: string,
  locale: string,
  altText: string,
  digest: string,
): Promise<void> {
  const registerResponse = await gateway.graphql(
    `#graphql
      mutation seoBulkFixAltTranslationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
        translationsRegister(resourceId: $resourceId, translations: $translations) {
          translations { key locale value }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        resourceId: imageResourceId,
        translations: [
          { key: "alt", value: altText, locale, translatableContentDigest: digest },
        ],
      },
    },
  );
  const registerData = (await registerResponse.json()) as {
    data?: {
      translationsRegister?: {
        translations?: { key: string; locale: string; value: string }[];
        userErrors?: { field?: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  };
  if (registerData.errors && registerData.errors.length > 0) {
    throw new Error(`GraphQL error: ${registerData.errors[0].message}`);
  }
  const userErrors = registerData.data?.translationsRegister?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors[0].message);
  }
  const echoed = registerData.data?.translationsRegister?.translations ?? [];
  const accepted = echoed.some((t) => t.key === "alt" && t.locale === locale);
  if (!accepted) {
    throw new Error(
      `Shopify accepted the mutation but did not echo the alt translation in ${locale} — nothing was saved.`,
    );
  }
}

/**
 * Write a foreign-locale image alt. Two shapes, one echo rule:
 *
 *  - PRODUCT gallery image: translationsRegister on the MediaImage GID +
 *    `ProductImageAltTranslation` upsert (keyed by the ProductImage cache row).
 *  - COLLECTION/ARTICLE featured image: translationsRegister on the image's own
 *    `CollectionImage`/`ArticleImage` GID + `ContentTranslation` upsert on the
 *    PARENT with key `image_alt_text` — the third translation shape, the exact
 *    rows `saveImageAltTextTranslation` (single editor) and the bulk editor
 *    write, so all three surfaces read each other's values. The image GID is
 *    cached nowhere and cannot be derived from the parent id, so it is resolved
 *    per job.
 *
 * A product whose only image is a bare `featuredImageUrl` has no per-locale
 * store at all and is filtered out upstream; the guard below stays as defense
 * in depth so this never degrades into a silent no-op.
 */
async function persistImageAltTextForLocale(params: PersistImageAltForLocaleArgs): Promise<void> {
  const { db, shop, job, altText, locale, gateway, digest: prefetchedDigest } = params;

  if (job.type === "collection" || job.type === "article") {
    const resourceType = job.type === "collection" ? "Collection" : "Article";
    const imageResourceId = await fetchFeaturedImageGid(gateway, job.type, job.id);
    if (!imageResourceId) {
      throw new Error(`${resourceType} ${job.id} has no image on Shopify — nothing to translate.`);
    }
    const digest = await loadAltDigest(gateway, imageResourceId);
    if (!digest) {
      throw new Error(`No translatable digest for alt on ${imageResourceId}.`);
    }
    await registerAltTranslation(gateway, imageResourceId, locale, altText, digest);

    // The single editor's featured-alt repair runs under its OWN key and
    // watches the image resource it is about to write, so a claim on neither
    // would let it overwrite this value (translation-locks.shared.ts). The
    // product branch below claims for the same reason.
    markTranslationSaved(featuredAltLockId(job.id));
    markTranslationSaved(imageResourceId);
    await db.contentTranslation.upsert({
      where: {
        shop_resourceId_key_locale_marketId: {
          shop,
          resourceId: job.id,
          key: "image_alt_text",
          locale,
          marketId: "",
        },
      },
      update: { value: altText, digest, resourceType },
      create: {
        shop,
        resourceId: job.id,
        resourceType,
        key: "image_alt_text",
        value: altText,
        locale,
        marketId: "",
        digest,
      },
    });
    return;
  }

  if (job.type !== "product") {
    // Defensive: pages have no images, so nothing else can reach this.
    throw new Error(`Foreign-locale alt-text fix is not supported for ${job.type}.`);
  }
  if (!job.productImageId) {
    throw new Error("productImageId missing — cannot persist foreign-locale alt to DB.");
  }

  // Resolve mediaId if we don't have one cached (bare featuredImageUrl case
  // is skipped for foreign runs, but this stays here for defense in depth).
  const mediaId = job.mediaId;
  if (!mediaId) {
    throw new Error("MediaImage GID missing — cannot translate this image's alt text.");
  }

  const digest = prefetchedDigest ?? (await loadAltDigest(gateway, mediaId));
  if (!digest) {
    throw new Error(`No translatable digest for alt on MediaImage ${mediaId}.`);
  }

  await registerAltTranslation(gateway, mediaId, locale, altText, digest);

  // The detached alt repair watches the MEDIA resource it is about to write
  // (translation-locks.shared.ts); without this claim it never sees the
  // merchant's bulk fix and overwrites it minutes later.
  markTranslationSaved(mediaId);

  await db.productImageAltTranslation.upsert({
    where: {
      imageId_locale_marketId: { imageId: job.productImageId, locale, marketId: "" },
    },
    update: { altText },
    create: { imageId: job.productImageId, locale, altText, marketId: "" },
  });
}

/**
 * The GID of a collection's / article's featured image — `CollectionImage` /
 * `ArticleImage`, which is what Shopify keys the `alt` translation by. NOT the
 * parent's id and NOT the `MediaImage` of the same file: the two are different
 * resources with different alt values (see CLAUDE.md), so translating the file
 * would not change what the collection page serves.
 */
async function fetchFeaturedImageGid(
  gateway: ShopifyApiGateway,
  type: "collection" | "article",
  parentId: string,
): Promise<string | undefined> {
  const field = type === "collection" ? "collection" : "article";
  const response = await gateway.graphql(
    type === "collection"
      ? `#graphql
          query seoBulkFixCollectionImageId($id: ID!) {
            collection(id: $id) { image { id } }
          }`
      : `#graphql
          query seoBulkFixArticleImageId($id: ID!) {
            article(id: $id) { image { id } }
          }`,
    { variables: { id: parentId } },
  );
  const data = (await response.json()) as {
    data?: Record<string, { image?: { id?: string } } | undefined>;
  };
  return data.data?.[field]?.image?.id;
}
