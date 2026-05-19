import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { fillAltTextTemplate, resolveVariableValues } from "../utils/alt-text-template";
import { withDbRaceRetry } from "../utils/db-retry.server";
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

// Shopify's Admin GraphQL API is cost-throttled per shop. Applying every
// locale in parallel (and the webhook syncs each apply triggers) can exhaust
// the bucket → HTTP 429 or a top-level THROTTLED error. Without this the
// previously-sequential path's work would just fail outright. Back off and
// retry so "apply to all languages" stays correct on large catalogs.
async function gqlWithThrottleRetry(
  admin: { graphql: (q: string, opts?: any) => Promise<Response> },
  query: string,
  variables: Record<string, unknown>,
  attempts = 4
): Promise<any> {
  const backoffMs = [800, 1600, 3200];
  for (let i = 0; ; i++) {
    const r = await admin.graphql(query, { variables });
    const status = r.status;
    const d = (await r.json()) as any;
    const throttled =
      status === 429 ||
      (Array.isArray(d?.errors) &&
        d.errors.some(
          (e: any) =>
            e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message ?? "")
        ));
    if (!throttled || i >= attempts - 1) return d;
    await new Promise((res) => setTimeout(res, backoffMs[Math.min(i, backoffMs.length - 1)]));
  }
}

// Persist the alt-text (primary) or translation (foreign locale) for one media
// GID, atomically and idempotently. The ProductImage row is upserted on the
// (productId, mediaId) unique key so concurrent applies collapse instead of
// creating duplicates; both writes share one transaction so a racing sync
// either sees both or neither, and the retry above heals an interleaved wipe.
async function persistAltText(
  productId: string,
  gid: string,
  shop: string,
  locale: string,
  isPrimary: boolean,
  altText: string,
  admin: { graphql: (q: string, opts?: any) => Promise<Response> }
): Promise<void> {
  await withDbRaceRetry(async () => {
    // Resolve a URL only when the row is missing — avoids a Shopify call per
    // image on the common update path. Scoped by shop: media GIDs are unique
    // per shop, so an unscoped match could touch another tenant's row.
    const existing = await db.productImage.findFirst({
      where: { mediaId: gid, product: { shop } },
      select: { id: true },
    });
    const createUrl = existing ? gid : await resolveImageUrl(admin, gid);

    await db.$transaction(async (tx) => {
      const img = await tx.productImage.upsert({
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
        await tx.productImageAltTranslation.upsert({
          where: { imageId_locale: { imageId: img.id, locale } },
          create: { imageId: img.id, locale, altText },
          update: { altText },
        });
      }
    });
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

  // Fail-closed ownership guard, aligned with the strong `shop_id` compound
  // pattern (see alt-text.handler). The only persistent work this route does
  // is creating ProductImage rows, whose required FK to Product means a
  // not-synced product would FK-fail anyway — so requiring an owned, synced
  // Product here rejects cross-tenant productIds without breaking any
  // legitimate flow.
  const ownedProduct = await db.product.findUnique({
    where: { shop_id: { shop: session.shop, id: productId } },
    select: { title: true },
  });
  if (!ownedProduct) {
    return json({ success: false, error: "Product not found for this shop" }, { status: 404 });
  }

  // Load templates for this product.
  //
  // R5-M2 (verified live regression): alt-text templates are authored ONCE,
  // stored under the PRIMARY locale. A foreign-locale apply sends
  // locale=<foreign>, so `where:{ …, locale:<foreign> }` matched 0 rows and
  // the request silently early-returned (success:true, applied:0, no task) —
  // "apply to all languages" did nothing for every non-primary language. The
  // write-back already switches the locale for translationsRegister /
  // persistAltText (isPrimary=false), so we just need to LOAD the templates
  // from where they actually live: the primary locale for a foreign apply.
  const isPrimaryApply = !locale || locale === primaryLocale;
  let templates = await db.altTextTemplate.findMany({
    where: {
      shop: session.shop,
      productId,
      ...(isPrimaryApply
        ? { locale }
        : primaryLocale
          ? { locale: primaryLocale }
          : {}), // no primaryLocale given → no locale filter (deduped below)
    },
    orderBy: { position: "asc" },
  });

  // When the no-locale-filter fallback ran, the same position can appear once
  // per stored locale — keep a single template per position (deterministic:
  // first after the position/locale ordering) so each image isn't written
  // multiple times.
  if (!isPrimaryApply && !primaryLocale && templates.length > 0) {
    const byPosition = new Map<number, (typeof templates)[number]>();
    for (const t of [...templates].sort(
      (a, b) => a.position - b.position || a.locale.localeCompare(b.locale),
    )) {
      if (!byPosition.has(t.position)) byPosition.set(t.position, t);
    }
    templates = [...byPosition.values()].sort((a, b) => a.position - b.position);
  }

  if (templates.length === 0) {
    return json({
      success: true,
      applied: 0,
      message: isPrimaryApply
        ? "No templates found for this locale"
        : "No alt-text templates authored for this product (none under the primary locale)",
    });
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
  const taskTitle = ownedProduct.title || productId;

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

  // Everything past task creation runs inside this guard so a thrown error
  // (notably resolveVariableValues hitting a Shopify THROTTLE on a foreign
  // locale — the primary path never calls it, which is exactly why foreign
  // tasks were the ones left stuck "running") still finalizes the task
  // instead of leaking it forever.
  // Progress heartbeat. The apply loop is the slow part; without periodic
  // task updates the bar sat at 0 until the final 100, AND the stuck-task
  // recovery (which keys off updatedAt and explicitly requires handlers to
  // heartbeat) could not tell a slow-but-alive apply from a dead one.
  let lastHeartbeatPct = 0;
  const heartbeat = async () => {
    if (!taskId) return;
    const pct = Math.min(99, Math.round((attempted / Math.max(estimatedTotal, 1)) * 100));
    if (pct === lastHeartbeatPct) return; // ≤100 writes/request, no churn
    lastHeartbeatPct = pct;
    try {
      await db.task.update({
        where: { id: taskId },
        data: { progress: pct, processed: applied },
      });
    } catch {
      // best-effort — a missed heartbeat must not break the apply
    }
  };

  try {
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
          const d = await gqlWithThrottleRetry(
            admin,
            `#graphql
              mutation fileUpdate($files: [FileUpdateInput!]!) {
                fileUpdate(files: $files) {
                  userErrors { field message }
                  files { id }
                }
              }`,
            { files: [{ id: gid, alt: altText }] }
          );
          const errs = d.data?.fileUpdate?.userErrors ?? [];
          if (errs.length === 0) {
            applied++;
            try {
              await persistAltText(productId, gid, session.shop, locale, true, altText, admin);
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
          const td = await gqlWithThrottleRetry(
            admin,
            `#graphql
              query translatableContent($id: ID!) {
                translatableResource(resourceId: $id) {
                  translatableContent { key digest }
                }
              }`,
            { id: gid }
          );
          const altDigest = (td.data?.translatableResource?.translatableContent ?? [])
            .find((c: { key: string; digest?: string }) => c.key === "alt")?.digest;

          if (!altDigest) {
            errors.push(`${variant.title} (Position ${tmpl.position}): No translatable digest found for GID ${gid}`);
            continue;
          }

          const d = await gqlWithThrottleRetry(
            admin,
            `#graphql
              mutation translateMedia($resourceId: ID!, $translations: [TranslationInput!]!) {
                translationsRegister(resourceId: $resourceId, translations: $translations) {
                  userErrors { field message }
                }
              }`,
            {
              resourceId: gid,
              translations: [{ key: "alt", value: altText, locale, translatableContentDigest: altDigest }],
            }
          );
          const errs = d.data?.translationsRegister?.userErrors ?? [];
          if (errs.length === 0) {
            applied++;
            try {
              await persistAltText(productId, gid, session.shop, locale, false, altText, admin);
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
      await heartbeat();
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
  } catch (fatal: unknown) {
    // An unexpected throw (Shopify throttle/network during variable resolution,
    // etc.) reached here. Close out the task as failed so the navigation badge
    // stops showing it as perpetually running, then surface the error.
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    if (taskId) {
      try {
        await db.task.update({
          where: { id: taskId },
          data: {
            status: "failed",
            progress: 100,
            total: attempted,
            processed: applied,
            error: `${msg}`.substring(0, 1000),
            completedAt: new Date(),
          },
        });
      } catch {
        // best-effort — never mask the original failure
      }
    }
    return json(
      { success: false, applied, attempted, error: msg },
      { status: 500 }
    );
  }
};
