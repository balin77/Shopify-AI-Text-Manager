import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { GroupedFieldTranslationService } from "../../src/services/grouped-field-translation.service";
import {
  registerWithDigests,
  mirrorConfirmedContentTranslations,
} from "~/services/translations/verified-translations.server";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";
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
        // The SOURCE VALUE alone. `fieldType` and `targetLocale` go into their
        // own columns right below and the Tasks card and the completion toast
        // render each of them with its own translated label — a composite
        // title named the field a second time (raw), so the toast read
        // 'Translation for Product type in "product_type: Vase -> fr"'.
        resourceTitle: entry.sourceValue,
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
        // Verified register: digest read, key sent, and the key must be ECHOED
        // back -- userErrors: [] alone is the silent no-op. A product with no
        // digest for the field is never sent and never mirrored.
        const verified = await registerWithDigests(admin, product.id, entry.targetLocale, [
          { key: shopifyKey, value: trimmed },
        ]);

        if (!verified.confirmedKeys.has(shopifyKey)) {
          const failure = { productId: product.id, shopifyKey, userErrors: verified.userErrors };
          if (verified.noDigest.includes(shopifyKey)) {
            logger.warn("[grouped-field-translations] No digest, skipping product", failure);
          } else {
            logger.error("[grouped-field-translations] Shopify did not confirm re-sync", failure);
          }
          failed++;
          continue;
        }

        // Claim the product only once Shopify confirmed: a webhook sync reading
        // a lagging answer must not undo what was just written.
        markTranslationSaved(product.id);

        await mirrorConfirmedContentTranslations(db, {
          shop,
          resourceId: product.id,
          resourceType: "Product",
          locale: entry.targetLocale,
          sent: [{ key: shopifyKey, value: trimmed }],
          result: verified,
          digests: verified.digests,
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
