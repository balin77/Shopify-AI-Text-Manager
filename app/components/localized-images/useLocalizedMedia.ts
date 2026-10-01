/**
 * State and writes behind the per-language replacement of a product's images
 * and videos (PLAN_LOCALIZED_IMAGES). It replaces what the separate card used
 * to own; the UI is now inline in the product gallery (see
 * LocalizedMediaContext.tsx for where this runs).
 *
 * Not a draft behind the save bar: every choice is one confirmed write of its
 * own, because the thing being changed is the product's storefront media, not
 * a text the save bar collects. What the UI shows is always the server's answer
 * after the write, never the client's hope.
 *
 * Everything is read LIVE (the metafield is the one store, see
 * localized-media.shared.ts), so a failed load is said, never shown as "nothing
 * replaced". In the PRIMARY locale nothing is loaded at all: there is nothing
 * special there. The first foreign locale triggers the one load per product;
 * switching between foreign locales keeps the entries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { CONTENT_EDITOR_ACTION_ENDPOINT, setContentEditorPage } from "../../services/editor/content-action-endpoint.shared";
import {
  marketNumericId,
  normalizeLocale,
  type LocalizedMediaEntry,
} from "../../services/localized-media/localized-media.shared";
import type { MarketInfo, ShopLocale } from "../../types/content-editor.types";
import {
  findOrphanEntries,
  isForeignShopLocale,
  isStaleAnswer,
  replacedMediaIds,
  type LocalizedMediaItem,
} from "./localized-media-view.shared";

/**
 * Talks to the product page's own actions (`localizedMediaLoad`,
 * `localizedMediaSet`, `localizedMediaRemove`) through the editors' one JSON
 * door, so it inherits the page's plan gate and the content rate limit.
 * A plan refusal answers `{ error: "gated" }`, the actions' own gate `{ code }`.
 */
type DoorAnswer = {
  ok?: boolean;
  entries?: LocalizedMediaEntry[];
  media?: LocalizedMediaItem[];
  code?: string;
  error?: string;
  message?: string;
};

async function callLocalizedMedia(action: string, fields: Record<string, string>): Promise<{ status: number; body: DoorAnswer }> {
  const fd = new FormData();
  fd.set("action", action);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  setContentEditorPage(fd, "/app/products");
  const res = await fetch(CONTENT_EDITOR_ACTION_ENDPOINT, { method: "POST", body: fd });
  const body = (await res.json().catch(() => ({}))) as DoorAnswer;
  return { status: res.status, body };
}

export type LocalizedMediaNotice = { tone: "success" | "critical"; text: string; scope: "panel" | "orphan"; mediaId?: string };

export interface UseLocalizedMediaArgs {
  productId: string;
  shopLocales: ShopLocale[];
  markets: MarketInfo[];
  /** The editor's own language and market: this hook has no selectors of its own. */
  currentLanguage?: string;
  selectedMarketId?: string;
  /** The plan gate (never the image manager's on/off). */
  enabled: boolean;
  /**
   * Changes when the product's media list changed (an image added or removed
   * in the gallery). The next foreign-language view reads the media again.
   */
  reloadKey?: string;
}

export function useLocalizedMedia({ productId, shopLocales, markets, currentLanguage, selectedMarketId = "", enabled, reloadKey = "" }: UseLocalizedMediaArgs) {
  const { t } = useI18n();
  const tx = t.localizedImages;

  // A foreign language is showing: the only state in which anything of this
  // feature exists. The primary locale (and a single-language shop, which has
  // no foreign locale to switch to) renders and loads nothing.
  const active = enabled && isForeignShopLocale(currentLanguage, shopLocales);
  const locale = active ? (currentLanguage as string) : "";
  const marketNumeric = marketNumericId(selectedMarketId) ?? "";

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [entries, setEntries] = useState<LocalizedMediaEntry[]>([]);
  const [media, setMedia] = useState<LocalizedMediaItem[]>([]);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [notice, setNotice] = useState<LocalizedMediaNotice | null>(null);
  const loadStartedRef = useRef(false);
  // The product the editor shows NOW: answers for another one are dropped.
  const productIdRef = useRef(productId);
  productIdRef.current = productId;
  const loadInFlightForRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const startedFor = productId;
    loadInFlightForRef.current = startedFor;
    setLoading(true);
    setLoadError(false);
    try {
      const { status, body } = await callLocalizedMedia("localizedMediaLoad", { productId: startedFor });
      if (isStaleAnswer(startedFor, productIdRef.current)) return;
      if (status < 200 || status >= 300 || !body.ok) throw new Error("load");
      setEntries(body.entries ?? []);
      setMedia(body.media ?? []);
      setLoaded(true);
    } catch {
      if (!isStaleAnswer(startedFor, productIdRef.current)) setLoadError(true);
    } finally {
      if (loadInFlightForRef.current === startedFor) loadInFlightForRef.current = null;
      if (!isStaleAnswer(startedFor, productIdRef.current)) setLoading(false);
    }
  }, [productId]);

  // A different product starts from nothing.
  useEffect(() => {
    loadStartedRef.current = false;
    loadInFlightForRef.current = null;
    setLoading(false);
    setBusySlot(null);
    setLoaded(false);
    setLoadError(false);
    setEntries([]);
    setMedia([]);
    setNotice(null);
  }, [productId]);

  // The gallery's media list moved: read again (immediately when a foreign
  // language is showing, else on the next visit to one). What is on screen
  // stays until the new answer lands.
  const prevReloadKeyRef = useRef(reloadKey);
  const prevReloadProductRef = useRef(productId);
  useEffect(() => {
    const productMoved = prevReloadProductRef.current !== productId;
    prevReloadProductRef.current = productId;
    if (prevReloadKeyRef.current === reloadKey) return;
    prevReloadKeyRef.current = reloadKey;
    // A product switch bumps the key too, but its own load is what runs; and a
    // read for this product that is already on the way needs no second one.
    if (productMoved || loadInFlightForRef.current === productId) return;
    loadStartedRef.current = false;
  }, [reloadKey, productId]);

  // A notice belongs to the language and market it was raised in.
  useEffect(() => {
    setNotice(null);
  }, [currentLanguage, selectedMarketId]);

  // ONE load per product, on the first foreign language. Never in the primary
  // locale, and not again when switching between foreign ones.
  useEffect(() => {
    if (!active || loadStartedRef.current) return;
    loadStartedRef.current = true;
    void load();
  }, [active, load, reloadKey]);

  // The route answers with machine codes; the merchant reads sentences.
  const errorText = useCallback((code: string | undefined, fallback: string) => {
    const known = code ? (tx.errors as Record<string, string>)[code] : undefined;
    return known ?? tx.saveFailed.replace("{error}", fallback);
  }, [tx]);

  const post = useCallback(async (
    action: "localizedMediaSet" | "localizedMediaRemove",
    payload: Record<string, string>,
    slot: string,
    okText: string,
    scope: "panel" | "orphan",
    mediaId?: string,
  ) => {
    const startedFor = productId;
    setBusySlot(slot);
    setNotice(null);
    try {
      const { status, body } = await callLocalizedMedia(action, { productId: startedFor, ...payload });
      if (isStaleAnswer(startedFor, productIdRef.current)) return;
      if (status < 200 || status >= 300 || !body.ok) {
        setNotice({ tone: "critical", text: errorText(body.code ?? body.error, body.message || `HTTP ${status}`), scope, mediaId });
        return;
      }
      // The server's answer after the write is what gets shown.
      if (body.entries) setEntries(body.entries);
      if (body.media) setMedia(body.media);
      setNotice({ tone: "success", text: okText, scope, mediaId });
    } catch (e) {
      if (isStaleAnswer(startedFor, productIdRef.current)) return;
      setNotice({ tone: "critical", text: tx.saveFailed.replace("{error}", e instanceof Error ? e.message : String(e)), scope, mediaId });
    } finally {
      if (!isStaleAnswer(startedFor, productIdRef.current)) setBusySlot(null);
    }
  }, [productId, tx, errorText]);

  const setFile = useCallback(
    (sourceMediaId: string, fileId: string) =>
      post("localizedMediaSet", { sourceMediaId, locale, marketId: selectedMarketId, fileId }, sourceMediaId, tx.saved, "panel", sourceMediaId),
    [post, locale, selectedMarketId, tx],
  );
  const setLink = useCallback(
    (sourceMediaId: string, externalUrl: string) =>
      post("localizedMediaSet", { sourceMediaId, locale, marketId: selectedMarketId, externalUrl }, sourceMediaId, tx.saved, "panel", sourceMediaId),
    [post, locale, selectedMarketId, tx],
  );
  const removeOwn = useCallback(
    (sourceMediaId: string) =>
      post("localizedMediaRemove", { sourceMediaId, locale, marketId: selectedMarketId }, sourceMediaId, tx.removedToast, "panel", sourceMediaId),
    [post, locale, selectedMarketId, tx],
  );
  const removeEntry = useCallback((e: LocalizedMediaEntry) => {
    const gid = e.k ? `gid://shopify/Market/${e.k}` : "";
    return post("localizedMediaRemove", { sourceMediaId: e.m, locale: e.l, marketId: gid }, `${e.m}|${e.l}|${e.k}`, tx.removedToast, "orphan");
  }, [post, tx]);
  const reportFailure = useCallback((mediaId: string, code: string | undefined, fallback: string) => {
    setBusySlot(null);
    setNotice({ tone: "critical", text: errorText(code, fallback), scope: "panel", mediaId });
  }, [errorText]);

  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const mediaIds = useMemo(() => new Set(media.map((m) => m.id)), [media]);
  const replaced = useMemo(
    () => (loaded && active ? replacedMediaIds(entries, mediaIds, locale, marketNumeric) : new Set<string>()),
    [loaded, active, entries, mediaIds, locale, marketNumeric],
  );
  const orphans = useMemo(
    () => (loaded && active ? findOrphanEntries(entries, mediaIds, markets, shopLocales) : []),
    [loaded, active, entries, mediaIds, markets, shopLocales],
  );

  return {
    productId,
    /** A foreign language is showing and the plan allows the feature. */
    active,
    locale: locale ? normalizeLocale(locale) : "",
    /** The editor's language as the editor spells it (for the picker titles). */
    rawLocale: locale,
    marketId: selectedMarketId,
    marketNumeric,
    /** The selected market's name, "" for every market. */
    marketName: selectedMarketId ? (markets.find((m) => m.id === selectedMarketId)?.name ?? "") : "",
    /** Orphan rows name their market; the active ones are known here. */
    markets,
    loading,
    loadError,
    loaded,
    load,
    entries,
    media,
    mediaById,
    replaced,
    orphans,
    busySlot,
    notice,
    setNotice,
    setFile,
    setLink,
    removeOwn,
    removeEntry,
    reportFailure,
  };
}

export type LocalizedMediaState = ReturnType<typeof useLocalizedMedia>;
