import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { fillAltTextTemplate, resolveVariableValues } from "../utils/alt-text-template";
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

  const uploadedSet = uploadedImageGids ? new Set(uploadedImageGids) : null;
  let applied = 0;
  const errors: string[] = [];

  const isPrimary = !locale || locale === primaryLocale;

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
      const gid = orderedGids[tmpl.position];
      if (!gid) continue;

      // Scope filter: only apply to uploaded images if scope === "uploaded"
      if (scope === "uploaded" && uploadedSet && !uploadedSet.has(gid)) continue;

      const altText = fillAltTextTemplate(tmpl.template, resolvedOptions);

      try {
        if (isPrimary) {
          // Primary locale: fileUpdate mutation
          const r = await admin.graphql(
            `#graphql
              mutation fileUpdate($files: [FileUpdateInput!]!) {
                fileUpdate(files: $files) {
                  userErrors { field message }
                }
              }`,
            { variables: { files: [{ id: gid, alt: altText }] } }
          );
          const d = await r.json() as any;
          const errs = d.data?.fileUpdate?.userErrors ?? [];
          if (errs.length === 0) {
            applied++;
            // Update DB
            await db.productImage.updateMany({
              where: { mediaId: gid },
              data: { altText: altText || null, altTextModifiedAt: new Date() },
            }).catch(() => {});
          } else {
            errors.push(`${variant.title} pos ${tmpl.position}: ${errs.map((e: any) => e.message).join(", ")}`);
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
            errors.push(`${variant.title} pos ${tmpl.position}: no digest`);
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
            // Update DB
            const dbImage = await db.productImage.findFirst({ where: { mediaId: gid }, select: { id: true } });
            if (dbImage) {
              await db.productImageAltTranslation.upsert({
                where: { imageId_locale: { imageId: dbImage.id, locale } },
                create: { imageId: dbImage.id, locale, altText },
                update: { altText },
              }).catch(() => {});
            }
          } else {
            errors.push(`${variant.title} pos ${tmpl.position}: ${errs.map((e: any) => e.message).join(", ")}`);
          }
        }
      } catch (err: unknown) {
        errors.push(`${variant.title} pos ${tmpl.position}: ${String(err)}`);
      }
    }
  }

  return json({
    success: errors.length === 0,
    applied,
    errors: errors.length > 0 ? errors : undefined,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  });
};
