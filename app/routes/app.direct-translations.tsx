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
import { UnifiedLanguageBar } from "../components/unified/UnifiedLanguageBar";
import type { ShopLocale, TranslatableItem, ContentType } from "../types/content-editor.types";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useTaskCount } from "../contexts/TaskCountContext";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import { confirmNavigation } from "../hooks/useSaveBar";
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
    // All published locales (incl. primary) are valid translation targets:
    // the source text is auto-detected per item, so an EN string on a
    // DE-primary store needs a DE translation for the German storefront.
    const targetLocales: TargetLocale[] = (ctx.shopLocales as Array<{ locale: string; name?: string; primary: boolean; published?: boolean }>)
      .filter((l) => l.published !== false)
      .map((l) => ({ locale: l.locale, name: l.name }));
    return { collect: settings.collect, newCandidateCount, targetLocales };
  },
});

// ============================================================================
// ACTION
// ============================================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = getFormString(formData, "action");
  const { db } = await import("../db.server");
  const dt = await import("../services/direct-translation.server");
  const { runAiTask, resolvePrimaryAndTargets } = await import("../services/direct-translation-ai.server");

  // Resolve published, non-primary target locales + the primary (source) locale.
  const resolveLocales = () => resolvePrimaryAndTargets(admin);

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

  // Restrict a bulk "all languages" request to the locales the merchant left
  // enabled in the language bar (intersected with the published targets). Falls
  // back to all published targets when the client sent nothing.
  const enabledTargets = (targets: string[]) => {
    let requested: string[] | null = null;
    try {
      const parsed = JSON.parse(getFormString(formData, "locales") || "null");
      if (Array.isArray(parsed)) requested = parsed.map(String);
    } catch { /* ignore */ }
    if (!requested) return targets;
    const allow = new Set(targets);
    return requested.filter((l) => allow.has(l));
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

      case "deleteTranslation": {
        // Remove ONE locale's translation; the item itself stays.
        const itemId = getFormString(formData, "itemId") || "";
        const locale = (getFormString(formData, "locale") || "").trim();
        if (itemId && locale && isValidLocale(locale)) {
          await dt.deleteTranslation(db, session.shop, itemId, locale);
        }
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
        const locales = scope === "all" ? enabledTargets(targets) : locale ? [locale] : [];
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
        const { targets } = await resolveLocales();
        const locales = scope === "all" ? enabledTargets(targets) : locale ? [locale] : [];
        if (locales.length === 0) return json({ success: true, actionType, itemId: id, translated: 0 });

        // Run in the background — the Task poller surfaces progress/completion
        // and the page revalidates when the running count drops to zero.
        void runAiTask(session.shop, {
          items: [{ id, sourceText }],
          locales,
          targetLocaleLabel: scope === "all" ? "all" : locale,
          resourceTitle: dt.normalizeSource(sourceText).slice(0, 80),
        }).catch(() => {});
        return json({ success: true, actionType, itemId: id, started: true });
      }

      case "aiAll": {
        // AI-translate ALL items into the enabled target locales.
        const { targets } = await resolveLocales();
        const locales = enabledTargets(targets);
        if (locales.length === 0) return json({ success: true, actionType, translated: 0 });
        const items = (await dt.listItems(db, session.shop)).map((r) => ({ id: r.id, sourceText: r.sourceText }));
        if (items.length === 0) return json({ success: true, actionType, translated: 0 });
        void runAiTask(session.shop, {
          items,
          locales,
          targetLocaleLabel: "all",
          resourceTitle: `Direktübersetzungen (${items.length})`,
        }).catch(() => {});
        return json({ success: true, actionType, started: true });
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
          const { targets } = await resolveLocales();
          if (targets.length > 0) {
            void runAiTask(session.shop, {
              items: created.map((c) => ({ id: c.id, sourceText: c.sourceText })),
              locales: targets,
              targetLocaleLabel: "all",
              resourceTitle: `Direktübersetzungen (${created.length})`,
            }).catch(() => {});
          }
        }
        return json({ success: true, actionType, added: created.length });
      }

      case "rejectCandidates": {
        const ids = JSON.parse(getFormString(formData, "ids") || "[]") as string[];
        for (const id of Array.isArray(ids) ? ids : []) await dt.setCandidateStatus(db, session.shop, id, "rejected");
        return json({ success: true, actionType, rejected: (ids as string[]).length });
      }

      case "clearCandidates": {
        // Drop every candidate (new + rejected) for this shop.
        const deleted = await dt.deleteAllCandidates(db, session.shop);
        return json({ success: true, actionType, deleted });
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
  const { runningTaskCount } = useTaskCount();
  const { registerItems, clearItems } = useItemSelector();
  const fetcher = useFetcher<{ success?: boolean; error?: string; actionType?: string; itemId?: string; translated?: number; added?: number; started?: boolean }>();
  const candidatesFetcher = useFetcher<{ success?: boolean; newItems?: Array<{ id: string; sourceText: string; count: number }>; rejectedItems?: Array<{ id: string; sourceText: string; count: number }> }>();
  const revalidator = useRevalidator();
  const tt = t.directTranslations;

  const hasTargets = targetLocales.length > 0;
  // Target locales sorted by their localized name (matches UnifiedLanguageBar).
  const sortedTargets = useMemo(
    () => [...targetLocales].sort((a, b) =>
      getLocalizedLanguageName(a.locale, appLocale, a.name).localeCompare(
        getLocalizedLanguageName(b.locale, appLocale, b.name),
      ),
    ),
    [targetLocales, appLocale],
  );
  const [currentLanguage, setCurrentLanguage] = useState<string>(sortedTargets[0]?.locale || "");
  // Ctrl/Cmd-click toggles a language off (excluded from "translate all" + shown
  // critical) — handled by the shared UnifiedLanguageBar.
  const [enabledLanguages, setEnabledLanguages] = useState<Set<string>>(
    () => new Set(targetLocales.map((l) => l.locale)),
  );
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
    async (id: string) => {
      if (id === (isNew ? NEW_ID : selectedId)) return;
      // Guard unsaved edits (same as switching languages / the other tabs).
      await confirmNavigation();
      const item = items.find((i) => i.id === id) || null;
      setSelectedId(id);
      setIsNew(false);
      loadEditor(item, currentLanguage);
    },
    [items, currentLanguage, loadEditor, isNew, selectedId],
  );

  const handleAddNew = useCallback(async () => {
    await confirmNavigation();
    setSelectedId(NEW_ID);
    setIsNew(true);
    setDraftSource("");
    setDraftTarget("");
    setBaseSource("");
    setBaseTarget("");
    setEditingSource(true);
  }, []);

  // Plain click switches language; Ctrl/Cmd-click toggles it on/off (primary
  // can't be toggled). The pointerdown flag prevents the click from also firing.
  const toggleLanguage = useCallback((locale: string) => {
    setEnabledLanguages((prev) => {
      const next = new Set(prev);
      if (next.has(locale)) next.delete(locale);
      else next.add(locale);
      return next;
    });
  }, []);

  const handleLanguageChange = useCallback(
    async (language: string) => {
      if (language === currentLanguage) return;
      // Prompt via the native save bar if there are unsaved edits (resolves
      // immediately when nothing is dirty / App Bridge is unavailable).
      await confirmNavigation();
      setCurrentLanguage(language);
      if (!isNew && selectedItem) {
        const tr = selectedItem.translations.find((x) => x.locale === language);
        setDraftTarget(tr?.targetText || "");
        setBaseTarget(tr?.targetText || "");
      }
    },
    [currentLanguage, isNew, selectedItem],
  );

  const hasChanges =
    (isNew && draftSource.trim().length > 0) ||
    (!isNew && selectedItem != null && (draftSource !== baseSource || draftTarget !== baseTarget));

  const isBusy = fetcher.state !== "idle";

  // Build UnifiedItemList items (title = source, subtitle = "n/m languages").
  // The blue "missing translations" dot mirrors the other content tabs.
  const listItems = useMemo(
    () =>
      items.map((i) => {
        const n = i.translations.filter((tr) => tr.targetText.trim()).length;
        const m = targetLocales.length;
        return {
          id: i.id,
          title: i.sourceText,
          subtitle: (tt.subtitleTranslated || "{n}/{m}").replace("{n}", String(n)).replace("{m}", String(m)),
          hasMissingTranslations: m > 0 && n < m,
          missingTranslationsTooltip: t.common?.missingTranslations,
        };
      }),
    [items, targetLocales.length, tt.subtitleTranslated, t.common?.missingTranslations],
  );

  // Register items for the mobile navbar's compact selector (the left list is
  // desktop-only, like every other content tab).
  useEffect(() => {
    registerItems({
      items: listItems,
      selectedItemId: isNew ? NEW_ID : selectedId,
      onItemSelect: (id: string) => { void handleSelect(id); },
      resourceName: { singular: tt.resourceSingular, plural: tt.resourcePlural },
      t: { searchPlaceholder: tt.searchPlaceholder },
    });
  }, [listItems, selectedId, isNew, registerItems, handleSelect, tt.resourceSingular, tt.resourcePlural, tt.searchPlaceholder]);
  useEffect(() => () => clearItems(), [clearItems]);

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

  const enabledList = useMemo(() => JSON.stringify([...enabledLanguages]), [enabledLanguages]);

  const handleAi = useCallback(
    (scope: "this" | "all") => {
      submit({ action: "ai", itemId: isNew ? "" : selectedId || "", sourceText: draftSource, scope, locale: currentLanguage, locales: enabledList });
    },
    [submit, isNew, selectedId, draftSource, currentLanguage, enabledList],
  );

  const handleTransfer = useCallback(
    (scope: "this" | "all") => {
      submit({ action: "transfer", itemId: isNew ? "" : selectedId || "", sourceText: draftSource, scope, locale: currentLanguage, locales: enabledList });
    },
    [submit, isNew, selectedId, draftSource, currentLanguage, enabledList],
  );

  // Inline button under the translation field: removes ONLY the currently
  // displayed locale's translation. The item itself + its other languages stay.
  const handleDeleteTranslation = useCallback(() => {
    if (isNew || !selectedId || !currentLanguage) {
      handleDiscard();
      return;
    }
    submit({ action: "deleteTranslation", itemId: selectedId, locale: currentLanguage });
  }, [isNew, selectedId, currentLanguage, submit, handleDiscard]);

  // Sidebar trash button: removes the WHOLE item (all locales). Used by the
  // shared UnifiedItemList; only enabled when an item is selected.
  const handleDeleteItem = useCallback((itemId: string) => {
    submit({ action: "deleteItem", itemId });
  }, [submit]);

  const reloadCandidates = useCallback(() => {
    const fd = new FormData();
    fd.append("action", "loadCandidates");
    candidatesFetcher.submit(fd, { method: "POST" });
  }, [candidatesFetcher]);

  // React to action responses: revalidate + adopt new item id + toast.
  const processedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!fetcher.data || processedRef.current === fetcher.data) return;
    processedRef.current = fetcher.data;
    if (!fetcher.data.success) {
      showInfoBox(fetcher.data.error || t.common?.error || "Error", "critical");
      return;
    }
    const at = fetcher.data.actionType;
    if (at === "deleteItem") {
      setSelectedId(null);
      setIsNew(false);
      didInit.current = false; // let auto-select pick the next first item
    } else if (at === "deleteTranslation") {
      // Item stays selected; just clear the current-language draft so the
      // editor reflects the removed translation immediately.
      setDraftTarget("");
      setBaseTarget("");
    } else if (fetcher.data.itemId) {
      // save / ai / transfer — adopt the (possibly newly created) item id.
      setSelectedId(fetcher.data.itemId);
      setIsNew(false);
    }
    // Candidate mutations already committed server-side → refresh the modal list.
    if ((at === "addCandidates" || at === "rejectCandidates" || at === "clearCandidates") && candidatesOpen) reloadCandidates();
    revalidator.revalidate();
  }, [fetcher.data, revalidator, showInfoBox, candidatesOpen, reloadCandidates, t]);

  // Background AI tasks: when the running-task count drops to zero, pull fresh
  // data (and refresh the candidate modal) so completed translations show up.
  const prevRunning = useRef(runningTaskCount);
  useEffect(() => {
    if (prevRunning.current > 0 && runningTaskCount === 0) {
      revalidator.revalidate();
      if (candidatesOpen) reloadCandidates();
    }
    prevRunning.current = runningTaskCount;
  }, [runningTaskCount, revalidator, candidatesOpen, reloadCandidates]);

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

  // Locales for the shared UnifiedLanguageBar (it sorts internally).
  // `targetLocales` now includes the primary, so we just map and mark it.
  const barLocales: ShopLocale[] = targetLocales.map((l) => ({
    locale: l.locale,
    primary: l.locale === primaryLocale,
    name: l.name,
  }));
  // Shape the selected item so the bar's status helpers (field-validation's
  // `directTranslations` branch) can read one translation per locale.
  const languageBarItem = useMemo<TranslatableItem | null>(() => {
    if (isNew || !selectedItem) return null;
    return {
      id: selectedItem.id,
      title: selectedItem.sourceText,
      sourceText: selectedItem.sourceText,
      translations: selectedItem.translations.map((tr) => ({ key: "__source__", locale: tr.locale, value: tr.targetText })),
    } as unknown as TranslatableItem;
  }, [isNew, selectedItem]);

  return (
    <PlanAccessGate contentType="directTranslations">
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <MainNavigation />
        <ContentTypeNavigation />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", gap: "16px", padding: "16px", boxSizing: "border-box" }}>
          {/* Left list is desktop-only; on mobile the navbar compact selector
              (fed via registerItems) takes over, like the other content tabs. */}
          <div className="desktop-only" style={{ flexShrink: 0, height: "100%" }}>
            <UnifiedItemList
              items={listItems}
              selectedItemId={isNew ? NEW_ID : selectedId}
              onItemSelect={handleSelect}
              resourceName={{ singular: tt.resourceSingular, plural: tt.resourcePlural }}
              searchPlaceholder={tt.searchPlaceholder}
              showAddButton
              onAddItem={handleAddNew}
              addButtonLabel={tt.addItem}
              showDeleteButton
              onDeleteItem={handleDeleteItem}
              deleteButtonLabel={tt.deleteItem}
              onSyncAll={() => revalidator.revalidate()}
              isSyncing={revalidator.state === "loading"}
              sortOptions={[{ field: "title", label: tt.sourceLabel }]}
              t={{
                searchPlaceholder: tt.searchPlaceholder,
                paginationOf: t.content?.paginationOf || "of",
                paginationPrevious: t.content?.paginationPrevious || "Previous",
                paginationNext: t.content?.paginationNext || "Next",
              }}
            />
          </div>

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingRight: "0.25rem" }}>
            <BlockStack gap="400">
              {!hasTargets && <Banner tone="warning">{tt.noTargetLocales}</Banner>}

              {/* Language bar — shared component for uniformity with the other
                  content tabs (status colours, Ctrl/Cmd-click toggle, tooltips). */}
              <Card>
                <UnifiedLanguageBar
                  shopLocales={barLocales}
                  currentLanguage={currentLanguage}
                  primaryLocale={primaryLocale}
                  selectedItem={languageBarItem}
                  contentType={"directTranslations" as ContentType}
                  hasChanges={hasChanges}
                  onLanguageChange={(loc) => { void handleLanguageChange(loc); }}
                  enabledLanguages={[primaryLocale, ...enabledLanguages]}
                  onToggleLanguage={toggleLanguage}
                  showTranslateAll={false}
                  showReloadButton={false}
                  t={{ primaryLocaleSuffix: t.content?.primaryLanguageSuffix }}
                />
              </Card>

              {/* Global operations: candidate review + bulk translate. The
                  "n new texts found" line replaces the old info banner — same
                  info, no second card. */}
              <Card>
                <BlockStack gap="200">
                  {newCandidateCount > 0 && (
                    <Text as="p" tone="subdued">
                      {(tt.banner || "{n}").replace("{n}", String(newCandidateCount))}
                    </Text>
                  )}
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Button onClick={() => { setCandidatesOpen(true); reloadCandidates(); }}>
                      {newCandidateCount > 0 ? `${tt.foundTexts} (${newCandidateCount})` : tt.foundTexts}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!hasTargets || items.length === 0 || isBusy}
                      loading={isBusy && fetcher.formData?.get("action") === "aiAll"}
                      onClick={() => submit({ action: "aiAll", locales: enabledList })}
                    >
                      {tt.translateAllItems}
                    </Button>
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
                        multiline={3}
                        readOnly={!isNew && !editingSource}
                      />
                    </BlockStack>

                    {/* 4 action buttons — primary is a legitimate target now
                        (source can be in any language), so no isPrimary disable. */}
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

                    {/* Current-language translation field — shown for every
                        locale (incl. primary). The storefront serves whatever
                        is here; leaving it blank falls back to the source. */}
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
                        multiline={3}
                        disabled={!hasTargets}
                      />
                    </BlockStack>

                    <InlineStack align="end">
                      {!isNew && (
                        <Button tone="critical" variant="plain" onClick={handleDeleteTranslation} disabled={isBusy || !draftTarget}>
                          {t.common?.clear || "Clear"}
                        </Button>
                      )}
                    </InlineStack>

                    <Text as="p" tone="subdued" variant="bodySm">{tt.seoNote}</Text>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </div>
        </div>

        <AppSaveBar
          hasChanges={hasChanges}
          onSave={handleSave}
          onDiscard={handleDiscard}
          loading={isBusy}
          saveText={t.content?.save}
          discardText={t.content?.discardChanges}
        />

        <FoundTextsModal
          open={candidatesOpen}
          onClose={() => setCandidatesOpen(false)}
          tt={tt}
          collect={collect}
          fetcher={candidatesFetcher}
          onAction={(action, payload) => {
            // The candidate list is reloaded by the parent effect once this
            // mutation settles (and again when any background AI task finishes).
            const fd = new FormData();
            fd.append("action", action);
            for (const [k, v] of Object.entries(payload)) fd.append(k, v);
            fetcher.submit(fd, { method: "POST" });
          }}
        />
      </div>
    </PlanAccessGate>
  );
}

// ============================================================================
// "Found texts" modal
// ============================================================================

function CandidatePill({
  item,
  checked,
  onToggle,
  seenLabel,
}: {
  item: { id: string; sourceText: string; count: number };
  checked: boolean;
  onToggle: () => void;
  seenLabel: string;
}) {
  return (
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
      <Badge tone="info">{seenLabel.replace("{n}", String(item.count))}</Badge>
    </div>
  );
}

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

  const seenLabel = tt.modalSeen || "{n}";

  const totalCount = newItems.length + rejectedItems.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tt.modalTitle}
      size="large"
      secondaryActions={[
        {
          content: tt.modalClearAll,
          destructive: true,
          disabled: totalCount === 0,
          onAction: () => {
            if (typeof window !== "undefined" && !window.confirm(tt.modalClearAllConfirm)) return;
            setSelectedNew(new Set());
            setSelectedRejected(new Set());
            onAction("clearCandidates", {});
          },
        },
      ]}
    >
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
                    <CandidatePill key={it.id} item={it} seenLabel={seenLabel} checked={selectedNew.has(it.id)} onToggle={() => toggle(selectedNew, setSelectedNew, it.id)} />
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
                    <CandidatePill key={it.id} item={it} seenLabel={seenLabel} checked={selectedRejected.has(it.id)} onToggle={() => toggle(selectedRejected, setSelectedRejected, it.id)} />
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
