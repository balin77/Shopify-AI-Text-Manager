/**
 * Pure rules of the image manager's alt-text fields on a market layer.
 *
 * With a market selected the server answers market rows over global ones and
 * names the media whose value is INHERITED from the global layer. An inherited
 * value is a fallback to look at, not content of this layer: putting it into
 * the field would (a) count the image as translated for the market and
 * (b) let a plain click in and out of the box -- the inputs save on blur --
 * pin the global wording as a market override.
 */

export interface LoadedAltLayer {
  /** url -> value that belongs to the OPEN layer (own rows only). */
  own: Record<string, string>;
  /** url -> value inherited from the global layer. */
  inherited: Record<string, string>;
}

export function splitLoadedAltTexts(
  altTexts: Record<string, string>,
  inheritedMediaIds: readonly string[] | undefined,
  urlOfMedia: (mediaId: string) => string | undefined,
): LoadedAltLayer {
  const inheritedSet = new Set(inheritedMediaIds ?? []);
  const own: Record<string, string> = {};
  const inherited: Record<string, string> = {};
  for (const [mediaId, value] of Object.entries(altTexts)) {
    const url = urlOfMedia(mediaId);
    if (!url) continue;
    (inheritedSet.has(mediaId) ? inherited : own)[url] = value;
  }
  return { own, inherited };
}

/** What a foreign-language alt field shows and how it counts. */
export function altFieldView(args: {
  own: string | undefined;
  inherited: string | undefined;
  primaryAlt: string;
  fallbackPlaceholder: string;
}): { value: string; placeholder: string; isTranslated: boolean; showsInherited: boolean } {
  const value = args.own ?? "";
  const inherited = (args.inherited ?? "").trim() !== "" && value === "" ? args.inherited! : "";
  return {
    value,
    placeholder: inherited || args.primaryAlt || args.fallbackPlaceholder,
    isTranslated: value !== "",
    showsInherited: inherited !== "",
  };
}

/** A blur without an edit writes nothing. */
export function shouldSaveAltText(dirty: boolean): boolean {
  return dirty;
}
