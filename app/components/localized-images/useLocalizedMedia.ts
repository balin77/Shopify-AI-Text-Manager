/**
 * State and writes behind the per-language replacement of a product's images
 * and videos (PLAN_LOCALIZED_IMAGES). The UI is inline in the product gallery
 * (see LocalizedMediaContext.tsx for where this runs): one button on the
 * selected medium, and the tile shows the replacement.
 *
 * A choice is a DRAFT behind the editor's one save bar (owner, 2026-10-01,
 * second revision): nothing is written when the merchant picks a file.
 * `LocalizedMediaSaveBridge` registers `{hasChanges, saving, save, discard}`
 * with the editor, and Save applies each draft through the existing
 * `localizedMediaSet` / `localizedMediaRemove` calls, one after the other.
 * What the entries hold afterwards is always the server's answer, never the
 * client's hope; the confirmation or the failure goes to the InfoBox.
 *
 * Everything is read LIVE (the metafield is the one store, see
 * localized-media.shared.ts), so a failed load is said, never shown as "nothing
 * replaced". In the PRIMARY locale nothing is loaded at all: there is nothing
 * special there. The first foreign locale triggers the one load per product;
 * switching between foreign locales keeps the entries AND the drafts (drafts
 * are keyed by medium, language and market). A different product starts clean.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { useInfoBox } from "../../contexts/InfoBoxContext";
import { CONTENT_EDITOR_ACTION_ENDPOINT, setContentEditorPage } from "../../services/editor/content-action-endpoint.shared";
import {
  marketNumericId,
  normalizeLocale,
  type LocalizedMediaEntry,
} from "../../services/localized-media/localized-media.shared";
import type { MarketInfo, ShopLocale } from "../../types/content-editor.types";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import {
  draftKey,
  draftsAfterRemove,
  draftsAfterSet,
  draftsToWrite,
  filenameFromUrl,
  effectiveEntries,
  findOrphanEntries,
  hasOwnReplacement,
  isForeignShopLocale,
  isStaleAnswer,
  pruneDrafts,
  replacedMediaIds,
  replacementView,
  type LocalizedMediaDraft,
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

/** How a gallery draws a medium that has a replacement (see `tileOf`). */
export interface LocalizedMediaTile {
  /** Picture to show in place of the original; null keeps the original's. */
  src: string | null;
  draft: boolean;
  showingOriginal: boolean;
  /** Tooltip / screen-reader words of the corner symbol. */
  label: string;
  /** Hover text of the tile image: "Original: <file>" / "Replacement: <file>". */
  title: string;
  onToggle: () => void;
}

export interface UseLocalizedMediaArgs {
  productId: string;
  shopLocales: ShopLocale[];
  markets: MarketInfo[];
  /** The editor's own language and market: this hook has no selectors of its own. */
  currentLanguage?: string;
  selectedMarketId?: string;
  /** The plan gate (never the image manager's on/off). */
  enabled: boolean;
  /** Theme-editor deep link that activates the storefront embed; the save confirmation links to it. */
  embedActivationUrl?: string | null;
  /**
   * Changes when the product's media list changed (an image added or removed
   * in the gallery). The next foreign-language view reads the media again.
   */
  reloadKey?: string;
}

export function useLocalizedMedia({ productId, shopLocales, markets, currentLanguage, selectedMarketId = "", enabled, reloadKey = "", embedActivationUrl = null }: UseLocalizedMediaArgs) {
  const { t, locale: appLocale } = useI18n();
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
  const [drafts, setDrafts] = useState<Record<string, LocalizedMediaDraft>>({});
  const [saving, setSaving] = useState(false);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // Media whose tile the merchant flipped to its ORIGINAL (the corner symbol).
  // View state only: it selects nothing and writes nothing.
  const [showOriginal, setShowOriginal] = useState<ReadonlySet<string>>(() => new Set());
  const savingRef = useRef(false);
  const mediaIdsRef = useRef<string[]>([]);
  const { showInfoBox } = useInfoBox();
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
    setDrafts({});
    setShowOriginal(new Set());
    setSaving(false);
    savingRef.current = false;
    setLoaded(false);
    setLoadError(false);
    setEntries([]);
    setMedia([]);
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

  /** The medium's name in a message: its alt text or the file name of its URL. */
  const mediaName = useCallback((mediaId: string) => {
    const m = media.find((x) => x.id === mediaId);
    if (m?.alt) return m.alt;
    const file = m?.url ? decodeURIComponent(m.url.split("?")[0].split("/").pop() ?? "") : "";
    return file || mediaId.split("/").pop() || mediaId;
  }, [media]);

  const slotTarget = useCallback((mediaId: string, mediaKind: LocalizedMediaDraft["mediaKind"]) => ({
    mediaId,
    locale,
    k: marketNumeric,
    marketId: selectedMarketId,
    mediaKind,
  }), [locale, marketNumeric, selectedMarketId]);

  /** A picked file (already materialised in Files) becomes a draft. */
  const draftFile = useCallback((mediaId: string, mediaKind: LocalizedMediaDraft["mediaKind"], fileId: string, previewUrl: string, name: string) => {
    setDrafts((d) => draftsAfterSet(d, { ...slotTarget(mediaId, mediaKind), op: "set", fileId, previewUrl, name }));
  }, [slotTarget]);
  /** A YouTube/Vimeo link becomes a draft; the server validates it on save. */
  const draftLink = useCallback((mediaId: string, externalUrl: string, previewUrl: string) => {
    setDrafts((d) => draftsAfterSet(d, { ...slotTarget(mediaId, "external"), op: "set", externalUrl, previewUrl, name: externalUrl }));
  }, [slotTarget]);
  /** "Remove the replacement" as a draft (or the undo of a draft that was never saved). */
  const draftRemove = useCallback((mediaId: string, mediaKind: LocalizedMediaDraft["mediaKind"]) => {
    setDrafts((d) => draftsAfterRemove(entries, d, slotTarget(mediaId, mediaKind)));
  }, [entries, slotTarget]);
  /** Cleaning up an orphan: also a draft, whatever language/market it sits in. */
  const draftRemoveEntry = useCallback((e: LocalizedMediaEntry) => {
    const marketId = e.k ? `gid://shopify/Market/${e.k}` : "";
    setDrafts((d) => draftsAfterRemove(entries, d, { mediaId: e.m, locale: e.l, k: e.k, marketId, mediaKind: "image" }));
  }, [entries]);
  /** Takes back ONE draft (the orphan row's undo). */
  const undoDraft = useCallback((mediaId: string, loc: string, k: string) => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[draftKey(mediaId, loc, k)];
      return next;
    });
  }, []);
  const discard = useCallback(() => setDrafts({}), []);

  /**
   * The save bar's Save: every draft through the existing write calls, one
   * after the other (the server writes one change per call and confirms it by
   * the echo). A confirmed draft is dropped; a failed one STAYS, named in the
   * InfoBox, so the next Save retries just those. Never throws.
   */
  const save = useCallback(async () => {
    if (savingRef.current) return;
    const startedFor = productId;
    const todo = draftsToWrite(pruneDrafts(draftsRef.current, new Set(mediaIdsRef.current)));
    if (todo.length === 0) {
      setDrafts({});
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const failures: Array<{ mediaId: string; text: string }> = [];
    let done = 0;
    let wroteSet = false;
    try {
      for (const d of todo) {
        if (isStaleAnswer(startedFor, productIdRef.current)) return;
        try {
          const fields: Record<string, string> = { productId: startedFor, sourceMediaId: d.mediaId, locale: d.locale, marketId: d.marketId };
          if (d.op === "set") {
            if (d.externalUrl) fields.externalUrl = d.externalUrl;
            else fields.fileId = d.fileId ?? "";
          }
          const { status, body } = await callLocalizedMedia(d.op === "set" ? "localizedMediaSet" : "localizedMediaRemove", fields);
          if (isStaleAnswer(startedFor, productIdRef.current)) return;
          if (status < 200 || status >= 300 || !body.ok) {
            failures.push({ mediaId: d.mediaId, text: errorText(body.code ?? body.error, body.message || `HTTP ${status}`) });
            continue;
          }
          done += 1;
          if (d.op === "set") wroteSet = true;
          // The server's answer after the write is what gets shown.
          if (body.entries) setEntries(body.entries);
          if (body.media) setMedia(body.media);
          // Drop exactly this draft, unless the merchant replaced it meanwhile.
          setDrafts((cur) => {
            const key = draftKey(d.mediaId, d.locale, d.k);
            if (!cur[key] || JSON.stringify(cur[key]) !== JSON.stringify(d)) return cur;
            const next = { ...cur };
            delete next[key];
            return next;
          });
        } catch (e) {
          failures.push({ mediaId: d.mediaId, text: tx.saveFailed.replace("{error}", e instanceof Error ? e.message : String(e)) });
        }
      }
    } finally {
      savingRef.current = false;
      if (!isStaleAnswer(startedFor, productIdRef.current)) setSaving(false);
    }
    if (isStaleAnswer(startedFor, productIdRef.current)) return;
    if (failures.length === 0) {
      const text = done === 1 ? tx.savedOne : tx.savedMany.replace("{count}", String(done));
      // The storefront only swaps once the app embed is on: say it where the
      // merchant is looking, with the link, when something was written.
      if (wroteSet && embedActivationUrl) {
        showInfoBox(`${text} ${tx.embedHint}`, "success", { url: embedActivationUrl, label: tx.openEmbed });
      } else {
        showInfoBox(text, "success");
      }
    } else {
      const detail = failures.slice(0, 3).map((f) => `${mediaName(f.mediaId)}: ${f.text}`).join(" · ");
      showInfoBox(
        (done > 0 ? tx.partialFailed : tx.allFailed)
          .replace("{done}", String(done))
          .replace("{failed}", String(failures.length))
          .replace("{details}", detail),
        "critical",
      );
    }
  }, [productId, tx, errorText, showInfoBox, mediaName, embedActivationUrl]);

  /** The deleted originals' replacements could not be removed with them: said, and the orphan list offers them. */
  const reportCleanupFailed = useCallback(() => {
    showInfoBox(tx.cleanupFailed, "warning");
  }, [showInfoBox, tx]);

  /** Said in the InfoBox, for a pick that failed before it could even become a draft. */
  const reportPickFailure = useCallback((code: string | undefined, fallback: string) => {
    showInfoBox(errorText(code, fallback), "critical");
  }, [errorText, showInfoBox]);

  mediaIdsRef.current = media.map((m) => m.id);
  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const mediaIds = useMemo(() => new Set(media.map((m) => m.id)), [media]);
  // What the editor shows is the entries as they will be once the drafts are saved.
  const shownEntries = useMemo(() => effectiveEntries(entries, drafts), [entries, drafts]);
  const replaced = useMemo(
    () => (loaded && active ? replacedMediaIds(shownEntries, mediaIds, locale, marketNumeric) : new Set<string>()),
    [loaded, active, shownEntries, mediaIds, locale, marketNumeric],
  );
  /** The replacement a medium shows for the current language and market (null = the original). */
  const viewOf = useCallback(
    (mediaId: string) => (loaded && active ? replacementView(entries, drafts, mediaId, locale, marketNumeric) : null),
    [loaded, active, entries, drafts, locale, marketNumeric],
  );
  const hasOwn = useCallback(
    (mediaId: string) => hasOwnReplacement(entries, drafts, mediaId, locale, marketNumeric),
    [entries, drafts, locale, marketNumeric],
  );
  const toggleOriginal = useCallback((mediaId: string) => {
    setShowOriginal((cur) => {
      const next = new Set(cur);
      if (!next.delete(mediaId)) next.add(mediaId);
      return next;
    });
  }, []);
  /**
   * What a tile or preview of this medium renders when it has a replacement for
   * the current language and market: the picture to show in place of the
   * original (null = keep the original's picture, e.g. a Vimeo link has no
   * thumbnail), and the symbol's state and words. Null = nothing replaced.
   */
  const tileOf = useCallback((mediaId: string): LocalizedMediaTile | null => {
    const v = viewOf(mediaId);
    if (!v) return null;
    const flipped = showOriginal.has(mediaId);
    const language = getLocalizedLanguageName(locale, appLocale);
    const m = mediaById.get(mediaId);
    const originalName = filenameFromUrl(m?.url) || m?.alt || "";
    const replacementTip = m && m.kind !== "image" ? tx.tipReplacementVideo : tx.tipReplacement;
    const base = flipped ? tx.originalMark : tx.replacedMark.replace("{language}", language);
    return {
      src: !flipped && v.url ? v.url : null,
      draft: v.draft,
      showingOriginal: flipped,
      label: v.draft && !flipped ? `${base} ${tx.unsavedSuffix}` : base,
      title: flipped
        ? tx.tipOriginal.replace("{name}", originalName)
        : replacementTip.replace("{name}", v.name || originalName),
      onToggle: () => toggleOriginal(mediaId),
    };
  }, [viewOf, showOriginal, locale, appLocale, tx, toggleOriginal, mediaById]);
  const hasDrafts = Object.keys(drafts).length > 0;
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
    drafts,
    hasDrafts,
    saving,
    viewOf,
    tileOf,
    toggleOriginal,
    hasOwn,
    draftFile,
    draftLink,
    draftRemove,
    draftRemoveEntry,
    undoDraft,
    reportPickFailure,
    reportCleanupFailed,
    save,
    discard,
  };
}

export type LocalizedMediaState = ReturnType<typeof useLocalizedMedia>;
