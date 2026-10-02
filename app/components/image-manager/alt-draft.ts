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
    if (same && same.altText === entry.altText) reuse.push(same);
    else send.push(entry);
  }
  return { send, reuse };
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
