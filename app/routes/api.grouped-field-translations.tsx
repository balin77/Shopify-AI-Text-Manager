import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { GroupedFieldTranslationService } from "../../src/services/grouped-field-translation.service";
import { TRANSLATE_CONTENT } from "../graphql/content.mutations";
import { isGroupedFieldKey } from "~/utils/grouped-field.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const fieldKey = url.searchParams.get("fieldKey") ?? undefined;
  const sourceLocale = url.searchParams.get("sourceLocale") ?? undefined;

  const service = new GroupedFieldTranslationService(db);
  const entries = await service.listForShop({ shop: session.shop, fieldKey, sourceLocale });
  return json({ entries });
};

interface PatchBody {
  intent: "update";
  id: string;
  translatedValue: string;
}

interface DeleteBody {
  intent: "delete";
  id: string;
}

interface DeleteGroupBody {
  intent: "deleteGroup";
  fieldKey: string;
  sourceLocale: string;
  sourceValueNorm: string;
}

type Body = PatchBody | DeleteBody | DeleteGroupBody;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const body = (await request.json()) as Body;
  const service = new GroupedFieldTranslationService(db);

  if (body.intent === "delete") {
    await service.deleteEntry({ shop, id: body.id });
    return json({ ok: true });
  }

  if (body.intent === "deleteGroup") {
    await service.deleteGroup({
      shop,
      fieldKey: body.fieldKey,
      sourceLocale: body.sourceLocale,
      sourceValueNorm: body.sourceValueNorm,
    });
    return json({ ok: true });
  }

  if (body.intent === "update") {
    const trimmed = body.translatedValue.trim();
    if (!trimmed) {
      return json({ ok: false, error: "Translation must not be empty" }, { status: 400 });
    }

    const entry = await db.groupedFieldTranslation.findFirst({
      where: { id: body.id, shop },
    });
    if (!entry) {
      return json({ ok: false, error: "Entry not found" }, { status: 404 });
    }
    if (!isGroupedFieldKey(entry.fieldKey)) {
      return json({ ok: false, error: "Unsupported field key" }, { status: 400 });
    }

    await db.groupedFieldTranslation.update({
      where: { id: entry.id },
      data: { translatedValue: trimmed, source: "user" },
    });

    // Re-sync all products that share this source value, so the new translation is
    // applied everywhere in Shopify and in our local ContentTranslation cache.
    const products = await service.findProductsUsingSourceValue({
      shop,
      sourceValueNorm: entry.sourceValueNorm,
    });

    const task = await db.task.create({
      data: {
        shop,
        type: "bulkTranslation",
        status: "running",
        resourceType: "Product",
        resourceTitle: `${entry.fieldKey}: ${entry.sourceValue} → ${entry.targetLocale}`,
        fieldType: entry.fieldKey,
        targetLocale: entry.targetLocale,
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    let synced = 0;
    let failed = 0;
    const shopifyKey = entry.fieldKey === "productType" ? "product_type" : entry.fieldKey;

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      try {
        // Resolve digest for this product's productType field.
        const digestResponse = await admin.graphql(
          `#graphql
            query getTranslatableContent($resourceId: ID!) {
              translatableResource(resourceId: $resourceId) {
                resourceId
                translatableContent { key digest }
              }
            }
          `,
          { variables: { resourceId: product.id } },
        );
        const digestData = await digestResponse.json();
        const translatable = digestData.data?.translatableResource?.translatableContent ?? [];
        const digest = translatable.find((c: { key: string; digest?: string }) => c.key === shopifyKey)?.digest;

        if (!digest) {
          logger.warn("[grouped-field-translations] No digest, skipping product", {
            productId: product.id,
            shopifyKey,
          });
          failed++;
          continue;
        }

        const writeResp = await admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId: product.id,
            translations: [
              {
                key: shopifyKey,
                value: trimmed,
                locale: entry.targetLocale,
                translatableContentDigest: digest,
              },
            ],
          },
        });
        const writeData = (await writeResp.json()) as {
          data?: { translationsRegister?: { userErrors?: Array<{ field?: string[]; message: string }> } };
          errors?: Array<{ message: string }>;
        };
        const userErrors = writeData.data?.translationsRegister?.userErrors ?? [];
        if ((writeData.errors?.length ?? 0) > 0 || userErrors.length > 0) {
          logger.error("[grouped-field-translations] Shopify rejected re-sync", {
            productId: product.id,
            userErrors,
            graphqlErrors: writeData.errors,
          });
          failed++;
          continue;
        }

        await db.contentTranslation.upsert({
          where: {
            shop_resourceId_key_locale_marketId: {
              marketId: "",
              shop,
              resourceId: product.id,
              key: shopifyKey,
              locale: entry.targetLocale,
            },
          },
          update: { value: trimmed, digest, resourceType: "Product" },
          create: {
            shop,
            resourceId: product.id,
            resourceType: "Product",
            key: shopifyKey,
            value: trimmed,
            locale: entry.targetLocale,
            digest,
          },
        });
        synced++;
      } catch (err) {
        logger.error("[grouped-field-translations] Exception during re-sync", {
          productId: product.id,
          error: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }

      const progress = Math.round(((i + 1) / Math.max(products.length, 1)) * 100);
      await db.task.update({ where: { id: task.id }, data: { progress } });
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: failed > 0 ? "completed_with_errors" : "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ synced, failed, total: products.length }),
      },
    });

    return json({ ok: true, taskId: task.id, synced, failed, total: products.length });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
};
