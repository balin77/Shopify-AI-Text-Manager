/**
 * Keyword tracking section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 5 / A6).
 *
 * Store one target keyword per item and see a local on-page analysis (presence
 * in title/H1/meta/SEO-title/body + density + position). Read-only scoring is
 * computed server-side from the DB content cache via analyzeOnPage. GSC ranking
 * data (Phase 6) plugs into the same rows later.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  TextField,
  Select,
  Banner,
  IndexTable,
  Autocomplete,
  Modal,
  Checkbox,
  ProgressBar,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useConfirm } from "../contexts/ConfirmContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone } from "../utils/seo-score";
import {
  analyzeOnPage,
  listAssignments,
  assignKeyword,
  promoteAssignment,
  removeAssignment,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupPriority,
  findPrimaryElsewhere,
  findCannibalizationConflicts,
  getGroupKeywords,
  addKeywordsToGroup,
  removeKeywordFromGroup,
  setKeywordPriority,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS_PER_ITEM,
  buildTranslatedContentInput,
  TRANSLATED_CONTENT_KEYS,
  type KeywordResourceType,
  type KeywordRole,
  type DensityBand,
  type TranslationRow,
  type KeywordGroupRow,
  type GroupKeywordRow,
} from "../services/seo/keywords.service";
import { parseKeywordsCsv } from "../services/seo/keywords-csv";
// Client-safe shared module — NOT keyword-distribution.service, which pulls
// the prompt sanitizer → logger.server into the browser bundle.
import { estimateDistributionCost } from "../services/seo/keyword-distribution.shared";
import type { DistributionSuggestResult } from "./api-ai-handlers/keyword-distribution.handler";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { getFormString } from "../utils/form-data.utils";

/** Items shown per type in the add-keyword picker. */
const PICKER_CAP = 250;

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

interface PickerItem {
  id: string;
  title: string;
}
interface ItemContent {
  title: string;
  seoTitle: string;
  metaDescription: string;
  bodyHtml: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  // Shop locales (60s-cached) drive both the add-form's locale picker and the
  // per-row translated-content analysis below. Primary locale is stored as ""
  // in SeoKeyword (existing convention) — its real Shopify code is only used
  // for display (the Locale column badge).
  const shopLocales = await getCachedShopLocales(admin, shop);
  const primaryLocale = shopLocales.find((l: any) => l.primary);
  const secondaryLocales = shopLocales.filter((l: any) => !l.primary && l.published);

  // Rows are ASSIGNMENTS since the keywords expansion (one keyword can be
  // assigned to several items; an item carries 1 primary + N secondaries).
  const rows = await listAssignments(db, shop);

  // Resolve item content for the tracked keywords, batched per type.
  const idsByType: Record<string, string[]> = {};
  for (const row of rows) {
    (idsByType[row.resourceType] ||= []).push(row.resourceId);
  }
  const content = new Map<string, ItemContent>();
  const put = (
    id: string,
    c: { title: string; seoTitle?: string | null; seoDescription?: string | null; body?: string | null },
  ) =>
    content.set(id, {
      title: c.title,
      seoTitle: c.seoTitle ?? "",
      metaDescription: c.seoDescription ?? "",
      bodyHtml: c.body ?? "",
    });

  await Promise.all([
    idsByType.Product?.length
      ? db.product
          .findMany({
            where: { shop, id: { in: idsByType.Product } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, descriptionHtml: true },
          })
          .then((items) => items.forEach((i) => put(i.id, { ...i, body: i.descriptionHtml })))
      : null,
    idsByType.Collection?.length
      ? db.collection
          .findMany({
            where: { shop, id: { in: idsByType.Collection } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, descriptionHtml: true },
          })
          .then((items) => items.forEach((i) => put(i.id, { ...i, body: i.descriptionHtml })))
      : null,
    idsByType.Article?.length
      ? db.article
          .findMany({
            where: { shop, id: { in: idsByType.Article } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, body: true },
          })
          .then((items) => items.forEach((i) => put(i.id, i)))
      : null,
    idsByType.Page?.length
      ? db.page
          .findMany({
            where: { shop, id: { in: idsByType.Page } },
            select: { id: true, title: true, seoTitle: true, seoDescription: true, body: true },
          })
          .then((items) => items.forEach((i) => put(i.id, i)))
      : null,
  ]);

  // Locale rows (locale !== "") are analyzed against their TRANSLATED content
  // (ContentTranslation), not the base table — a merchant tracking a keyword
  // for the French edition of a product needs to know if the FRENCH title/meta
  // actually contain it, not the German original. One batched findMany over
  // every (resourceId, locale) pair the tracked rows touch, then indexed below.
  const localeRows = rows.filter((row) => row.locale !== "");
  const translationIndex = new Map<string, TranslationRow[]>();
  if (localeRows.length > 0) {
    const resourceIds = Array.from(new Set(localeRows.map((row) => row.resourceId)));
    const locales = Array.from(new Set(localeRows.map((row) => row.locale)));
    const translations = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceId: { in: resourceIds },
        locale: { in: locales },
        key: { in: TRANSLATED_CONTENT_KEYS },
      },
      select: { resourceId: true, locale: true, key: true, value: true },
    });
    for (const t of translations) {
      const bucketKey = `${t.resourceId}::${t.locale}`;
      let bucket = translationIndex.get(bucketKey);
      if (!bucket) {
        bucket = [];
        translationIndex.set(bucketKey, bucket);
      }
      bucket.push(t);
    }
  }

  const keywords = rows.map((row) => {
    const c = content.get(row.resourceId);
    const analysisInput =
      row.locale === ""
        ? {
            title: c?.title ?? "",
            seoTitle: c?.seoTitle ?? "",
            metaDescription: c?.metaDescription ?? "",
            bodyHtml: c?.bodyHtml ?? "",
          }
        : buildTranslatedContentInput(translationIndex.get(`${row.resourceId}::${row.locale}`) ?? []);
    const analysis = analyzeOnPage({
      keyword: row.keyword,
      ...analysisInput,
      // Product/Collection H1s come from the title (themes render it as the
      // page H1); Article/Page may also carry an explicit <h1> in the body.
      resourceType: row.resourceType as KeywordResourceType,
    });
    return {
      id: row.id,
      keywordId: row.keywordId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      keyword: row.keyword,
      locale: row.locale,
      role: row.role,
      priority: row.priority,
      // Display code for the Locale column badge: primary rows are stored as
      // "" so they show the shop's actual primary locale code, not a blank badge.
      localeDisplay: row.locale || primaryLocale?.locale || "",
      itemTitle: c?.title ?? "",
      itemMissing: !c,
      intent: row.intent, // threaded for the intent badge + filter (§7.2)
      // Only the primary carries the 0-100 on-page score — it is
      // presence-weighted and would dilute or double-count across several
      // keywords. Secondaries keep presence/density (factual per keyword).
      score: row.role === "primary" ? analysis.score : null,
      densityPct: analysis.densityPct,
      densityBand: analysis.densityBand,
      presence: analysis.presence,
      gscPosition: row.gscPosition,
    };
  });

  // Stable listing: item → role (primary first) → keyword, so an item's
  // keyword block reads as one visual unit instead of shuffling on updates.
  keywords.sort(
    (a, b) =>
      (a.itemTitle || a.resourceId).localeCompare(b.itemTitle || b.resourceId) ||
      a.role.localeCompare(b.role) ||
      a.keyword.localeCompare(b.keyword),
  );

  // Cannibalization conflicts (§7.1): same keyword primary on ≥2 items of the
  // same type. Pure over the loaded assignment list; item titles resolved
  // from the content map already built above.
  const conflicts = findCannibalizationConflicts(rows).map((c) => ({
    keyword: c.keyword,
    locale: c.locale,
    resourceType: c.resourceType,
    itemTitles: c.resourceIds.map((id) => content.get(id)?.title || id),
  }));

  // Intent classification backlog (§7.2) — drives the classify button label.
  const unclassifiedCount = await db.seoKeyword.count({ where: { shop, intent: null } });

  // Lightweight per-type pickers for the add form (capped).
  const [products, collections, articles, pages] = await Promise.all([
    db.product.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
    db.collection.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
    db.article.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
    db.page.findMany({ where: { shop }, select: { id: true, title: true }, orderBy: { title: "asc" }, take: PICKER_CAP }),
  ]);

  const pickers: Record<KeywordResourceType, PickerItem[]> = {
    Product: products,
    Collection: collections,
    Article: articles,
    Page: pages,
  };

  // Locale options for the add-form's Select: primary first (value "" — the
  // SeoKeyword convention), then published secondaries by their Shopify code.
  const localeOptions = [
    { locale: "", name: primaryLocale?.name ?? primaryLocale?.locale ?? "", primary: true },
    ...secondaryLocales.map((l: any) => ({ locale: String(l.locale), name: String(l.name), primary: false })),
  ];

  // ── Groups + AI distribution (PLAN_KEYWORDS_EXPANSION.md §5) ──

  // Plan flag for the distribution button (the handler gates server-side
  // again; this only decides whether the button renders as available).
  const settingsRow = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const isPro = meetsPlan((settingsRow?.subscriptionPlan || "free") as Plan, "pro");

  const groups = await listGroups(db, shop);
  const url = new URL(request.url);
  const selectedGroupId = url.searchParams.get("group") || "";
  let groupDetail:
    | { id: string; name: string; description: string | null; keywords: GroupKeywordRow[] }
    | null = null;
  if (selectedGroupId) {
    const g = groups.find((grp) => grp.id === selectedGroupId);
    if (g) {
      groupDetail = {
        id: g.id,
        name: g.name,
        description: g.description,
        keywords: await getGroupKeywords(db, shop, g.id),
      };
    }
  }

  // Distribution state: a running task (either stage) blocks new runs and
  // drives the progress banner; otherwise the latest completed suggest task
  // for the selected group (not yet applied) feeds the preview table.
  const runningDistribution = await db.task.findFirst({
    where: { shop, type: "distributeKeywords", status: "running" },
    select: { id: true, fieldType: true, progress: true },
  });
  let distributionPreview: DistributionSuggestResult | null = null;
  let suggestTaskId: string | null = null;
  if (groupDetail && !runningDistribution) {
    const latest = await db.task.findFirst({
      where: { shop, type: "distributeKeywords", fieldType: "suggest", status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { id: true, result: true },
    });
    if (latest?.result) {
      try {
        const parsed = JSON.parse(latest.result) as DistributionSuggestResult;
        if (parsed.groupId === groupDetail.id && !parsed.appliedAt && parsed.suggestions.length > 0) {
          distributionPreview = parsed;
          suggestTaskId = latest.id;
        }
      } catch {
        // Malformed result blob — no preview.
      }
    }
  }

  // Item counts per type: the distribution modal's cost preview needs the
  // target-set size before anything runs.
  const [productCount, collectionCount, articleCount, pageCount] = await Promise.all([
    db.product.count({ where: { shop } }),
    db.collection.count({ where: { shop } }),
    db.article.count({ where: { shop } }),
    db.page.count({ where: { shop } }),
  ]);

  // Product facets for the distribution modal's optional target filter
  // (plan §5.4 — Product only; the handler filters server-side). Note: the
  // cached Product model has NO vendor column, so the plan's vendor facet is
  // not implementable from the cache — productType only.
  const productTypeRows = await db.product.findMany({
    where: { shop, productType: { not: "" } },
    select: { productType: true },
    distinct: ["productType"],
    orderBy: { productType: "asc" },
    take: 100,
  });
  const productTypes = productTypeRows
    .map((r) => r.productType)
    .filter((p): p is string => !!p);

  return json({
    keywords,
    pickers,
    localeOptions,
    // Research panel: hl codes to offer (primary first, then secondaries).
    primaryLocaleCode: String(primaryLocale?.locale || "en"),
    conflicts,
    unclassifiedCount,
    productTypes,
    isPro,
    groups,
    groupDetail,
    runningDistribution,
    distributionPreview,
    suggestTaskId,
    itemCounts: {
      Product: productCount,
      Collection: collectionCount,
      Article: articleCount,
      Page: pageCount,
    } as Record<KeywordResourceType, number>,
  });
};

type CsvErrorRow = { row: number; keyword: string; error: string };

type ActionResult =
  | { ok: true; kind: "saved" | "deleted" | "promoted" | "prioritySet" | "groupCreated" | "groupDeleted" | "groupUpdated" }
  | { ok: true; kind: "csvImported"; added: number; alreadyInGroup: number; csvErrors: CsvErrorRow[] }
  | { ok: false; error: "invalid" | "tooMany" | "duplicateName" | "csvEmpty" | "csvTooMany"; existingKeyword?: never }
  // A different keyword already holds the primary role for this (item, locale)
  // — the UI confirms the swap and re-submits with demoteExisting=true.
  | { ok: false; error: "primaryExists"; existingKeyword: string }
  // Cross-item cannibalization pre-check (plan §7.1): this keyword is already
  // primary on ANOTHER item of the same type — the UI confirms and re-submits
  // with acceptCannibalization=true.
  | { ok: false; error: "cannibalization"; existingItemTitle: string };

/** Item-title lookup for the cannibalization confirm message. */
async function lookupItemTitle(
  db: any,
  shop: string,
  resourceType: KeywordResourceType,
  id: string,
): Promise<string> {
  const model =
    resourceType === "Product"
      ? db.product
      : resourceType === "Collection"
        ? db.collection
        : resourceType === "Article"
          ? db.article
          : db.page;
  const row = await model.findFirst({ where: { shop, id }, select: { title: true } });
  return row?.title || id;
}

/** CSV import cap per request (plan §5.3) — anything bigger must be split. */
const MAX_CSV_ROWS = 2000;

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "setKeyword") {
    const resourceType = getFormString(form, "resourceType") as KeywordResourceType;
    const resourceId = getFormString(form, "resourceId");
    const keyword = getFormString(form, "keyword");
    const localeInput = getFormString(form, "locale");
    const roleInput = getFormString(form, "role");
    const role: KeywordRole = roleInput === "secondary" ? "secondary" : "primary";
    const demoteExisting = getFormString(form, "demoteExisting") === "true";
    if (
      !RESOURCE_TYPES.includes(resourceType) ||
      !resourceId ||
      !keyword.trim() ||
      keyword.trim().length > MAX_KEYWORD_LENGTH
    ) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Validate the posted locale server-side against the shop's actual
    // published locales — "" (primary) is always accepted without a lookup.
    let locale = "";
    if (localeInput) {
      const shopLocales = await getCachedShopLocales(admin, session.shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === localeInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      locale = localeInput;
    }
    // Cross-item cannibalization guard (plan §7.1): warn BEFORE creating a
    // primary that already exists as primary on another item of the same
    // type. Bypassed after the merchant confirmed (acceptCannibalization).
    const acceptCannibalization = getFormString(form, "acceptCannibalization") === "true";
    if (role === "primary" && !acceptCannibalization) {
      const elsewhere = await findPrimaryElsewhere(db, session.shop, {
        keyword,
        locale,
        resourceType,
        excludeResourceId: resourceId,
      });
      if (elsewhere) {
        const existingItemTitle = await lookupItemTitle(db, session.shop, resourceType, elsewhere.resourceId);
        return json<ActionResult>({ ok: false, error: "cannibalization", existingItemTitle }, { status: 409 });
      }
    }

    const result = await assignKeyword(db, session.shop, {
      resourceType,
      resourceId,
      keyword,
      locale,
      role,
      demoteExisting,
    });
    if (!result.ok) {
      if (result.reason === "primaryExists") {
        return json<ActionResult>(
          { ok: false, error: "primaryExists", existingKeyword: result.existingKeyword },
          { status: 409 },
        );
      }
      return json<ActionResult>({ ok: false, error: "tooMany" }, { status: 409 });
    }
    return json<ActionResult>({ ok: true, kind: "saved" });
  }

  if (actionType === "deleteKeyword") {
    const id = getFormString(form, "id");
    if (id) await removeAssignment(db, session.shop, id);
    return json<ActionResult>({ ok: true, kind: "deleted" });
  }

  if (actionType === "makePrimary") {
    const id = getFormString(form, "id");
    if (id) await promoteAssignment(db, session.shop, id);
    return json<ActionResult>({ ok: true, kind: "promoted" });
  }

  // ── Priority (plan §5.2) ──
  if (actionType === "setPriority") {
    const keywordId = getFormString(form, "keywordId");
    const priority = Number(getFormString(form, "priority"));
    if (!keywordId || ![1, 2, 3].includes(priority)) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await setKeywordPriority(db, session.shop, keywordId, priority);
    return json<ActionResult>({ ok: true, kind: "prioritySet" });
  }

  // ── Groups (plan §5.1) ──
  if (actionType === "createGroup") {
    const name = getFormString(form, "name").trim();
    if (!name || name.length > 100) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const result = await createGroup(db, session.shop, name, getFormString(form, "description"));
    if (!result.ok) return json<ActionResult>({ ok: false, error: "duplicateName" }, { status: 409 });
    return json<ActionResult>({ ok: true, kind: "groupCreated" });
  }

  if (actionType === "renameGroup") {
    const groupId = getFormString(form, "groupId");
    const name = getFormString(form, "name").trim();
    if (!groupId || !name || name.length > 100) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const result = await renameGroup(db, session.shop, groupId, name);
    if (!result.ok) return json<ActionResult>({ ok: false, error: "duplicateName" }, { status: 409 });
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  if (actionType === "setGroupPriority") {
    const groupId = getFormString(form, "groupId");
    const priority = Number(getFormString(form, "priority"));
    if (!groupId || ![1, 2, 3].includes(priority)) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    await setGroupPriority(db, session.shop, groupId, priority);
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  if (actionType === "deleteGroup") {
    const groupId = getFormString(form, "groupId");
    if (groupId) await deleteGroup(db, session.shop, groupId);
    return json<ActionResult>({ ok: true, kind: "groupDeleted" });
  }

  if (actionType === "removeFromGroup") {
    const groupId = getFormString(form, "groupId");
    const keywordId = getFormString(form, "keywordId");
    if (groupId && keywordId) await removeKeywordFromGroup(db, session.shop, groupId, keywordId);
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  if (actionType === "addToGroup") {
    const groupId = getFormString(form, "groupId");
    const keyword = getFormString(form, "keyword").trim();
    const localeInput = getFormString(form, "locale");
    if (!groupId || !keyword || keyword.length > MAX_KEYWORD_LENGTH) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Ownership check (review H1): a client-supplied groupId must never write
    // into another shop's group — same guard as importCsv below.
    const targetGroup = await db.seoKeywordGroup.findFirst({
      where: { id: groupId, shop: session.shop },
      select: { id: true },
    });
    if (!targetGroup) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    let locale = "";
    if (localeInput) {
      const shopLocales = await getCachedShopLocales(admin, session.shop);
      const isPublishedSecondary = shopLocales.some(
        (l: any) => !l.primary && l.published && l.locale === localeInput,
      );
      if (!isPublishedSecondary) {
        return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
      }
      locale = localeInput;
    }
    await addKeywordsToGroup(db, session.shop, groupId, [{ keyword, locale }]);
    return json<ActionResult>({ ok: true, kind: "groupUpdated" });
  }

  // ── CSV import (plan §5.3): keyword[,priority][,intent][,locale] ──
  if (actionType === "importCsv") {
    const groupId = getFormString(form, "groupId");
    const csv = getFormString(form, "csv");
    if (!groupId || !csv.trim()) {
      return json<ActionResult>({ ok: false, error: "csvEmpty" }, { status: 400 });
    }
    const group = await db.seoKeywordGroup.findFirst({
      where: { id: groupId, shop: session.shop },
      select: { id: true },
    });
    if (!group) return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });

    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const validLocales = new Set<string>(
      shopLocales
        .filter((l: any) => !l.primary && l.published)
        .map((l: any) => String(l.locale).toLowerCase()),
    );
    const parsed = parseKeywordsCsv(csv, validLocales);
    if (parsed.rows.length === 0 && parsed.errors.length === 0) {
      return json<ActionResult>({ ok: false, error: "csvEmpty" }, { status: 400 });
    }
    if (parsed.rows.length > MAX_CSV_ROWS) {
      return json<ActionResult>({ ok: false, error: "csvTooMany" }, { status: 400 });
    }
    const { added, alreadyInGroup } = await addKeywordsToGroup(
      db,
      session.shop,
      groupId,
      parsed.rows.map((r) => ({ keyword: r.keyword, locale: r.locale, priority: r.priority, intent: r.intent })),
    );
    return json<ActionResult>({
      ok: true,
      kind: "csvImported",
      added,
      alreadyInGroup,
      csvErrors: parsed.errors.slice(0, 20), // cap the error list the UI shows
    });
  }

  return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
};

const DENSITY_TONE: Record<DensityBand, "success" | "warning" | "critical" | undefined> = {
  ok: "success",
  low: "warning",
  high: "critical",
  none: undefined,
};

/** Editor list route per resource type — target of the row's "open in editor" deep-link. */
const KEYWORD_TYPE_PATH: Record<KeywordResourceType, string> = {
  Product: "/app/products",
  Collection: "/app/collections",
  Article: "/app/blog",
  Page: "/app/pages",
};

export default function SeoKeywords() {
  const data = useLoaderData<typeof loader>();
  const { keywords, pickers, localeOptions } = data;
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const confirm = useConfirm();
  const k = t.seo.keywordsPage;

  const saveFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();

  const [type, setType] = useState<KeywordResourceType>("Product");
  const [itemId, setItemId] = useState("");
  // Text typed into the item Autocomplete's TextField — separate from itemId
  // so the field can show a human-readable label while itemId stores the id.
  const [itemInputValue, setItemInputValue] = useState("");
  const [keyword, setKeywordInput] = useState("");
  // "" = primary locale (default). Not reset after save, same as `type`, so
  // tracking several keywords in a row for the same secondary locale is quick.
  const [locale, setLocale] = useState("");
  // Role for the add form (Phase 1): primary is the default; secondaries
  // supplement it (max 5 keywords per item, enforced server-side).
  const [role, setRole] = useState<KeywordRole>("primary");
  // Which row's action is in flight — the rowFetcher is shared across rows,
  // so this is what lets us spinner the right button and disable the rest.
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  // Last setKeyword payload, kept for the primary-swap confirm flow: when the
  // server answers `primaryExists`, we confirm with the merchant and re-submit
  // the SAME payload with demoteExisting=true.
  const lastSubmitRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    const data = saveFetcher.data;
    if (data.ok && data.kind === "saved") {
      setKeywordInput("");
      setItemId("");
      setItemInputValue("");
      lastSubmitRef.current = null;
      return;
    }
    if (!data.ok && data.error === "primaryExists" && lastSubmitRef.current) {
      const payload = lastSubmitRef.current;
      lastSubmitRef.current = null; // one confirm per submission
      const existing = data.existingKeyword;
      void (async () => {
        const ok = await confirm({
          title: k.primarySwapTitle || "Replace primary keyword?",
          message: (
            k.primarySwapBody ||
            `"${existing}" is currently the primary keyword for this item. Demote it to secondary and make "${payload.keyword}" the new primary?`
          )
            .replace("{existing}", existing)
            .replace("{next}", payload.keyword),
          confirmLabel: k.primarySwapConfirm || "Replace",
        });
        if (ok) {
          lastSubmitRef.current = { ...payload, demoteExisting: "true" };
          saveFetcher.submit({ ...payload, demoteExisting: "true" }, { method: "post" });
        }
      })();
      return;
    }
    // Cross-item cannibalization warning (plan §7.1): the keyword is already
    // primary on another item of the same type — confirm before creating a
    // competing primary.
    if (!data.ok && data.error === "cannibalization" && "existingItemTitle" in data && lastSubmitRef.current) {
      const payload = lastSubmitRef.current;
      lastSubmitRef.current = null;
      const existingTitle = data.existingItemTitle;
      void (async () => {
        const ok = await confirm({
          title: k.cannibalizationConfirmTitle || "Keyword already primary elsewhere",
          message: (
            k.cannibalizationConfirmBody ||
            `"{keyword}" is already the primary keyword of "{item}". Two items competing for the same keyword cannibalize each other in Google. Track it here as primary anyway?`
          )
            .replace("{keyword}", payload.keyword)
            .replace("{item}", existingTitle),
          confirmLabel: k.cannibalizationConfirm || "Track anyway",
        });
        if (ok) {
          // Keep the payload stashed — the SAME submit may next hit the
          // same-item primaryExists confirm above.
          lastSubmitRef.current = { ...payload, acceptCannibalization: "true" };
          saveFetcher.submit({ ...payload, acceptCannibalization: "true" }, { method: "post" });
        }
      })();
    }
    // confirm/saveFetcher are stable; k strings don't change mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data]);

  useEffect(() => {
    if (rowFetcher.state === "idle") setPendingRowId(null);
  }, [rowFetcher.state]);

  const handleSubmitKeyword = () => {
    const payload: Record<string, string> = {
      actionType: "setKeyword",
      resourceType: type,
      resourceId: itemId,
      keyword,
      locale,
      role,
    };
    lastSubmitRef.current = payload;
    saveFetcher.submit(payload, { method: "post" });
  };

  const handleDeleteKeyword = async (row: { id: string; keyword: string }) => {
    const ok = await confirm({
      title: k.deleteConfirmTitle || "Stop tracking this keyword?",
      message:
        k.deleteConfirmBody ||
        `This will remove "${row.keyword}" from tracked keywords. This can't be undone.`,
      confirmLabel: k.delete,
      destructive: true,
    });
    if (!ok) return;
    setPendingRowId(row.id);
    rowFetcher.submit({ actionType: "deleteKeyword", id: row.id }, { method: "post" });
  };

  const handleMakePrimary = (row: { id: string }) => {
    setPendingRowId(row.id);
    rowFetcher.submit({ actionType: "makePrimary", id: row.id }, { method: "post" });
  };

  // ── Groups + distribution state (plan §5) ──
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const groupFetcher = useFetcher<ActionResult>();
  const priorityFetcher = useFetcher<ActionResult>();
  const distFetcher = useFetcher<{ success: boolean; taskId?: string; error?: string; code?: string }>();

  const [newGroupName, setNewGroupName] = useState("");
  const [groupKeywordInput, setGroupKeywordInput] = useState("");
  const [groupKeywordLocale, setGroupKeywordLocale] = useState("");
  const [csvText, setCsvText] = useState("");
  const [showDistModal, setShowDistModal] = useState(false);
  const [distTargetType, setDistTargetType] = useState<KeywordResourceType>("Product");
  const [distMaxSecondaries, setDistMaxSecondaries] = useState("3");
  // Optional Product facet filter (plan §5.4 modal) — "" = no filter.
  // (productType only — the cached Product model has no vendor column.)
  const [distFilterProductType, setDistFilterProductType] = useState("");
  // Group rename + bulk priority (plan §5.1).
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [bulkPriority, setBulkPriority] = useState("2");
  // Per-suggestion decision for the preview table; keyed by keyword.
  const [decisions, setDecisions] = useState<Record<string, "accept" | "secondaryOnly" | "reject">>({});
  const [demoteExisting, setDemoteExisting] = useState(false);

  const selectGroup = (groupId: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (groupId) next.set("group", groupId);
        else next.delete("group");
        return next;
      },
      { preventScrollReset: true },
    );
  };

  // Reset the local form state when the group changes; seed the preview
  // decisions (default: accept at confidence ≥ 0.6, plan §5.4 step 4).
  const previewKey = data.suggestTaskId ?? "";
  useEffect(() => {
    if (!data.distributionPreview) {
      setDecisions({});
      return;
    }
    const seeded: Record<string, "accept" | "secondaryOnly" | "reject"> = {};
    for (const s of data.distributionPreview.suggestions) {
      seeded[s.keyword] = s.primaryItemId && s.confidence >= 0.6 ? "accept" : "reject";
    }
    setDecisions(seeded);
    setDemoteExisting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  // While a distribution task runs, poll the loader so the banner progresses
  // and the preview appears without a manual reload.
  const runningDistId = data.runningDistribution?.id ?? null;
  useEffect(() => {
    if (!runningDistId) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningDistId]);

  // A successful suggest/apply start also needs polling to kick in — the
  // loader only knows about the task after the next revalidate.
  useEffect(() => {
    if (distFetcher.state === "idle" && distFetcher.data?.success) {
      setShowDistModal(false);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distFetcher.state, distFetcher.data]);

  const startDistribution = () => {
    if (!data.groupDetail) return;
    distFetcher.submit(
      {
        action: "distributeKeywords",
        contentType: "products",
        stage: "suggest",
        groupId: data.groupDetail.id,
        targetType: distTargetType,
        maxSecondaries: distMaxSecondaries,
        ...(distTargetType === "Product" && distFilterProductType
          ? { filterProductType: distFilterProductType }
          : {}),
      },
      { method: "post", action: "/api/ai" },
    );
  };

  const applyDistribution = () => {
    const preview = data.distributionPreview;
    if (!preview || !data.groupDetail) return;
    const localeByKeyword = new Map(data.groupDetail.keywords.map((k) => [k.keyword, k.locale]));
    const rows = preview.suggestions
      // A null-primary row with secondaries is still applyable — the apply
      // stage handles primaryItemId: null and only writes the secondaries.
      .filter(
        (s) =>
          decisions[s.keyword] &&
          decisions[s.keyword] !== "reject" &&
          (s.primaryItemId || s.secondaryItemIds.length > 0),
      )
      .map((s) => ({
        keyword: s.keyword,
        locale: localeByKeyword.get(s.keyword) ?? "",
        primaryItemId: s.primaryItemId,
        secondaryItemIds: s.secondaryItemIds,
        decision: decisions[s.keyword],
      }));
    if (rows.length === 0) return;
    distFetcher.submit(
      {
        action: "distributeKeywords",
        contentType: "products",
        stage: "apply",
        targetType: preview.targetType,
        suggestTaskId: data.suggestTaskId ?? "",
        demoteExisting: demoteExisting ? "true" : "false",
        rows: JSON.stringify(rows),
      },
      { method: "post", action: "/api/ai" },
    );
  };

  const distCost = useMemo(() => {
    if (!data.groupDetail) return null;
    return estimateDistributionCost(data.groupDetail.keywords.length, data.itemCounts[distTargetType] ?? 0);
  }, [data.groupDetail, data.itemCounts, distTargetType]);

  const priorityOptions = [
    { label: k.priority?.high || "1 — high", value: "1" },
    { label: k.priority?.medium || "2 — medium", value: "2" },
    { label: k.priority?.low || "3 — low", value: "3" },
  ];

  // ── Keyword research panel (plan §6) ──
  const suggestFetcher = useFetcher<{
    ok: boolean;
    groups?: { direct: string[]; questions: string[]; alphabet: string[] };
    error?: "invalid" | "rateLimited" | "blocked";
  }>();
  const [seedInput, setSeedInput] = useState("");
  const [seedHl, setSeedHl] = useState(data.primaryLocaleCode);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [importGroupId, setImportGroupId] = useState("");

  const runResearch = (expandAlphabet: boolean) => {
    if (!seedInput.trim()) return;
    setSelectedSuggestions(new Set());
    suggestFetcher.submit(
      { seed: seedInput, hl: seedHl, expandAlphabet: expandAlphabet ? "true" : "false" },
      { method: "post", action: "/api/keyword-suggestions" },
    );
  };

  const toggleSuggestion = (s: string) => {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const importSelectedSuggestions = () => {
    if (!importGroupId || selectedSuggestions.size === 0) return;
    // Reuse the CSV import path — the research locale becomes the keyword
    // locale when it matches a published secondary; primary otherwise.
    const isSecondary = localeOptions.some((l) => !l.primary && l.locale.toLowerCase() === seedHl.toLowerCase());
    const csv =
      "keyword,locale\n" +
      Array.from(selectedSuggestions)
        .map((s) => `"${s.replace(/"/g, '""')}",${isSecondary ? seedHl.toLowerCase() : ""}`)
        .join("\n");
    groupFetcher.submit({ actionType: "importCsv", groupId: importGroupId, csv }, { method: "post" });
    setSelectedSuggestions(new Set());
  };

  const hlOptions = useMemo(() => {
    const codes = new Set<string>([data.primaryLocaleCode.toLowerCase()]);
    for (const l of localeOptions) {
      if (!l.primary && l.locale) codes.add(l.locale.toLowerCase());
    }
    return Array.from(codes).map((c) => ({ label: c, value: c }));
  }, [data.primaryLocaleCode, localeOptions]);

  // ── Intent classification + filter (plan §7.2) ──
  const intentFetcher = useFetcher<{ success: boolean; classified?: number; remaining?: number; error?: string }>();
  const [intentFilter, setIntentFilter] = useState("all");
  const filteredKeywords = useMemo(() => {
    if (intentFilter === "all") return keywords;
    if (intentFilter === "none") return keywords.filter((r) => !r.intent);
    return keywords.filter((r) => r.intent === intentFilter);
  }, [keywords, intentFilter]);

  useEffect(() => {
    if (intentFetcher.state === "idle" && intentFetcher.data?.success) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentFetcher.state, intentFetcher.data]);

  const intentLabel = (intent: string | null | undefined): string | null =>
    intent ? (k.intents as Record<string, string> | undefined)?.[intent] ?? intent : null;

  const renderSuggestionGroup = (title: string, list: string[]) =>
    list.length === 0 ? null : (
      <BlockStack gap="150" key={title}>
        <Text as="h4" variant="headingSm">
          {title}
        </Text>
        <InlineStack gap="200" wrap>
          {list.map((s) => (
            <Checkbox key={s} label={s} checked={selectedSuggestions.has(s)} onChange={() => toggleSuggestion(s)} />
          ))}
        </InlineStack>
      </BlockStack>
    );

  const items = pickers[type] ?? [];
  // Full option list for the current type (Autocomplete filters this client-side
  // as the merchant types — no "select an item" placeholder entry needed since
  // an empty text field naturally shows every loaded item).
  const itemOptions = useMemo(
    () => items.map((i) => ({ label: i.title || i.id, value: i.id })),
    [items],
  );
  const filteredItemOptions = useMemo(() => {
    const q = itemInputValue.trim().toLowerCase();
    if (!q) return itemOptions;
    return itemOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [itemOptions, itemInputValue]);
  const typeOptions = RESOURCE_TYPES.map((rt) => ({ label: k.types[rt], value: rt }));
  const localeSelectOptions = useMemo(
    () =>
      localeOptions.map((l) => ({
        label: l.primary ? `${l.name} (${k.localePrimary})` : l.name,
        value: l.locale,
      })),
    [localeOptions, k.localePrimary],
  );

  const canSave = !!itemId && !!keyword.trim();

  const openInEditor = (row: { resourceType: string; resourceId: string }) => {
    const path = KEYWORD_TYPE_PATH[row.resourceType as KeywordResourceType];
    if (!path) return;
    handleNavigate(path, { searchParams: new URLSearchParams({ select: row.resourceId }) });
  };

  return (
    <SeoSectionLayout sectionId="keywords">
      <BlockStack gap="400">
        <Banner tone="info" title={k.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{k.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{k.helpBody2}</Text>
          </BlockStack>
        </Banner>

        {/* Cannibalization conflicts (plan §7.1) */}
        {data.conflicts.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                {k.conflictsTitle || "Keyword conflicts"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {k.conflictsIntro ||
                  "The same primary keyword on several items of the same type makes them compete against each other in Google."}
              </Text>
              {data.conflicts.map((c) => (
                <Banner key={`${c.keyword}:${c.resourceType}:${c.locale}`} tone="warning">
                  <Text as="p" variant="bodyMd">
                    {(k.conflictItem || '"{keyword}" is primary on {count} {type} items: {items}')
                      .replace("{keyword}", c.keyword)
                      .replace("{count}", String(c.itemTitles.length))
                      .replace("{type}", k.types[c.resourceType as KeywordResourceType] || c.resourceType)
                      .replace("{items}", c.itemTitles.join(", "))}
                  </Text>
                </Banner>
              ))}
            </BlockStack>
          </Card>
        )}

        {/* Add keyword */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {k.addTitle}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {k.intro}
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "140px" }}>
                <Select
                  label={k.typeLabel}
                  options={typeOptions}
                  value={type}
                  onChange={(v) => {
                    setType(v as KeywordResourceType);
                    setItemId("");
                    setItemInputValue("");
                  }}
                />
              </div>
              <div style={{ flex: "1 1 240px" }}>
                <Autocomplete
                  options={filteredItemOptions}
                  selected={itemId ? [itemId] : []}
                  onSelect={(selected) => {
                    const id = selected[0] ?? "";
                    setItemId(id);
                    const match = itemOptions.find((o) => o.value === id);
                    setItemInputValue(match ? match.label : "");
                  }}
                  textField={
                    <Autocomplete.TextField
                      label={k.itemLabel}
                      autoComplete="off"
                      placeholder={k.selectItem}
                      value={itemInputValue}
                      onChange={(value) => {
                        setItemInputValue(value);
                        // Typing invalidates the previously selected id until a
                        // new option is chosen from the (re-filtered) list.
                        if (itemId) setItemId("");
                      }}
                    />
                  }
                />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <TextField
                  label={k.keywordLabel}
                  autoComplete="off"
                  placeholder={k.keywordPlaceholder}
                  value={keyword}
                  onChange={setKeywordInput}
                />
              </div>
              <div style={{ minWidth: "160px" }}>
                <Select
                  label={k.localeLabel}
                  options={localeSelectOptions}
                  value={locale}
                  onChange={setLocale}
                />
              </div>
              <div style={{ minWidth: "150px" }}>
                <Select
                  label={k.roleLabel || "Role"}
                  options={[
                    { label: k.role?.primary || "Primary", value: "primary" },
                    { label: k.role?.secondary || "Secondary", value: "secondary" },
                  ]}
                  value={role}
                  onChange={(v) => setRole(v as KeywordRole)}
                />
              </div>
              <Button
                variant="primary"
                disabled={!canSave}
                loading={saveFetcher.state !== "idle"}
                onClick={handleSubmitKeyword}
              >
                {k.addButton}
              </Button>
            </InlineStack>
            {saveFetcher.data && !saveFetcher.data.ok && saveFetcher.data.error === "tooMany" && (
              <Banner tone="warning">
                {k.tooManyKeywords ||
                  "This item already tracks the maximum number of keywords for this locale."}
              </Banner>
            )}
            {items.length >= PICKER_CAP && (
              <Text as="p" variant="bodySm" tone="subdued">
                {k.pickerCapped.replace("{cap}", String(PICKER_CAP))}
              </Text>
            )}
          </BlockStack>
        </Card>

        {/* Tracked keywords */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="end" wrap>
              <Text as="h3" variant="headingMd">
                {k.listTitle}
              </Text>
              <InlineStack gap="200" blockAlign="end" wrap>
                <div style={{ minWidth: "170px" }}>
                  <Select
                    label={k.intentFilterLabel || "Intent"}
                    options={[
                      { label: k.intentFilterAll || "All intents", value: "all" },
                      { label: k.intentFilterNone || "Unclassified", value: "none" },
                      ...(["informational", "commercial", "transactional", "navigational"] as const).map((i) => ({
                        label: intentLabel(i) ?? i,
                        value: i,
                      })),
                    ]}
                    value={intentFilter}
                    onChange={setIntentFilter}
                  />
                </div>
                {data.isPro && data.unclassifiedCount > 0 && (
                  <Button
                    loading={intentFetcher.state !== "idle"}
                    onClick={() =>
                      intentFetcher.submit(
                        { action: "classifyKeywordIntents", contentType: "products" },
                        { method: "post", action: "/api/ai" },
                      )
                    }
                  >
                    {(k.classifyButton || "Classify intent ({count} open)").replace(
                      "{count}",
                      String(data.unclassifiedCount),
                    )}
                  </Button>
                )}
              </InlineStack>
            </InlineStack>
            {intentFetcher.state === "idle" && intentFetcher.data?.success && (
              <Banner tone="success">
                {(k.classifyDone || "{count} keyword(s) classified, {remaining} remaining.")
                  .replace("{count}", String(intentFetcher.data.classified ?? 0))
                  .replace("{remaining}", String(intentFetcher.data.remaining ?? 0))}
              </Banner>
            )}
            {rowFetcher.data && !rowFetcher.data.ok && <Banner tone="critical">{k.errorGeneric}</Banner>}

            {filteredKeywords.length === 0 ? (
              <Text as="p" tone="subdued">
                {k.noKeywords}
              </Text>
            ) : (
              <BlockStack gap="200">
                <IndexTable
                  itemCount={filteredKeywords.length}
                  selectable={false}
                  headings={[
                    { title: k.colItem },
                    { title: k.colKeyword },
                    { title: k.colRole || "Role" },
                    { title: k.colLocale },
                    { title: k.colPriority || "Priority" },
                    { title: k.colScore },
                    { title: k.colDensity },
                    { title: k.colPresence },
                    { title: k.colGscPosition },
                    { title: "" },
                  ]}
                >
                  {filteredKeywords.map((row, index) => (
                    <IndexTable.Row id={row.id} key={row.id} position={index}>
                      <IndexTable.Cell>
                        <div style={{ maxWidth: "240px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {row.itemMissing ? k.itemMissing : row.itemTitle || row.resourceId}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {" "}
                            {k.types[row.resourceType as KeywordResourceType] || row.resourceType}
                          </Text>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" blockAlign="center" wrap={false}>
                          <Text as="span" variant="bodyMd">{row.keyword}</Text>
                          {row.intent && <Badge>{intentLabel(row.intent) ?? row.intent}</Badge>}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={row.role === "primary" ? "info" : undefined}>
                          {row.role === "primary"
                            ? k.role?.primary || "Primary"
                            : k.role?.secondary || "Secondary"}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge>{row.localeDisplay || "–"}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ minWidth: "110px" }}>
                          <Select
                            label={k.colPriority || "Priority"}
                            labelHidden
                            options={priorityOptions}
                            value={String(row.priority)}
                            disabled={priorityFetcher.state !== "idle"}
                            onChange={(v) =>
                              priorityFetcher.submit(
                                { actionType: "setPriority", keywordId: row.keywordId, priority: v },
                                { method: "post" },
                              )
                            }
                          />
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.score == null ? (
                          // Secondaries carry no 0-100 score — it is
                          // presence-weighted for ONE target keyword and would
                          // dilute across several (§3.1).
                          <Text as="span" variant="bodyMd" tone="subdued">
                            –
                          </Text>
                        ) : (
                          <Badge tone={scoreTone(row.score) as any}>{String(row.score)}</Badge>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={DENSITY_TONE[row.densityBand as DensityBand]}>
                          {`${k.density[row.densityBand]} (${row.densityPct}%)`}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" wrap>
                          {(["title", "h1", "metaDescription", "seoTitle", "body"] as const).map((key) => (
                            <Badge key={key} tone={row.presence[key] ? "success" : undefined}>
                              {k.presence[key]}
                            </Badge>
                          ))}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd" tone={row.gscPosition == null ? "subdued" : undefined}>
                          {row.gscPosition == null ? "–" : row.gscPosition.toFixed(1)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200" align="end" wrap={false}>
                          <Button
                            variant="plain"
                            onClick={() => openInEditor(row)}
                            disabled={row.itemMissing}
                          >
                            {k.openInEditor}
                          </Button>
                          {row.role === "secondary" && (
                            <Button
                              variant="plain"
                              loading={rowFetcher.state !== "idle" && pendingRowId === row.id}
                              disabled={rowFetcher.state !== "idle" && pendingRowId !== row.id}
                              onClick={() => handleMakePrimary(row)}
                            >
                              {k.makePrimary || "Make primary"}
                            </Button>
                          )}
                          <Button
                            variant="plain"
                            tone="critical"
                            loading={rowFetcher.state !== "idle" && pendingRowId === row.id}
                            disabled={rowFetcher.state !== "idle" && pendingRowId !== row.id}
                            onClick={() => handleDeleteKeyword(row)}
                          >
                            {k.delete}
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
                <Text as="p" variant="bodySm" tone="subdued">
                  {k.gscHint}
                </Text>
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Keyword groups (plan §5.1) ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {k.groupsTitle || "Keyword groups"}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {k.groupsIntro ||
                "Groups are management containers: import keyword lists, then distribute them onto items with AI."}
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 240px", maxWidth: "360px" }}>
                <TextField
                  label={k.groupNameLabel || "New group"}
                  autoComplete="off"
                  placeholder={k.groupNamePlaceholder || "e.g. Vases 2026"}
                  value={newGroupName}
                  onChange={setNewGroupName}
                />
              </div>
              <Button
                loading={groupFetcher.state !== "idle"}
                disabled={!newGroupName.trim()}
                onClick={() => {
                  groupFetcher.submit({ actionType: "createGroup", name: newGroupName }, { method: "post" });
                  setNewGroupName("");
                }}
              >
                {k.groupCreate || "Create group"}
              </Button>
            </InlineStack>
            {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "duplicateName" && (
              <Banner tone="warning">{k.groupDuplicateName || "A group with this name already exists."}</Banner>
            )}
            {data.groups.length === 0 ? (
              <Text as="p" tone="subdued">
                {k.noGroups || "No groups yet."}
              </Text>
            ) : (
              <InlineStack gap="200" wrap>
                {data.groups.map((g) => (
                  <Button
                    key={g.id}
                    pressed={data.groupDetail?.id === g.id}
                    onClick={() => selectGroup(data.groupDetail?.id === g.id ? null : g.id)}
                  >
                    {`${g.name} (${g.keywordCount})`}
                  </Button>
                ))}
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Keyword research (plan §6) — free autocomplete suggestions ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {k.researchTitle || "Keyword research"}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {k.researchIntro ||
                "Get free long-tail suggestions from Google Autocomplete for a seed keyword, then import them into a group."}
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 220px", maxWidth: "340px" }}>
                <TextField
                  label={k.researchSeedLabel || "Seed keyword"}
                  autoComplete="off"
                  placeholder={k.keywordPlaceholder}
                  value={seedInput}
                  onChange={setSeedInput}
                />
              </div>
              <div style={{ minWidth: "110px" }}>
                <Select label={k.researchLangLabel || "Language"} options={hlOptions} value={seedHl} onChange={setSeedHl} />
              </div>
              <Button
                loading={suggestFetcher.state !== "idle"}
                disabled={!seedInput.trim()}
                onClick={() => runResearch(false)}
              >
                {k.researchButton || "Get suggestions"}
              </Button>
              {suggestFetcher.data?.ok && (
                <Button variant="plain" loading={suggestFetcher.state !== "idle"} onClick={() => runResearch(true)}>
                  {k.researchMore || "Load alphabet expansion (a–z)"}
                </Button>
              )}
            </InlineStack>

            {suggestFetcher.state === "idle" && suggestFetcher.data && !suggestFetcher.data.ok && (
              <Banner tone={suggestFetcher.data.error === "invalid" ? "critical" : "warning"}>
                {suggestFetcher.data.error === "rateLimited"
                  ? k.researchRateLimited || "Please wait a moment — at most 3 searches per minute."
                  : suggestFetcher.data.error === "blocked"
                    ? k.researchBlocked ||
                      "Google is currently not answering suggestion requests from this server. Try again later."
                    : k.errorGeneric}
              </Banner>
            )}

            {suggestFetcher.state === "idle" && suggestFetcher.data?.ok && suggestFetcher.data.groups && (
              <BlockStack gap="300">
                {suggestFetcher.data.groups.direct.length === 0 &&
                suggestFetcher.data.groups.questions.length === 0 &&
                suggestFetcher.data.groups.alphabet.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {k.researchNoResults || "No suggestions found for this seed."}
                  </Text>
                ) : (
                  <>
                    {renderSuggestionGroup(k.researchDirect || "Direct suggestions", suggestFetcher.data.groups.direct)}
                    {renderSuggestionGroup(k.researchQuestions || "Questions", suggestFetcher.data.groups.questions)}
                    {renderSuggestionGroup(
                      k.researchAlphabet || "Alphabet expansion",
                      suggestFetcher.data.groups.alphabet,
                    )}
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <div style={{ minWidth: "220px" }}>
                        <Select
                          label={k.researchImportGroup || "Import into group"}
                          options={[
                            { label: k.researchImportGroupNone || "Choose a group…", value: "" },
                            ...data.groups.map((g) => ({ label: g.name, value: g.id })),
                          ]}
                          value={importGroupId}
                          onChange={setImportGroupId}
                        />
                      </div>
                      <Button
                        variant="primary"
                        loading={groupFetcher.state !== "idle"}
                        disabled={!importGroupId || selectedSuggestions.size === 0}
                        onClick={importSelectedSuggestions}
                      >
                        {(k.researchImportButton || "Import {count} selected").replace(
                          "{count}",
                          String(selectedSuggestions.size),
                        )}
                      </Button>
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Group detail: keywords, CSV import, AI distribution ── */}
        {data.groupDetail && (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                {isRenaming ? (
                  <InlineStack gap="200" blockAlign="end" wrap={false}>
                    <TextField
                      label={k.groupRenameLabel || "New name"}
                      labelHidden
                      autoComplete="off"
                      value={renameValue}
                      onChange={setRenameValue}
                    />
                    <Button
                      size="slim"
                      loading={groupFetcher.state !== "idle"}
                      disabled={!renameValue.trim()}
                      onClick={() => {
                        if (!data.groupDetail) return;
                        groupFetcher.submit(
                          { actionType: "renameGroup", groupId: data.groupDetail.id, name: renameValue },
                          { method: "post" },
                        );
                        setIsRenaming(false);
                      }}
                    >
                      {k.groupRenameSave || "Save"}
                    </Button>
                    <Button size="slim" variant="plain" onClick={() => setIsRenaming(false)}>
                      {k.distModalCancel || "Cancel"}
                    </Button>
                  </InlineStack>
                ) : (
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {data.groupDetail.name}
                    </Text>
                    <Button
                      size="micro"
                      variant="plain"
                      onClick={() => {
                        setRenameValue(data.groupDetail?.name ?? "");
                        setIsRenaming(true);
                      }}
                    >
                      {k.groupRename || "Rename"}
                    </Button>
                  </InlineStack>
                )}
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    disabled={!data.isPro || !!data.runningDistribution || data.groupDetail.keywords.length === 0}
                    onClick={() => setShowDistModal(true)}
                  >
                    {k.distributeButton || "Distribute onto items"}
                  </Button>
                  <Button
                    tone="critical"
                    variant="plain"
                    onClick={async () => {
                      const ok = await confirm({
                        title: k.groupDeleteConfirmTitle || "Delete this group?",
                        message:
                          k.groupDeleteConfirmBody ||
                          "Keywords stay tracked; only the group and its memberships are removed.",
                        confirmLabel: k.delete,
                        destructive: true,
                      });
                      if (!ok || !data.groupDetail) return;
                      selectGroup(null);
                      groupFetcher.submit(
                        { actionType: "deleteGroup", groupId: data.groupDetail.id },
                        { method: "post" },
                      );
                    }}
                  >
                    {k.groupDelete || "Delete group"}
                  </Button>
                </InlineStack>
              </InlineStack>
              {!data.isPro && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {k.distributeProHint || "AI distribution requires the Pro plan."}
                </Text>
              )}

              {/* Running distribution progress */}
              {data.runningDistribution && (
                <Banner tone="info">
                  <BlockStack gap="150">
                    <Text as="p" variant="bodyMd">
                      {(data.runningDistribution.fieldType === "apply"
                        ? k.distApplyRunning || "Applying accepted assignments… ({progress}%)"
                        : k.distSuggestRunning || "AI distribution is running… ({progress}%)"
                      ).replace("{progress}", String(data.runningDistribution.progress ?? 0))}
                    </Text>
                    <ProgressBar progress={data.runningDistribution.progress ?? 0} size="small" />
                  </BlockStack>
                </Banner>
              )}
              {distFetcher.data && !distFetcher.data.success && (
                <Banner tone="critical">
                  {distFetcher.data.code === "ALREADY_RUNNING"
                    ? k.distAlreadyRunning || "A distribution is already running — check the Tasks tab."
                    : distFetcher.data.error || k.errorGeneric}
                </Banner>
              )}

              {/* Group keywords */}
              {data.groupDetail.keywords.length === 0 ? (
                <Text as="p" tone="subdued">
                  {k.groupNoKeywords || "No keywords in this group yet — add one below or import a CSV."}
                </Text>
              ) : (
                <IndexTable
                  itemCount={data.groupDetail.keywords.length}
                  selectable={false}
                  headings={[
                    { title: k.colKeyword },
                    { title: k.colLocale },
                    { title: k.colPriority || "Priority" },
                    { title: k.colAssignments || "Assignments" },
                    { title: "" },
                  ]}
                >
                  {data.groupDetail.keywords.map((gk, index) => (
                    <IndexTable.Row id={gk.keywordId} key={gk.keywordId} position={index}>
                      <IndexTable.Cell>
                        <InlineStack gap="100" blockAlign="center" wrap={false}>
                          <Text as="span" variant="bodyMd">
                            {gk.keyword}
                          </Text>
                          {gk.intent && <Badge>{intentLabel(gk.intent) ?? gk.intent}</Badge>}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge>{gk.locale || localeOptions[0]?.name || "–"}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <div style={{ minWidth: "110px" }}>
                          <Select
                            label={k.colPriority || "Priority"}
                            labelHidden
                            options={priorityOptions}
                            value={String(gk.priority)}
                            disabled={priorityFetcher.state !== "idle"}
                            onChange={(v) =>
                              priorityFetcher.submit(
                                { actionType: "setPriority", keywordId: gk.keywordId, priority: v },
                                { method: "post" },
                              )
                            }
                          />
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">
                          {gk.assignmentCount}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Button
                          variant="plain"
                          tone="critical"
                          disabled={groupFetcher.state !== "idle"}
                          onClick={() =>
                            data.groupDetail &&
                            groupFetcher.submit(
                              {
                                actionType: "removeFromGroup",
                                groupId: data.groupDetail.id,
                                keywordId: gk.keywordId,
                              },
                              { method: "post" },
                            )
                          }
                        >
                          {k.groupRemoveKeyword || "Remove"}
                        </Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}

              {/* Bulk priority (plan §5.1 group bulk actions) */}
              {data.groupDetail.keywords.length > 1 && (
                <InlineStack gap="200" blockAlign="end" wrap>
                  <div style={{ minWidth: "150px" }}>
                    <Select
                      label={k.bulkPriorityLabel || "Set priority for ALL"}
                      options={priorityOptions}
                      value={bulkPriority}
                      onChange={setBulkPriority}
                    />
                  </div>
                  <Button
                    loading={groupFetcher.state !== "idle"}
                    onClick={async () => {
                      if (!data.groupDetail) return;
                      const ok = await confirm({
                        title: k.bulkPriorityConfirmTitle || "Set priority for all keywords?",
                        message: (
                          k.bulkPriorityConfirmBody ||
                          "This sets the priority of all {count} keywords in this group."
                        ).replace("{count}", String(data.groupDetail.keywords.length)),
                        confirmLabel: k.bulkPriorityApply || "Apply to all",
                      });
                      if (!ok) return;
                      groupFetcher.submit(
                        { actionType: "setGroupPriority", groupId: data.groupDetail.id, priority: bulkPriority },
                        { method: "post" },
                      );
                    }}
                  >
                    {k.bulkPriorityApply || "Apply to all"}
                  </Button>
                </InlineStack>
              )}

              {/* Add single keyword to group */}
              <InlineStack gap="200" blockAlign="end" wrap>
                <div style={{ flex: "1 1 200px", maxWidth: "320px" }}>
                  <TextField
                    label={k.groupAddKeywordLabel || "Add keyword"}
                    autoComplete="off"
                    placeholder={k.keywordPlaceholder}
                    value={groupKeywordInput}
                    onChange={setGroupKeywordInput}
                  />
                </div>
                <div style={{ minWidth: "150px" }}>
                  <Select
                    label={k.localeLabel}
                    options={localeSelectOptions}
                    value={groupKeywordLocale}
                    onChange={setGroupKeywordLocale}
                  />
                </div>
                <Button
                  loading={groupFetcher.state !== "idle"}
                  disabled={!groupKeywordInput.trim()}
                  onClick={() => {
                    if (!data.groupDetail) return;
                    groupFetcher.submit(
                      {
                        actionType: "addToGroup",
                        groupId: data.groupDetail.id,
                        keyword: groupKeywordInput,
                        locale: groupKeywordLocale,
                      },
                      { method: "post" },
                    );
                    setGroupKeywordInput("");
                  }}
                >
                  {k.groupAddKeyword || "Add"}
                </Button>
              </InlineStack>

              {/* CSV import (plan §5.3) */}
              <BlockStack gap="150">
                <TextField
                  label={k.csvLabel || "CSV import (keyword[, priority][, intent][, locale])"}
                  autoComplete="off"
                  multiline={4}
                  placeholder={k.csvPlaceholder || "keyword,priority\ngreen ceramic vase,1\nhandmade vase,2"}
                  value={csvText}
                  onChange={setCsvText}
                  helpText={(k.csvHint || "Up to {max} rows per import.").replace("{max}", "2000")}
                />
                <InlineStack gap="200">
                  <Button
                    loading={groupFetcher.state !== "idle"}
                    disabled={!csvText.trim()}
                    onClick={() => {
                      if (!data.groupDetail) return;
                      groupFetcher.submit(
                        { actionType: "importCsv", groupId: data.groupDetail.id, csv: csvText },
                        { method: "post" },
                      );
                      setCsvText("");
                    }}
                  >
                    {k.csvImport || "Import CSV"}
                  </Button>
                </InlineStack>
                {groupFetcher.data?.ok && groupFetcher.data.kind === "csvImported" && (
                  <Banner tone={groupFetcher.data.csvErrors.length ? "warning" : "success"}>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd">
                        {(k.csvResult || "{added} imported, {existing} already in the group.")
                          .replace("{added}", String(groupFetcher.data.added))
                          .replace("{existing}", String(groupFetcher.data.alreadyInGroup))}
                      </Text>
                      {groupFetcher.data.csvErrors.map((e) => (
                        <Text key={`${e.row}:${e.keyword}`} as="p" variant="bodySm">
                          {(k.csvErrorRow || 'Row {row}: "{keyword}" — {error}')
                            .replace("{row}", String(e.row))
                            .replace("{keyword}", e.keyword)
                            .replace("{error}", k.csvErrors?.[e.error] ?? e.error)}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                )}
                {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "csvTooMany" && (
                  <Banner tone="critical">
                    {(k.csvTooMany || "A single import is limited to {max} rows.").replace("{max}", "2000")}
                  </Banner>
                )}
              </BlockStack>

              {/* Distribution preview (plan §5.4 step 4 — never auto-applied) */}
              {data.distributionPreview && (
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h4" variant="headingSm">
                      {k.distPreviewTitle || "Distribution suggestions"}
                    </Text>
                    <Button
                      variant="plain"
                      onClick={() => {
                        const next: Record<string, "accept" | "secondaryOnly" | "reject"> = {};
                        for (const s of data.distributionPreview?.suggestions ?? []) {
                          next[s.keyword] = s.primaryItemId ? "accept" : "reject";
                        }
                        setDecisions(next);
                      }}
                    >
                      {k.distAcceptAll || "Accept all"}
                    </Button>
                  </InlineStack>
                  {data.distributionPreview.failedBatches > 0 && (
                    <Banner tone="warning">
                      {(k.distFailedBatches ||
                        "{failed} of {total} AI calls failed — their items received no suggestions.")
                        .replace("{failed}", String(data.distributionPreview.failedBatches))
                        .replace("{total}", String(data.distributionPreview.batches))}
                    </Banner>
                  )}
                  <IndexTable
                    itemCount={data.distributionPreview.suggestions.length}
                    selectable={false}
                    headings={[
                      { title: k.distColDecision || "Decision" },
                      { title: k.colKeyword },
                      { title: k.distColPrimary || "Primary suggestion" },
                      { title: k.distColSecondaries || "Secondaries" },
                      { title: k.distColConfidence || "Confidence" },
                    ]}
                  >
                    {data.distributionPreview.suggestions.map((s, index) => {
                      const titles = data.distributionPreview?.itemTitles ?? {};
                      return (
                        <IndexTable.Row id={s.keyword} key={s.keyword} position={index}>
                          <IndexTable.Cell>
                            <div style={{ minWidth: "140px" }}>
                              <Select
                                label={k.distColDecision || "Decision"}
                                labelHidden
                                disabled={!s.primaryItemId && s.secondaryItemIds.length === 0}
                                options={[
                                  { label: k.distDecisionAccept || "Accept", value: "accept" },
                                  { label: k.distDecisionSecondary || "As secondary only", value: "secondaryOnly" },
                                  { label: k.distDecisionReject || "Reject", value: "reject" },
                                ]}
                                value={decisions[s.keyword] ?? "reject"}
                                onChange={(v) =>
                                  setDecisions((prev) => ({
                                    ...prev,
                                    [s.keyword]: v as "accept" | "secondaryOnly" | "reject",
                                  }))
                                }
                              />
                            </div>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Text as="span" variant="bodyMd">
                              {s.keyword}
                            </Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Text as="span" variant="bodySm" tone={s.primaryItemId ? undefined : "subdued"}>
                              {s.primaryItemId
                                ? titles[s.primaryItemId] || s.primaryItemId
                                : k.distNoMatch || "no match"}
                            </Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {s.secondaryItemIds.map((id) => titles[id] || id).join(", ") || "–"}
                            </Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Badge tone={s.confidence >= 0.6 ? "success" : undefined}>
                              {`${Math.round(s.confidence * 100)}%`}
                            </Badge>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      );
                    })}
                  </IndexTable>
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Checkbox
                      label={k.distDemoteExisting || "Replace existing primary keywords (demote them to secondary)"}
                      checked={demoteExisting}
                      onChange={setDemoteExisting}
                    />
                    <Button
                      variant="primary"
                      loading={distFetcher.state !== "idle"}
                      disabled={
                        !!data.runningDistribution ||
                        !Object.values(decisions).some((d) => d !== "reject")
                      }
                      onClick={applyDistribution}
                    >
                      {k.distApply || "Apply accepted"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>

      {/* Distribution modal (plan §5.4): target + rules + cost preview */}
      <Modal
        open={showDistModal}
        onClose={() => setShowDistModal(false)}
        title={k.distModalTitle || "Distribute keywords onto items"}
        primaryAction={{
          content: k.distModalStart || "Start distribution",
          loading: distFetcher.state !== "idle",
          onAction: startDistribution,
        }}
        secondaryActions={[{ content: k.distModalCancel || "Cancel", onAction: () => setShowDistModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Select
              label={k.distModalTarget || "Target type"}
              options={RESOURCE_TYPES.map((rt) => ({
                label: `${k.types[rt]} (${data.itemCounts[rt] ?? 0})`,
                value: rt,
              }))}
              value={distTargetType}
              onChange={(v) => setDistTargetType(v as KeywordResourceType)}
            />
            <Select
              label={k.distModalMaxSecondaries || "Max secondaries per item"}
              options={["0", "1", "2", "3", "4"].map((v) => ({ label: v, value: v }))}
              value={distMaxSecondaries}
              onChange={setDistMaxSecondaries}
            />
            {distTargetType === "Product" && data.productTypes.length > 0 && (
              <Select
                label={k.distModalFilterType || "Filter: product type"}
                options={[
                  { label: k.distModalFilterAll || "All", value: "" },
                  ...data.productTypes.map((p) => ({ label: p, value: p })),
                ]}
                value={distFilterProductType}
                onChange={setDistFilterProductType}
              />
            )}
            {distTargetType === "Product" && distFilterProductType && (
              <Text as="p" variant="bodySm" tone="subdued">
                {k.distModalFilterHint ||
                  "The cost estimate below assumes ALL items of this type — with a filter the actual cost is lower."}
              </Text>
            )}
            {distCost && (
              <Text as="p" variant="bodySm" tone={distCost.batches > 30 ? "caution" : "subdued"}>
                {(k.distCostPreview || "~{batches} AI call(s), estimated ~${usd}.")
                  .replace("{batches}", String(distCost.batches))
                  .replace("{usd}", distCost.usd.toFixed(2))}
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              {k.distModalHint ||
                "Nothing is assigned automatically — you review every suggestion before it is applied."}
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </SeoSectionLayout>
  );
}
