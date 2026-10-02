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
  /** Sends every dirty alt through the save queue; resolves once each was answered. Never throws. */
  flush: () => Promise<AltFlushSummary>;
  /** Puts every alt draft back to what it was before it was edited. */
  discard: () => void;
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
 * The saves a page Save has to send, one per dirty image of the language and
 * market the view shows. A draft whose image has no media id yet (an unsaved
 * tile) cannot be addressed: it is reported as `unaddressable` and stays dirty.
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
}): { entries: QueuedAltSave[]; unaddressable: string[] } {
  const entries: QueuedAltSave[] = [];
  const unaddressable: string[] = [];
  for (const url of args.dirtyUrls) {
    const text = args.texts[url];
    // A dirty flag without a text is a draft that was already taken back.
    if (text === undefined) continue;
    const mediaId = args.urlToGid[url];
    if (!mediaId || !mediaId.startsWith("gid://")) {
      unaddressable.push(url);
      continue;
    }
    entries.push({
      url,
      mediaId,
      altText: text,
      locale: args.locale,
      marketId: args.marketId || undefined,
      productId: args.productId,
      productTitle: args.productTitle,
    });
  }
  return { entries, unaddressable };
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

/** One page Save waiting for its saves to be answered. */
export interface AltFlushWaiter {
  pending: Set<string>;
  ok: number;
  failed: number;
  unsent: number;
}

export function createAltFlushWaiter(keys: Iterable<string>, unsent = 0): AltFlushWaiter {
  return { pending: new Set(keys), ok: 0, failed: 0, unsent };
}

/** Records one answer; true once nothing is pending any more. An answer nobody waits for is ignored. */
export function settleAltFlushWaiter(w: AltFlushWaiter, key: string, ok: boolean): boolean {
  if (w.pending.delete(key)) {
    if (ok) w.ok += 1;
    else w.failed += 1;
  }
  return w.pending.size === 0;
}

export function altFlushSummary(w: AltFlushWaiter): AltFlushSummary {
  // A save still pending when the summary is taken (it was dropped by a switch
  // or Discard) was not confirmed either: it counts as unsent, never as saved.
  return { ok: w.ok, failed: w.failed, unsent: w.unsent + w.pending.size };
}
