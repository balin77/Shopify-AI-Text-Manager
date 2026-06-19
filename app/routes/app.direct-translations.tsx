/**
 * Direct translations ("Direktübersetzungen") — first-class content type.
 *
 * Merchant-managed storefront text that is NOT in translatable Shopify fields
 * (e.g. third-party app widgets). Items (the rendered source string) carry
 * per-locale translations; a theme app embed applies them client-side. This page
 * mirrors the other content types: a UnifiedItemList on the left and a bespoke
 * editor on the right (source on top + 4 action buttons + the current language's
 * translation), saved via the native App Bridge save bar. Persists to our DB
 * (never to Shopify); the storefront fetches it via the app proxy.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  ButtonGroup,
  Banner,
  Badge,
  Modal,
  Checkbox,
  Box,
  Divider,
  Spinner,
} from "@shopify/polaris";
import { createContentLoader, type LoaderContext } from "~/utils/loader-factory.server";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { AppSaveBar } from "../components/AppSaveBar";
import { UnifiedItemList } from "../components/unified/UnifiedItemList";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { getFormString } from "../utils/form-data.utils";
import { isValidLocale } from "../utils/validation";

// ============================================================================
// Types
// ============================================================================

interface DirectTranslationDTO {
  id: string;
  sourceText: string;
  translations: Array<{ locale: string; targetText: string; source: string }>;
}

interface TargetLocale {
  locale: string;
  name?: string;
}

// ============================================================================
// LOADER
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "DIRECT-TRANSLATIONS",
  resourceType: null, // Uses its own tables, not ContentTranslation.
  itemsKey: "items",

  async loadData(ctx: LoaderContext) {
    const dt = await import("../services/direct-translation.server");
    const rows = await dt.listItems(ctx.db, ctx.session.shop);
    const items = rows.map((r) => ({
      id: r.id,
      sourceText: r.sourceText,
      translations: r.translations.map((t) => ({ locale: t.locale, targetText: t.targetText, source: t.source })),
    }));
    return { items, ids: items.map((i) => i.id) };
  },

  async extraData(ctx: LoaderContext) {
    const dt = await import("../services/direct-translation.server");
    const [settings, newCandidateCount] = await Promise.all([
      dt.getSettings(ctx.db, ctx.session.shop),
      dt.countNewCandidates(ctx.db, ctx.session.shop),
    ]);
    // Published, non-primary locales are the valid translation targets.
    const targetLocales: TargetLocale[] = (ctx.shopLocales as Array<{ locale: string; name?: string; primary: boolean; published?: boolean }>)
      .filter((l) => !l.primary && l.published !== false)
      .map((l) => ({ locale: l.locale, name: l.name }));
    return { collect: settings.collect, newCandidateCount, targetLocales };
  },
});

// ============================================================================
// ACTION
// ============================================================================

/** Build a bound AIService.translateBatchValues for this shop, plus the provider. */
async function buildTranslateBatch(shop: string, taskId?: string) {
  const { db } = await import("../db.server");
  const { AIService, toValidProvider } = await import("../../src/services/ai.service");
  const { tryDecryptApiKey } = await import("../utils/encryption.server");
  const aiSettings = await db.aISettings.findUnique({ where: { shop } });
  const provider = toValidProvider(aiSettings?.preferredProvider);
  const config = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };
  const service = new AIService(provider, config, shop, taskId);
  const translateBatch = (values: string[], from: string, to: string, context: string) =>
    service.translateBatchValues(values, from, to, context);
  return { translateBatch, provider };
}

/**
 * Run an AI translation pass with Task tracking (same pattern as the product
 * sub-resource translator): create a queued Task, advance progress per chunk via
 * onProgress, mark it completed/failed. The TaskCountContext poller surfaces the
 * running count + completion toast in the main navigation.
 */
async function runAiTask(
  shop: string,
  params: {
    items: Array<{ id: string; sourceText: string }>;
    fromLang: string;
    locales: string[];
    targetLocaleLabel: string;
    resourceTitle: string;
  },
): Promise<number> {
  const { db } = await import("../db.server");
  const dt = await import("../services/direct-translation.server");
  const { toValidProvider } = await import("../../src/services/ai.service");
  const { getTaskExpirationDate } = await import("../config/constants");

  const total = params.items.length * params.locales.length;
  const aiSettings = await db.aISettings.findUnique({ where: { shop }, select: { preferredProvider: true } });
  const provider = toValidProvider(aiSettings?.preferredProvider);

  const task = await db.task.create({
    data: {
      shop,
      type: "translation",
      status: "queued",
      fieldType: "direct-translations",
      resourceTitle: params.resourceTitle,
      targetLocale: params.targetLocaleLabel,
      provider,
      progress: 10,
      total,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Build the AI client bound to this task so token usage is attributed to it.
  const { translateBatch } = await buildTranslateBatch(shop, task.id);

  try {
    const rows = await dt.aiAutoTranslateItems(
      db,
      shop,
      { items: params.items, fromLang: params.fromLang, locales: params.locales },
      translateBatch,
      async (done, t) => {
        await db.task.update({
          where: { id: task.id },
          data: { processed: done, progress: t > 0 ? Math.min(99, 10 + Math.round((done / t) * 89)) : 100 },
        });
      },
    );
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        processed: rows.length,
        completedAt: new Date(),
        result: JSON.stringify({ translated: rows.length, total }),
      },
    });
    return rows.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    throw err;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = getFormString(formData, "action");
  const { db } = await import("../db.server");
  const dt = await import("../services/direct-translation.server");
  const { ContentService } = await import("../services/content.service");

  // Resolve published, non-primary target locales + the primary (source) locale.
  const resolveLocales = async () => {
    const locales = await new ContentService(admin).getShopLocales().catch(() => []);
    const primary = (locales as Array<{ locale: string; primary: boolean }>).find((l) => l.primary)?.locale || "en";
    const targets = (locales as Array<{ locale: string; primary: boolean; published: boolean }>)
      .filter((l) => !l.primary && l.published)
      .map((l) => l.locale);
    return { primary, targets };
  };

  /** Ensure an item exists for the given (possibly edited) source; returns its id. */
  const ensureItem = async (itemId: string, sourceText: string) => {
    if (itemId) {
      const existing = await dt.getItem(db, session.shop, itemId);
      if (existing && dt.normalizeSource(sourceText) !== existing.sourceText && sourceText.trim()) {
        await dt.updateItemSource(db, session.shop, itemId, sourceText);
      }
      return itemId;
    }
    const created = await dt.createItem(db, session.shop, sourceText);
    return created.id;
  };

  try {
    switch (actionType) {
      case "save": {
        const itemId = getFormString(formData, "itemId") || "";
        const sourceText = getFormString(formData, "sourceText") || "";
        const locale = (getFormString(formData, "locale") || "").trim();
        const targetText = getFormString(formData, "targetText") ?? "";
        if (!sourceText.trim()) return json({ success: false, error: "Source is required", actionType }, { status: 400 });

        const id = await ensureItem(itemId, sourceText);
        if (locale && isValidLocale(locale)) {
          if (targetText.trim()) await dt.setTranslation(db, session.shop, id, locale, targetText, "user");
          else await dt.deleteTranslation(db, session.shop, id, locale);
        }
        return json({ success: true, actionType, itemId: id });
      }

      case "deleteItem": {
        const itemId = getFormString(formData, "itemId") || "";
        if (itemId) await dt.deleteItem(db, session.shop, itemId);
        return json({ success: true, actionType, itemId });
      }

      case "transfer": {
        // Copy the source 1:1 into the given locales (brand names etc.).
        const itemId = getFormString(formData, "itemId") || "";
        const sourceText = getFormString(formData, "sourceText") || "";
        const scope = getFormString(formData, "scope") || "this"; // "this" | "all"
        const locale = (getFormString(formData, "locale") || "").trim();
        if (!sourceText.trim()) return json({ success: false, error: "Source is required", actionType }, { status: 400 });

        const id = await ensureItem(itemId, sourceText);
        const { targets } = await resolveLocales();
        const locales = scope === "all" ? targets : locale ? [locale] : [];
        const normalized = dt.normalizeSource(sourceText);
        for (const l of locales) {
          if (isValidLocale(l)) await dt.setTranslation(db, session.shop, id, l, normalized, "user");
        }
        return json({ success: true, actionType, itemId: id });
      }

      case "ai": {
        // AI-translate ONE item into this/all target locales.
        const itemId = getFormString(formData, "itemId") || "";
        const sourceText = getFormString(formData, "sourceText") || "";
        const scope = getFormString(formData, "scope") || "this";
        const locale = (getFormString(formData, "locale") || "").trim();
        if (!sourceText.trim()) return json({ success: false, error: "Source is required", actionType }, { status: 400 });

        const id = await ensureItem(itemId, sourceText);
        const { primary, targets } = await resolveLocales();
        const locales = scope === "all" ? targets : locale ? [locale] : [];
        if (locales.length === 0) return json({ success: true, actionType, itemId: id, translated: 0 });

        const translated = await runAiTask(session.shop, {
          items: [{ id, sourceText }],
          fromLang: primary,
          locales,
          targetLocaleLabel: scope === "all" ? "all" : locale,
          resourceTitle: dt.normalizeSource(sourceText).slice(0, 80),
        });
        return json({ success: true, actionType, itemId: id, translated });
      }

      case "aiAll": {
        // AI-translate ALL items into all target locales.
        const { primary, targets } = await resolveLocales();
        if (targets.length === 0) return json({ success: true, actionType, translated: 0 });
        const items = (await dt.listItems(db, session.shop)).map((r) => ({ id: r.id, sourceText: r.sourceText }));
        if (items.length === 0) return json({ success: true, actionType, translated: 0 });
        const translated = await runAiTask(session.shop, {
          items,
          fromLang: primary,
          locales: targets,
          targetLocaleLabel: "all",
          resourceTitle: `Direktübersetzungen (${items.length})`,
        });
        return json({ success: true, actionType, translated });
      }

      case "loadCandidates": {
        const [newItems, rejectedItems] = await Promise.all([
          dt.listCandidates(db, session.shop, "new"),
          dt.listCandidates(db, session.shop, "rejected"),
        ]);
        const map = (c: { id: string; sourceText: string; count: number }) => ({ id: c.id, sourceText: c.sourceText, count: c.count });
        return json({ success: true, actionType, newItems: newItems.map(map), rejectedItems: rejectedItems.map(map) });
      }

      case "addCandidates": {
        const ids = JSON.parse(getFormString(formData, "ids") || "[]") as string[];
        const withAi = getFormString(formData, "withAi") === "true";
        const created = await dt.addCandidatesAsItems(db, session.shop, Array.isArray(ids) ? ids : []);
        if (withAi && created.length > 0) {
          const { primary, targets } = await resolveLocales();
          if (targets.length > 0) {
            await runAiTask(session.shop, {
              items: created.map((c) => ({ id: c.id, sourceText: c.sourceText })),
              fromLang: primary,
              locales: targets,
              targetLocaleLabel: "all",
              resourceTitle: `Direktübersetzungen (${created.length})`,
            });
          }
        }
        return json({ success: true, actionType, added: created.length });
      }

      case "rejectCandidates": {
        const ids = JSON.parse(getFormString(formData, "ids") || "[]") as string[];
        for (const id of Array.isArray(ids) ? ids : []) await dt.setCandidateStatus(db, session.shop, id, "rejected");
        return json({ success: true, actionType, rejected: (ids as string[]).length });
      }

      case "setCollect": {
        await dt.setCollect(db, session.shop, getFormString(formData, "collect") === "true");
        return json({ success: true, actionType });
      }

      default:
        return json({ success: false, error: "Unknown action", actionType }, { status: 400 });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const { logger } = await import("~/utils/logger.server");
    logger.error("[DIRECT-TRANSLATIONS-ACTION] Error", { error: msg, actionType });
    return json({ success: false, error: msg, actionType }, { status: 500 });
  }
};

// ============================================================================
// COMPONENT
// ============================================================================

const NEW_ID = "__new__";

export default function DirectTranslationsPage() {
  const { items, primaryLocale, targetLocales, collect, newCandidateCount, error } =
    useLoaderData<typeof loader>() as {
      items: DirectTranslationDTO[];
      shopLocales: unknown;
      primaryLocale: string;
      targetLocales: TargetLocale[];
      collect: boolean;
      newCandidateCount: number;
      error: string | null;
    };
  const { t, locale: appLocale } = useI18n();
  const { showInfoBox } = useInfoBox();
  const fetcher = useFetcher<{ success?: boolean; error?: string; actionType?: string; itemId?: string; translated?: number; added?: number }>();
  const candidatesFetcher = useFetcher<{ success?: boolean; newItems?: Array<{ id: string; sourceText: string; count: number }>; rejectedItems?: Array<{ id: string; sourceText: string; count: number }> }>();
  const revalidator = useRevalidator();
  const tt = t.directTranslations;

  const hasTargets = targetLocales.length > 0;
  const [currentLanguage, setCurrentLanguage] = useState<string>(targetLocales[0]?.locale || "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draftSource, setDraftSource] = useState("");
  const [draftTarget, setDraftTarget] = useState("");
  const [editingSource, setEditingSource] = useState(false);
  const [baseSource, setBaseSource] = useState("");
  const [baseTarget, setBaseTarget] = useState("");
  const [candidatesOpen, setCandidatesOpen] = useState(false);

  const selectedItem = useMemo(
    () => (isNew ? null : items.find((i) => i.id === selectedId) || null),
    [items, selectedId, isNew],
  );

  // Load an item's source + the current language's translation into the editor.
  const loadEditor = useCallback(
    (item: DirectTranslationDTO | null, language: string) => {
      if (!item) {
        setDraftSource("");
        setDraftTarget("");
        setBaseSource("");
        setBaseTarget("");
        return;
      }
      const tr = item.translations.find((x) => x.locale === language);
      setDraftSource(item.sourceText);
      setBaseSource(item.sourceText);
      setDraftTarget(tr?.targetText || "");
      setBaseTarget(tr?.targetText || "");
      setEditingSource(false);
    },
    [],
  );

  // Auto-select the first item once.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    if (items.length > 0) {
      didInit.current = true;
      setSelectedId(items[0].id);
      setIsNew(false);
      loadEditor(items[0], currentLanguage);
    }
  }, [items, currentLanguage, loadEditor]);

  const handleSelect = useCallback(
    (id: string) => {
      const item = items.find((i) => i.id === id) || null;
      setSelectedId(id);
      setIsNew(false);
      loadEditor(item, currentLanguage);
    },
    [items, currentLanguage, loadEditor],
  );

  const handleAddNew = useCallback(() => {
    setSelectedId(NEW_ID);
    setIsNew(true);
    setDraftSource("");
    setDraftTarget("");
    setBaseSource("");
    setBaseTarget("");
    setEditingSource(true);
  }, []);

  const handleLanguageChange = useCallback(
    (language: string) => {
      setCurrentLanguage(language);
      if (!isNew && selectedItem) {
        const tr = selectedItem.translations.find((x) => x.locale === language);
        setDraftTarget(tr?.targetText || "");
        setBaseTarget(tr?.targetText || "");
      }
    },
    [isNew, selectedItem],
  );

  const hasChanges =
    (isNew && draftSource.trim().length > 0) ||
    (!isNew && selectedItem != null && (draftSource !== baseSource || draftTarget !== baseTarget));

  const isBusy = fetcher.state !== "idle";

  // Build UnifiedItemList items (title = source, subtitle = "n/m languages").
  const listItems = useMemo(
    () =>
      items.map((i) => {
        const n = i.translations.filter((tr) => tr.targetText.trim()).length;
        const m = targetLocales.length;
        return {
          id: i.id,
          title: i.sourceText,
          subtitle: (tt.subtitleTranslated || "{n}/{m}").replace("{n}", String(n)).replace("{m}", String(m)),
        };
      }),
    [items, targetLocales.length, tt.subtitleTranslated],
  );

  const submit = useCallback(
    (fields: Record<string, string>) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fetcher.submit(fd, { method: "POST" });
    },
    [fetcher],
  );

  const handleSave = useCallback(() => {
    submit({
      action: "save",
      itemId: isNew ? "" : selectedId || "",
      sourceText: draftSource,
      locale: currentLanguage,
      targetText: draftTarget,
    });
  }, [submit, isNew, selectedId, draftSource, currentLanguage, draftTarget]);

  const handleDiscard = useCallback(() => {
    if (isNew) {
      setSelectedId(items[0]?.id || null);
      setIsNew(false);
      loadEditor(items[0] || null, currentLanguage);
    } else {
      loadEditor(selectedItem, currentLanguage);
    }
  }, [isNew, items, selectedItem, currentLanguage, loadEditor]);

  const handleAi = useCallback(
    (scope: "this" | "all") => {
      submit({ action: "ai", itemId: isNew ? "" : selectedId || "", sourceText: draftSource, scope, locale: currentLanguage });
    },
    [submit, isNew, selectedId, draftSource, currentLanguage],
  );

  const handleTransfer = useCallback(
    (scope: "this" | "all") => {
      submit({ action: "transfer", itemId: isNew ? "" : selectedId || "", sourceText: draftSource, scope, locale: currentLanguage });
    },
    [submit, isNew, selectedId, draftSource, currentLanguage],
  );

  const handleDelete = useCallback(() => {
    if (isNew || !selectedId) {
      handleDiscard();
      return;
    }
    submit({ action: "deleteItem", itemId: selectedId });
  }, [isNew, selectedId, submit, handleDiscard]);

  // React to action responses: revalidate + adopt new item id + toast.
  const processedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!fetcher.data || processedRef.current === fetcher.data) return;
    processedRef.current = fetcher.data;
    if (!fetcher.data.success) {
      showInfoBox(fetcher.data.error || "Error", "critical");
      return;
    }
    const at = fetcher.data.actionType;
    if (at === "deleteItem") {
      setSelectedId(null);
      setIsNew(false);
      didInit.current = false; // let auto-select pick the next first item
    } else if (fetcher.data.itemId) {
      // save / ai / transfer — adopt the (possibly newly created) item id.
      setSelectedId(fetcher.data.itemId);
      setIsNew(false);
    }
    revalidator.revalidate();
  }, [fetcher.data, revalidator, showInfoBox]);

  // After revalidation completes, refresh the editor baseline from fresh data.
  const prevRevState = useRef(revalidator.state);
  useEffect(() => {
    if (prevRevState.current === "loading" && revalidator.state === "idle") {
      if (!isNew && selectedId) {
        const item = items.find((i) => i.id === selectedId) || null;
        loadEditor(item, currentLanguage);
      }
    }
    prevRevState.current = revalidator.state;
  }, [revalidator.state, isNew, selectedId, items, currentLanguage, loadEditor]);

  useEffect(() => {
    if (error) showInfoBox(error, "critical");
  }, [error, showInfoBox]);

  const langName = (loc: string) => getLocalizedLanguageName(loc, appLocale, targetLocales.find((l) => l.locale === loc)?.name);

  return (
    <PlanAccessGate contentType="directTranslations">
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <MainNavigation />
        <ContentTypeNavigation />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", gap: "1rem", padding: "1rem" }}>
          <UnifiedItemList
            items={listItems}
            selectedItemId={isNew ? NEW_ID : selectedId}
            onItemSelect={handleSelect}
            resourceName={{ singular: tt.resourceSingular, plural: tt.resourcePlural }}
            searchPlaceholder={tt.searchPlaceholder}
            showAddButton
            onAddItem={handleAddNew}
            addButtonLabel={tt.addItem}
            sortOptions={[{ field: "title", label: tt.sourceLabel }]}
            t={{ searchPlaceholder: tt.searchPlaceholder }}
          />

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            <Page>
              <BlockStack gap="400">
                {!hasTargets && <Banner tone="warning">{tt.noTargetLocales}</Banner>}

                {newCandidateCount > 0 && (
                  <Banner
                    tone="info"
                    onDismiss={() => setCandidatesOpen(true)}
                    action={{ content: tt.foundTexts, onAction: () => setCandidatesOpen(true) }}
                  >
                    {(tt.banner || "{n}").replace("{n}", String(newCandidateCount))}
                  </Banner>
                )}

                {/* Toolbar: language bar + found-texts + translate-all */}
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center" gap="200">
                      <InlineStack gap="200" blockAlign="center">
                        {targetLocales.map((l) => (
                          <Button
                            key={l.locale}
                            size="slim"
                            variant={currentLanguage === l.locale ? "primary" : undefined}
                            onClick={() => handleLanguageChange(l.locale)}
                          >
                            {langName(l.locale)}
                          </Button>
                        ))}
                      </InlineStack>
                      <InlineStack gap="200" blockAlign="center">
                        <Button
                          onClick={() => {
                            setCandidatesOpen(true);
                            const fd = new FormData();
                            fd.append("action", "loadCandidates");
                            candidatesFetcher.submit(fd, { method: "POST" });
                          }}
                        >
                          {newCandidateCount > 0 ? `${tt.foundTexts} (${newCandidateCount})` : tt.foundTexts}
                        </Button>
                        <Button
                          variant="primary"
                          disabled={!hasTargets || items.length === 0 || isBusy}
                          loading={isBusy && fetcher.formData?.get("action") === "aiAll"}
                          onClick={() => submit({ action: "aiAll" })}
                        >
                          {tt.translateAllItems}
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </BlockStack>
                </Card>

                {/* Editor */}
                {selectedId == null && !isNew ? (
                  <Card>
                    <Box padding="400">
                      <Text as="p" tone="subdued">{tt.emptyEditor}</Text>
                    </Box>
                  </Card>
                ) : (
                  <Card>
                    <BlockStack gap="400">
                      {/* Source */}
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingSm">{tt.sourceLabel}</Text>
                          {!isNew && !editingSource && (
                            <Button variant="plain" onClick={() => setEditingSource(true)}>{tt.editSource}</Button>
                          )}
                        </InlineStack>
                        <TextField
                          label=""
                          labelHidden
                          value={draftSource}
                          onChange={setDraftSource}
                          placeholder={tt.sourcePlaceholder}
                          autoComplete="off"
                          multiline={2}
                          readOnly={!isNew && !editingSource}
                        />
                      </BlockStack>

                      {/* 4 action buttons */}
                      <InlineStack gap="200" wrap>
                        <ButtonGroup>
                          <Button disabled={!hasTargets || !draftSource.trim() || isBusy} onClick={() => handleAi("all")}>
                            {tt.translateAllLangs}
                          </Button>
                          <Button disabled={!hasTargets || !draftSource.trim() || isBusy} onClick={() => handleAi("this")}>
                            {tt.translateThisLang}
                          </Button>
                        </ButtonGroup>
                        <ButtonGroup>
                          <Button disabled={!hasTargets || !draftSource.trim() || isBusy} onClick={() => handleTransfer("all")}>
                            {tt.transferAllLangs}
                          </Button>
                          <Button disabled={!hasTargets || !draftSource.trim() || isBusy} onClick={() => handleTransfer("this")}>
                            {tt.transferThisLang}
                          </Button>
                        </ButtonGroup>
                      </InlineStack>

                      <Divider />

                      {/* Current-language translation */}
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          {(tt.translationLabel || "{lang}").replace("{lang}", currentLanguage ? langName(currentLanguage) : "")}
                        </Text>
                        <TextField
                          label=""
                          labelHidden
                          value={draftTarget}
                          onChange={setDraftTarget}
                          autoComplete="off"
                          multiline={2}
                          disabled={!hasTargets}
                        />
                      </BlockStack>

                      <InlineStack align="end">
                        {!isNew && (
                          <Button tone="critical" variant="plain" onClick={handleDelete} disabled={isBusy}>
                            {tt.deleteItem}
                          </Button>
                        )}
                      </InlineStack>

                      <Text as="p" tone="subdued" variant="bodySm">{tt.seoNote}</Text>
                    </BlockStack>
                  </Card>
                )}
              </BlockStack>
            </Page>
          </div>
        </div>

        <AppSaveBar hasChanges={hasChanges} onSave={handleSave} onDiscard={handleDiscard} loading={isBusy} />

        <FoundTextsModal
          open={candidatesOpen}
          onClose={() => setCandidatesOpen(false)}
          tt={tt}
          collect={collect}
          fetcher={candidatesFetcher}
          onAction={(action, payload) => {
            const fd = new FormData();
            fd.append("action", action);
            for (const [k, v] of Object.entries(payload)) fd.append(k, v);
            fetcher.submit(fd, { method: "POST" });
            // Reload the candidate list after the mutation.
            setTimeout(() => {
              const reload = new FormData();
              reload.append("action", "loadCandidates");
              candidatesFetcher.submit(reload, { method: "POST" });
            }, 400);
          }}
        />
      </div>
    </PlanAccessGate>
  );
}

// ============================================================================
// "Found texts" modal
// ============================================================================

function FoundTextsModal({
  open,
  onClose,
  tt,
  collect,
  fetcher,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  tt: ReturnType<typeof useI18n>["t"]["directTranslations"];
  collect: boolean;
  fetcher: ReturnType<typeof useFetcher<{ success?: boolean; newItems?: Array<{ id: string; sourceText: string; count: number }>; rejectedItems?: Array<{ id: string; sourceText: string; count: number }> }>>;
  onAction: (action: string, payload: Record<string, string>) => void;
}) {
  const [selectedNew, setSelectedNew] = useState<Set<string>>(new Set());
  const [selectedRejected, setSelectedRejected] = useState<Set<string>>(new Set());
  const [collectOn, setCollectOn] = useState(collect);
  useEffect(() => setCollectOn(collect), [collect]);

  const data = fetcher.data;
  const newItems = data?.newItems || [];
  const rejectedItems = data?.rejectedItems || [];
  const loading = fetcher.state !== "idle";

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  };

  const Pill = ({ item, checked, onToggle }: { item: { id: string; sourceText: string; count: number }; checked: boolean; onToggle: () => void }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px",
        border: `1px solid ${checked ? "#008060" : "#c9cccf"}`,
        borderRadius: "16px",
        background: checked ? "#f1f8f5" : "white",
      }}
    >
      <Checkbox label="" labelHidden checked={checked} onChange={onToggle} />
      <Text as="span" variant="bodySm">{item.sourceText}</Text>
      <Badge tone="info">{(tt.modalSeen || "{n}").replace("{n}", String(item.count))}</Badge>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={tt.modalTitle} size="large">
      <Modal.Section>
        <BlockStack gap="400">
          <Checkbox
            label={tt.collectToggle}
            helpText={tt.collectHelp}
            checked={collectOn}
            onChange={(v) => {
              setCollectOn(v);
              onAction("setCollect", { collect: String(v) });
            }}
          />

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">{tt.modalNewHeading}</Text>
            {loading && newItems.length === 0 ? (
              <Spinner size="small" />
            ) : newItems.length === 0 ? (
              <Text as="p" tone="subdued">{tt.modalEmpty}</Text>
            ) : (
              <>
                <InlineStack gap="200" wrap>
                  {newItems.map((it) => (
                    <Pill key={it.id} item={it} checked={selectedNew.has(it.id)} onToggle={() => toggle(selectedNew, setSelectedNew, it.id)} />
                  ))}
                </InlineStack>
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    disabled={selectedNew.size === 0}
                    onClick={() => { onAction("addCandidates", { ids: JSON.stringify([...selectedNew]), withAi: "false" }); setSelectedNew(new Set()); }}
                  >
                    {tt.modalAdd}
                  </Button>
                  <Button
                    disabled={selectedNew.size === 0}
                    onClick={() => { onAction("addCandidates", { ids: JSON.stringify([...selectedNew]), withAi: "true" }); setSelectedNew(new Set()); }}
                  >
                    {tt.modalAddWithAi}
                  </Button>
                  <Button
                    tone="critical"
                    disabled={selectedNew.size === 0}
                    onClick={() => { onAction("rejectCandidates", { ids: JSON.stringify([...selectedNew]) }); setSelectedNew(new Set()); }}
                  >
                    {tt.modalReject}
                  </Button>
                </InlineStack>
              </>
            )}
          </BlockStack>

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" tone="subdued">{tt.modalRejectedHeading}</Text>
            {rejectedItems.length === 0 ? (
              <Text as="p" tone="subdued">{tt.modalRejectedEmpty}</Text>
            ) : (
              <>
                <InlineStack gap="200" wrap>
                  {rejectedItems.map((it) => (
                    <Pill key={it.id} item={it} checked={selectedRejected.has(it.id)} onToggle={() => toggle(selectedRejected, setSelectedRejected, it.id)} />
                  ))}
                </InlineStack>
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    disabled={selectedRejected.size === 0}
                    onClick={() => { onAction("addCandidates", { ids: JSON.stringify([...selectedRejected]), withAi: "false" }); setSelectedRejected(new Set()); }}
                  >
                    {tt.modalAdd}
                  </Button>
                  <Button
                    disabled={selectedRejected.size === 0}
                    onClick={() => { onAction("addCandidates", { ids: JSON.stringify([...selectedRejected]), withAi: "true" }); setSelectedRejected(new Set()); }}
                  >
                    {tt.modalAddWithAi}
                  </Button>
                </InlineStack>
              </>
            )}
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
