/**
 * The website's images, and whether each one exists yet.
 *
 * Same shape as marketing-videos.ts and for the same reason: the page ships
 * BEFORE the artwork, every slot renders a clean placeholder until its entry
 * is filled in, and filling one in is an edit to this file alone. A slot is
 * named after the PLACE it appears in, never after a file, so the layout can
 * be finished and reviewed while every entry is still `null`.
 *
 * `width`/`height` are the intrinsic pixel size and are required: without
 * them the browser cannot reserve the box before the file arrives, and the
 * page jumps as each screenshot loads. `alt` lives with the copy
 * (`media.alt[slot]` in app/i18n/marketing) so it is translated like
 * everything else.
 */

export const MARKETING_IMAGE_SLOTS = [
  "hero",
  "pillar-writes",
  "pillar-translates",
  "pillar-found",
  "feature-ai",
  "feature-translations",
  "feature-bulk",
  "feature-seo",
  "feature-aeo",
  "feature-media",
  "feature-structure",
] as const;

export type MarketingImageSlot = (typeof MARKETING_IMAGE_SLOTS)[number];

export interface MarketingImage {
  /** Absolute https URL or a path under /public. */
  src: string;
  width: number;
  height: number;
}

export const MARKETING_IMAGES: Record<MarketingImageSlot, MarketingImage | null> = {
  hero: null,
  "pillar-writes": null,
  "pillar-translates": null,
  "pillar-found": null,
  "feature-ai": null,
  "feature-translations": null,
  "feature-bulk": null,
  "feature-seo": null,
  "feature-aeo": null,
  "feature-media": null,
  "feature-structure": null,
};
