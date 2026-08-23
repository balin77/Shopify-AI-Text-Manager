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
import { data as json, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
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
  Collapsible,
} from "@shopify/polaris";
import { ToggleRow } from "../components/ToggleRow";
import { createContentLoader, type LoaderContext } from "~/utils/loader-factory.server";
import { authenticate } from "../shopify.server";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { AppSaveBar } from "../components/AppSaveBar";
import { UnifiedItemList } from "../components/unified/UnifiedItemList";
import { UnifiedLanguageBar, shouldRenderLanguageBar } from "../components/unified/UnifiedLanguageBar";
import type { ShopLocale, TranslatableItem, ContentType, MarketInfo } from "../types/content-editor.types";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useConfirm } from "../contexts/ConfirmContext";
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
  translations: Array<{ locale: string; targetText: string; source: string; marketId?: string }>;
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
    // Fail-closed plan gate: PlanAccessGate only hides the UI, so without this
    // check the loader would still ship a non-Max merchant's direct-translation
    // items to the client. Return an empty list — the gate then renders the
    // upgrade message instead.
    if (!(await dt.isDirectTranslationsAvailable(ctx.db, ctx.session.shop))) {
      return { items: [], ids: [] };
    }
    const rows = await dt.listItems(ctx.db, ctx.session.shop);
    const items = rows.map((r) => ({
      id: r.id,
      sourceText: r.sourceText,
      translations: r.translations.map((t) => ({ locale: t.locale, targetText: t.targetText, source: t.source, marketId: t.marketId ?? "" })),
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
    return {
      collect: settings.collect,
      ignoreTranslateNo: settings.ignoreTranslateNo,
      filterByLanguage: settings.filterByLanguage,
      newCandidateCount,
      targetLocales,
      // The myshopify.com URL — "Visit storefront" deep-links to it so the
      // merchant can surf the shop to trigger the collector. Custom primary
      // domains aren't fetched (extra round-trip not worth it; the .myshopify
      // domain works on every shop).
      shopUrl: `https://${ctx.session.shop}`,
    };
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

  // Server-side plan gate: PlanAccessGate is render-only — without this a
  // non-Max merchant could POST directly to this action and create items,
  // burning DB rows and BYO AI tokens. Loader has the matching check.
  if (!(await dt.isDirectTranslationsAvailable(db, session.shop))) {
    return json({ success: false, error: "Direct translations require the Max plan", actionType }, { status: 403 });
  }

  // Market scope for market-specific direct translations. "" = global (default).
  // Validated to the stored GID form; anything else falls back to global so a
  // malformed value can never create a market row the storefront won't match.
  const rawMarketId = (getFormString(formData, "marketId") || "").trim();
  const marketId = /^gid:\/\/shopify\/Market\/\d+$/.test(rawMarketId) ? rawMarketId : "";

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
          if (targetText.trim()) await dt.setTranslation(db, session.shop, id, locale, targetText, "user", marketId);
          else await dt.deleteTranslation(db, session.shop, id, locale, marketId);
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
          await dt.deleteTranslation(db, session.shop, itemId, locale, marketId);
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
          if (isValidLocale(l)) await dt.setTranslation(db, session.shop, id, l, normalized, "user", marketId);
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
          marketId,
        }).catch(() => {});
        return json({ success: true, actionType, itemId: id, started: true });
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

      case "setCollectorSettings": {
        // Patch any subset of { collect, ignoreTranslateNo, filterByLanguage }
        // — the modal's three checkboxes all use this case.
        const patch: { collect?: boolean; ignoreTranslateNo?: boolean; filterByLanguage?: boolean } = {};
        const c = getFormString(formData, "collect");
        const i = getFormString(formData, "ignoreTranslateNo");
        const f = getFormString(formData, "filterByLanguage");
        if (c === "true" || c === "false") patch.collect = c === "true";
        if (i === "true" || i === "false") patch.ignoreTranslateNo = i === "true";
        if (f === "true" || f === "false") patch.filterByLanguage = f === "true";
        await dt.updateSettings(db, session.shop, patch);
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
  const { items, primaryLocale, targetLocales, markets, collect, ignoreTranslateNo, filterByLanguage, newCandidateCount, shopUrl, error } =
    useLoaderData<typeof loader>() as {
      items: DirectTranslationDTO[];
      shopLocales: unknown;
      primaryLocale: string;
      targetLocales: TargetLocale[];
      markets: MarketInfo[];
      collect: boolean;
      ignoreTranslateNo: boolean;
      filterByLanguage: boolean;
      newCandidateCount: number;
      shopUrl: string;
      error: string | null;
    };
  const { t, locale: appLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const { showInfoBox } = useInfoBox();
  const confirm = useConfirm();
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
  // Selected market ("" = global / all markets). Market-specific translations
  // override the global value for buyers in that market (storefront fallback).
  const [selectedMarketId, setSelectedMarketId] = useState<string>("");

  // Resolve the effective target text for (item, locale, market): the
  // market-specific override if present, otherwise the global value (inherited).
  const resolveTargetText = useCallback(
    (item: DirectTranslationDTO | null, language: string, marketId: string): string => {
      if (!item) return "";
      if (marketId) {
        const m = item.translations.find((x) => x.locale === language && (x.marketId ?? "") === marketId);
        if (m && m.targetText) return m.targetText;
      }
      const g = item.translations.find((x) => x.locale === language && (x.marketId ?? "") === "");
      return g?.targetText || "";
    },
    [],
  );
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
  const [aboutOpen, setAboutOpen] = useState(false);
  // Bumped whenever a translation row is added/edited/deleted so the language
  // bar's pulse memo (keyed on validationVersion) re-runs even when the
  // translations-array length is unchanged (e.g. edit-in-place).
  const [validationVersion, setValidationVersion] = useState(0);
  // Per-item × per-locale spinner state for running AI translations.
  //   itemId → Set of locales OR "*" (the "translate all languages" sentinel).
  // The pulse-mode TaskCountContext fires us when *any* task completes (count
  // hits 0); we use that to clear the map. Persisted in React state only —
  // a page reload loses the spinners, by design.
  const [pendingAi, setPendingAi] = useState<Map<string, Set<string>>>(new Map());
  // When the user fires AI on a brand-new item, we don't have its id yet —
  // remember the scope+locale and transfer the pending entry the moment the
  // action response brings the new itemId back.
  const queuedForNewRef = useRef<{ scope: "this" | "all"; locale: string } | null>(null);
  const addPending = useCallback((itemId: string, scope: "this" | "all", locale: string) => {
    setPendingAi((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(itemId) || []);
      set.add(scope === "all" ? "*" : locale);
      next.set(itemId, set);
      return next;
    });
  }, []);
  /**
   * The three collector switches are a DRAFT until Save — the app-wide rule
   * (CLAUDE.md, "Field chrome"): a setting is never written by the click that
   * changes it. They used to fire an action per click, which is also why they
   * were mirrored locally "so the toggles feel snappy".
   *
   * All three save TOGETHER, in one request: they are one decision with two
   * refinements ("collect texts, and which ones"), the action already takes
   * them as one present-or-absent payload, and three save rows under three
   * switches in a settings panel is not a design, it is an accident.
   */
  const [collectOn, setCollectOn] = useState(collect);
  const [ignoreOn, setIgnoreOn] = useState(ignoreTranslateNo);
  const [filterOn, setFilterOn] = useState(filterByLanguage);
  useEffect(() => setCollectOn(collect), [collect]);
  useEffect(() => setIgnoreOn(ignoreTranslateNo), [ignoreTranslateNo]);
  useEffect(() => setFilterOn(filterByLanguage), [filterByLanguage]);
  const resetCollectorDraft = useCallback(() => {
    setCollectOn(collect);
    setIgnoreOn(ignoreTranslateNo);
    setFilterOn(filterByLanguage);
  }, [collect, ignoreTranslateNo, filterByLanguage]);
  /**
   * The page's navigation guards ask the save bar before switching item,
   * language or market — and that bar now also stands for the collector
   * switches. Once the merchant has CONFIRMED leaving, this draft is what they
   * chose to drop: without resetting it the bar stays up over a change nothing
   * else clears, and the same dialog greets every following click, forever.
   */
  const leaveGuard = useCallback(async () => {
    await confirmNavigation();
    resetCollectorDraft();
  }, [resetCollectorDraft]);

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
      const resolved = resolveTargetText(item, language, selectedMarketId);
      setDraftSource(item.sourceText);
      setBaseSource(item.sourceText);
      setDraftTarget(resolved);
      setBaseTarget(resolved);
      setEditingSource(false);
    },
    [resolveTargetText, selectedMarketId],
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
      await leaveGuard();
      const item = items.find((i) => i.id === id) || null;
      setSelectedId(id);
      setIsNew(false);
      loadEditor(item, currentLanguage);
    },
    [items, currentLanguage, loadEditor, isNew, selectedId, leaveGuard],
  );

  const handleAddNew = useCallback(async () => {
    await leaveGuard();
    setSelectedId(NEW_ID);
    setIsNew(true);
    setDraftSource("");
    setDraftTarget("");
    setBaseSource("");
    setBaseTarget("");
    setEditingSource(true);
    // `leaveGuard` in the deps, not an empty array: it closes over the loader
    // values the collector draft is reset TO, so a stale copy would put the
    // switches back to what they were before the last save.
  }, [leaveGuard]);

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
      await leaveGuard();
      setCurrentLanguage(language);
      // If the selected market does not serve the new locale, fall back to global
      // (a market-specific translation only makes sense for locales it offers).
      let effectiveMarket = selectedMarketId;
      if (selectedMarketId) {
        const m = markets.find((mk) => mk.id === selectedMarketId);
        if (!m || !m.localeCodes.includes(language)) {
          effectiveMarket = "";
          setSelectedMarketId("");
        }
      }
      if (!isNew && selectedItem) {
        const resolved = resolveTargetText(selectedItem, language, effectiveMarket);
        setDraftTarget(resolved);
        setBaseTarget(resolved);
      }
    },
    [currentLanguage, isNew, selectedItem, selectedMarketId, markets, resolveTargetText, leaveGuard],
  );

  const handleMarketChange = useCallback(
    async (marketId: string) => {
      if (marketId === selectedMarketId) return;
      await leaveGuard();
      setSelectedMarketId(marketId);
      // Re-resolve the editor for the new market (market override → global fallback).
      if (!isNew && selectedItem) {
        const resolved = resolveTargetText(selectedItem, currentLanguage, marketId);
        setDraftTarget(resolved);
        setBaseTarget(resolved);
      }
    },
    [selectedMarketId, isNew, selectedItem, currentLanguage, resolveTargetText, leaveGuard],
  );

  const editorHasChanges =
    (isNew && draftSource.trim().length > 0) ||
    (!isNew && selectedItem != null && (draftSource !== baseSource || draftTarget !== baseTarget));

  const isBusy = fetcher.state !== "idle";

  // Build UnifiedItemList items (title = source, subtitle = "n/m languages").
  // The blue "missing translations" dot mirrors the other content tabs and
  // its tooltip lists the actual locales that are still missing — matching
  // the per-locale field tooltips you get on Products/Collections.
  const listItems = useMemo(
    () =>
      items.map((i) => {
        // Coverage in the list reflects the GLOBAL layer (marketId ""); a
        // market-only override does not count a locale as globally translated.
        const presentLocales = new Set(
          i.translations
            .filter((tr) => tr.targetText.trim() && (tr.marketId ?? "") === "")
            .map((tr) => tr.locale),
        );
        const missingLocales = targetLocales.filter((l) => !presentLocales.has(l.locale));
        const n = presentLocales.size;
        const m = targetLocales.length;
        const hasMissing = m > 0 && missingLocales.length > 0;
        const tooltip = hasMissing
          ? `${t.common?.missingTranslations ?? "Missing translations:"} ${missingLocales
              .map((l) => getLocalizedLanguageName(l.locale, appLocale, l.name))
              .join(", ")}`
          : undefined;
        return {
          id: i.id,
          title: i.sourceText,
          subtitle: (tt.subtitleTranslated || "{n}/{m}").replace("{n}", String(n)).replace("{m}", String(m)),
          hasMissingTranslations: hasMissing,
          missingTranslationsTooltip: tooltip,
          isBusy: pendingAi.has(i.id),
        };
      }),
    [items, targetLocales, tt.subtitleTranslated, t.common?.missingTranslations, appLocale, pendingAi],
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

  /**
   * The collector switches ride on the page's ONE save bar.
   *
   * `SaveDiscardButtons` / `AppSaveBar` is not a pair of in-page buttons — it
   * is the native App Bridge `ui-save-bar` above the iframe, and only one can
   * be visible. A second one mounted for these switches REPLACED the editor's
   * bar while a translation draft was dirty, and its unmount then hid the bar
   * altogether, leaving that draft with no way to save and `confirmNavigation`
   * asking about the wrong thing.
   */
  const collectorChanged =
    collectOn !== collect || ignoreOn !== ignoreTranslateNo || filterOn !== filterByLanguage;

  const handleSave = useCallback(() => {
    submit({
      action: "save",
      itemId: isNew ? "" : selectedId || "",
      sourceText: draftSource,
      locale: currentLanguage,
      targetText: draftTarget,
      marketId: selectedMarketId,
    });
  }, [submit, isNew, selectedId, draftSource, currentLanguage, draftTarget, selectedMarketId]);

  /**
   * Its OWN fetcher, and that is not a preference.
   *
   * The bar can cover two independent drafts, and `router.fetch` begins by
   * ABORTING whatever is in flight on the same fetcher key — so saving both at
   * once on the page's fetcher killed the collector request mid-air, silently.
   * A second fetcher lets them fly together; the effect below reports its
   * failure the same way the page reports any other.
   */
  const collectorFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const saveCollectorSettings = useCallback(() => {
    // All three in ONE request: they are one decision with two refinements, and
    // the action already takes them as a single present-or-absent patch.
    const fd = new FormData();
    fd.append("action", "setCollectorSettings");
    fd.append("collect", String(collectOn));
    fd.append("ignoreTranslateNo", String(ignoreOn));
    fd.append("filterByLanguage", String(filterOn));
    collectorFetcher.submit(fd, { method: "POST" });
  }, [collectorFetcher, collectOn, ignoreOn, filterOn]);

  // Never silent: the page's own error surface, for the one save that does not
  // go through the shared fetcher the effect below watches.
  useEffect(() => {
    if (collectorFetcher.state !== "idle" || !collectorFetcher.data) return;
    if (collectorFetcher.data.success === false) {
      // Put the switches back, like the crawl and AEO drafts do: left standing,
      // they assert a value nobody stored and the save bar stays up for the
      // rest of the page's life.
      resetCollectorDraft();
      showInfoBox(collectorFetcher.data.error || t.common?.error || "Error", "critical");
    }
  }, [collectorFetcher.state, collectorFetcher.data, showInfoBox, t, resetCollectorDraft]);

  /** The bar covers two independent drafts; each half is saved only if it is
   *  the one that changed. */
  const handleSaveAll = useCallback(() => {
    if (collectorChanged) saveCollectorSettings();
    if (editorHasChanges) handleSave();
  }, [collectorChanged, saveCollectorSettings, editorHasChanges, handleSave]);

  const handleDiscard = useCallback(() => {
    resetCollectorDraft();
    // Only the half that is dirty. The bar can be up for the collector switches
    // alone, and running the editor branch then throws a merchant who is
    // composing a new entry out of the form they are typing in.
    if (!editorHasChanges) return;
    if (isNew) {
      setSelectedId(items[0]?.id || null);
      setIsNew(false);
      loadEditor(items[0] || null, currentLanguage);
    } else {
      loadEditor(selectedItem, currentLanguage);
    }
  }, [isNew, items, selectedItem, currentLanguage, loadEditor, resetCollectorDraft, editorHasChanges]);

  const enabledList = useMemo(() => JSON.stringify([...enabledLanguages]), [enabledLanguages]);

  const handleAi = useCallback(
    (scope: "this" | "all") => {
      const itemId = isNew ? "" : selectedId || "";
      if (itemId) {
        addPending(itemId, scope, currentLanguage);
      } else {
        // No id yet — remember the scope+locale so we can transfer it onto
        // the new id the moment the action response comes back (below).
        queuedForNewRef.current = { scope, locale: currentLanguage };
      }
      submit({ action: "ai", itemId, sourceText: draftSource, scope, locale: currentLanguage, locales: enabledList, marketId: selectedMarketId });
    },
    [submit, isNew, selectedId, draftSource, currentLanguage, enabledList, addPending, selectedMarketId],
  );

  const handleTransfer = useCallback(
    (scope: "this" | "all") => {
      submit({ action: "transfer", itemId: isNew ? "" : selectedId || "", sourceText: draftSource, scope, locale: currentLanguage, locales: enabledList, marketId: selectedMarketId });
    },
    [submit, isNew, selectedId, draftSource, currentLanguage, enabledList, selectedMarketId],
  );

  // Sidebar trash button: removes the WHOLE item (all locales). Used by the
  // shared UnifiedItemList; only enabled when an item is selected.
  const handleDeleteItem = useCallback(async (itemId: string) => {
    const ok = await confirm({
      title: tt.deleteItem,
      message: tt.deleteItemConfirm,
      confirmLabel: tt.deleteItem,
      destructive: true,
    });
    if (!ok) return;
    submit({ action: "deleteItem", itemId });
  }, [confirm, submit, tt.deleteItem, tt.deleteItemConfirm]);

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
    // Anything that touches the translation set on the server should bump the
    // validationVersion so the language-bar pulse memo re-runs (the array
    // length alone doesn't always change — e.g. user-edit in place).
    if (at === "save" || at === "ai" || at === "transfer" || at === "deleteTranslation" || at === "addCandidates") {
      setValidationVersion((v) => v + 1);
    }
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
      // If the user fired AI on a brand-new item, transfer the queued
      // pending entry onto the now-known id so the spinner appears.
      if (at === "ai" && queuedForNewRef.current) {
        const q = queuedForNewRef.current;
        addPending(fetcher.data.itemId, q.scope, q.locale);
        queuedForNewRef.current = null;
      }
    }
    // Candidate mutations already committed server-side → refresh the modal list.
    if ((at === "addCandidates" || at === "rejectCandidates" || at === "clearCandidates") && candidatesOpen) reloadCandidates();
    revalidator.revalidate();
  }, [fetcher.data, revalidator, showInfoBox, candidatesOpen, reloadCandidates, t, addPending]);

  // Background AI tasks: when the running-task count drops to zero, pull fresh
  // data (and refresh the candidate modal) so completed translations show up,
  // and clear the spinner-tracking map.
  const prevRunning = useRef(runningTaskCount);
  useEffect(() => {
    if (prevRunning.current > 0 && runningTaskCount === 0) {
      revalidator.revalidate();
      if (candidatesOpen) reloadCandidates();
      setPendingAi(new Map());
      queuedForNewRef.current = null;
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

  // Per-button spinner state for the currently selected item. "*" is the
  // sentinel for "translate all languages" — when it's pending, BOTH buttons
  // spin (because "this" is included in "all").
  const selectedPending = selectedId ? pendingAi.get(selectedId) : undefined;
  const translateAllLoading = !!selectedPending?.has("*");
  const translateThisLoading = translateAllLoading || (!!currentLanguage && !!selectedPending?.has(currentLanguage));

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
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* Capped at .app-page-width-start (responsive.css :root) — this page
            has no item sidebar, so nothing else would stop the right column
            from growing on a wide screen. The cap includes the item column, so
            the translation column beside it comes out at the same reading width
            as an SEO page. Left-aligned: the list stays flush with the gutter. */}
        <div className="app-page-width-start" style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", gap: "var(--app-page-padding)", padding: "var(--app-page-padding)", boxSizing: "border-box" }}>
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
                sortTooltip: t.content?.sortTooltip,
                reloadAllTooltip: t.content?.reloadAllTooltip,
              }}
            />
          </div>

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingRight: "0.25rem" }}>
            <BlockStack gap="400">
              {!hasTargets && <Banner tone="warning">{tt.noTargetLocales}</Banner>}

              {/* Merged About + Collector card. Intro + collapsible long-form
                  explanation, then the storefront collector toggle and its
                  secondary settings (gated on the toggle being on). */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">{tt.resourcePlural}</Text>
                  <Text as="p">{tt.aboutIntro}</Text>
                  <InlineStack align="start">
                    <Button
                      variant="plain"
                      onClick={() => setAboutOpen((v) => !v)}
                      ariaExpanded={aboutOpen}
                      ariaControls="dt-about-details"
                    >
                      {tt.aboutLearnMore}
                    </Button>
                  </InlineStack>
                  <Collapsible
                    id="dt-about-details"
                    open={aboutOpen}
                    transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
                  >
                    <Box paddingBlockStart="200">
                      <BlockStack gap="300">
                        <Text as="p" tone="subdued">{tt.aboutDetails}</Text>
                        <Text as="p" tone="subdued">{tt.aboutWorkflow}</Text>
                        <InlineStack align="start">
                          {/* Every app embed is activated in Settings → Setup,
                              not from the feature that happens to need it. */}
                          <Button
                            onClick={() =>
                              handleNavigate("/app/settings", {
                                searchParams: new URLSearchParams({ tab: "setup" }),
                              })
                            }
                            variant="primary"
                            size="slim"
                          >
                            {(tt as unknown as Record<string, string>).activateInSettings ?? tt.openThemeEditor}
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  </Collapsible>

                  <Divider />

                  <ToggleRow
                    label={tt.collectToggle}
                    help={tt.collectHelp}
                    checked={collectOn}
                    onChange={setCollectOn}
                  />

                  {collectOn && (
                    <>
                      <ToggleRow
                        label={tt.ignoreTranslateNoToggle}
                        help={tt.ignoreTranslateNoHelp}
                        checked={ignoreOn}
                        onChange={setIgnoreOn}
                      />
                      <ToggleRow
                        label={tt.filterByLanguageToggle}
                        help={tt.filterByLanguageHelp}
                        checked={filterOn}
                        onChange={setFilterOn}
                      />
                    </>
                  )}

                  {/* The workflow below follows the STORED setting, not the
                      draft: nothing is being collected until the switch is
                      saved, so offering "visit the storefront, then look at
                      what was found" beforehand promises a list that cannot
                      fill. The two switches above it are the opposite case —
                      they are what is being configured. */}
                  {collect && (
                    <>
                      <Divider />

                      <BlockStack gap="200">
                        <Text as="p" tone="subdued" variant="bodySm">{tt.visitStorefrontExplain}</Text>
                        <InlineStack gap="200" wrap>
                          <Button url={shopUrl} target="_blank" external>
                            {tt.visitStorefront}
                          </Button>
                          <Button variant="primary" onClick={() => { setCandidatesOpen(true); reloadCandidates(); }}>
                            {newCandidateCount > 0 ? `${tt.foundTexts} (${newCandidateCount})` : tt.foundTexts}
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </>
                  )}
                </BlockStack>
              </Card>

              {/* Language bar — shared component for uniformity with the other
                  content tabs (status colours, Ctrl/Cmd-click toggle, tooltips).
                  Skipped for single-language shops unless a market override is
                  still selectable (the bar itself renders null there, so the
                  Card would otherwise stay behind as an empty box). Translating
                  DOES stay available here: a direct-translation source string is
                  arbitrary storefront text, so translating it into the shop's
                  only language is a valid operation. */}
              {shouldRenderLanguageBar({
                localeCount: barLocales.length,
                marketCount: markets.length,
                hasMarketHandler: true,
                allowPrimaryLocaleMarket: true,
              }) && (
              <Card>
                <UnifiedLanguageBar
                  shopLocales={barLocales}
                  currentLanguage={currentLanguage}
                  primaryLocale={primaryLocale}
                  selectedItem={languageBarItem}
                  contentType={"directTranslations" as ContentType}
                  hasChanges={editorHasChanges}
                  onLanguageChange={(loc) => { void handleLanguageChange(loc); }}
                  markets={markets}
                  selectedMarketId={selectedMarketId}
                  onMarketChange={(id) => { void handleMarketChange(id); }}
                  // DirectTranslations is a custom storefront dictionary: a market
                  // override is valid for ANY locale, including the primary one.
                  allowPrimaryLocaleMarket
                  enabledLanguages={Array.from(new Set([primaryLocale, ...enabledLanguages]))}
                  onToggleLanguage={toggleLanguage}
                  showTranslateAll={false}
                  showReloadButton={false}
                  validationVersion={validationVersion}
                  t={{
                    primaryLocaleSuffix: t.content?.primaryLanguageSuffix,
                    allMarketsGlobal: t.content?.market?.allMarketsGlobal || "All markets (global)",
                    marketSelectorLabel: t.content?.market?.selectorLabel || "Market",
                    marketTooltip: t.content?.market?.tooltip,
                    marketPrimaryDisabledHint: t.content?.market?.primaryDisabledHint,
                  }}
                />
              </Card>
              )}

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

                    {/* 4 action buttons — same iconography as Products
                        (🌍 translate, 📋 transfer). The "in alle Sprachen"
                        variants are variant=primary (dark) so the merchant
                        can tell them apart from the single-language ones.
                        Spinner+disable: translateAllLoading covers everything
                        kicked off by "all"; translateThisLoading also fires
                        when "all" is running (this locale is part of "all"). */}
                    <InlineStack gap="200" wrap>
                      <ButtonGroup>
                        <Button
                          variant="primary"
                          loading={translateAllLoading}
                          disabled={!hasTargets || !draftSource.trim() || isBusy || translateAllLoading}
                          onClick={() => handleAi("all")}
                        >
                          {`🌍 ${tt.translateAllLangs}`}
                        </Button>
                        <Button
                          loading={translateThisLoading}
                          disabled={!hasTargets || !draftSource.trim() || isBusy || translateThisLoading}
                          onClick={() => handleAi("this")}
                        >
                          {`🌍 ${tt.translateThisLang}`}
                        </Button>
                      </ButtonGroup>
                      <ButtonGroup>
                        <Button variant="primary" disabled={!hasTargets || !draftSource.trim() || isBusy} onClick={() => handleTransfer("all")}>
                          {`📋 ${tt.transferAllLangs}`}
                        </Button>
                        <Button disabled={!hasTargets || !draftSource.trim() || isBusy} onClick={() => handleTransfer("this")}>
                          {`📋 ${tt.transferThisLang}`}
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
                        <Button tone="critical" variant="plain" onClick={() => setDraftTarget("")} disabled={isBusy || !draftTarget}>
                          {t.common?.clear || "Clear"}
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </div>
        </div>

        <AppSaveBar
          hasChanges={editorHasChanges || collectorChanged}
          onSave={handleSaveAll}
          onDiscard={handleDiscard}
          // BOTH fetchers: during a collector-only save the shared one is idle,
          // so Save stayed enabled and a second click re-submitted — and
          // `router.fetch` aborts the first request on that same key, which is
          // exactly what the second fetcher exists to avoid.
          loading={isBusy || collectorFetcher.state !== "idle"}
          saveText={t.content?.save}
          discardText={t.content?.discardChanges}
        />

        <FoundTextsModal
          open={candidatesOpen}
          onClose={() => setCandidatesOpen(false)}
          tt={tt}
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
        border: `1px solid ${checked ? "#008060" : "var(--app-surface-border-color)"}`,
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
  fetcher,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  tt: ReturnType<typeof useI18n>["t"]["directTranslations"];
  fetcher: ReturnType<typeof useFetcher<{ success?: boolean; newItems?: Array<{ id: string; sourceText: string; count: number }>; rejectedItems?: Array<{ id: string; sourceText: string; count: number }> }>>;
  onAction: (action: string, payload: Record<string, string>) => void;
}) {
  const confirm = useConfirm();
  const [selectedNew, setSelectedNew] = useState<Set<string>>(new Set());
  const [selectedRejected, setSelectedRejected] = useState<Set<string>>(new Set());

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
  // All actions operate on the union of both selection sets so the merchant
  // can mix-and-match across the "new" / "rejected" sections without losing
  // a selection when switching focus. Reject is the one exception: rejected
  // candidates can't be rejected again, so it only ever sees the "new" set.
  const allSelectedIds = [...selectedNew, ...selectedRejected];
  const hasAnySelection = allSelectedIds.length > 0;
  const clearSelections = () => { setSelectedNew(new Set()); setSelectedRejected(new Set()); };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tt.modalTitle}
      size="large"
      // Order left → right: Hinzufügen, Hinzufügen+KI, Ablehnen, Kandidaten löschen.
      // (No primaryAction — Polaris would push it to the far right, breaking
      // that order; the consistent secondary row keeps the user-requested flow.)
      secondaryActions={[
        {
          content: tt.modalAdd,
          disabled: !hasAnySelection,
          onAction: () => {
            onAction("addCandidates", { ids: JSON.stringify(allSelectedIds), withAi: "false" });
            clearSelections();
          },
        },
        {
          content: tt.modalAddWithAi,
          disabled: !hasAnySelection,
          onAction: () => {
            onAction("addCandidates", { ids: JSON.stringify(allSelectedIds), withAi: "true" });
            clearSelections();
          },
        },
        {
          content: tt.modalReject,
          destructive: true,
          disabled: selectedNew.size === 0,
          onAction: () => {
            onAction("rejectCandidates", { ids: JSON.stringify([...selectedNew]) });
            setSelectedNew(new Set());
          },
        },
        {
          content: tt.modalClearAll,
          destructive: true,
          disabled: totalCount === 0,
          onAction: async () => {
            const ok = await confirm({
              title: tt.modalClearAll,
              message: tt.modalClearAllConfirm,
              confirmLabel: tt.modalClearAll,
              destructive: true,
            });
            if (!ok) return;
            clearSelections();
            onAction("clearCandidates", {});
          },
        },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">{tt.modalNewHeading}</Text>
            {loading && newItems.length === 0 ? (
              <Spinner size="small" />
            ) : newItems.length === 0 ? (
              <Text as="p" tone="subdued">{tt.modalEmpty}</Text>
            ) : (
              <InlineStack gap="200" wrap>
                {newItems.map((it) => (
                  <CandidatePill key={it.id} item={it} seenLabel={seenLabel} checked={selectedNew.has(it.id)} onToggle={() => toggle(selectedNew, setSelectedNew, it.id)} />
                ))}
              </InlineStack>
            )}
          </BlockStack>

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" tone="subdued">{tt.modalRejectedHeading}</Text>
            {rejectedItems.length === 0 ? (
              <Text as="p" tone="subdued">{tt.modalRejectedEmpty}</Text>
            ) : (
              <InlineStack gap="200" wrap>
                {rejectedItems.map((it) => (
                  <CandidatePill key={it.id} item={it} seenLabel={seenLabel} checked={selectedRejected.has(it.id)} onToggle={() => toggle(selectedRejected, setSelectedRejected, it.id)} />
                ))}
              </InlineStack>
            )}
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
