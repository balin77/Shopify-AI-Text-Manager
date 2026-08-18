/**
 * Menus — translate navigation items, at every level.
 *
 * This page used to say "Shopify does not support translating menu items" and
 * render every field disabled. That was an assumption, never a measurement,
 * and it has since been measured to be wrong (2026-08, live shop,
 * /api/menu-translation-probe under Settings -> Probes -> Translation;
 * identical on 2025-10 and 2026-07):
 *
 *   - Every menu item at EVERY depth has its own Link resource with the single
 *     key title. 59 links for 59 items across depths 1-3, none absent.
 *   - gid://shopify/MenuItem/<n> corresponds to gid://shopify/Link/<n> — the
 *     SAME number — so a child is addressable without any enumeration.
 *   - Registering on such a Link echoes, a fresh read returns the value, and
 *     removing it is confirmed too: the full cycle, on a depth-3 item.
 *   - What does NOT work is the documented enumeration:
 *     nestedTranslatableResources(resourceType: LINK) returns ZERO links for
 *     every menu at every depth. Reading menus as untranslatable is what that
 *     empty answer looks like from the inside — which is how the wrong claim
 *     got here in the first place.
 *
 * Two deliberate limits. PRIMARY values stay read-only: renaming a menu item
 * or restructuring a menu is menuUpdate's job, it is not translation, and the
 * mutation replaces the whole item tree — a page that offers text fields over
 * a cached tree would be one stale load away from reordering a merchant's
 * navigation. And translations are GLOBAL (no market scope): whether a
 * market-scoped menu translation behaves like a global one is UNMEASURED, and
 * the market selector would promise a behaviour nobody has verified.
 *
 * The item column is the shared UnifiedItemList, not a bespoke one: below
 * 900px `.desktop-only` hides it and the navbar's compact selector takes over,
 * which only works for pages that register their items with ItemSelectorContext.
 *
 * Still unmeasured and therefore not claimed anywhere in the UI: whether a
 * translated sub-item RENDERS in the storefront navigation. Shopify's own
 * editor writes the same resource, so it is likely — but likely is not
 * measured, and this file has already paid for that difference once.
 */

import { useState, useEffect, useMemo, useCallback, useRef, type ReactElement } from "react";
import { useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Banner,
  Button,
  TextField,
} from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { AppSaveBar } from "../components/AppSaveBar";
import { DisabledActionTooltip } from "../components/DisabledActionTooltip";
import { UnifiedItemList, type UnifiedItem } from "../components/unified/UnifiedItemList";
import { UnifiedLanguageBar, shouldRenderLanguageBar } from "../components/unified/UnifiedLanguageBar";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import type { ShopLocale, TranslatableItem, ContentType } from "../types/content-editor.types";
// The translation-state colours and the per-field action footer live here.
// The stylesheet is imported per component in this codebase, not globally, so
// a page that uses `bg-missing-translation` / `bg-untranslated` / the footer
// classes without this import renders them as plain unstyled markup.
import "../styles/AIEditableField.css";
import { createContentLoader } from "~/utils/loader-factory.server";
import {
  flattenMenuItems,
  diffMenuTranslations,
  type FlatMenuItem,
} from "~/services/menu-translations.shared";
import type { ActionFunctionArgs } from "react-router";

/** What the loader hands the client per Link GID. */
interface LinkTranslationDTO {
  primaryTitle: string | null;
  translatable: boolean;
  byLocale: Record<string, string>;
}

// ============================================================================
// LOADER — menu sync + every Link translation of the shop
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "MENUS",
  resourceType: null, // Menu itself carries only its admin-only name.
  itemsKey: "menus",

  async loadData(ctx) {
    // Every tree, every load. Menus have no Shopify webhook, and the previous
    // incremental sync only fetched menus MISSING from the DB — so a tree was
    // read once and never again: items added in Shopify never showed up, and
    // deleted ones kept rendering as "not translatable". One query for the
    // whole shop replaces the per-menu round trips it used to make.
    try {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { refreshMenuCache } = await import("~/services/menu-translations.server");
      await refreshMenuCache(
        new ShopifyApiGateway(ctx.admin, ctx.session.shop),
        ctx.db,
        ctx.session.shop,
      );
    } catch (error) {
      // A thrown Response is the framework's business, not a refresh failure:
      // createContentLoader turns a 401 into "delete the stale session, show
      // Session expired, re-authenticate on the next request". Swallowing it
      // would leave a revoked token serving cached menus with every field
      // disabled — forever, since nothing would ever trigger the recovery.
      if (error instanceof Response) throw error;
      // Anything else shows the CACHED menus rather than an error page —
      // stale navigation labels are worth more than no page at all, and the
      // save path re-reads from Shopify anyway.
      const { logger } = await import("~/utils/logger.server");
      logger.error("[MENUS-LOADER] Menu refresh failed — serving cached menus", {
        context: "Menus",
        shop: ctx.session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const menus = await ctx.db.menu.findMany({
      where: { shop: ctx.session.shop },
      orderBy: { title: "asc" },
    });

    return { items: menus, ids: [] };
  },

  /**
   * The Link sweep. Shop-wide rather than per-menu on purpose: the per-menu
   * nested connection returns nothing, and the sweep costs one query for the
   * whole shop in every locale at once. It is read LIVE rather than from
   * ContentTranslation because a shop that translated its menus in Shopify's
   * own editor has values this app has never seen — showing empty fields over
   * them would invite overwriting work the merchant already did.
   */
  async extraData(ctx) {
    // PUBLISHED and non-primary. An unpublished locale is not served to any
    // customer, so offering to translate into it would spend the merchant's
    // time on text nobody can reach — the same filter app.bulk.tsx applies.
    // `published` comes from getCachedShopLocales at runtime; the loader
    // factory's ShopLocale type predates the field, hence the widening. An
    // ABSENT flag counts as published — never gate a feature on a lookup that
    // did not answer.
    const foreignLocales = (ctx.shopLocales as Array<{
      locale: string;
      primary: boolean;
      published?: boolean;
    }>)
      .filter((l) => l.published !== false && !l.primary)
      .map((l) => l.locale);

    if (foreignLocales.length === 0) {
      return { linkTranslations: {} as Record<string, LinkTranslationDTO>, linkSweepTruncated: false };
    }

    try {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { fetchShopLinkTranslations } = await import("~/services/menu-translations.server");
      const gateway = new ShopifyApiGateway(ctx.admin, ctx.session.shop);
      const sweep = await fetchShopLinkTranslations(gateway, foreignLocales);

      const linkTranslations: Record<string, LinkTranslationDTO> = {};
      for (const [linkId, row] of sweep.rows) {
        linkTranslations[linkId] = {
          primaryTitle: row.primaryTitle,
          // No digest means translationsRegister cannot be called for it, so
          // the field must not pretend to be editable.
          translatable: !!row.digest,
          byLocale: row.byLocale,
        };
      }
      return { linkTranslations, linkSweepTruncated: sweep.truncated };
    } catch (error) {
      // Same rule as the refresh above: a 401 belongs to the loader factory's
      // session recovery, not to this catch.
      if (error instanceof Response) throw error;
      const { logger } = await import("~/utils/logger.server");
      logger.error("[MENUS-LOADER] Link sweep failed", {
        context: "Menus",
        shop: ctx.session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
      // An empty map with truncated=true reads as "incomplete", never as
      // "these items are untranslatable" — the exact distinction this page
      // got wrong for years.
      return { linkTranslations: {} as Record<string, LinkTranslationDTO>, linkSweepTruncated: true };
    }
  },

  errorFallback: { linkTranslations: {} as Record<string, LinkTranslationDTO>, linkSweepTruncated: false },
});

// ============================================================================
// ACTION — save one locale's menu-item translations
// ============================================================================

export async function action({ request }: ActionFunctionArgs) {
  const { authenticate } = await import("../shopify.server");
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("~/db.server");
  const { canAccessContentType } = await import("~/utils/planUtils");
  const { isValidLocale } = await import("~/utils/validation");

  // Directly POST-reachable, so the plan gate lives here as well as in the UI.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!canAccessContentType((settings?.subscriptionPlan || "free") as never, "menus")) {
    return Response.json({ success: false, error: "gated" }, { status: 403 });
  }

  const formData = await request.formData();

  // Per-LOCALE payload, not a single locale. The per-entry buttons write into
  // several languages at once ("translate into all languages"), and the native
  // save bar is one button for whatever is pending — so a save that could only
  // carry one language would silently drop the rest of the merchant's work.
  let byLocale: Record<string, Array<{ linkId: string; value: string }>> = {};
  try {
    const parsed = JSON.parse(String(formData.get("changesByLocale") || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [locale, entries] of Object.entries(parsed)) {
        if (!isValidLocale(locale) || !Array.isArray(entries)) continue;
        byLocale[locale] = entries
          .filter((c) => c && typeof c.linkId === "string" && typeof c.value === "string")
          .map((c) => ({ linkId: c.linkId, value: String(c.value).trim() }));
      }
    }
  } catch {
    return Response.json({ success: false, error: "Malformed changes" }, { status: 400 });
  }

  const locales = Object.keys(byLocale).filter((l) => byLocale[l].length > 0);
  if (locales.length === 0) {
    return Response.json({ success: true, saved: {}, failures: [] });
  }

  const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
  const { fetchShopLinkTranslations, saveMenuLinkTranslations } = await import(
    "~/services/menu-translations.server"
  );
  const gateway = new ShopifyApiGateway(admin, session.shop);

  // Digests are re-read server-side and NEVER taken from the client — the same
  // rule the bulk editor follows for its column universe. It doubles as the
  // authorization check on the ids themselves: the sweep is scoped to this
  // shop, so an id it does not contain cannot be written, and this action can
  // never become a generic "translate any Link" endpoint. ONE sweep serves
  // every locale: the digest belongs to the primary value, not to a language.
  let sweep;
  try {
    sweep = await fetchShopLinkTranslations(gateway, []);
  } catch (error) {
    // Without this the whole action throws, the error boundary renders and
    // the merchant's unsaved draft is gone — while every OTHER failure on
    // this path is reported per item and keeps the draft on screen.
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        saved: {},
        failures: [],
      },
      { status: 502 },
    );
  }

  const saved: Record<string, string[]> = {};
  const failures: Array<{ linkId: string; locale: string; message: string }> = [];

  // translationsRegister addresses ONE resource, so a save is one round trip
  // per item per language: five languages over sixty items is 300 calls in a
  // single HTTP request, which is a timeout, not a save. The bulk editor bounds
  // the same shape at MAX_SYNC_SAVE. Here the budget is spent in order and the
  // remainder is simply not written — those entries stay in the draft (they
  // never reach `saved`), so pressing save again continues where this stopped,
  // and the response says how many are left rather than pretending to be done.
  const MAX_WRITES_PER_SAVE = 100;
  let budget = MAX_WRITES_PER_SAVE;
  let deferred = 0;

  for (const locale of locales) {
    const entries = [];
    for (const change of byLocale[locale]) {
      if (budget <= 0) {
        deferred += 1;
        continue;
      }
      const row = sweep.rows.get(change.linkId);
      if (!row) {
        failures.push({ linkId: change.linkId, locale, message: "Unknown menu item for this shop." });
        continue;
      }
      entries.push({ linkId: change.linkId, value: change.value, digest: row.digest });
      budget -= 1;
    }

    const result = await saveMenuLinkTranslations(
      gateway,
      db,
      session.shop,
      locale,
      "", // Global only — a market-scoped menu translation is unmeasured.
      entries,
    );
    saved[locale] = result.savedLinkIds;
    for (const failure of result.failures) failures.push({ ...failure, locale });
  }

  return Response.json({ success: true, saved, failures, deferred });
}

// ============================================================================
// UI
// ============================================================================

export default function MenusPage() {
  const { menus, shopLocales, primaryLocale, error, linkTranslations, linkSweepTruncated } =
    useLoaderData<typeof loader>();
  const { t, locale: appLocale } = useI18n();
  const { registerItems, clearItems } = useItemSelector();
  type SaveResponse = {
    success: boolean;
    error?: string;
    saved?: Record<string, string[]>;
    failures?: Array<{ linkId: string; locale: string; message: string }>;
    /** Changes the server's per-request write budget did not reach. */
    deferred?: number;
  };
  /** The manual save bar. */
  const fetcher = useFetcher<SaveResponse>();
  /**
   * The per-entry buttons' own save. A SECOND fetcher on purpose: sharing one
   * would make the save bar spin for an action it did not start, and would let
   * one response prune the other's draft bookkeeping.
   */
  const autoFetcher = useFetcher<SaveResponse>();

  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [activeLocale, setActiveLocale] = useState<string>(primaryLocale);
  /**
   * locale -> linkId -> pending value.
   *
   * Keyed by LOCALE, not just by link: the per-entry buttons fill several
   * languages from one click, and a draft that only ever held the language on
   * screen would throw the rest away the moment the merchant looked at it.
   */
  const [draftByLocale, setDraftByLocale] = useState<Record<string, Record<string, string>>>({});
  const [busyLinkIds, setBusyLinkIds] = useState<Set<string>>(new Set());
  /**
   * Values written by the translate / copy buttons while their save is in
   * flight.
   *
   * Deliberately NOT the draft. Those buttons persist by themselves, so their
   * result is never unsaved work and the save bar must not appear for it —
   * a bar that pops up after an action that already saved asks the merchant to
   * confirm something that is done. They are shown from here until the loader
   * comes back carrying them, and only a FAILED one is moved into the draft,
   * where the bar is then exactly right: there really is unsaved work.
   */
  const [autoPending, setAutoPending] = useState<Record<string, Record<string, string>>>({});
  /** The last auto-save's outcome. See the settle effect for why it is state. */
  const [autoFailures, setAutoFailures] = useState<
    Array<{ linkId: string; locale: string; message: string }>
  >([]);
  const [autoError, setAutoError] = useState<string | undefined>(undefined);
  /** Exactly what the in-flight save submitted, captured at click time. */
  const submittedRef = useRef<Record<string, Array<{ linkId: string; value: string }>> | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);

  const localeList = useMemo(
    () => (shopLocales || []).filter((l: any) => l.primary || l.published !== false),
    [shopLocales],
  );
  const foreignLocales = useMemo(
    () => localeList.filter((l: any) => !l.primary).map((l: any) => l.locale as string),
    [localeList],
  );
  // Single-language shops keep every action VISIBLE and disabled with a reason
  // — hiding them reads as a missing feature. Only the locale bar disappears.
  const singleLocaleHint = foreignLocales.length === 0 ? t.common?.requiresSecondLanguage : undefined;
  const isPrimary = activeLocale === primaryLocale;

  const parsedMenus = useMemo(
    () => (menus || []).map((menu: any) => ({ ...menu, flat: flattenMenuItems(menu.items) })),
    [menus],
  );
  const selectedMenu = parsedMenus.find((m: any) => m.id === selectedMenuId);

  useEffect(() => {
    if (parsedMenus.length > 0 && !selectedMenuId) setSelectedMenuId(parsedMenus[0].id);
  }, [parsedMenus, selectedMenuId]);

  // ── Values ───────────────────────────────────────────────────────────────

  /**
   * Whether the sweep actually told us about this link. A link with no row is
   * UNKNOWN, not untranslated — the sweep may have failed or hit its page cap.
   * Every "is something missing here" question below goes through this first,
   * because painting unknown as missing is how a page ends up showing a blue
   * dot, a pulsing language button and a "not translatable" hint on the same
   * field at the same time.
   */
  const isKnown = useCallback(
    (linkId: string): boolean => !!(linkTranslations || {})[linkId],
    [linkTranslations],
  );

  /** What Shopify holds for a locale — the diff baseline. */
  const savedFor = useCallback(
    (locale: string, linkId: string): string =>
      ((linkTranslations || {})[linkId] as LinkTranslationDTO | undefined)?.byLocale?.[locale] ?? "",
    [linkTranslations],
  );
  /**
   * What is on screen. A manual edit wins over an auto-saved value still in
   * flight (the merchant typed later), and both win over what is stored.
   */
  const valueFor = useCallback(
    (locale: string, linkId: string): string =>
      draftByLocale[locale]?.[linkId] ?? autoPending[locale]?.[linkId] ?? savedFor(locale, linkId),
    [draftByLocale, autoPending, savedFor],
  );
  const isMissingIn = useCallback(
    (locale: string, linkId: string): boolean =>
      isKnown(linkId) && !valueFor(locale, linkId).trim(),
    [isKnown, valueFor],
  );

  const setDraftValue = useCallback((locale: string, linkId: string, value: string) => {
    setDraftByLocale((prev) => ({ ...prev, [locale]: { ...(prev[locale] ?? {}), [linkId]: value } }));
  }, []);

  // ── What a save would write ──────────────────────────────────────────────

  /**
   * The links the merchant can currently SEE. Drafts are keyed by Link GID
   * across the whole shop, so without this scope a Save pressed in one menu
   * would publish an edit parked in another — and the save bar would appear
   * for changes that are nowhere on screen.
   */
  const visibleLinkIds = useMemo(
    () =>
      new Set(
        ((selectedMenu?.flat ?? []) as FlatMenuItem[])
          .map((i) => i.linkId)
          .filter((id): id is string => !!id),
      ),
    [selectedMenu],
  );

  const changesByLocale = useMemo(() => {
    const out: Record<string, Array<{ linkId: string; value: string }>> = {};
    for (const locale of foreignLocales) {
      const scoped: Record<string, string> = {};
      for (const [linkId, value] of Object.entries(draftByLocale[locale] ?? {})) {
        if (visibleLinkIds.has(linkId)) scoped[linkId] = value;
      }
      const baseline: Record<string, string> = {};
      for (const linkId of Object.keys(scoped)) baseline[linkId] = savedFor(locale, linkId);
      const changes = diffMenuTranslations(baseline, scoped);
      if (changes.length > 0) out[locale] = changes;
    }
    return out;
  }, [foreignLocales, draftByLocale, visibleLinkIds, savedFor]);

  const changeCount = useMemo(
    () => Object.values(changesByLocale).reduce((sum, list) => sum + list.length, 0),
    [changesByLocale],
  );
  const isSaving = fetcher.state !== "idle";

  const onSave = useCallback(() => {
    if (changeCount === 0) return;
    // Captured HERE, synchronously, not in an effect: an effect that also
    // depends on changesByLocale re-captures while the request is in flight,
    // so a keystroke made during the save would match the response and get
    // deleted from the draft — silently reverting what the merchant just typed.
    submittedRef.current = changesByLocale;
    const fd = new FormData();
    fd.set("changesByLocale", JSON.stringify(changesByLocale));
    fetcher.submit(fd, { method: "post" });
  }, [changeCount, changesByLocale, fetcher]);

  const onDiscard = useCallback(() => {
    // Only what this save bar would have written. The bar appears for the
    // VISIBLE menu, so discarding edits parked in another menu would throw
    // away work the merchant was never told was at stake.
    setDraftByLocale((prev) => {
      const next: Record<string, Record<string, string>> = {};
      for (const [locale, entries] of Object.entries(prev)) {
        const kept: Record<string, string> = {};
        for (const [linkId, value] of Object.entries(entries)) {
          if (!visibleLinkIds.has(linkId)) kept[linkId] = value;
        }
        next[locale] = kept;
      }
      return next;
    });
    setTranslateError(null);
  }, [visibleLinkIds]);

  // Confirmed values return through the loader on revalidation, so the draft
  // only drops what was saved — and only where it still equals what was sent.
  // Anything edited again mid-save, and anything that FAILED, stays put.
  useEffect(() => {
    const saved = fetcher.data?.saved;
    const submitted = submittedRef.current;
    if (!saved || !submitted) return;
    setDraftByLocale((prev) => {
      const next = { ...prev };
      for (const [locale, linkIds] of Object.entries(saved)) {
        const sent = new Map((submitted[locale] ?? []).map((c) => [c.linkId, c.value]));
        const bucket = { ...(next[locale] ?? {}) };
        for (const linkId of linkIds) {
          if ((bucket[linkId] ?? "").trim() === sent.get(linkId)) delete bucket[linkId];
        }
        next[locale] = bucket;
      }
      return next;
    });
  }, [fetcher.data]);
  // ── AI translate / copy, per entry ───────────────────────────────────────

  const withBusy = useCallback(async (linkId: string, run: () => Promise<void>) => {
    setBusyLinkIds((prev) => new Set(prev).add(linkId));
    try {
      await run();
    } finally {
      setBusyLinkIds((prev) => {
        const next = new Set(prev);
        next.delete(linkId);
        return next;
      });
    }
  }, []);

  /**
   * One AI translation. Deliberately the PURE `translateField` action, which
   * translates and returns without persisting: the result lands in the draft
   * and is written by the page's own echo-verified save. Menus must not gain
   * a second write path.
   */
  const translateOne = useCallback(
    async (linkId: string, sourceText: string, targetLocale: string): Promise<string | null> => {
      const fd = new FormData();
      fd.set("action", "translateField");
      fd.set("contentType", "menus");
      fd.set("itemId", linkId);
      fd.set("fieldType", "title");
      fd.set("sourceText", sourceText);
      fd.set("targetLocale", targetLocale);
      fd.set("primaryLocale", primaryLocale);
      const response = await fetch("/api/ai", { method: "POST", body: fd });
      const payload = (await response.json()) as { success?: boolean; translatedValue?: string; error?: string };
      if (!payload?.success || typeof payload.translatedValue !== "string") {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload.translatedValue;
    },
    [primaryLocale],
  );

  /**
   * Persist one entry's values right away, through the SAME action the save
   * bar uses — one echo-verified write path, no second one for buttons.
   *
   * The values go to `autoPending` rather than the draft, so the save bar
   * never appears for work that is already on its way: these actions save by
   * themselves, and a bar asking to confirm them afterwards is a question the
   * merchant has no reason to answer.
   */
  const autoSave = useCallback(
    (valuesByLocale: Record<string, string>, linkId: string) => {
      const entries = Object.entries(valuesByLocale).filter(([, value]) => !!value.trim());
      if (entries.length === 0) return;

      setAutoPending((prev) => {
        const next = { ...prev };
        for (const [locale, value] of entries) {
          next[locale] = { ...(next[locale] ?? {}), [linkId]: value };
        }
        return next;
      });
      // And drop any manual edit of the same field. `valueFor` resolves the
      // draft FIRST, so a leftover draft entry would hide the value that was
      // just saved, keep the save bar claiming an unsaved change, and let the
      // next Save write the old text back over it.
      setDraftByLocale((prev) => {
        const next = { ...prev };
        for (const [locale] of entries) {
          if (!next[locale] || !(linkId in next[locale])) continue;
          const bucket = { ...next[locale] };
          delete bucket[linkId];
          next[locale] = bucket;
        }
        return next;
      });

      const changesByLocale: Record<string, Array<{ linkId: string; value: string }>> = {};
      for (const [locale, value] of entries) changesByLocale[locale] = [{ linkId, value }];

      setAutoFailures([]);
      setAutoError(undefined);
      const fd = new FormData();
      fd.set("changesByLocale", JSON.stringify(changesByLocale));
      autoFetcher.submit(fd, { method: "post" });
    },
    [autoFetcher],
  );

  /**
   * Settle every pending value when the auto-save answers.
   *
   * Confirmed ones simply drop — the loader revalidation carries them now.
   * EVERYTHING else moves into the draft: a per-item failure, a transport
   * error that saved nothing, a value the server's write budget did not
   * reach. Only two outcomes are acceptable for a value the merchant can
   * see — it is stored, or it is visibly unsaved with the save bar offering
   * a retry. Leaving it "pending" would be a third one: shown as if saved,
   * with its button spinning forever.
   *
   * A second auto-save still in flight can be rescued into the draft by this
   * too. That is self-healing rather than wrong: when its own response lands
   * the loader carries the same value, the diff against it is empty, and the
   * save bar goes away by itself.
   */
  // Mirrored in a ref so the settle effect can read the pending values without
  // depending on them (which would re-run it on its own writes) and without
  // calling setState from inside another updater — updaters run in the render
  // phase and StrictMode invokes them twice.
  const autoPendingRef = useRef(autoPending);
  useEffect(() => {
    autoPendingRef.current = autoPending;
  }, [autoPending]);

  useEffect(() => {
    const data = autoFetcher.data;
    if (!data || autoFetcher.state !== "idle") return;

    const pending = autoPendingRef.current;
    const rescued: Array<{ locale: string; linkId: string; value: string }> = [];
    for (const [locale, entries] of Object.entries(pending)) {
      const confirmed = new Set(data.saved?.[locale] ?? []);
      for (const [linkId, value] of Object.entries(entries)) {
        if (!confirmed.has(linkId)) rescued.push({ locale, linkId, value });
      }
    }
    if (rescued.length > 0) {
      setDraftByLocale((draft) => {
        const merged = { ...draft };
        for (const r of rescued) {
          merged[r.locale] = { ...(merged[r.locale] ?? {}), [r.linkId]: r.value };
        }
        return merged;
      });
    }
    if (Object.keys(pending).length > 0) setAutoPending({});

    // Held as state rather than read from the fetcher: `autoFetcher.data`
    // survives until the NEXT auto-save, so a failure reported straight from it
    // would still be on screen after the merchant fixed the same item through
    // the save bar, with only a reload to clear it.
    setAutoFailures(data.failures ?? []);
    setAutoError(data.error);
  }, [autoFetcher.data, autoFetcher.state]);

  /** Primary view: translate this entry into every other language, and save. */
  const translateToAll = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      const linkId = item.linkId;
      setTranslateError(null);
      void withBusy(linkId, async () => {
        const values: Record<string, string> = {};
        for (const locale of foreignLocales) {
          try {
            const value = await translateOne(linkId, sourceText, locale);
            if (value) values[locale] = value;
          } catch (e) {
            setTranslateError(e instanceof Error ? e.message : String(e));
          }
        }
        autoSave(values, linkId);
      });
    },
    [foreignLocales, translateOne, autoSave, withBusy],
  );

  /** Primary view: put the primary label into every other language, and save. */
  const copyToAll = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      const values: Record<string, string> = {};
      for (const locale of foreignLocales) values[locale] = sourceText;
      autoSave(values, item.linkId);
    },
    [foreignLocales, autoSave],
  );

  /** Foreign view: translate this entry from the primary language, and save. */
  const translateFromPrimary = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      const linkId = item.linkId;
      setTranslateError(null);
      void withBusy(linkId, async () => {
        try {
          const value = await translateOne(linkId, sourceText, activeLocale);
          if (value) autoSave({ [activeLocale]: value }, linkId);
        } catch (e) {
          setTranslateError(e instanceof Error ? e.message : String(e));
        }
      });
    },
    [activeLocale, translateOne, autoSave, withBusy],
  );

  /** Foreign view: take the primary label over as-is, and save. */
  const copyFromPrimary = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      autoSave({ [activeLocale]: sourceText }, item.linkId);
    },
    [activeLocale, autoSave],
  );

  // ── The menu picker ──────────────────────────────────────────────────────

  /**
   * A menu is incomplete when any of its links lacks a STORED value in any
   * language. Deliberately blind to the draft: a dot that reacts to typing
   * would re-run registerItems (seven setStates in the provider, every
   * consumer re-rendered) on each keystroke — and it would also claim work is
   * done that nobody has saved yet.
   */
  const menuHasMissing = useCallback(
    (flat: FlatMenuItem[]): boolean =>
      foreignLocales.some((locale) =>
        flat.some((item) => item.linkId && isKnown(item.linkId) && !savedFor(locale, item.linkId).trim()),
      ),
    [foreignLocales, isKnown, savedFor],
  );

  const selectorItems: UnifiedItem[] = useMemo(
    () =>
      parsedMenus.map((m: any) => ({
        id: m.id,
        title: m.title,
        subtitle: m.handle,
        // The blue dot every other content list uses for the same state.
        hasMissingTranslations: menuHasMissing(m.flat),
        missingTranslationsTooltip: t.content?.menuMissingTranslations,
      })),
    [parsedMenus, menuHasMissing, t],
  );

  useEffect(() => {
    registerItems({
      items: selectorItems,
      selectedItemId: selectedMenuId,
      onItemSelect: (id: string) => setSelectedMenuId(id),
      resourceName: {
        singular: t.content?.menu || "Menu",
        plural: t.content?.menus || "Menus",
      },
      t: { searchPlaceholder: t.content?.searchPlaceholder },
    });
  }, [selectorItems, selectedMenuId, registerItems, t]);
  useEffect(() => () => clearItems(), [clearItems]);

  // ── The language bar ─────────────────────────────────────────────────────

  /**
   * The bar colours each language button from ONE item's translation status,
   * so a menu is collapsed into one synthetic entry per language — present
   * only when every item of the menu has a value there. The `menus` branch in
   * field-validation.utils.ts reads exactly that shape; the value itself is
   * never displayed, it only has to be non-empty.
   */
  const languageBarItem = useMemo<TranslatableItem | null>(() => {
    if (!selectedMenu) return null;
    const links = ((selectedMenu.flat ?? []) as FlatMenuItem[])
      .map((i) => i.linkId)
      .filter((id): id is string => !!id);
    const translations = foreignLocales
      .filter((locale) => links.every((linkId) => !isMissingIn(locale, linkId)))
      .map((locale) => ({ key: "title", locale, value: selectedMenu.title }));
    return { id: selectedMenu.id, title: selectedMenu.title, translations } as unknown as TranslatableItem;
  }, [selectedMenu, foreignLocales, isMissingIn]);

  // ── Rendering one menu item ──────────────────────────────────────────────

  const renderItem = (item: FlatMenuItem): ReactElement => {
    const row = item.linkId
      ? ((linkTranslations || {})[item.linkId] as LinkTranslationDTO | undefined)
      : undefined;
    const primaryTitle = row?.primaryTitle ?? item.title;
    const canTranslate = !!item.linkId && !!row?.translatable && !singleLocaleHint;
    const editable = canTranslate && !isPrimary;
    const value = isPrimary ? primaryTitle : item.linkId ? valueFor(activeLocale, item.linkId) : "";
    const busy = !!item.linkId && (busyLinkIds.has(item.linkId) || isAutoSaving(item.linkId));

    // The app's two translation-state colours, same classes as everywhere else:
    // BLUE on a primary field whose translation is missing somewhere, YELLOW on
    // a foreign field that has no value yet.
    const missingSomewhere =
      !!item.linkId && foreignLocales.some((locale) => isMissingIn(locale, item.linkId as string));
    const background = isPrimary
      ? missingSomewhere
        ? "bg-missing-translation"
        : "bg-white"
      : item.linkId && isMissingIn(activeLocale, item.linkId)
        ? "bg-untranslated"
        : "bg-white";

    return (
      <div
        key={item.menuItemId}
        style={{ marginLeft: `${(item.depth - 1) * 1.5}rem`, marginBottom: "0.75rem" }}
      >
        <div className={`ai-editable-field-wrapper ${background}`}>
          <TextField
            // No depth badge: the indentation already shows the nesting, and
            // "L2" is this app's vocabulary, not the merchant's.
            label={<Text as="span" variant="bodySm">{`${item.path.join(".")} · ${primaryTitle}`}</Text>}
            value={value}
            onChange={(next) => {
              if (!editable || !item.linkId) return;
              setDraftValue(activeLocale, item.linkId, next);
            }}
            placeholder={isPrimary ? undefined : primaryTitle}
            disabled={!editable}
            helpText={
              !item.linkId || !row?.translatable
                ? linkSweepTruncated
                  ? t.content?.menuListIncomplete
                  : t.content?.menuNotTranslatable
                : undefined
            }
            autoComplete="off"
          />
        </div>

        {/* Per-entry actions, the same pair every translatable field of the app
            offers: translate with AI, or take the source over unchanged. In the
            primary language they act on ALL other languages at once; in a
            foreign one they act on the language being shown. */}
        {!!item.linkId && !!row?.translatable && (
          <div className="ai-field-footer">
            <div className="ai-field-footer-left" />
            <div className="ai-field-footer-right">
              <DisabledActionTooltip hint={singleLocaleHint}>
                <Button
                  size="slim"
                  loading={busy}
                  disabled={!canTranslate || !primaryTitle.trim() || busy}
                  onClick={() =>
                    isPrimary
                      ? translateToAll(item, primaryTitle)
                      : translateFromPrimary(item, primaryTitle)
                  }
                >
                  🌍{" "}
                  {isPrimary
                    ? t.content?.menuTranslateAll
                    : t.content?.menuTranslateFromPrimary}
                </Button>
              </DisabledActionTooltip>
              <DisabledActionTooltip hint={singleLocaleHint}>
                <Button
                  size="slim"
                  disabled={!canTranslate || !primaryTitle.trim() || busy}
                  onClick={() =>
                    isPrimary ? copyToAll(item, primaryTitle) : copyFromPrimary(item, primaryTitle)
                  }
                >
                  📋 {isPrimary ? t.content?.menuCopyAll : t.content?.menuCopyFromPrimary}
                </Button>
              </DisabledActionTooltip>
            </div>
          </div>
        )}
      </div>
    );
  };

  /** A failure has to name the item to be actionable — an id tail is not one. */
  const titleForLink = useCallback(
    (linkId: string): string => {
      for (const menu of parsedMenus) {
        const hit = (menu.flat as FlatMenuItem[]).find((i) => i.linkId === linkId);
        if (hit) return hit.title;
      }
      return linkId.split("/").pop() ?? linkId;
    },
    [parsedMenus],
  );

  /** A link is busy while its auto-save is in flight — `autoPending` holds it
   *  from submit until the loader carries the value, which is exactly that
   *  window. No extra state to keep in sync. */
  const isAutoSaving = useCallback(
    (linkId: string): boolean => Object.values(autoPending).some((byLink) => linkId in byLink),
    [autoPending],
  );

  // Both save paths report into the same banner: a failure from a per-entry
  // button is no less important than one from the save bar.
  const failures = [...(fetcher.data?.failures ?? []), ...autoFailures];
  const saveError = fetcher.data?.error ?? autoError;

  return (
    <PlanAccessGate contentType="menus">
      <Page fullWidth>
        {/* The native Shopify save bar, not an in-page button: App Bridge
            projects it above the embedded app and it is what "Built for
            Shopify" requires in place of a custom save control. */}
        <AppSaveBar
          hasChanges={changeCount > 0}
          onSave={onSave}
          onDiscard={onDiscard}
          loading={isSaving}
          saveText={t.content?.save}
          discardText={t.content?.discard}
        />
        {/* The frame every Polaris page in this app uses. `.app-page-content`
            is what makes responsive.css zero Polaris' own Page/Page__Content
            inset (0 24px sides, 20px top, 8px bottom) and own the single
            gutter via --app-page-padding instead. Without the class those
            rules do not match, so this page was rendering Polaris' asymmetric
            inset PLUS a hardcoded 1rem of its own — visibly more padding than
            anywhere else. The width class caps the FRAME, adds no padding of
            its own, and <Page fullWidth> has to stay or Polaris' ~1000px cap
            wins first. `-start` rather than `-full`: this page has no item
            sidebar, so nothing else stops the right column from growing on a
            wide screen — capped at the item column PLUS the shared reading
            width, left-aligned so the item column stays flush with the gutter.

            The frame also owns the height, which retires the viewport calc
            this page used to do by hand. `.app-page-content > *` makes its
            SINGLE child the scroll container, so the flex row below is that
            one child. */}
        <div className="app-page-content app-page-width-start">
          <div style={{ display: "flex", gap: "var(--app-page-padding)", minHeight: 0, overflow: "hidden" }}>
            {/* The shared item column, not a hand-built one. Two things came with
                the bespoke version and both were bugs: it was invisible to the
                mobile navbar selector (see registerItems above), and it hardcoded
                its own list chrome instead of the search, sorting and pagination
                every other content tab has. UnifiedItemList owns its own width
                token, so none is set here. `desktop-only` is what hands the list
                over to the navbar below 900px. */}
            <div className="desktop-only" style={{ flexShrink: 0, height: "100%" }}>
              <UnifiedItemList
                items={selectorItems}
                selectedItemId={selectedMenuId}
                onItemSelect={setSelectedMenuId}
                resourceName={{
                  singular: t.content?.menu || "Menu",
                  plural: t.content?.menus || "Menus",
                }}
                searchPlaceholder={t.content?.searchPlaceholder}
                sortOptions={[{ field: "title", label: t.content?.title || "Title" }]}
                t={{
                  searchPlaceholder: t.content?.searchPlaceholder,
                  paginationOf: t.content?.paginationOf || "of",
                  paginationPrevious: t.content?.paginationPrevious || "Previous",
                  paginationNext: t.content?.paginationNext || "Next",
                  sortTooltip: t.content?.sortTooltip,
                  noItemsFound: t.content?.noEntries,
                }}
              />
            </div>

            {/* Right: the selected menu's items, in the active language */}
            <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              {error && (
                <div style={{ marginBottom: "1rem" }}>
                  <Banner title={t.content?.error || "Error"} tone="critical">
                    <p>{error}</p>
                  </Banner>
                </div>
              )}

              <Card>
                {selectedMenu ? (
                  <BlockStack gap="500">
                    <Text as="p" tone="subdued">
                      {t.content?.menuIntro}
                    </Text>

                    {/* The app's standard language bar. It disappears entirely on
                        a single-language shop — one permanently active button is
                        noise, not a choice. */}
                    {shouldRenderLanguageBar({ localeCount: localeList.length }) && (
                      <UnifiedLanguageBar
                        shopLocales={localeList as ShopLocale[]}
                        currentLanguage={activeLocale}
                        primaryLocale={primaryLocale}
                        selectedItem={languageBarItem}
                        contentType={"menus" as ContentType}
                        hasChanges={changeCount > 0}
                        onLanguageChange={setActiveLocale}
                        showTranslateAll={false}
                        showReloadButton={false}
                        t={{ primaryLocaleSuffix: t.content?.primaryLanguageSuffix }}
                      />
                    )}

                    {foreignLocales.length === 0 && (
                      <Banner tone="info">
                        <p>{t.content?.menuNeedsSecondLanguage}</p>
                      </Banner>
                    )}

                    {foreignLocales.length > 0 && isPrimary && (
                      <Banner tone="info">
                        <p>{t.content?.menuPrimaryReadOnly}</p>
                      </Banner>
                    )}

                    {linkSweepTruncated && (
                      <Banner tone="warning">
                        <p>{t.content?.menuListIncomplete}</p>
                      </Banner>
                    )}

                    {translateError && (
                      <Banner tone="critical">
                        <p>
                          {t.content?.menuTranslateFailed} {translateError}
                        </p>
                      </Banner>
                    )}

                    {!!fetcher.data?.deferred && (
                      <Banner tone="warning">
                        <p>{t.content?.menuSaveDeferred}</p>
                      </Banner>
                    )}

                    {failures.length > 0 && (
                      <Banner tone="critical">
                        <BlockStack gap="100">
                          <Text as="p">{t.content?.menuSaveFailed}</Text>
                          {/* Indexed: the same locale/link can legitimately
                              appear from both save paths, and a shared React
                              key would collapse them into one warning-emitting
                              row. */}
                          {failures.map((f, index) => (
                            <Text as="p" variant="bodySm" key={`${index}-${f.locale}-${f.linkId}`}>
                              {titleForLink(f.linkId)} ({f.locale}): {f.message}
                            </Text>
                          ))}
                        </BlockStack>
                      </Banner>
                    )}

                    {/* Every failure mode of the action reaches the merchant.
                        Reporting only the gated one made a 502 from the digest
                        re-read look like a Save button that does nothing. */}
                    {saveError && (
                      <Banner tone="critical">
                        <p>
                          {saveError === "gated"
                            ? t.content?.upgradeRequired || "Upgrade required"
                            : `${t.content?.menuSaveFailed ?? ""} ${saveError}`.trim()}
                        </p>
                      </Banner>
                    )}

                    {selectedMenu.flat.length > 0 && (
                      <div>{selectedMenu.flat.map(renderItem)}</div>
                    )}
                  </BlockStack>
                ) : (
                  <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                    <Text as="p" variant="headingLg" tone="subdued">
                      {t.content?.selectFromList || "Select a menu from the list"}
                    </Text>
                  </div>
                )}
              </Card>
            </div>
          </div>
        </div>
      </Page>
    </PlanAccessGate>
  );
}
