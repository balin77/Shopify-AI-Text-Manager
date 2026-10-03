/**
 * The local write of the alt-text template apply (api.apply-alt-text-templates.tsx),
 * for ONE media GID after Shopify confirmed it. Its own module so the
 * store decision (product cache vs. media library) is testable.
 */
import type { PrismaClient } from "@prisma/client";
import { withDbRaceRetry } from "../utils/db-retry.server";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
import { isLibraryOnlyMedia } from "~/services/translations/library-alt-repair.server";
import { mirrorLibraryImageAlt, mirrorProductMediaAlt } from "~/services/translations/verified-translations.server";

// Resolve a fresh image URL from Shopify for stub-row creation. Returns the gid
// itself as a last-resort placeholder so we never lose a translation due to a
// missing local DB row — the next product sync will overwrite the URL.
async function resolveImageUrl(admin: { graphql: (q: string, opts?: any) => Promise<Response> }, gid: string): Promise<string> {
  try {
    const r = await admin.graphql(
      `#graphql
        query mediaImageUrl($id: ID!) {
          node(id: $id) {
            ... on MediaImage { image { url } }
          }
        }`,
      { variables: { id: gid } }
    );
    const d = await r.json() as any;
    const url = d?.data?.node?.image?.url;
    if (typeof url === "string" && url.length > 0) return url;
  } catch {
    // fall through
  }
  return gid;
}

// Persist the alt-text (primary) or translation (foreign locale) for one media
// GID, atomically and idempotently. The ProductImage row is upserted on the
// (productId, mediaId) unique key so concurrent applies collapse instead of
// creating duplicates; both writes share one transaction so a racing sync
// either sees both or neither, and the retry above heals an interleaved wipe.
export async function persistAltText(
  db: PrismaClient,
  productId: string,
  gid: string,
  shop: string,
  locale: string,
  isPrimary: boolean,
  altText: string,
  admin: { graphql: (q: string, opts?: any) => Promise<Response> }
): Promise<void> {
  await withDbRaceRetry(async () => {
    // A media-LIBRARY file (a file picked into a variant gallery: no
    // ProductImage row anywhere in the shop, cached as non-product) stays a
    // library file. The row this function used to upsert for it made the file
    // count as product media from then on, so its foreign alts in
    // ContentTranslation("MediaImage") were no longer read and showed empty
    // while Shopify still served them -- and the next product sync deleted
    // that row again. The primary alt lives in the library cache (also written
    // by the caller), a foreign one in the library mirror, exactly as the
    // image manager's own save does for such a file.
    if (await isLibraryOnlyMedia(db, shop, gid)) {
      if (isPrimary) {
        await db.mediaLibraryImage.updateMany({
          where: { shop, id: gid },
          data: { altText: altText || null },
        });
      } else {
        markTranslationSaved(gid);
        await mirrorLibraryImageAlt(db, { shop, mediaId: gid, locale, value: altText });
      }
      return;
    }
    // Resolve a URL only when the row is missing — avoids a Shopify call per
    // image on the common update path. Scoped by shop: media GIDs are unique
    // per shop, so an unscoped match could touch another tenant's row.
    const existing = await db.productImage.findFirst({
      where: { mediaId: gid, product: { shop } },
      select: { id: true },
    });
    const createUrl = existing ? gid : await resolveImageUrl(admin, gid);

    await db.$transaction(async (tx) => {
      await tx.productImage.upsert({
        where: { productId_mediaId: { productId, mediaId: gid } },
        create: {
          productId,
          mediaId: gid,
          url: createUrl,
          ...(isPrimary ? { altText: altText || null, altTextModifiedAt: new Date() } : {}),
        },
        update: isPrimary ? { altText: altText || null, altTextModifiedAt: new Date() } : {},
        select: { id: true },
      });
      if (!isPrimary) {
        // The detached alt repair watches the MEDIA resource it is about to
        // write (translation-locks.shared.ts); without this claim it never sees
        // the merchant write and overwrites it minutes later.
        markTranslationSaved(gid);
        // The ONE product-alt mirror, narrowed to THIS product's row (just
        // upserted, so the lookup inside the transaction sees it): a
        // foreign-key failure on ANOTHER product's row inside a Postgres
        // transaction would abort the whole transaction, so those rows are
        // mirrored after commit, below.
        const mirrored = await mirrorProductMediaAlt(tx, {
          shop,
          productId,
          mediaId: gid,
          locale,
          value: altText,
          inTransaction: true,
        });
        if (mirrored === "imageGone") {
          throw new Error(`No cached ProductImage row for ${gid} -- the alt translation could not be mirrored`);
        }
      }
    });
    if (!isPrimary) {
      // Every OTHER product's row of a shared medium -- the translation lives
      // on the one MediaImage they all show. Outside the transaction, so a
      // row a concurrent sync just deleted is skipped instead of aborting
      // anything; this product's row is re-upserted with the same value
      // (idempotent), and a retry of this whole block repeats it harmlessly.
      await mirrorProductMediaAlt(db, { shop, productId, mediaId: gid, locale, value: altText });
    }
  });
}

