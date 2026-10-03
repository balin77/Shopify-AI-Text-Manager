import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { fillAltTextTemplate, resolveVariableValues, createTranslationCache } from "../utils/alt-text-template";
import { getTaskExpirationDate } from "../config/constants";
import type { VariantWithGallery } from "../components/image-manager/types";
import { fileUpdateEchoConfirms } from "~/utils/file-update-echo.server";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { persistAltText } from "~/services/image-alt-template-persist.server";
import { registerMediaAltAndVerify } from "~/services/translations/verified-translations.server";

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

// The verified helpers take a `{ graphql }` client; this one keeps the
// throttle backoff above in front of every call they make.
function throttledClient(admin: { graphql: (q: string, opts?: any) => Promise<Response> }) {
  return {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const body = await gqlWithThrottleRetry(admin, query, options?.variables ?? {});
      return { json: async () => body };
    },
  };
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
  // Per-position merge: foreign-locale templates (authored via
  // api.translate-alt-text-template — full sentence translated by AI) win.
  // For positions where no foreign-locale row exists, fall back to the
  // primary-locale template so variable substitution still produces *some*
  // alt text. The earlier R5-M2 fix loaded *only* the primary template for
  // foreign applies, which meant the full German sentence was written into
  // the French translation with just the {color} variable swapped — that's
  // the bug this merge restores.
  const isPrimaryApply = !locale || locale === primaryLocale;
  let templates: Awaited<ReturnType<typeof db.altTextTemplate.findMany>>;
  if (isPrimaryApply) {
    templates = await db.altTextTemplate.findMany({
      where: { shop: session.shop, productId, locale },
      orderBy: { position: "asc" },
    });
  } else {
    const foreignRows = await db.altTextTemplate.findMany({
      where: { shop: session.shop, productId, locale },
      orderBy: { position: "asc" },
    });
    const primaryRows = primaryLocale
      ? await db.altTextTemplate.findMany({
          where: { shop: session.shop, productId, locale: primaryLocale },
          orderBy: { position: "asc" },
        })
      : [];
    const byPosition = new Map<number, (typeof foreignRows)[number]>();
    for (const t of primaryRows) byPosition.set(t.position, t);
    // Foreign wins — but only when it has actual content. An empty foreign
    // row (e.g. saved by a blur before translation completed) must not
    // overwrite the primary fallback with "".
    for (const t of foreignRows) {
      if (t.template && t.template.trim().length > 0) byPosition.set(t.position, t);
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

  // Single cache for the whole apply call. Multiple variants typically share
  // the same option values (e.g. "Red" appears on 10 variants of one product)
  // — without this, each occurrence fired its own translatableResource query
  // and a partial Shopify cost-throttle would silently leave some variants
  // with the primary-locale fallback while others showed the translation.
  const translationCache = createTranslationCache();

  // PRIMARY applies overwrite alts, so their foreign translations need the
  // same repair every primary alt write gets (product-alt-repair.server.ts):
  // the alts BEFORE the loop, and what was written, last write per image wins.
  const { snapshotProductAlts, repairAltsAfterWrite } = await import(
    "../services/translations/product-alt-repair.server"
  );
  const altSnapshot = isPrimary
    ? await snapshotProductAlts(
        db,
        session.shop,
        [...new Set(variants.flatMap((v) => [v.mainImageGid, ...v.galleryFileGids].filter((g): g is string => !!g)))],
      )
    : new Map();
  // A media-LIBRARY file picked into a variant gallery has no product repair:
  // its foreign translations are deleted when its primary alt changes
  // (library-alt-repair.server.ts). Read BEFORE the loop, like the snapshot above.
  const { snapshotLibraryAlts, purgeLibraryAltTranslationsAfterWrite } = await import(
    "../services/translations/library-alt-repair.server"
  );
  const libraryAltSnapshot = isPrimary
    ? await snapshotLibraryAlts(
        db,
        session.shop,
        [...new Set(variants.flatMap((v) => [v.mainImageGid, ...v.galleryFileGids].filter((g): g is string => !!g)))],
      )
    : new Map();
  const primaryWritten = new Map<string, string>();

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
      admin,
      translationCache,
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
                  files { id ... on MediaImage { alt } }
                }
              }`,
            { files: [{ id: gid, alt: altText }] }
          );
          const errs = d.data?.fileUpdate?.userErrors ?? [];
          // Confirmed only by the ECHO of this file with the alt that was sent: a
          // null payload carries no userErrors either.
          const confirmed = errs.length === 0 && fileUpdateEchoConfirms(d.data?.fileUpdate?.files, gid, altText);
          if (confirmed) {
            applied++;
            primaryWritten.set(gid, altText);
            // Keep the library cache in step (a library file has no ProductImage
            // row until persistAltText creates one): the next "before" must be this alt.
            await db.mediaLibraryImage
              .updateMany({ where: { shop: session.shop, id: gid }, data: { altText: altText || null } })
              .catch(() => undefined);
            try {
              await persistAltText(db, productId, gid, session.shop, locale, true, altText, admin);
            } catch (dbErr: unknown) {
              // Don't roll back the Shopify save; surface the DB failure so the user
              // knows the local cache is out of sync and can retry / re-sync.
              errors.push(`${variant.title} (Position ${tmpl.position}, DB save): ${String(dbErr)}`);
            }
          } else {
            errors.push(
              `${variant.title} (Position ${tmpl.position}, GID ${gid}): ${
                errs.length > 0 ? errs.map((e: any) => e.message).join(", ") : "Shopify did not confirm the alt-text write"
              }`,
            );
          }
        } else {
          // Foreign locale: verified register (digest -> register -> echo).
          // Only a write Shopify echoed counts as applied and is mirrored, with
          // the value it stored. The client wraps the throttle backoff.
          const verified = await registerMediaAltAndVerify(throttledClient(admin), gid, locale, altText);
          if (verified.noDigest) {
            errors.push(`${variant.title} (Position ${tmpl.position}): No translatable digest found for GID ${gid}`);
            continue;
          }
          if (verified.confirmed) {
            applied++;
            try {
              await persistAltText(db, productId, gid, session.shop, locale, false, verified.storedValue ?? altText, admin);
            } catch (dbErr: unknown) {
              errors.push(`${variant.title} (Position ${tmpl.position}, ${locale} DB save): ${String(dbErr)}`);
            }
          } else {
            const detail = verified.userErrors.length > 0
              ? verified.userErrors.map((e) => e.message).join(", ")
              : "Shopify did not store the translation";
            errors.push(`${variant.title} (Position ${tmpl.position}, GID ${gid}): ${detail}`);
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

  // One repair per product for the alts this apply changed; never fails it.
  const retranslationTaskIds =
    primaryWritten.size > 0
      ? await repairAltsAfterWrite({
          gateway: new ShopifyApiGateway(admin as never, session.shop),
          db,
          shop: session.shop,
          snapshot: altSnapshot,
          written: [...primaryWritten].map(([mediaId, alt]) => ({ mediaId, alt })),
        })
      : [];
  const libraryAltsPurged =
    primaryWritten.size > 0
      ? await purgeLibraryAltTranslationsAfterWrite({
          gateway: new ShopifyApiGateway(admin as never, session.shop),
          db,
          shop: session.shop,
          snapshot: libraryAltSnapshot,
          written: [...primaryWritten].map(([mediaId, alt]) => ({ mediaId, alt })),
        })
      : [];

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
    ...(retranslationTaskIds.length > 0 ? { retranslationTaskIds } : {}),
    ...(libraryAltsPurged.length > 0 ? { libraryAltsPurged } : {}),
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
