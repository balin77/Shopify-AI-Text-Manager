import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { fillAltTextTemplate, resolveVariableValues } from "../utils/alt-text-template";
import { getTaskExpirationDate } from "../config/constants";
import type { VariantWithGallery } from "../components/image-manager/types";

interface ApplyBody {
  productId: string;
  locale: string;
  primaryLocale: string;
  scope: "all" | "uploaded";
  uploadedImageGids?: string[];
  variants: VariantWithGallery[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const { admin, session } = await authenticate.admin(request);
  const body: ApplyBody = await request.json();
  const { productId, locale, primaryLocale, scope, uploadedImageGids, variants } = body;

  if (!productId || !locale || !variants) {
    return json({ success: false, error: "productId, locale, and variants are required" }, { status: 400 });
  }

  // Load templates for this product
  const templates = await db.altTextTemplate.findMany({
    where: { shop: session.shop, productId, locale },
    orderBy: { position: "asc" },
  });

  if (templates.length === 0) {
    return json({ success: true, applied: 0, message: "No templates found for this locale" });
  }

  // Legacy templates were stored 0-based (0 = main image, 1 = first gallery, …).
  // Current templates are stored 1-based (1 = main image, 2 = first gallery, …).
  // Detect which convention is in use so both old and new data map correctly.
  const minPosition = Math.min(...templates.map(t => t.position));
  const positionBase = minPosition === 0 ? 0 : 1;

  const uploadedSet = uploadedImageGids ? new Set(uploadedImageGids) : null;
  let applied = 0;
  let attempted = 0;
  const errors: string[] = [];

  const isPrimary = !locale || locale === primaryLocale;

  // Resolve a display title for the navigation InfoBox.
  // Falls back to productId if the product isn't synced yet.
  const productRecord = await db.product.findUnique({
    where: { id: productId },
    select: { title: true },
  });
  const taskTitle = productRecord?.title || productId;

  for (const variant of variants) {
    // Build ordered list of image GIDs for this variant:
    // Position 0 = main featured image, positions 1+ = gallery images
    // Filter mainImageGid from gallery to avoid duplicate when the metafield still contains it
    const galleryGids = variant.galleryFileGids.filter(gid => gid !== variant.mainImageGid);
    const orderedGids: (string | undefined)[] = [
      variant.mainImageGid,
      ...galleryGids,
    ];
    // Resolve variable values for foreign locales
    const resolvedOptions = await resolveVariableValues(
      variant.selectedOptions,
      locale,
      isPrimary,
      admin
    );

    for (const tmpl of templates) {
      // Convert stored position to 0-based array index (handles both 0-based legacy and 1-based current data)
      const gid = orderedGids[tmpl.position - positionBase];
      if (!gid) continue;

      // Scope filter: only apply to uploaded images if scope === "uploaded"
      if (scope === "uploaded" && uploadedSet && !uploadedSet.has(gid)) continue;

      attempted++;
      const altText = fillAltTextTemplate(tmpl.template, resolvedOptions);

      try {
        if (isPrimary) {
          // Primary locale: fileUpdate mutation
          const r = await admin.graphql(
            `#graphql
              mutation fileUpdate($files: [FileUpdateInput!]!) {
                fileUpdate(files: $files) {
                  userErrors { field message }
                  files { id }
                }
              }`,
            { variables: { files: [{ id: gid, alt: altText }] } }
          );
          const d = await r.json() as any;
          const errs = d.data?.fileUpdate?.userErrors ?? [];
          if (errs.length === 0) {
            applied++;
            try {
              await db.productImage.updateMany({
                where: { mediaId: gid },
                data: { altText: altText || null, altTextModifiedAt: new Date() },
              });
            } catch (dbErr: unknown) {
              // Don't roll back the Shopify save; surface the DB failure so the user
              // knows the local cache is out of sync and can retry / re-sync.
              errors.push(`${variant.title} (Position ${tmpl.position}, DB save): ${String(dbErr)}`);
            }
          } else {
            errors.push(`${variant.title} (Position ${tmpl.position}, GID ${gid}): ${errs.map((e: any) => e.message).join(", ")}`);
          }
        } else {
          // Foreign locale: get digest first
          const tr = await admin.graphql(
            `#graphql
              query translatableContent($id: ID!) {
                translatableResource(resourceId: $id) {
                  translatableContent { key digest }
                }
              }`,
            { variables: { id: gid } }
          );
          const td = await tr.json() as any;
          const altDigest = (td.data?.translatableResource?.translatableContent ?? [])
            .find((c: { key: string; digest?: string }) => c.key === "alt")?.digest;

          if (!altDigest) {
            errors.push(`${variant.title} (Position ${tmpl.position}): No translatable digest found for GID ${gid}`);
            continue;
          }

          const r = await admin.graphql(
            `#graphql
              mutation translateMedia($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                  userErrors { field message }
                }
              }`,
            {
              variables: {
                resourceId: gid,
                translations: [{ key: "alt", value: altText, locale, translatableContentDigest: altDigest }],
              },
            }
          );
          const d = await r.json() as any;
          const errs = d.data?.translationsRegister?.userErrors ?? [];
          if (errs.length === 0) {
            applied++;
            try {
              const dbImage = await db.productImage.findFirst({ where: { mediaId: gid }, select: { id: true } });
              if (dbImage) {
                await db.productImageAltTranslation.upsert({
                  where: { imageId_locale: { imageId: dbImage.id, locale } },
                  create: { imageId: dbImage.id, locale, altText },
                  update: { altText },
                });
              }
            } catch (dbErr: unknown) {
              errors.push(`${variant.title} (Position ${tmpl.position}, ${locale} DB save): ${String(dbErr)}`);
            }
          } else {
            errors.push(`${variant.title} (Position ${tmpl.position}, GID ${gid}): ${errs.map((e: any) => e.message).join(", ")}`);
          }
        }
      } catch (err: unknown) {
        errors.push(`${variant.title} (Position ${tmpl.position}, GID ${gid}): ${String(err)}`);
      }
    }
  }

  if (attempted === 0) {
    return json({
      success: false,
      applied: 0,
      error: "No images could be matched to positions. Make sure variant images and gallery images are loaded before applying.",
    });
  }

  // Persist the outcome as a Task so the navigation InfoBox can surface
  // partial failures and DB-save errors (which used to be swallowed silently).
  // status: "failed" when nothing was applied, "completed" otherwise — the
  // navigation logic differentiates partial vs. full success via processed/total.
  const errorSummary = errors.length > 0 ? errors.join("\n").substring(0, 1000) : null;
  const taskStatus = applied === 0 ? "failed" : "completed";
  try {
    await db.task.create({
      data: {
        shop: session.shop,
        type: "altTextTemplateApply",
        status: taskStatus,
        resourceType: "products",
        resourceId: productId,
        resourceTitle: taskTitle,
        fieldType: "allAltTexts",
        targetLocale: locale,
        progress: 100,
        total: attempted,
        processed: applied,
        result: JSON.stringify({ applied, attempted, errors }),
        error: errorSummary,
        completedAt: new Date(),
        expiresAt: getTaskExpirationDate(),
      },
    });
  } catch {
    // Task logging failure must not break the actual apply — the response
    // below still carries the errors back to the caller.
  }

  return json({
    success: errors.length === 0,
    applied,
    attempted,
    errors: errors.length > 0 ? errors : undefined,
    error: errorSummary,
  });
};
