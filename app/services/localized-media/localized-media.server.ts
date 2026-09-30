/**
 * "Images per language" for PRODUCTS — the Shopify half (PLAN_LOCALIZED_IMAGES
 * Phase 1b). Reads and writes the product's `custom.localized_media`
 * metafield; the shape and every rule about it live in
 * localized-media.shared.ts.
 *
 * Three rules this module owns:
 *  - A write counts only when Shopify ECHOES it: `metafieldsSet` must hand
 *    back this product's metafield carrying exactly the value sent
 *    (`userErrors: []` alone confirms nothing — CLAUDE.md). An emptied list is
 *    `metafieldsDelete`, because `metafieldsSet` rejects a blank value, and it
 *    counts only on the echoed owner.
 *  - Every write is READ-MODIFY-WRITE of the whole list, fresh from Shopify,
 *    never from a client copy: the client names ONE change and the server
 *    applies it to what is stored now. Two editors at the same moment: the
 *    later write wins (stated in the plan).
 *  - Nothing the storefront trusts comes from the client. The original's
 *    filename comes from the product's OWN media, the replacement's URL from
 *    a fresh read of the chosen file (READY, a MediaImage, on Shopify's CDN),
 *    the locale must be a non-primary shop locale and the market an active one.
 *
 * `setLocalizedImage` takes `origin` so stage 2 (the AI translating the text
 * inside an image) writes through this same function with `origin: "ai"`.
 */
import { METAFIELDS_DELETE, METAFIELDS_SET } from "~/graphql/content.mutations";
import { logger } from "~/utils/logger.server";
import {
  LOCALIZED_MEDIA_KEY,
  LOCALIZED_MEDIA_NAMESPACE,
  LOCALIZED_MEDIA_TYPE,
  MAX_LOCALIZED_MEDIA_ENTRIES,
  isSafeFilename,
  isShopifyCdnUrl,
  marketNumericId,
  normalizeLocale,
  parseLocalizedMediaValue,
  removeLocalizedMediaEntry,
  serializeLocalizedMedia,
  storefrontFilename,
  upsertLocalizedMediaEntry,
  type LocalizedMediaEntry,
  type LocalizedMediaOrigin,
} from "./localized-media.shared";

type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

export interface ProductMediaImage {
  id: string;
  url: string;
  alt: string | null;
}

export type LocalizedMediaErrorCode =
  | "notFound"
  | "readFailed"
  | "writeNotConfirmed"
  | "invalidLocale"
  | "invalidMarket"
  | "invalidSource"
  | "invalidFile"
  | "fileNotReady"
  | "sameFile"
  | "replacementIsOriginal"
  | "tooManyEntries";

export type LocalizedMediaResult<T> = ({ ok: true } & T) | { ok: false; code: LocalizedMediaErrorCode; message?: string };

// Prose stays out of the documents (CLAUDE.md: #graphql literals are sent verbatim).
const READ_PRODUCT = `#graphql
  query localizedMediaProduct($id: ID!, $namespace: String!, $key: String!) {
    product(id: $id) {
      id
      metafield(namespace: $namespace, key: $key) { id value }
      media(first: 250) {
        nodes {
          id
          mediaContentType
          ... on MediaImage { alt image { url } }
        }
      }
    }
  }
`;

const READ_FILE = `#graphql
  query localizedMediaFile($id: ID!) {
    node(id: $id) {
      id
      ... on MediaImage { fileStatus image { url } }
    }
  }
`;

async function gqlData<T>(graphql: Graphql, query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await graphql(query, { variables });
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
  } catch (error) {
    logger.warn("[localized-media] graphql failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function readProductLocalizedMedia(
  graphql: Graphql,
  productId: string,
): Promise<LocalizedMediaResult<{ entries: LocalizedMediaEntry[]; media: ProductMediaImage[]; hasMetafield: boolean }>> {
  const data = await gqlData<{
    product: {
      metafield: { id: string; value: string } | null;
      media: { nodes: Array<{ id: string; mediaContentType: string; alt?: string | null; image?: { url: string } | null }> };
    } | null;
  }>(graphql, READ_PRODUCT, { id: productId, namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY });
  if (!data) return { ok: false, code: "readFailed" };
  if (!data.product) return { ok: false, code: "notFound" };
  const media = (data.product.media?.nodes ?? [])
    .filter((n) => n.mediaContentType === "IMAGE" && n.image?.url)
    .map((n) => ({ id: n.id, url: n.image!.url, alt: n.alt ?? null }));
  return {
    ok: true,
    entries: parseLocalizedMediaValue(data.product.metafield?.value ?? null),
    media,
    hasMetafield: !!data.product.metafield,
  };
}

/**
 * Writes the WHOLE list and confirms it by the echo. Empty ⇒ delete (only when
 * there is something to delete — a delete of nothing echoes nothing).
 */
export async function writeProductLocalizedMedia(
  graphql: Graphql,
  productId: string,
  entries: LocalizedMediaEntry[],
  hadMetafield: boolean,
): Promise<LocalizedMediaResult<object>> {
  if (entries.length > MAX_LOCALIZED_MEDIA_ENTRIES) return { ok: false, code: "tooManyEntries" };
  if (entries.length === 0) {
    if (!hadMetafield) return { ok: true };
    const data = await gqlData<{
      metafieldsDelete: { deletedMetafields: Array<{ ownerId: string; key: string; namespace: string } | null> | null; userErrors: { message: string }[] } | null;
    }>(graphql, METAFIELDS_DELETE, {
      metafields: [{ ownerId: productId, namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY }],
    });
    const confirmed = (data?.metafieldsDelete?.deletedMetafields ?? []).some(
      (d) => d?.ownerId === productId && d.key === LOCALIZED_MEDIA_KEY && d.namespace === LOCALIZED_MEDIA_NAMESPACE,
    );
    if (!confirmed) {
      logger.warn("[localized-media] delete not confirmed", { productId, userErrors: data?.metafieldsDelete?.userErrors });
      return { ok: false, code: "writeNotConfirmed", message: data?.metafieldsDelete?.userErrors?.[0]?.message };
    }
    return { ok: true };
  }

  const value = serializeLocalizedMedia(entries);
  const data = await gqlData<{
    metafieldsSet: {
      metafields: Array<{ key: string; namespace: string; value: string; owner: { id?: string } | null }> | null;
      userErrors: { message: string }[];
    } | null;
  }>(graphql, METAFIELDS_SET, {
    metafields: [{ ownerId: productId, namespace: LOCALIZED_MEDIA_NAMESPACE, key: LOCALIZED_MEDIA_KEY, type: LOCALIZED_MEDIA_TYPE, value }],
  });
  const echoed = (data?.metafieldsSet?.metafields ?? []).find(
    (mf) => mf.owner?.id === productId && mf.key === LOCALIZED_MEDIA_KEY && mf.namespace === LOCALIZED_MEDIA_NAMESPACE,
  );
  // Compared as parsed data: Shopify may re-serialise JSON (key order, spacing).
  const same = !!echoed && serializeLocalizedMedia(parseLocalizedMediaValue(echoed.value)) === serializeLocalizedMedia(parseLocalizedMediaValue(value));
  if (!same) {
    logger.warn("[localized-media] write not confirmed", { productId, userErrors: data?.metafieldsSet?.userErrors });
    return { ok: false, code: "writeNotConfirmed", message: data?.metafieldsSet?.userErrors?.[0]?.message };
  }
  return { ok: true };
}

export interface LocaleMarketScope {
  /** Every shop locale code with its primary flag. An EMPTY list means the lookup failed. */
  shopLocales: Array<{ locale: string; primary: boolean }>;
  /** Active markets (GIDs). */
  activeMarketIds: string[];
}

function validateScope(locale: string, marketId: string, scope: LocaleMarketScope): LocalizedMediaErrorCode | null {
  const foreign = scope.shopLocales.filter((l) => !l.primary).map((l) => normalizeLocale(l.locale));
  // An empty locale list is a FAILED lookup, never "one language": refuse
  // rather than write an entry for a locale nobody could confirm.
  if (scope.shopLocales.length === 0 || !foreign.includes(normalizeLocale(locale))) return "invalidLocale";
  if (marketId && !scope.activeMarketIds.includes(marketId)) return "invalidMarket";
  if (marketNumericId(marketId) === null) return "invalidMarket";
  return null;
}

export async function setLocalizedImage(args: {
  graphql: Graphql;
  productId: string;
  sourceMediaId: string;
  locale: string;
  marketId: string;
  fileId: string;
  origin: LocalizedMediaOrigin;
  scope: LocaleMarketScope;
}): Promise<LocalizedMediaResult<{ entries: LocalizedMediaEntry[]; media: ProductMediaImage[] }>> {
  const { graphql, productId, sourceMediaId, locale, marketId, fileId, origin, scope } = args;
  const scopeError = validateScope(locale, marketId, scope);
  if (scopeError) return { ok: false, code: scopeError };

  const current = await readProductLocalizedMedia(graphql, productId);
  if (!current.ok) return current;
  const source = current.media.find((m) => m.id === sourceMediaId);
  const o = source ? storefrontFilename(source.url) : null;
  if (!source || !isSafeFilename(o)) return { ok: false, code: "invalidSource" };

  if (!/^gid:\/\/shopify\/MediaImage\/\d+$/.test(fileId)) return { ok: false, code: "invalidFile" };
  const file = await gqlData<{ node: { id: string; fileStatus?: string; image?: { url: string } | null } | null }>(graphql, READ_FILE, { id: fileId });
  if (!file) return { ok: false, code: "readFailed" };
  const url = file.node?.image?.url;
  if (!file.node || !url) return { ok: false, code: file.node && file.node.fileStatus !== "READY" ? "fileNotReady" : "invalidFile" };
  if (file.node.fileStatus && file.node.fileStatus !== "READY") return { ok: false, code: "fileNotReady" };
  const replacementName = storefrontFilename(url);
  if (!isShopifyCdnUrl(url) || !isSafeFilename(replacementName)) return { ok: false, code: "invalidFile" };
  // Same filename would make the storefront swap a no-op (and the pre-paint
  // hide would then fall to its fail-safe) — refuse it as the pointless edit it is.
  if (replacementName.toLowerCase() === o.toLowerCase()) return { ok: false, code: "sameFile" };
  // A replacement that is itself one of this product's images would chain
  // (A→B while B→C shows C in the gallery but B in og:image) or cycle (A→B,
  // B→A). The storefront guards against the loop, but the only honest answer
  // is one level of replacement, so it is refused here.
  if (current.media.some((mm) => (storefrontFilename(mm.url) ?? "").toLowerCase() === replacementName.toLowerCase())) {
    return { ok: false, code: "replacementIsOriginal" };
  }

  const entry: LocalizedMediaEntry = {
    o,
    m: sourceMediaId,
    l: normalizeLocale(locale),
    k: marketNumericId(marketId) ?? "",
    u: url,
    f: fileId,
    a: origin,
    s: source.url,
    t: new Date().toISOString(),
  };
  const next = upsertLocalizedMediaEntry(current.entries, entry);
  const written = await writeProductLocalizedMedia(graphql, productId, next, current.hasMetafield);
  if (!written.ok) return written;
  return { ok: true, entries: next, media: current.media };
}

export async function removeLocalizedImage(args: {
  graphql: Graphql;
  productId: string;
  sourceMediaId: string;
  locale: string;
  marketId: string;
}): Promise<LocalizedMediaResult<{ entries: LocalizedMediaEntry[]; media: ProductMediaImage[] }>> {
  const { graphql, productId, sourceMediaId, locale, marketId } = args;
  const k = marketNumericId(marketId);
  if (k === null) return { ok: false, code: "invalidMarket" };
  const current = await readProductLocalizedMedia(graphql, productId);
  if (!current.ok) return current;
  // No scope validation on removal: an entry for a language the shop has
  // since removed (or an original that is gone) must still be deletable.
  const next = removeLocalizedMediaEntry(current.entries, sourceMediaId, locale, k);
  if (next.length === current.entries.length) return { ok: true, entries: current.entries, media: current.media };
  const written = await writeProductLocalizedMedia(graphql, productId, next, current.hasMetafield);
  if (!written.ok) return written;
  return { ok: true, entries: next, media: current.media };
}
