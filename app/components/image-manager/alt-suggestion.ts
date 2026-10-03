/**
 * The pure half of the image manager's alt-text SUGGESTIONS.
 *
 * ✨ generate no longer writes into the field and saves at once: it shows the
 * result as a suggestion (the editor's own banner) and the merchant decides --
 * Accept, Accept & Translate or Decline -- exactly as for every other field.
 * (The single-language 🌍 translate stays an immediate save.)
 *
 * A suggestion belongs to ONE (product, language, market, medium): it is kept
 * under that key and only ever shown in that view, so it cannot leak into
 * another language, market or product. It is not a save-bar draft: it does not
 * light the bar, and nothing is written until it is accepted.
 *
 * Accepting is decided here, BEFORE any state is touched: a refusal stages
 * nothing. The accept itself is the existing immediate per-image save
 * (`planImmediateAltSave`); "& translate" only marks that save, and the
 * translate-to-all request is started by the manager once that save is
 * CONFIRMED (`shouldTranslateAfterSave`) -- a failed save translates nothing.
 *
 * Import-light on purpose (types and one sibling module): the manager and its
 * tests both use it.
 */
import type { QueuedAltSave } from "../../services/alt-text-feedback.shared";
import { planImmediateAltSave } from "./alt-draft";

export interface AltSuggestionScope {
  productId: string;
  /** Undefined = the primary language. */
  locale?: string;
  /** Undefined / "" = the global layer. */
  marketId?: string;
  mediaId: string;
}

export type AltSuggestionMap = Readonly<Record<string, string>>;

export function altSuggestionKey(scope: AltSuggestionScope): string {
  return `${scope.productId}|${scope.locale ?? ""}|${scope.marketId ?? ""}|${scope.mediaId}`;
}

/** The map with this suggestion stored (an empty text is not a suggestion). */
export function withAltSuggestion(map: AltSuggestionMap, scope: AltSuggestionScope, text: string): AltSuggestionMap {
  if (!text.trim()) return withoutAltSuggestion(map, scope);
  return { ...map, [altSuggestionKey(scope)]: text };
}

export function withoutAltSuggestion(map: AltSuggestionMap, scope: AltSuggestionScope): AltSuggestionMap {
  const key = altSuggestionKey(scope);
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Only the suggestions of one product (a product switch drops every other). */
export function altSuggestionsOfProduct(map: AltSuggestionMap, productId: string): AltSuggestionMap {
  const prefix = `${productId}|`;
  const next: Record<string, string> = {};
  for (const [key, text] of Object.entries(map)) if (key.startsWith(prefix)) next[key] = text;
  return Object.keys(next).length === Object.keys(map).length ? map : next;
}

/** The suggestion of the medium in the view the merchant is looking at. */
export function altSuggestionInView(
  map: AltSuggestionMap,
  view: { productId: string; locale?: string; marketId?: string },
  mediaId: string | null | undefined,
): string | undefined {
  if (!mediaId) return undefined;
  return map[altSuggestionKey({ ...view, mediaId })];
}

export type AcceptRefusal =
  /** No suggestion for this medium in this view. */
  | "noSuggestion"
  /** The image has no media id yet (an unsaved upload): nothing to save to. */
  | "noMedia"
  /** A generate / translate request is out: its answer would collide with the save. */
  | "busy"
  /** "& translate" outside the primary language. */
  | "translateNeedsPrimary"
  /** "& translate" in a shop with one language only. */
  | "singleLanguage";

export type AcceptPlan =
  | { kind: "refused"; reason: AcceptRefusal }
  | {
      kind: "save";
      /** The suggestion text that goes into the field. */
      text: string;
      /** The one save to queue (IMMEDIATE, marked `thenTranslateAll` for "& translate"). */
      entry: QueuedAltSave;
    };

/**
 * Decides an Accept / Accept & Translate. Pure and called BEFORE the field or
 * any state is touched: every refusal leaves everything as it was.
 */
export function planAcceptAltSuggestion(args: {
  url: string;
  mediaId: string | null | undefined;
  suggestion: string | undefined;
  translate: boolean;
  isPrimaryLocale: boolean;
  singleLocale: boolean;
  /** A generate / translate request of the manager is in flight. */
  aiBusy: boolean;
  dirtyUrls: Iterable<string>;
  texts: Readonly<Record<string, string>>;
  gidOf: (url: string) => string | null | undefined;
  locale?: string;
  marketId?: string;
  productId: string;
  productTitle?: string;
  editOrder?: ReadonlyMap<string, number>;
}): AcceptPlan {
  if (!args.suggestion || !args.suggestion.trim()) return { kind: "refused", reason: "noSuggestion" };
  if (!args.mediaId || !args.mediaId.startsWith("gid://")) return { kind: "refused", reason: "noMedia" };
  if (args.aiBusy) return { kind: "refused", reason: "busy" };
  if (args.translate && !args.isPrimaryLocale) return { kind: "refused", reason: "translateNeedsPrimary" };
  if (args.translate && args.singleLocale) return { kind: "refused", reason: "singleLanguage" };
  const entry = planImmediateAltSave({
    url: args.url,
    dirtyUrls: args.dirtyUrls,
    // The text as it will be once accepted -- the field itself is not touched yet.
    texts: { ...args.texts, [args.url]: args.suggestion },
    gidOf: (u) => (u === args.url ? args.mediaId : args.gidOf(u)),
    locale: args.locale,
    marketId: args.marketId,
    productId: args.productId,
    productTitle: args.productTitle,
    // The accepted text is the latest edit of its medium.
    editOrder: new Map([...(args.editOrder ?? []), [args.url, Number.MAX_SAFE_INTEGER]]),
  });
  if (!entry) return { kind: "refused", reason: "noMedia" };
  return { kind: "save", text: args.suggestion, entry: args.translate ? { ...entry, thenTranslateAll: true } : entry };
}

/**
 * Is the translate-to-all of an "Accept & Translate" to start now? Only for a
 * CONFIRMED save of a marked entry, while the view still shows the product the
 * save was made on: a failed save translates nothing.
 */
export function shouldTranslateAfterSave(
  entry: Pick<QueuedAltSave, "thenTranslateAll" | "productId" | "locale">,
  verdictKind: string,
  currentProductId: string,
  primaryLocale?: string,
): boolean {
  // The save must be of the primary language and of the product on screen.
  const primary = !entry.locale || !primaryLocale || entry.locale === primaryLocale;
  return !!entry.thenTranslateAll && verdictKind === "saved" && primary && (!entry.productId || entry.productId === currentProductId);
}
