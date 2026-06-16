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

  // Shop-isolation: resolve which of the requested variants actually belong to
  // this shop (ProductVariant has no shop column — scope via the product
  // relation). All local writes below are restricted to this owned set so an
  // enumerable shopifyGid can't overwrite another tenant's sku/imageKey.
  const requestedGids = updates.map((u) => u.variantId);
  const ownedVariants = await db.productVariant.findMany({
    where: { shopifyGid: { in: requestedGids }, product: { shop } },
    select: { shopifyGid: true, productId: true },
  });
  const ownedGids = new Set(ownedVariants.map((v) => v.shopifyGid));
  const ownedUpdates = updates.filter((u) => ownedGids.has(u.variantId));

  if (ownedUpdates.length === 0) {
    return json({ ok: false, errors: ["Product not found — please reload the product first."] }, { status: 404 });
  }

  const errors: string[] = [];

  const collectErrors = (d: any, dataKey: string): string[] => [
    ...(d.errors ?? []).map((e: { message: string }) => e.message),
    ...(d.data?.[dataKey]?.userErrors ?? []).map((e: { message: string }) => e.message),
  ];

  if (mode === "sku") {
    const productId = ownedVariants.find((v) => v.shopifyGid === ownedUpdates[0].variantId)?.productId;
    if (!productId) {
      return json({ ok: false, errors: ["Product not found — please reload the product first."] }, { status: 404 });
    }

    try {
      const r = await admin.graphql(`
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }
      `, {
        variables: {
          productId,
          variants: ownedUpdates.map(({ variantId, value }) => ({ id: variantId, inventoryItem: { sku: value } })),
        },
      });
      const d = await r.json();
      const errs = collectErrors(d, "productVariantsBulkUpdate");
      if (errs.length > 0) {
        errors.push(...errs);
      } else {
        await Promise.all(ownedUpdates.map(({ variantId, value }) =>
          db.productVariant.updateMany({ where: { shopifyGid: variantId }, data: { sku: value } })
        ));
      }
    } catch (err: any) {
      errors.push(`Shopify API error: ${err?.message ?? "unknown"}`);
    }
  } else {
    try {
      const r = await admin.graphql(`
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `, {
        variables: {
          metafields: ownedUpdates.map(({ variantId, value }) => ({
            ownerId: variantId,
            namespace: "custom",
            key: "image_key",
            type: "single_line_text_field",
            value,
          })),
        },
      });
      const d = await r.json();
      const errs = collectErrors(d, "metafieldsSet");
      if (errs.length > 0) {
        errors.push(...errs);
      } else {
        await Promise.all(ownedUpdates.map(({ variantId, value }) =>
          db.productVariant.updateMany({ where: { shopifyGid: variantId }, data: { imageKey: value } })
        ));
      }
    } catch (err: any) {
      errors.push(`Shopify API error: ${err?.message ?? "unknown"}`);
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
