/**
 * The pure half of the per-language media UI on the product page: which of the
 * product's media carry a replacement for the language (+ market) the editor is
 * showing, and which stored entries nothing can reach any more.
 *
 * Import-light on purpose (types + the storefront's own precedence function):
 * the tile mark, the replace panel and the orphan notice all ask these two
 * questions, and a second copy of the precedence rule is exactly how the
 * editor, the snippet and the storefront asset would come to disagree.
 */
import {
  marketNumericId,
  normalizeLocale,
  resolveLocalizedMedia,
  type LocalizedMediaEntry,
} from "../../services/localized-media/localized-media.shared";

/** One product medium as `localizedMediaLoad` reports it (ProductMediaItem). */
export interface LocalizedMediaItem {
  id: string;
  kind: "image" | "video" | "external";
  url: string;
  alt: string | null;
  /** Null = the storefront key could not be derived; such a medium is listed but not replaceable. */
  key: string | null;
  poster: string;
  stamp: string;
}

/**
 * The media (by GID) a visitor in (locale, market) would see REPLACED. An
 * every-market entry counts from a specific market too (that is what the
 * storefront serves), so "inherited" and "own" are marked alike.
 * The primary locale (`locale` = "") never has one.
 */
export function replacedMediaIds(
  entries: LocalizedMediaEntry[],
  mediaIds: Iterable<string>,
  locale: string,
  marketNumeric: string,
): Set<string> {
  const out = new Set<string>();
  if (!locale) return out;
  for (const id of mediaIds) {
    if (resolveLocalizedMedia(entries, id, locale, marketNumeric)) out.add(id);
  }
  return out;
}

/**
 * An entry nothing in the editor can reach any more: its original is gone, its
 * market is not an active one, or its language is no longer on the shop.
 * Markets and languages are judged only when their lists answered (an empty
 * language list is a failed lookup, never "no languages"), so a failed lookup
 * cannot offer every entry for removal.
 */
export function findOrphanEntries(
  entries: LocalizedMediaEntry[],
  mediaIds: ReadonlySet<string>,
  markets: ReadonlyArray<{ id: string }>,
  shopLocales: ReadonlyArray<{ locale: string; primary?: boolean }>,
): LocalizedMediaEntry[] {
  const activeMarkets = new Set(markets.map((mk) => marketNumericId(mk.id)).filter((k): k is string => !!k));
  const foreign = new Set(shopLocales.filter((l) => !l.primary).map((l) => normalizeLocale(l.locale)));
  return entries.filter(
    (e) =>
      !mediaIds.has(e.m) ||
      (!!e.k && markets.length > 0 && !activeMarkets.has(e.k)) ||
      (shopLocales.length > 0 && !foreign.has(e.l)),
  );
}

/** Whether `locale` is a non-primary language of the shop (and so may carry a replacement). */
export function isForeignShopLocale(
  locale: string | undefined,
  shopLocales: ReadonlyArray<{ locale: string; primary?: boolean }>,
): boolean {
  if (!locale) return false;
  return shopLocales.some((l) => l.locale === locale && !l.primary);
}

/**
 * An answer that arrives after the editor moved to another product belongs to
 * the old one and must neither fill the new product's lists nor clear its
 * loading/busy state.
 */
export function isStaleAnswer(startedFor: string, current: string): boolean {
  return startedFor !== current;
}

// ---------------------------------------------------------------------------
// Drafts: a choice waits for the editor's save bar (owner, 2026-10-01, second
// revision). Everything below is pure so the keying and the "what does the
// tile show" answer are testable without a render.
// ---------------------------------------------------------------------------

/**
 * One unsaved choice for (medium, language, market). A "set" carries what the
 * existing `localizedMediaSet` call needs (a file GID or an external link) plus
 * a preview the tile can show before anything is written.
 */
export interface LocalizedMediaDraft {
  op: "set" | "remove";
  /** Original medium GID. */
  mediaId: string;
  /** Language, normalized (lowercase) like the entries. */
  locale: string;
  /** Market NUMERIC id, "" = every market (the entry's own `k`). */
  k: string;
  /** The market GID the write call is sent with ("" = every market). */
  marketId: string;
  /** What the original is, so a preview and the write agree. */
  mediaKind: "image" | "video" | "external";
  fileId?: string;
  externalUrl?: string;
  /** Preview URL for the tile ("" = none, e.g. a Vimeo link). */
  previewUrl?: string;
  /** What the hover text calls the replacement: the file's name, or the link. */
  name?: string;
}

export function draftKey(mediaId: string, locale: string, k: string): string {
  return `${mediaId}|${normalizeLocale(locale)}|${k}`;
}

/** The marker `t` of an entry that is only a draft's stand-in. */
export const DRAFT_ENTRY_STAMP = "draft";

/**
 * The entries as they WOULD be after the drafts were saved: a "set" replaces
 * (or adds) its slot with a stand-in carrying the preview, a "remove" drops its
 * slot. Everything the editor shows (the corner symbol, the tile image) asks
 * this one list, so a draft and a saved replacement are marked alike.
 */
export function effectiveEntries(
  entries: LocalizedMediaEntry[],
  drafts: Readonly<Record<string, LocalizedMediaDraft>>,
): LocalizedMediaEntry[] {
  const list = Object.values(drafts);
  if (list.length === 0) return entries;
  const dropped = new Set(list.map((d) => draftKey(d.mediaId, d.locale, d.k)));
  const kept = entries.filter((e) => !dropped.has(draftKey(e.m, e.l, e.k)));
  for (const d of list) {
    if (d.op !== "set") continue;
    kept.push({
      o: "",
      m: d.mediaId,
      l: normalizeLocale(d.locale),
      k: d.k,
      u: d.previewUrl ?? "",
      f: d.fileId ?? "",
      a: "manual",
      s: "",
      t: DRAFT_ENTRY_STAMP,
      ...(d.mediaKind === "video" ? { x: "v" as const } : d.mediaKind === "external" ? { x: "e" as const } : {}),
      ...(d.externalUrl ? { r: d.externalUrl } : {}),
    });
  }
  return kept;
}

/** What a medium shows for (locale, market): the replacement and where it stands. */
export interface ReplacementView {
  /** File name (or link) of the replacement, for the hover text; "" = unknown. */
  name: string;
  /** Preview URL ("" = the replacement has none: keep the original's picture). */
  url: string;
  /** Not saved yet. */
  draft: boolean;
  /** Comes from the every-market entry (seen from a specific market). */
  inherited: boolean;
}

export function replacementView(
  entries: LocalizedMediaEntry[],
  drafts: Readonly<Record<string, LocalizedMediaDraft>>,
  mediaId: string,
  locale: string,
  marketNumeric: string,
): ReplacementView | null {
  if (!locale) return null;
  const hit = resolveLocalizedMedia(effectiveEntries(entries, drafts), mediaId, locale, marketNumeric);
  if (!hit) return null;
  const draft = hit.entry.t === DRAFT_ENTRY_STAMP;
  const name = draft
    ? drafts[draftKey(hit.entry.m, hit.entry.l, hit.entry.k)]?.name ?? ""
    : entryDisplayName(hit.entry);
  return { url: hit.entry.u, draft, inherited: hit.inherited, name };
}

/** The last path segment of a URL, decoded, without query ("" when there is none). */
export function filenameFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  const last = url.split("#")[0].split("?")[0].split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A saved entry's name for the hover text: the video file, the link, or the image file. */
export function entryDisplayName(e: LocalizedMediaEntry): string {
  if (e.x === "e") return e.r ?? "";
  if (e.x === "v") return filenameFromUrl(e.w?.[0]?.u) || filenameFromUrl(e.u);
  return filenameFromUrl(e.u);
}

/** Whether the medium has a replacement of its OWN for (locale, market), saved or draft. */
export function hasOwnReplacement(
  entries: LocalizedMediaEntry[],
  drafts: Readonly<Record<string, LocalizedMediaDraft>>,
  mediaId: string,
  locale: string,
  marketNumeric: string,
): boolean {
  const l = normalizeLocale(locale);
  return effectiveEntries(entries, drafts).some((e) => e.m === mediaId && e.l === l && e.k === marketNumeric);
}

/**
 * "Remove the replacement" as a draft: where a SAVED entry sits in the slot the
 * removal has to be written; where only a draft sets it, dropping the draft is
 * the whole undo (nothing was ever written).
 */
export function draftsAfterRemove(
  entries: LocalizedMediaEntry[],
  drafts: Readonly<Record<string, LocalizedMediaDraft>>,
  target: Pick<LocalizedMediaDraft, "mediaId" | "locale" | "k" | "marketId" | "mediaKind">,
): Record<string, LocalizedMediaDraft> {
  const key = draftKey(target.mediaId, target.locale, target.k);
  const next = { ...drafts };
  const saved = entries.some((e) => draftKey(e.m, e.l, e.k) === key);
  if (saved) next[key] = { ...target, locale: normalizeLocale(target.locale), op: "remove" };
  else delete next[key];
  return next;
}

/** A "set" draft for the slot; replaces whatever draft the slot held. */
export function draftsAfterSet(
  drafts: Readonly<Record<string, LocalizedMediaDraft>>,
  draft: LocalizedMediaDraft,
): Record<string, LocalizedMediaDraft> {
  const d = { ...draft, locale: normalizeLocale(draft.locale) };
  return { ...drafts, [draftKey(d.mediaId, d.locale, d.k)]: d };
}

/**
 * "Set" drafts whose original is no longer a medium of the product (deleted in
 * the gallery meanwhile) could only fail, so they are dropped. A "remove" stays:
 * it is also how an orphan (original already gone) is cleaned up.
 */
export function pruneDrafts(
  drafts: Readonly<Record<string, LocalizedMediaDraft>>,
  mediaIds: ReadonlySet<string>,
): Record<string, LocalizedMediaDraft> {
  const out: Record<string, LocalizedMediaDraft> = {};
  for (const [k, d] of Object.entries(drafts)) if (d.op === "remove" || mediaIds.has(d.mediaId)) out[k] = d;
  return out;
}

/** The write calls to make, in a stable order (removals first: they free slots). */
export function draftsToWrite(drafts: Readonly<Record<string, LocalizedMediaDraft>>): LocalizedMediaDraft[] {
  return Object.values(drafts).sort((a, b) => (a.op === b.op ? 0 : a.op === "remove" ? -1 : 1));
}
