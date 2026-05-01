import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

interface UpdateVariantMatchKeyBody {
  mode: "sku" | "imageKey";
  updates: Array<{ variantId: string; value: string }>;
  memoryEntries?: Array<{ optionValue: string; savedAs: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const body: UpdateVariantMatchKeyBody = await request.json();
  const { mode, updates, memoryEntries } = body;

  if (!updates?.length) return json({ ok: true });

  const errors: string[] = [];

  if (mode === "sku") {
    // productVariantUpdate was removed in API 2025-01; use productVariantsBulkUpdate instead.
    // That mutation requires a productId, which we fetch from the DB.
    const dbVariant = await db.productVariant.findFirst({
      where: { shopifyGid: updates[0].variantId },
      select: { productId: true },
    });
    const productId = dbVariant?.productId;
    if (!productId) {
      return json({ ok: false, errors: ["Product not found — please reload the product first."] }, { status: 400 });
    }

    const r = await admin.graphql(`
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
    `, {
      variables: {
        productId,
        variants: updates.map(({ variantId, value }) => ({ id: variantId, sku: value })),
      },
    });
    const d = await r.json();
    const ue = d.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (ue.length > 0) {
      errors.push(...ue.map((e: { message: string }) => e.message));
    } else {
      await Promise.all(updates.map(({ variantId, value }) =>
        db.productVariant.updateMany({
          where: { shopifyGid: variantId },
          data: { sku: value },
        })
      ));
    }
  } else {
    const r = await admin.graphql(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `, {
      variables: {
        metafields: updates.map(({ variantId, value }) => ({
          ownerId: variantId,
          namespace: "custom",
          key: "image_key",
          type: "single_line_text_field",
          value,
        })),
      },
    });
    const d = await r.json();
    const ue = d.data?.metafieldsSet?.userErrors ?? [];
    if (ue.length > 0) {
      errors.push(...ue.map((e: { message: string }) => e.message));
    } else {
      await Promise.all(updates.map(({ variantId, value }) =>
        db.productVariant.updateMany({
          where: { shopifyGid: variantId },
          data: { imageKey: value },
        })
      ));
    }
  }

  if (errors.length > 0) return json({ ok: false, errors }, { status: 400 });

  if (memoryEntries?.length) {
    await Promise.all(memoryEntries.map(({ optionValue, savedAs }) =>
      db.optionValueMemory.upsert({
        where: { shop_optionValue: { shop, optionValue } },
        create: { shop, optionValue, savedAs },
        update: { savedAs },
      })
    ));
  }

  return json({ ok: true });
};
