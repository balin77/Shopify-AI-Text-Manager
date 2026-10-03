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
  /** Load only: the metafield holds data this app did not write. */
  foreignValue?: boolean;
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
  /** A product is selected (never the image manager's on/off, never the plan). */
  enabled: boolean;
  /**
   * The plan allows NEW replacements. Without it the feature is remove-only:
   * existing replacements keep serving on the storefront after a downgrade, so
   * they stay listed and removable, but nothing new can be picked.
   */
  canReplace?: boolean;
  /** Theme-editor deep link that activates the storefront embed; the save confirmation links to it. */
  embedActivationUrl?: string | null;
  /**
   * Whether that embed is already on in the live theme: true / false / null
   * (unknown). Only `true` leaves the activation reminder out of the save
   * confirmation; an unknown state keeps it.
   */
  embedActive?: boolean | null;
  /**
   * Changes when the product's media list changed (an image added or removed
   * in the gallery). The next foreign-language view reads the media again.
   */
  reloadKey?: string;
}

export function useLocalizedMedia({ productId, shopLocales, markets, currentLanguage, selectedMarketId = "", enabled, canReplace = true, reloadKey = "", embedActivationUrl = null, embedActive = null }: UseLocalizedMediaArgs) {
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
  // custom.localized_media holds data this app did not write: nothing in it is listed or changed.
  const [foreignValue, setForeignValue] = useState(false);
  const [entries, setEntries] = useState<LocalizedMediaEntry[]>([]);
  const [media, setMedia] = useState<LocalizedMediaItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, LocalizedMediaDraft>>({});
  const [saving, setSaving] = useState(false);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // Slots (medium|language|market) whose tile the merchant flipped to its
  // ORIGINAL (the corner symbol). View state only: it selects nothing and
  // writes nothing; it is per slot, so it never carries over to another
  // language or market, and Discard clears it.
  const [showOriginal, setShowOriginal] = useState<ReadonlySet<string>>(() => new Set());
  const savingRef = useRef(false);
  // Which save run owns `savingRef`: a run that went stale after a product
  // switch must not clear the flag of a newer one.
  const saveTokenRef = useRef(0);
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
      setForeignValue(!!body.foreignValue);
      setLoaded(true);
    } catch {
      if (!isStaleAnswer(startedFor, productIdRef.current)) setLoadError(true);
    } finally {
      if (loadInFlightForRef.current === startedFor) loadInFlightForRef.current = null;
      if (!isStaleAnswer(startedFor, productIdRef.current)) setLoading(false);
    }
  }, [productId]);

  /**
   * Reads again after the gallery CONFIRMED a delete: the server removed the
   * deleted originals' replacements, and the list on screen must follow (a
   * read fired by the optimistic removal can land before that). Before the
   * first foreign-language visit there is nothing on screen to refresh.
   */
  const refresh = useCallback(() => {
    if (!loadStartedRef.current) return;
    void load();
  }, [load]);

  // A different product starts from nothing.
  useEffect(() => {
    loadStartedRef.current = false;
    loadInFlightForRef.current = null;
    setLoading(false);
    setDrafts({});
    setShowOriginal(new Set());
    setSaving(false);
    savingRef.current = false;
    saveTokenRef.current += 1;
    setLoaded(false);
    setForeignValue(false);
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
  // `slot` names the language/market the pick STARTED in: the upload can finish
  // after the merchant switched view, and a draft is keyed by (medium, language,
  // market), so it belongs to the slot that was asked for, not the one showing.
  const draftFile = useCallback((mediaId: string, mediaKind: LocalizedMediaDraft["mediaKind"], fileId: string, previewUrl: string, name: string, slot?: { locale: string; marketId: string; productId?: string }) => {
    // The pick started on another product: the draft would land on this one.
    if (slot?.productId !== undefined && isStaleAnswer(slot.productId, productIdRef.current)) return;
    const target = slot
      ? { mediaId, locale: slot.locale, k: marketNumericId(slot.marketId) ?? "", marketId: slot.marketId, mediaKind }
      : slotTarget(mediaId, mediaKind);
    setDrafts((d) => draftsAfterSet(d, { ...target, op: "set", fileId, previewUrl, name }));
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
  const discard = useCallback(() => {
    setDrafts({});
    setShowOriginal(new Set());
  }, []);

  // A medium that left the product (deleted in the gallery) takes its "set"
  // drafts with it: left in state they would keep the save bar lit for a write
  // that can never happen.
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(media.map((m) => m.id));
    setDrafts((d) => {
      const pruned = pruneDrafts(d, ids);
      return Object.keys(pruned).length === Object.keys(d).length ? d : pruned;
    });
  }, [loaded, media]);

  /**
   * The save bar's Save: every draft through the existing write calls, one
   * after the other (the server writes one change per call and confirms it by
   * the echo). A confirmed draft is dropped; a failed one STAYS, named in the
   * InfoBox, so the next Save retries just those. Never throws.
   */
  const save = useCallback(async () => {
    if (savingRef.current) return;
    const startedFor = productId;
    const pruned = pruneDrafts(draftsRef.current, new Set(mediaIdsRef.current));
    const todo = draftsToWrite(pruned);
    setDrafts(pruned);
    if (todo.length === 0) return;
    const token = ++saveTokenRef.current;
    savingRef.current = true;
    setSaving(true);
    const failures: Array<{ mediaId: string; locale: string; text: string }> = [];
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
            failures.push({ mediaId: d.mediaId, locale: d.locale, text: errorText(body.code ?? body.error, body.message || `HTTP ${status}`) });
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
          failures.push({ mediaId: d.mediaId, locale: d.locale, text: tx.saveFailed.replace("{error}", e instanceof Error ? e.message : String(e)) });
        }
      }
    } finally {
      if (saveTokenRef.current === token) {
        savingRef.current = false;
        if (!isStaleAnswer(startedFor, productIdRef.current)) setSaving(false);
      }
    }
    if (isStaleAnswer(startedFor, productIdRef.current)) return;
    if (failures.length === 0) {
      const text = done === 1 ? tx.savedOne : tx.savedMany.replace("{count}", String(done));
      // The storefront only swaps once the app embed is on: say it where the
      // merchant is looking, with the link, when something was written -
      // unless the theme is KNOWN to have it on already (unknown keeps it).
      if (wroteSet && embedActivationUrl && embedActive !== true) {
        showInfoBox(`${text} ${tx.embedHint}`, "success", { url: embedActivationUrl, label: tx.openEmbed });
      } else {
        showInfoBox(text, "success");
      }
    } else {
      const detail = failures.slice(0, 3).map((f) => `${mediaName(f.mediaId)} (${getLocalizedLanguageName(f.locale, appLocale)}): ${f.text}`).join(" · ");
      showInfoBox(
        (done > 0 ? tx.partialFailed : tx.allFailed)
          .replace("{done}", String(done))
          .replace("{failed}", String(failures.length))
          .replace("{details}", detail),
        "critical",
      );
    }
  }, [productId, tx, errorText, showInfoBox, mediaName, embedActivationUrl, embedActive, appLocale]);

  /** The deleted originals' replacements could not be removed with them: said, and the orphan list offers them. */
  const reportCleanupFailed = useCallback((code?: string) => {
    // The orphan list lists nothing for a foreign-valued metafield, and it only
    // exists in a foreign language: each case gets the sentence that is true.
    const text = code === "foreignMetafieldValue" ? tx.cleanupForeign : active ? tx.cleanupFailed : tx.cleanupFailedPrimary;
    showInfoBox(text, "warning");
  }, [showInfoBox, tx, active]);

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
    const slot = draftKey(mediaId, locale, marketNumeric);
    setShowOriginal((cur) => {
      const next = new Set(cur);
      if (!next.delete(slot)) next.add(slot);
      return next;
    });
  }, [locale, marketNumeric]);
  /**
   * What a tile or preview of this medium renders when it has a replacement for
   * the current language and market: the picture to show in place of the
   * original (null = keep the original's picture, e.g. a Vimeo link has no
   * thumbnail), and the symbol's state and words. Null = nothing replaced.
   */
  const tileOf = useCallback((mediaId: string): LocalizedMediaTile | null => {
    const v = viewOf(mediaId);
    if (!v) return null;
    const flipped = showOriginal.has(draftKey(mediaId, locale, marketNumeric));
    const language = getLocalizedLanguageName(locale, appLocale);
    const m = mediaById.get(mediaId);
    // A YouTube/Vimeo original has no file: its link is its name.
    const originalName = m?.kind === "external" ? (m.stamp || m.key || "") : (filenameFromUrl(m?.url) || m?.alt || "");
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
  }, [viewOf, showOriginal, locale, marketNumeric, appLocale, tx, toggleOriginal, mediaById]);
  /** A medium's kind in the merchant's words (never the raw "video" / "external"). */
  const kindName = useCallback((kind: LocalizedMediaItem["kind"]) => (kind === "external" ? tx.kindLink : kind === "video" ? tx.kindVideo : tx.kindImage), [tx]);
  const hasDrafts = Object.keys(drafts).length > 0;
  /** Languages (normalized codes) that hold unsaved drafts. */
  const draftLocales = useMemo(() => [...new Set(Object.values(drafts).map((d) => d.locale))], [drafts]);
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
    foreignValue,
    canReplace,
    load,
    refresh,
    kindName,
    entries,
    media,
    mediaById,
    replaced,
    orphans,
    drafts,
    hasDrafts,
    draftLocales,
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
