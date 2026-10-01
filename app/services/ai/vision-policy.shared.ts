/**
 * May the AI look at the shop's images, and at how many per request?
 *
 * ONE answer, stored on `AISettings` and edited in AI instructions → General.
 * Before this it was three answers: a checkbox in the content editor's toolbar
 * that reset to off on every page load, a second one in the create dialog, and
 * a hardcoded `false` in the alt-text action the image manager posts to. Same
 * merchant, same shop, three behaviours depending on which button they pressed
 * — and no way to find the switch from the two surfaces that did not have one.
 *
 * **The SERVER decides.** The client sends the image URLs it has and nothing
 * else; the flag is not on the wire any more. That is not tidiness: every AI
 * route takes a direct POST, so a client-sent "yes" is not a permission, and a
 * merchant who switched vision off has to be able to rely on it costing them
 * nothing.
 *
 * Client-safe (no `.server` import, no Prisma import): the settings tab renders
 * the ceiling from here and the handlers clamp against it, so the number the
 * merchant can pick and the number the server will accept are the same number.
 */

/** What a caller needs to know. Structural, so `AISettings` satisfies it. */
export interface VisionSettingsLike {
  sendImagesToAI: boolean;
  aiImagesPerRequest: number;
}

export interface VisionPolicy {
  /** May any image be attached at all? */
  sendImages: boolean;
  /** How many, at most, for a request that can carry several. Always >= 1 so a
   *  caller that ignores `sendImages` still cannot fan out. */
  maxImages: number;
}

/**
 * The ceiling on "how many images per request".
 *
 * Not a round number pulled from the air: each image is a separate cost and a
 * separate upload, Gemini's path DOWNLOADS every one of them inside the request
 * (`fetchImageAsBase64`) before the call even starts, and beyond a handful the
 * model's attention is the binding constraint rather than the catalogue's. Five
 * is generous for describing one product and still bounded.
 */
export const AI_IMAGES_PER_REQUEST_MAX = 5;
export const AI_IMAGES_PER_REQUEST_MIN = 1;

/** The stored number, made safe. Anything unusable falls back to ONE — the
 *  historic behaviour — never to the maximum. */
export function clampImagesPerRequest(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return AI_IMAGES_PER_REQUEST_MIN;
  const rounded = Math.floor(value);
  if (rounded < AI_IMAGES_PER_REQUEST_MIN) return AI_IMAGES_PER_REQUEST_MIN;
  if (rounded > AI_IMAGES_PER_REQUEST_MAX) return AI_IMAGES_PER_REQUEST_MAX;
  return rounded;
}

/**
 * The shop's answer. `null` settings — no row yet — means OFF: a shop that has
 * never opened the settings has never agreed to pay for vision.
 */
export function resolveVisionPolicy(settings: Partial<VisionSettingsLike> | null | undefined): VisionPolicy {
  return {
    sendImages: settings?.sendImagesToAI === true,
    maxImages: clampImagesPerRequest(settings?.aiImagesPerRequest),
  };
}

/**
 * The images a request may actually carry, out of everything the client offered.
 *
 * Every image-bearing AI handler goes through this rather than testing
 * `policy.sendImages` itself: with the test written out per call site, "off"
 * gets honoured in one branch and forgotten in the next, which is precisely the
 * history this module ends. Empty, blank and duplicate URLs are dropped — a
 * duplicate is the same picture twice at full price, and the product gallery
 * legitimately repeats the featured image.
 */
export function visionImageUrls(
  candidates: Array<string | null | undefined>,
  policy: VisionPolicy,
  /** Alt text describes ONE image; its siblings would only invite the model to
   *  describe the wrong one. Such a caller passes 1 and ignores the setting. */
  limitOverride?: number,
): string[] {
  if (!policy.sendImages) return [];
  const limit = limitOverride === undefined ? policy.maxImages : Math.max(0, Math.floor(limitOverride));
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const url = typeof candidate === "string" ? candidate.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    picked.push(url);
  }
  return picked;
}

/**
 * Read the candidate list off a form.
 *
 * Two spellings on purpose: `imageUrls` is a JSON array (what a caller with a
 * gallery sends) and `imageUrl` is the single one every existing caller already
 * sends. Accepting both is what lets the alt-text paths and the image manager
 * keep their one-image payload untouched while the generation paths grow a
 * list. A malformed JSON array is treated as no list at all rather than
 * throwing: the request still has a generation to do.
 */
export function readImageCandidates(formData: {
  get(name: string): FormDataEntryValue | null;
}): string[] {
  const raw = formData.get("imageUrls");
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      // fall through to the single-URL spelling
    }
  }
  const single = formData.get("imageUrl");
  return typeof single === "string" && single.trim() ? [single] : [];
}

/** The little an item has to expose for its pictures to be offered. */
export interface VisionImageSourceLike {
  images?: Array<{ url?: string | null } | null> | null;
  featuredImage?: { url?: string | null } | null;
}

/**
 * Which of an item's images the AI could be shown, best first.
 *
 * The SELECTED one leads: it is the picture the merchant is looking at while
 * they press the button, and with the setting at one image it must be the one
 * that goes — that was the old behaviour and losing it would be a regression
 * dressed up as a feature. The rest of the gallery follows in its own order,
 * and the featured image last in case it is not in the gallery at all.
 *
 * Only product-shaped content has a gallery; a collection, a blog or an article
 * has exactly one image, so the count setting simply has nothing to spend
 * itself on there. Everything else (pages, policies, metaobjects, theme
 * content) has no image this app knows about and offers none.
 *
 * Capped at the ceiling: sending the server more candidates than it could ever
 * use is payload nobody reads, and the clamp lives in one place.
 */
export function aiImageCandidates(
  contentType: string,
  item: VisionImageSourceLike | null | undefined,
  selectedIndex = 0,
): string[] {
  if (!item) return [];
  const urlOf = (entry: { url?: string | null } | null | undefined): string =>
    typeof entry?.url === "string" ? entry.url.trim() : "";

  const ordered: string[] = [];
  if (contentType === "products") {
    const gallery = Array.isArray(item.images) ? item.images : [];
    const selected = urlOf(gallery[selectedIndex]);
    if (selected) ordered.push(selected);
    for (const entry of gallery) {
      const url = urlOf(entry);
      if (url) ordered.push(url);
    }
  }
  const featured = urlOf(item.featuredImage);
  if (featured && (contentType === "products" || contentType === "collections" || contentType === "blogs")) {
    ordered.push(featured);
  }

  // Deduplicated by the same rule the server uses — the featured image is
  // usually the gallery's first entry, and paying for it twice is the one
  // outcome nobody would ask for.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of ordered) {
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
    if (unique.length >= AI_IMAGES_PER_REQUEST_MAX) break;
  }
  return unique;
}
