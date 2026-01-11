import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Debug Route: Check Translation Data
 *
 * Shows what translations are stored in the database for a product
 * Usage: /api/debug-translations?productId=gid://shopify/Product/123
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ error: "Missing productId parameter" }, { status: 400 });
  }

  const { db } = await import("../db.server");

  try {
    const product = await db.product.findUnique({
      where: {
        shop_id: {
          shop: session.shop,
          id: productId,
        },
      },
      include: {
        translations: true,
      },
    });

    if (!product) {
      return json({ error: "Product not found in database" }, { status: 404 });
    }

    // Group translations by locale
    const translationsByLocale: Record<string, any> = {};

    for (const translation of product.translations) {
      if (!translationsByLocale[translation.locale]) {
        translationsByLocale[translation.locale] = {};
      }
      translationsByLocale[translation.locale][translation.key] = translation.value;
    }

    return json({
      productId: product.id,
      title: product.title,
      handle: product.handle,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      translationsCount: product.translations.length,
      translationsByLocale,
      allTranslations: product.translations.map(t => ({
        key: t.key,
        locale: t.locale,
        value: t.value.substring(0, 100) + (t.value.length > 100 ? "..." : ""),
      })),
    });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
