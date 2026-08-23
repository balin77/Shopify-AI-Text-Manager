import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { type Plan } from "../config/plans";
import { consumeImageOperations, refundImageOperations } from "../utils/imageOperations.server";
import {
  WEBP_ITEM_TASK_TYPE,
  WEBP_PARENT_TASK_TYPE,
} from "../config/webp-tasks.js";
import { taskTitleOrFallback } from "../services/tasks/resource-title.server";

interface ConvertWebpBody {
  productId: string;
  productTitle?: string;
  images: Array<{ mediaId: string; url: string; productImageId: string; altText?: string | null; position?: number | null }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { productId, productTitle, images: requestedImages }: ConvertWebpBody = await request.json();
  let images = requestedImages;

  if (!images?.length) {
    return json({ error: "No images provided" }, { status: 400 });
  }

  // Bound the fan-out: an unbounded images[] array would create an unbounded
  // number of db.task rows in a single request. Cheap check first, before the
  // quota / ownership DB round-trips below.
  const MAX_IMAGES_PER_REQUEST = 250;
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return json(
      { error: `Too many images in one request (max ${MAX_IMAGES_PER_REQUEST}, got ${images.length})` },
      { status: 413 },
    );
  }

  // Fail-closed ownership guard (strong `shop_id` compound): never create
  // imageWebpConversion task rows for a productId owned by another shop
  // (N-H6). Also prevents charging quota for a foreign product.
  const owned = await db.product.findUnique({
    where: { shop_id: { shop: session.shop, id: productId } },
    select: { id: true },
  });
  if (!owned) {
    return json({ error: "Product not found for this shop" }, { status: 404 });
  }

  // Only a MediaImage can be converted. Every other product medium — Video,
  // Model3d, ExternalVideo — is reported to the client under its POSTER url
  // (a .jpg on the Shopify CDN), so "the URL does not end in .webp" is not
  // evidence that the row is an image, and this route is directly POST-
  // reachable anyway. Converting a video would be worse than a wasted
  // operation: the worker creates a MediaImage from the poster and then
  // productDeleteMedia's the task's mediaId, i.e. deletes the video. So the
  // kind is verified against Shopify BEFORE the quota is charged and before
  // a single task row exists.
  const mediaIds = [...new Set(images.map(i => i.mediaId).filter((id): id is string => !!id))];
  if (mediaIds.length > 0) {
    let kinds: Record<string, string>;
    try {
      const res = await admin.graphql(
        `#graphql
        query WebpConvertibleMedia($ids: [ID!]!) {
          nodes(ids: $ids) {
            id
            __typename
          }
        }`,
        { variables: { ids: mediaIds } },
      );
      const body = await res.json();
      const nodes = body?.data?.nodes;
      if (!Array.isArray(nodes)) throw new Error("nodes query returned no data");
      kinds = Object.fromEntries(
        nodes.filter((n: any) => n?.id).map((n: any) => [n.id, n.__typename]),
      );
    } catch (err: any) {
      // An unverified kind is never treated as "it is an image" — a throttled
      // or failed lookup must not be able to delete a merchant's video. The
      // merchant retries; nothing was charged.
      console.error("[api.convert-webp] media kind lookup failed:", err?.message);
      return json(
        { error: "Could not verify the media types with Shopify", code: "MEDIA_KIND_UNVERIFIED" },
        { status: 503 },
      );
    }
    // Only a POSITIVELY identified non-image is dropped. An id Shopify cannot
    // resolve at all (a MediaImage deleted in the admin while the ProductImage
    // cache row survived) is passed through deliberately: it cannot be the
    // video this guard exists for, and dropping it would make the image
    // disappear from the batch with a 200 and no task — silently never
    // converted. Passed through it becomes a task that FAILS visibly in the
    // task list and refunds its image operation, which is the observable
    // outcome and the one a product resync fixes.
    const convertible = images.filter(i => {
      if (!i.mediaId) return true;
      const typename = kinds[i.mediaId];
      return typename === undefined || typename === "MediaImage";
    });
    if (convertible.length !== images.length) {
      console.warn(
        `[api.convert-webp] dropped ${images.length - convertible.length} non-image medium/media from the batch`,
      );
    }
    images = convertible;
    if (images.length === 0) {
      return json({ error: "No convertible images in the request", code: "NO_CONVERTIBLE_IMAGES" }, { status: 400 });
    }
  }

  // Each image conversion = one billable image operation (real compute/
  // bandwidth; AI is merchant-funded BYO). Whole-batch semantics: reject the
  // entire batch if it doesn't fit, so no tasks are created on overage.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const quota = await consumeImageOperations(session.shop, plan, images.length);
  if (!quota.allowed) {
    return json(
      { error: "Monthly image-operation limit reached", code: "IMAGE_QUOTA_EXCEEDED", limit: quota.limit },
      { status: 422 }
    );
  }

  // ONE merchant-facing row for the whole run, N work items under it.
  //
  // The parent is created FIRST because every item carries its id, and it is
  // created `running` rather than `pending`: the run IS in flight from the
  // merchant's point of view, and a pending row of this type is what the
  // processor picks up as work. `total` is the image count and is the column
  // that tells a parent from a pre-split row (app/config/webp-tasks.js).
  // Its result starts as the ONE number that is already true — a `converted: 0`
  // written before anything ran would be a fabricated measurement in a blob the
  // Tasks page renders (the "an absent key is omitted, never rendered as 0"
  // rule); the processor fills the counts in as items finish.
  // ONE lookup for the whole run: the parent row and every item row under it
  // name the same product, and a per-row resolve here would be an N+1 against
  // the product cache for a title that never varies. No GID fallback — the
  // Tasks card renders the numeric id and the Shopify deep link off
  // `resourceId` itself, so a GID stored here is that fact spelled unreadably.
  const runResourceTitle = await taskTitleOrFallback(
    db, session.shop, "product", productId, productTitle,
  );

  const parent = await db.task.create({
    data: {
      shop: session.shop,
      type: WEBP_PARENT_TASK_TYPE,
      status: "running",
      resourceType: "product",
      resourceId: productId,
      resourceTitle: runResourceTitle,
      total: images.length,
      processed: 0,
      result: JSON.stringify({ total: images.length }),
    },
  });

  // allSettled, not all: `Promise.all` rejects on the first failure while the
  // other creates keep going, so a rejected batch used to leave the item rows
  // that DID land behind as pending work nobody knew about — they convert, and
  // a merchant told "it failed" retries and converts them a second time,
  // deleting the media the first run just made. Whatever really landed is what
  // the batch is.
  const settled = await Promise.allSettled(images.map(img =>
    db.task.create({
      data: {
        shop: session.shop,
        type: WEBP_ITEM_TASK_TYPE,
        status: "pending",
        resourceType: "product",
        resourceId: productId,
        resourceTitle: runResourceTitle,
        // The job input, with the SAME keys and the same shape it has always
        // had — the processor, the image manager's spinner and the completion
        // write all read it — plus the parent id. Nothing was removed or
        // renamed, so a row written by either build is driven by either
        // processor.
        result: JSON.stringify({
          sourceUrl: img.url,
          mediaId: img.mediaId,
          productImageId: img.productImageId,
          productId,
          altText: img.altText ?? null,
          position: img.position ?? null,
          parentTaskId: parent.id,
        }),
      },
    })
  ));

  const tasks = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));

  if (tasks.length < images.length) {
    const lost = images.length - tasks.length;
    const reason = settled.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    console.error(
      `[api.convert-webp] ${lost} of ${images.length} conversion item(s) could not be created:`,
      reason?.reason?.message,
    );
    // Nothing was converted for those images and nothing ever will be, so the
    // operations reserved for them go back.
    await refundImageOperations(session.shop, lost);
    if (tasks.length === 0) {
      // A batch with no items would otherwise sit `running` until the reaper
      // timed it out ten minutes later and called it a timeout. Say what
      // happened — a machine code, translated at render time — and let the
      // merchant retry, which is safe because no image was touched.
      await db.task
        .update({
          where: { id: parent.id },
          data: {
            status: "failed",
            progress: 100,
            completedAt: new Date(),
            error: "webp_batch_not_started",
          },
        })
        .catch(() => {});
      return json(
        { error: "Could not start the conversion", code: "WEBP_BATCH_NOT_STARTED" },
        { status: 500 },
      );
    }
    // Some items landed: the run is real and its `total` is what it really
    // covers. Left at the requested count it would settle as "18 of 20
    // converted" with two images nobody ever attempted.
    await db.task
      .update({ where: { id: parent.id }, data: { total: tasks.length } })
      .catch(() => {});
  }

  // `taskIds` stays the ITEM ids: it is what this route has always returned.
  // The only caller (`handleConvertToWebP` in VariantImageManager) ignores the
  // body entirely and polls by productId, so the addition is for a future
  // caller, not for that one.
  return json({ taskIds: tasks.map(t => t.id), batchTaskId: parent.id });
};
