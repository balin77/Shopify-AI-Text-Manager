import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

// Read-only diagnostic for verifying alt-text translations after a bulk apply.
// Compares Shopify (source of truth) against the local ContentPilot DB so the
// user can tell whether a save reached Shopify, the DB, both, or neither.
//
// Usage: GET /api/debug-alt-text-translation?gid=gid://shopify/MediaImage/...&locale=fr
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const gid = url.searchParams.get("gid");
  const locale = url.searchParams.get("locale");

  if (!gid || !locale) {
    return json(
      { error: "Provide ?gid=<MediaImage GID>&locale=<locale code>" },
      { status: 400 }
    );
  }

  const tr = await admin.graphql(
    `#graphql
      query altTextTranslation($id: ID!, $locale: String!) {
        translatableResource(resourceId: $id) {
          resourceId
          translatableContent { key digest value }
          translations(locale: $locale) { key value locale }
        }
        node(id: $id) {
          ... on MediaImage { id image { url altText } }
        }
      }`,
    { variables: { id: gid, locale } }
  );
  const data = (await tr.json()) as any;

  const tc: Array<{ key: string; digest?: string; value?: string }> =
    data?.data?.translatableResource?.translatableContent ?? [];
  const trs: Array<{ key: string; value?: string; locale?: string }> =
    data?.data?.translatableResource?.translations ?? [];
  const altDigest = tc.find((c) => c.key === "alt")?.digest;
  const altPrimary = tc.find((c) => c.key === "alt")?.value;
  const altTranslated = trs.find((t) => t.key === "alt")?.value;
  const mediaImage = data?.data?.node ?? null;

  const dbImage = await db.productImage.findFirst({
    where: { mediaId: gid },
    select: {
      id: true,
      productId: true,
      url: true,
      altText: true,
      altTextModifiedAt: true,
    },
  });
  const dbTranslation = dbImage
    ? await db.productImageAltTranslation.findUnique({
        where: { imageId_locale_marketId: { marketId: "",  imageId: dbImage.id, locale } },
        select: { altText: true, updatedAt: true },
      })
    : null;

  return json({
    gid,
    locale,
    shopify: {
      hasTranslatableResource: tc.length > 0,
      altDigest: altDigest ?? null,
      altPrimary: altPrimary ?? null,
      altTranslated: altTranslated ?? null,
      mediaImageNode: mediaImage,
    },
    db: {
      productImage: dbImage,
      translation: dbTranslation,
    },
    consistent:
      (altTranslated ?? null) === (dbTranslation?.altText ?? null),
  });
};
