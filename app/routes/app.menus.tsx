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
  ResourceList,
  ResourceItem,
  Banner,
  Button,
  TextField,
  Badge,
} from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { SubNavBar, type SubNavBarItem } from "../components/nav/SubNavBar";
import { CONTENT_MAX_HEIGHT } from "../constants/layout";
import { createContentLoader } from "~/utils/loader-factory.server";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
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
      // A failed refresh shows the CACHED menus rather than an error page —
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
  const locale = String(formData.get("locale") || "");
  if (!locale || !isValidLocale(locale)) {
    return Response.json({ success: false, error: "Invalid locale" }, { status: 400 });
  }

  let changes: Array<{ linkId: string; value: string }> = [];
  try {
    const parsed = JSON.parse(String(formData.get("changes") || "[]"));
    if (Array.isArray(parsed)) {
      changes = parsed
        .filter((c) => c && typeof c.linkId === "string" && typeof c.value === "string")
        .map((c) => ({ linkId: c.linkId, value: String(c.value).trim() }));
    }
  } catch {
    return Response.json({ success: false, error: "Malformed changes" }, { status: 400 });
  }
  if (changes.length === 0) {
    return Response.json({ success: true, savedLinkIds: [], failures: [] });
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
  // never become a generic "translate any Link" endpoint.
  let sweep;
  try {
    sweep = await fetchShopLinkTranslations(gateway, [locale]);
  } catch (error) {
    // Without this the whole action throws, the error boundary renders and
    // the merchant's unsaved draft is gone — while every OTHER failure on
    // this path is reported per item and keeps the draft on screen.
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        savedLinkIds: [],
        failures: [],
      },
      { status: 502 },
    );
  }

  const entries = [];
  const failures: Array<{ linkId: string; message: string }> = [];
  for (const change of changes) {
    const row = sweep.rows.get(change.linkId);
    if (!row) {
      failures.push({ linkId: change.linkId, message: "Unknown menu item for this shop." });
      continue;
    }
    entries.push({ linkId: change.linkId, value: change.value, digest: row.digest });
  }

  const result = await saveMenuLinkTranslations(
    gateway,
    db,
    session.shop,
    locale,
    "", // Global only — a market-scoped menu translation is unmeasured.
    entries,
  );

  return Response.json({
    success: true,
    savedLinkIds: result.savedLinkIds,
    failures: [...failures, ...result.failures],
  });
}

// ============================================================================
// UI
// ============================================================================

export default function MenusPage() {
  const { menus, shopLocales, primaryLocale, error, linkTranslations, linkSweepTruncated } =
    useLoaderData<typeof loader>();
  const { t, locale: appLocale } = useI18n();
  const { getTotalNavHeight } = useNavigationHeight();
  const fetcher = useFetcher<{
    success: boolean;
    error?: string;
    savedLinkIds?: string[];
    failures?: Array<{ linkId: string; message: string }>;
  }>();

  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const foreignLocales = useMemo(
    () =>
      (shopLocales || [])
        .filter((l: any) => l.published !== false && !l.primary)
        .map((l: any) => l.locale as string),
    [shopLocales],
  );
  // The primary locale is a real choice here (it shows the source text), so it
  // is a chip like any other — but a shop with only one language gets no bar
  // at all rather than a single permanently-active button.
  const [activeLocale, setActiveLocale] = useState<string>(primaryLocale);
  const isPrimary = activeLocale === primaryLocale;

  /** linkId -> edited value, for the ACTIVE locale only. */
  const [draft, setDraft] = useState<Record<string, string>>({});

  const parsedMenus = useMemo(
    () =>
      (menus || []).map((menu: any) => ({
        ...menu,
        flat: flattenMenuItems(menu.items),
      })),
    [menus],
  );
  const selectedMenu = parsedMenus.find((m: any) => m.id === selectedMenuId);

  useEffect(() => {
    if (parsedMenus.length > 0 && !selectedMenuId) setSelectedMenuId(parsedMenus[0].id);
  }, [parsedMenus, selectedMenuId]);

  /** What Shopify currently holds for the active locale — the diff baseline. */
  const savedValues = useMemo(() => {
    const map: Record<string, string> = {};
    if (isPrimary) return map;
    for (const [linkId, row] of Object.entries(linkTranslations || {})) {
      const value = (row as LinkTranslationDTO).byLocale?.[activeLocale];
      if (typeof value === "string") map[linkId] = value;
    }
    return map;
  }, [linkTranslations, activeLocale, isPrimary]);

  // A draft belongs to ONE locale. Carrying it across a language switch would
  // write German text into the Spanish translation.
  useEffect(() => {
    setDraft({});
  }, [activeLocale]);

  const changes = useMemo(() => diffMenuTranslations(savedValues, draft), [savedValues, draft]);
  const isSaving = fetcher.state !== "idle";

  /**
   * Exactly what the in-flight save submitted. A save is N sequential Shopify
   * round trips, so the merchant can easily type — or switch language — while
   * it runs, and the response must not be allowed to discard those keystrokes.
   */
  const submittedRef = useRef<{ locale: string; byLink: Record<string, string> } | null>(null);

  const onSave = useCallback(() => {
    if (changes.length === 0) return;
    submittedRef.current = {
      locale: activeLocale,
      byLink: Object.fromEntries(changes.map((c) => [c.linkId, c.value])),
    };
    const fd = new FormData();
    fd.set("locale", activeLocale);
    fd.set("changes", JSON.stringify(changes));
    fetcher.submit(fd, { method: "post" });
  }, [changes, activeLocale, fetcher]);

  // Confirmed values come back through the loader on revalidation, so the
  // draft only has to drop the keys that were saved. Two things it must NOT
  // drop: a key the merchant edited again while the save was in flight (its
  // draft no longer equals what was submitted), and anything at all if the
  // language changed underneath — a German save's response would otherwise
  // clear the Spanish boxes now on screen. Failures stay in the draft by
  // construction: they are never in savedLinkIds.
  useEffect(() => {
    const saved = fetcher.data?.savedLinkIds;
    const submitted = submittedRef.current;
    if (!saved?.length || !submitted || submitted.locale !== activeLocale) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const linkId of saved) {
        if ((next[linkId] ?? "").trim() === submitted.byLink[linkId]) delete next[linkId];
      }
      return next;
    });
  }, [fetcher.data, activeLocale]);

  const localeItems: SubNavBarItem[] = useMemo(() => {
    const primarySuffix = t.content?.primaryLanguageSuffix || "Primary";
    return (shopLocales || [])
      .filter((l: any) => l.primary || l.published !== false)
      .map((l: any) => ({
        id: l.locale,
        label: l.primary
          ? `${getLocalizedLanguageName(l.locale, appLocale, l.name)} (${primarySuffix})`
          : getLocalizedLanguageName(l.locale, appLocale, l.name),
      }));
  }, [shopLocales, appLocale, t]);

  const renderItem = (item: FlatMenuItem): ReactElement => {
    const row = item.linkId
      ? ((linkTranslations || {})[item.linkId] as LinkTranslationDTO | undefined)
      : undefined;
    // Primary title from Shopify where the sweep saw it, else the cached tree.
    const primaryTitle = row?.primaryTitle ?? item.title;
    const canTranslate = !isPrimary && !!item.linkId && !!row?.translatable;
    const value = isPrimary
      ? primaryTitle
      : draft[item.linkId ?? ""] ?? savedValues[item.linkId ?? ""] ?? "";

    return (
      <div
        key={item.menuItemId}
        style={{ marginLeft: `${(item.depth - 1) * 1.5}rem`, marginBottom: "0.5rem" }}
      >
        <TextField
          label={
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodySm">{`${item.path.join(".")} · ${primaryTitle}`}</Text>
              {!isPrimary && item.depth > 1 && <Badge tone="info">{`L${item.depth}`}</Badge>}
            </InlineStack>
          }
          value={value}
          onChange={(next) => {
            if (!canTranslate || !item.linkId) return;
            setDraft((prev) => ({ ...prev, [item.linkId as string]: next }));
          }}
          placeholder={isPrimary ? undefined : primaryTitle}
          disabled={!canTranslate}
          helpText={
            !isPrimary && !canTranslate
              ? linkSweepTruncated
                ? t.content?.menuListIncomplete
                : t.content?.menuNotTranslatable
              : undefined
          }
          autoComplete="off"
        />
      </div>
    );
  };

  const failures = fetcher.data?.failures ?? [];

  return (
    <PlanAccessGate contentType="menus">
      <Page fullWidth>
        {/* Own viewport calc rather than height:100% (the Polaris Page chain has
            no definite height here). It therefore has to subtract the bottom
            inset itself — the app shell's padding-bottom does not reach a box
            sized off the viewport. */}
        <div
          className="app-page-width-full"
          style={{
            height: `calc(var(--app-shell-height) - ${getTotalNavHeight()}px - var(--app-bottom-inset))`,
            display: "flex",
            gap: "1rem",
            padding: "1rem",
            overflow: "hidden",
          }}
        >
          {/* Left Sidebar - Menus List. Width from --app-list-column-width
              (responsive.css :root), the same token every other item column of
              the app spends — do not hardcode a width here. */}
          <div style={{ width: "var(--app-list-column-width)", flexShrink: 0 }}>
            <Card padding="0">
              <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
                <Text as="h2" variant="headingMd">
                  {t.content?.menus || "Menus"} ({parsedMenus.length})
                </Text>
              </div>
              <div style={{ maxHeight: CONTENT_MAX_HEIGHT, overflowY: "auto" }}>
                {parsedMenus.length > 0 ? (
                  <ResourceList
                    resourceName={{ singular: "Menu", plural: "Menus" }}
                    items={parsedMenus}
                    renderItem={(item: any) => {
                      const { id, title } = item;
                      const isSelected = selectedMenuId === id;
                      return (
                        <ResourceItem id={id} onClick={() => setSelectedMenuId(id)}>
                          <Text
                            as="p"
                            variant="bodyMd"
                            fontWeight={isSelected ? "bold" : "regular"}
                          >
                            {title}
                          </Text>
                        </ResourceItem>
                      );
                    }}
                  />
                ) : (
                  <div style={{ padding: "2rem", textAlign: "center" }}>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.content?.noEntries || "No menus found"}
                    </Text>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Middle: menu item translations */}
          <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
            {error && (
              <div style={{ marginBottom: "1rem" }}>
                <Banner title={t.content?.error || "Error"} tone="critical">
                  <p>{error}</p>
                </Banner>
              </div>
            )}

            <Card padding="600">
              {selectedMenu ? (
                <BlockStack gap="500">
                  <Text as="p" tone="subdued">
                    {t.content?.menuIntro}
                  </Text>

                  {/* Single-language shops get no locale bar at all — one
                      permanently-active chip is noise, not a choice. */}
                  {foreignLocales.length > 0 && (
                    <SubNavBar
                      items={localeItems}
                      activeId={activeLocale}
                      onSelect={(item) => setActiveLocale(item.id)}
                      ariaLabel={t.content?.menus || "Languages"}
                      variant="level3"
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

                  {failures.length > 0 && (
                    <Banner tone="critical">
                      <BlockStack gap="100">
                        <Text as="p">{t.content?.menuSaveFailed}</Text>
                        {failures.map((f) => (
                          <Text as="p" variant="bodySm" key={f.linkId}>
                            {f.linkId.split("/").pop()}: {f.message}
                          </Text>
                        ))}
                      </BlockStack>
                    </Banner>
                  )}

                  {fetcher.data?.error === "gated" && (
                    <Banner tone="critical">
                      <p>{t.content?.upgradeRequired || "Upgrade required"}</p>
                    </Banner>
                  )}

                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content?.idPrefix || "ID:"} {selectedMenu.id.split("/").pop()} ·{" "}
                    {selectedMenu.handle}
                  </Text>

                  {selectedMenu.flat.length > 0 && (
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingMd">
                          {`${t.content?.menus || "Menu"} · ${selectedMenu.flat.length}`}
                        </Text>
                        <Button
                          variant="primary"
                          disabled={changes.length === 0 || isPrimary}
                          loading={isSaving}
                          onClick={onSave}
                        >
                          {changes.length > 0
                            ? `${t.content?.save || "Save"} (${changes.length})`
                            : t.content?.save || "Save"}
                        </Button>
                      </InlineStack>
                      <div>{selectedMenu.flat.map(renderItem)}</div>
                    </BlockStack>
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
      </Page>
    </PlanAccessGate>
  );
}
