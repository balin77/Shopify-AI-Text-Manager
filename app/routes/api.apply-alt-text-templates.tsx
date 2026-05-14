import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { fillAltTextTemplate, resolveVariableValues } from "../utils/alt-text-template";
import { getTaskExpirationDate } from "../config/constants";
import type { VariantWithGallery } from "../components/image-manager/types";

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

// Get-or-create the local ProductImage row for a given media GID. Without this,
// productImageAltTranslation upserts silently no-op when the gallery image was
// never synced into the local DB (common for variant_gallery metafield images).
async function getOrCreateProductImage(productId: string, gid: string, admin: { graphql: (q: string, opts?: any) => Promise<Response> }): Promise<{ id: string }> {
  const existing = await db.productImage.findFirst({ where: { mediaId: gid }, select: { id: true } });
  if (existing) return existing;
  const url = await resolveImageUrl(admin, gid);
  return db.productImage.create({
    data: { productId, mediaId: gid, url },
    select: { id: true },
  });
}

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

  // Create the task up-front with status "running" so the navigation badge
  // counts it while we work — otherwise it only appeared after completion.
  // The total is an upper-bound estimate (variants × templates); we update
  // the real `processed`/`total` at the end alongside the final status.
  const estimatedTotal = variants.length * templates.length;
  let taskId: string | null = null;
  try {
    const task = await db.task.create({
      data: {
        shop: session.shop,
        type: "altTextTemplateApply",
        status: "running",
        resourceType: "products",
        resourceId: productId,
        resourceTitle: taskTitle,
        fieldType: "allAltTexts",
        targetLocale: locale,
        progress: 0,
        total: estimatedTotal,
        processed: 0,
        expiresAt: getTaskExpirationDate(),
      },
      select: { id: true },
    });
    taskId = task.id;
  } catch {
    // Task tracking is best-effort — failure here must not block the apply.
  }

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
              const dbImage = await getOrCreateProductImage(productId, gid, admin);
              await db.productImage.update({
                where: { id: dbImage.id },
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
              const dbImage = await getOrCreateProductImage(productId, gid, admin);
              await db.productImageAltTranslation.upsert({
                where: { imageId_locale: { imageId: dbImage.id, locale } },
                create: { imageId: dbImage.id, locale, altText },
                update: { altText },
              });
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
    if (taskId) {
      try {
        await db.task.update({
          where: { id: taskId },
          data: {
            status: "failed",
            progress: 100,
            total: 0,
            processed: 0,
            error: "No images could be matched to positions.",
            completedAt: new Date(),
          },
        });
      } catch {
        // best-effort — don't block the response
      }
    }
    return json({
      success: false,
      applied: 0,
      error: "No images could be matched to positions. Make sure variant images and gallery images are loaded before applying.",
    });
  }

  // Finalize the running task with the real outcome. status: "failed" when
  // nothing was applied, "completed" otherwise — the navigation logic
  // differentiates partial vs. full success via processed/total.
  const errorSummary = errors.length > 0 ? errors.join("\n").substring(0, 1000) : null;
  const taskStatus = applied === 0 ? "failed" : "completed";
  if (taskId) {
    try {
      await db.task.update({
        where: { id: taskId },
        data: {
          status: taskStatus,
          progress: 100,
          total: attempted,
          processed: applied,
          result: JSON.stringify({ applied, attempted, errors }),
          error: errorSummary,
          completedAt: new Date(),
        },
      });
    } catch {
      // Task tracking failure must not break the actual apply — the response
      // below still carries the errors back to the caller.
    }
  }

  return json({
    success: errors.length === 0,
    applied,
    attempted,
    errors: errors.length > 0 ? errors : undefined,
    error: errorSummary,
  });
};
