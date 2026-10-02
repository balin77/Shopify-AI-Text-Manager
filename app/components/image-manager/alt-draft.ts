/**
 * The pure half of the image manager's alt-text DRAFTS.
 *
 * An alt text typed (or generated / translated) in the image manager is a draft
 * until the merchant presses the editor's ONE save bar -- the standing rule
 * "a setting is never saved by the click that changes it", which a blur
 * auto-save broke. The save bar's Save asks the manager to FLUSH: every dirty
 * alt goes through the manager's serial save queue (one fetcher, one in flight)
 * and the answer says how many were really confirmed, so the page never
 * reports "saved" for an alt it did not send.
 *
 * Import-light on purpose (a type only): the manager and its tests both use it.
 */
import type { QueuedAltSave } from "../../services/alt-text-feedback.shared";

/** What the page asks of the manager (a ref the manager fills; see VariantImageManager). */
export interface AltDraftApi {
  /**
   * Sends every dirty alt through the save queue; resolves once each was
   * answered. Never throws. `galleryApply` is the gallery save running in the
   * same page Save: the alt of an image that is only being uploaded by it has
   * no media id yet, so it is CARRIED OVER and sent once that image exists
   * (or reported as not sent when the gallery save failed).
   */
  flush: (opts?: { galleryApply?: Promise<unknown> }) => Promise<AltFlushSummary>;
  /** Puts every alt draft back to what it was before it was edited. */
  discard: () => void;
  /** True while a draft exists that no pending save will write (what a switch would lose). */
  hasUnsentDrafts: () => boolean;
}

export interface AltFlushSummary {
  /** Confirmed by the server. */
  ok: number;
  /** Answered with a failure (each already named in the InfoBox by the manager). */
  failed: number;
  /** Dirty alts that could not even be sent (no media id yet). */
  unsent: number;
}

/** A save is identified by what it writes to, never by object identity: a newer queued save replaces an older one. */
export function altFlushKey(entry: Pick<QueuedAltSave, "mediaId" | "locale" | "marketId">): string {
  return `${entry.mediaId}|${entry.locale ?? ""}|${entry.marketId ?? ""}`;
}

/**
 * The saves a page Save has to send, one per dirty MEDIUM of the language and
 * market the view shows. One medium can carry two drafts (the product gallery
 * and a variant gallery show it under urls that differ by the `?v=` query):
 * they are merged, the latest edit wins (`editOrder`, higher = later) and the
 * others ride along as `aliases`. A draft whose image has no media id yet (an
 * unsaved tile) cannot be addressed: it is reported as `unaddressable`.
 */
export function planAltFlush(args: {
  dirtyUrls: Iterable<string>;
  texts: Readonly<Record<string, string>>;
  urlToGid: Readonly<Record<string, string>>;
  locale?: string;
  /** Undefined = the global layer (always for the primary language). */
  marketId?: string;
  productId: string;
  productTitle?: string;
  editOrder?: ReadonlyMap<string, number>;
}): { entries: QueuedAltSave[]; unaddressable: string[] } {
  const unaddressable: string[] = [];
  const byKey = new Map<string, Array<{ url: string; mediaId: string; text: string; order: number; index: number }>>();
  let index = 0;
  for (const url of args.dirtyUrls) {
    const text = args.texts[url];
    // A dirty flag without a text is a draft that was already taken back.
    if (text === undefined) continue;
    const mediaId = args.urlToGid[url];
    if (!mediaId || !mediaId.startsWith("gid://")) {
      unaddressable.push(url);
      continue;
    }
    const key = altFlushKey({ mediaId, locale: args.locale, marketId: args.marketId || undefined });
    const list = byKey.get(key) ?? [];
    list.push({ url, mediaId, text, order: args.editOrder?.get(url) ?? -1, index: index++ });
    byKey.set(key, list);
  }
  const entries: QueuedAltSave[] = [];
  for (const list of byKey.values()) {
    // Latest edit wins; without an order the later url in the dirty set does.
    const winner = list.reduce((a, b) => (b.order > a.order || (b.order === a.order && b.index > a.index) ? b : a));
    const entry: QueuedAltSave = {
      url: winner.url,
      mediaId: winner.mediaId,
      altText: winner.text,
      locale: args.locale,
      marketId: args.marketId || undefined,
      productId: args.productId,
      productTitle: args.productTitle,
    };
    const aliases = list.filter((c) => c !== winner).map((c) => ({ url: c.url, altText: c.text }));
    if (aliases.length > 0) entry.aliases = aliases;
    entries.push(entry);
  }
  return { entries, unaddressable };
}

/**
 * The ONE save an AI button's result goes out as (✨ generate, 🌍 translate):
 * owner's rule 2026-10-02 — an AI result is saved IMMEDIATELY, for that image
 * only, while typing stays a draft for the page Save. The medium of `url` is
 * planned exactly like a page Save would plan it (tiles of the same medium in
 * other galleries ride along as aliases, the latest edit wins), and nothing of
 * any OTHER medium is touched. `null` = the image has no media id yet (an
 * unsaved upload), so there is nothing to address — the caller refuses rather
 * than leaving a draft.
 */
export function planImmediateAltSave(args: {
  url: string;
  dirtyUrls: Iterable<string>;
  texts: Readonly<Record<string, string>>;
  /** url -> media GID (null/undefined = not addressable). */
  gidOf: (url: string) => string | null | undefined;
  locale?: string;
  marketId?: string;
  productId: string;
  productTitle?: string;
  editOrder?: ReadonlyMap<string, number>;
}): QueuedAltSave | null {
  const gid = args.gidOf(args.url);
  if (!gid || !gid.startsWith("gid://")) return null;
  const urls = new Set<string>([args.url]);
  for (const d of args.dirtyUrls) if (d !== args.url && args.gidOf(d) === gid) urls.add(d);
  const lookup: Record<string, string> = {};
  for (const u of urls) lookup[u] = gid;
  const { entries } = planAltFlush({
    dirtyUrls: urls,
    texts: args.texts,
    urlToGid: lookup,
    locale: args.locale,
    marketId: args.marketId,
    productId: args.productId,
    productTitle: args.productTitle,
    editOrder: args.editOrder,
  });
  return entries[0] ? { ...entries[0], immediate: true } : null;
}

/** Is a save an AI button sent at once still queued or in flight? */
export function hasImmediateAltSave(
  inFlight: QueuedAltSave | null | undefined,
  queue: readonly QueuedAltSave[],
): boolean {
  return !!inFlight?.immediate || queue.some((q) => !!q.immediate);
}

/**
 * Which planned saves still have to be SENT. A save that is already queued or
 * in flight for the same medium AND with the same text is reused (the new page
 * Save waits for it); one with a different text -- the merchant typed on after
 * the first Save -- is sent again, never filtered out by its key alone.
 */
export function selectAltSends(
  planned: readonly QueuedAltSave[],
  pending: readonly QueuedAltSave[],
): { send: QueuedAltSave[]; reuse: QueuedAltSave[] } {
  const send: QueuedAltSave[] = [];
  const reuse: QueuedAltSave[] = [];
  for (const entry of planned) {
    const key = altFlushKey(entry);
    // The LAST matching pending save is the one that decides what is stored.
    const same = [...pending].reverse().find((p) => altFlushKey(p) === key);
    if (same && same.altText === entry.altText) {
      // Reused -- but a tile of the same medium planned only NOW (the merchant
      // typed the same text on a second tile after the first Save) rides on it
      // as an alias, or it never settles and the bar stays up. The pending
      // save is mutated on purpose: it is the very object the queue sends and
      // the answer settles (its identity is the page Save's token).
      const extra = mergeAltAliases(same, entry);
      if (extra.length > 0) same.aliases = [...(same.aliases ?? []), ...extra];
      reuse.push(same);
    } else send.push(entry);
  }
  return { send, reuse };
}

/**
 * The tiles a planned save covers (its own url and its aliases) that a reused
 * pending save of the same medium and text does not cover yet.
 */
export function mergeAltAliases(
  pending: Pick<QueuedAltSave, "url" | "aliases">,
  planned: Pick<QueuedAltSave, "url" | "altText" | "aliases">,
): Array<{ url: string; altText: string }> {
  const covered = new Set<string>([pending.url, ...(pending.aliases ?? []).map((a) => a.url)]);
  const out: Array<{ url: string; altText: string }> = [];
  for (const c of [{ url: planned.url, altText: planned.altText }, ...(planned.aliases ?? [])]) {
    if (covered.has(c.url)) continue;
    covered.add(c.url);
    out.push({ url: c.url, altText: c.altText });
  }
  return out;
}

/** Is a queued save (or carried-over draft) one of the view the merchant is looking at? Discard only takes back those. */
export function altSaveInView(
  entry: Pick<QueuedAltSave, "productId" | "locale" | "marketId">,
  view: { productId: string; locale?: string; marketId?: string },
): boolean {
  return (entry.productId ?? view.productId) === view.productId
    && (entry.locale ?? "") === (view.locale ?? "")
    && (entry.marketId ?? "") === (view.marketId ?? "");
}

/**
 * The draft urls that belong to media that no longer exist: a url whose
 * medium (resolved through the url -> gid lookup, `?v=`-tolerant) was
 * DELETED, or an unsaved upload's preview url that was removed with it.
 */
export function altDraftUrlsOfDeletedMedia(
  urls: Iterable<string>,
  lookup: Readonly<Record<string, string>>,
  deletedGids: ReadonlySet<string>,
  removedPreviewUrls: ReadonlySet<string>,
  gidOf: (lookup: Readonly<Record<string, string>>, url: string) => string | null,
): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (removedPreviewUrls.has(url)) {
      out.push(url);
      continue;
    }
    const gid = gidOf(lookup, url);
    if (gid && deletedGids.has(gid)) out.push(url);
  }
  return out;
}

/**
 * Drafts stranded under a url that nothing can address any more: no medium
 * resolves it, no tile shows it, and no carried-over or settling upload will
 * move it (a medium deleted elsewhere, a WebP swap that replaced it with a new
 * one). Left alone such a draft keeps the save bar up and fails every Save.
 * A non-preview url is only judged while the gallery is LOADED: an empty
 * lookup is a gallery still loading, not one in which every medium vanished.
 */
export function strandedAltDraftUrls(args: {
  dirtyUrls: Iterable<string>;
  lookup: Readonly<Record<string, string>>;
  shown: ReadonlySet<string>;
  carried: ReadonlySet<string>;
  settlingPreviews: ReadonlySet<string>;
  gidOf: (lookup: Readonly<Record<string, string>>, url: string) => string | null;
}): string[] {
  const loaded = Object.keys(args.lookup).length > 0 || args.shown.size > 0;
  const out: string[] = [];
  for (const url of args.dirtyUrls) {
    if (args.shown.has(url) || args.carried.has(url) || args.settlingPreviews.has(url)) continue;
    const isPreview = url.startsWith("blob:") || url.startsWith("data:");
    if (!isPreview && (!loaded || args.gidOf(args.lookup, url))) continue;
    out.push(url);
  }
  return out;
}

/** The draft state without the given urls (texts, dirty, baselines, failed flags, edit order). */
export function dropAltDrafts(state: AltDraftState, urls: Iterable<string>): AltDraftState {
  const texts = { ...state.texts };
  const dirty = new Set(state.dirty);
  const baselines = new Map(state.baselines);
  const failed = new Set(state.failed);
  const editOrder = new Map(state.editOrder);
  for (const url of urls) {
    delete texts[url];
    dirty.delete(url);
    baselines.delete(url);
    failed.delete(url);
    editOrder.delete(url);
  }
  return { texts, dirty, baselines, failed, editOrder };
}

/** Splits the QUEUE (never the save in flight -- it cannot be taken back) into what stays and what is dropped. */
export function partitionAltQueue<T>(queue: readonly T[], drop: (entry: T) => boolean): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const q of queue) (drop(q) ? dropped : kept).push(q);
  return { kept, dropped };
}

/** What Discard puts back: the value an image's alt had before its first edit (undefined = no own value). */
export function restoreAltDrafts(
  texts: Readonly<Record<string, string>>,
  baselines: ReadonlyMap<string, string | undefined>,
  urls: Iterable<string>,
): Record<string, string> {
  const next = { ...texts };
  for (const url of urls) {
    const base = baselines.get(url);
    if (base === undefined) delete next[url];
    else next[url] = base;
  }
  return next;
}

/**
 * A foreign save Shopify could not store because the image has no PRIMARY alt
 * (`noPrimary`): no retry can ever store it, so instead of a failed draft the
 * tiles go back to what the language held before the edit (the Discard value).
 * A tile typed on after the save was sent shows a NEWER draft and is left
 * alone. Returns the new texts and the urls that were reverted.
 */
export function revertAltDraftsWithoutPrimary(args: {
  texts: Readonly<Record<string, string>>;
  baselines: ReadonlyMap<string, string | undefined>;
  planned: ReadonlyArray<{ url: string; altText: string }>;
}): { texts: Record<string, string>; reverted: string[] } {
  const reverted: string[] = [];
  for (const p of args.planned) {
    const current = args.texts[p.url];
    if (current !== undefined && current !== p.altText) continue;
    if (!reverted.includes(p.url)) reverted.push(p.url);
  }
  return { texts: restoreAltDrafts(args.texts, args.baselines, reverted), reverted };
}

/**
 * One page Save waiting for its saves to be answered. It waits for TOKENS:
 * the queued save objects themselves (so a second save of the same medium is
 * told apart from the first), or a placeholder for a draft carried over until
 * its image exists.
 */
export interface AltFlushWaiter {
  pending: Set<object>;
  ok: number;
  failed: number;
  unsent: number;
}

export function createAltFlushWaiter(tokens: Iterable<object>, unsent = 0): AltFlushWaiter {
  return { pending: new Set(tokens), ok: 0, failed: 0, unsent };
}

/** Records one answer; true once nothing is pending any more. An answer nobody waits for is ignored. */
export function settleAltFlushWaiter(w: AltFlushWaiter, token: object, ok: boolean): boolean {
  if (w.pending.delete(token)) {
    if (ok) w.ok += 1;
    else w.failed += 1;
  }
  return w.pending.size === 0;
}

/** A token that will never be answered (dropped, not sendable): it counts as unsent. True once nothing is pending. */
export function releaseAltFlushToken(w: AltFlushWaiter, token: object): boolean {
  if (w.pending.delete(token)) w.unsent += 1;
  return w.pending.size === 0;
}

/** A save replaced by a newer one (same medium, queued) or a carried-over draft that was finally sent: whoever waited for `from` now waits for `to`. */
export function transferAltFlushWaiter(w: AltFlushWaiter, from: object, to: object): void {
  if (w.pending.delete(from)) w.pending.add(to);
}

export function altFlushSummary(w: AltFlushWaiter): AltFlushSummary {
  // A save still pending when the summary is taken (it was dropped by a switch
  // or Discard) was not confirmed either: it counts as unsent, never as saved.
  return { ok: w.ok, failed: w.failed, unsent: w.unsent + w.pending.size };
}

/**
 * Drafts no pending save will write: a dirty image whose current text is not
 * the text of a queued / in-flight / carried-over save of that url (or of a
 * save it rides on as an alias). This is what a language, market or product
 * switch would really lose.
 */
export function unsentAltDrafts(
  dirtyUrls: Iterable<string>,
  texts: Readonly<Record<string, string>>,
  pending: ReadonlyArray<Pick<QueuedAltSave, "url" | "altText" | "aliases">>,
): string[] {
  const covered = new Map<string, Set<string>>();
  const cover = (url: string, text: string) => {
    const set = covered.get(url) ?? new Set<string>();
    set.add(text);
    covered.set(url, set);
  };
  for (const p of pending) {
    cover(p.url, p.altText);
    for (const a of p.aliases ?? []) cover(a.url, a.altText);
  }
  const out: string[] = [];
  for (const url of dirtyUrls) {
    const text = texts[url];
    if (text === undefined) continue;
    if (!covered.get(url)?.has(text)) out.push(url);
  }
  return out;
}

/** A newly saved medium the gallery now shows under its real url. */
export interface SettlingAltSource {
  productId: string;
  mediaId: string;
  previewUrl?: string;
}

/**
 * Where a draft typed on an UNSAVED tile goes once the image exists: the
 * settling entry whose preview the tile showed names its media id, and the
 * fetched media map its real url (null while Shopify still processes it).
 * Null = the url belongs to no saved medium (yet).
 */
export function settledAltTarget(
  url: string,
  settling: readonly SettlingAltSource[],
  productId: string,
  mediaMap: Readonly<Record<string, string>>,
): { mediaId: string; url: string | null } | null {
  const hit = settling.find((s) => s.productId === productId && s.previewUrl === url);
  if (!hit) return null;
  return { mediaId: hit.mediaId, url: mediaMap[hit.mediaId] || null };
}

/**
 * The tile urls that changed: a settling medium's preview url (the key its
 * alt draft lives under) -> the real url the gallery shows from now on.
 */
export function settledAltRenames(
  settling: readonly SettlingAltSource[],
  productId: string,
  mediaMap: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of settling) {
    if (s.productId !== productId || !s.previewUrl) continue;
    const real = mediaMap[s.mediaId];
    if (real && real !== s.previewUrl) out[s.previewUrl] = real;
  }
  return out;
}

/** The alt-draft state, keyed by tile url. */
export interface AltDraftState {
  texts: Record<string, string>;
  dirty: Set<string>;
  baselines: Map<string, string | undefined>;
  failed: Set<string>;
  editOrder: Map<string, number>;
}

/**
 * Moves every draft from an old tile url to the new one (a saved upload that
 * left its preview url behind). A draft is never stranded under a url no tile
 * shows any more: the bar would never clear and its text never be sent.
 */
export function rekeyAltDrafts(state: AltDraftState, renames: Readonly<Record<string, string>>): AltDraftState {
  const texts = { ...state.texts };
  const dirty = new Set(state.dirty);
  const baselines = new Map(state.baselines);
  const failed = new Set(state.failed);
  const editOrder = new Map(state.editOrder);
  for (const [from, to] of Object.entries(renames)) {
    if (from === to) continue;
    if (from in texts) {
      texts[to] = texts[from];
      delete texts[from];
    }
    if (dirty.delete(from)) dirty.add(to);
    if (failed.delete(from)) failed.add(to);
    if (baselines.has(from)) {
      baselines.set(to, baselines.get(from));
      baselines.delete(from);
    }
    if (editOrder.has(from)) {
      editOrder.set(to, editOrder.get(from)!);
      editOrder.delete(from);
    }
  }
  return { texts, dirty, baselines, failed, editOrder };
}
