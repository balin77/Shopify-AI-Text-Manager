import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Background poll for Shopify's async Model3d processing.
 *
 * The main save route (api.update-variant-galleries) runs ~1.5s of sync
 * polling — enough to catch small models, not enough for big ones. Any
 * Model3d whose source URL or preview thumbnail isn't ready in that window
 * ends up either dropped (source URL missing, "processing" carry-over) or
 * with an empty preview slot. The client then calls THIS endpoint on a
 * back-off schedule to resolve the slow paths without freezing the Save
 * button or forcing the merchant to click Save again.
 *
 * The endpoint resolves TWO things:
 *
 *   A) Pending model URLs (passed in `pendingModels`):
 *      Each entry is {variantId, modelGid, stagingUrl}. We poll the
 *      Model3d node and, when sources[0].url is populated, append the
 *      final CDN URL to that variant's variant_3d_models metafield
 *      (replacing any stale staging-URL entry).
 *
 *   B) Missing previews on already-saved model URLs:
 *      For every variant_3d_models slot whose variant_3d_previews counterpart
 *      is empty, look up the corresponding Model3d on product.media and
 *      copy its preview.image.url into the parallel preview metafield.
 *
 * Returns:
 *   updated:        number of variants whose metafields were rewritten this call
 *   stillPending:   number of unresolved slots (source URL or preview) the
 *                   client should keep polling on; once 0 the loop stops.
 */

type PendingModel = { variantId: string; modelGid: string; stagingUrl: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const body = (await request.json()) as { productId?: string; pendingModels?: PendingModel[] };
  const productId = body.productId;
  const pendingModels = Array.isArray(body.pendingModels) ? body.pendingModels : [];
  if (!productId || !productId.startsWith("gid://shopify/Product/")) {
    return json({ error: "productId required" }, { status: 400 });
  }

  // 1. Pull product.media + every variant's 3D metafields in one round-trip.
  const pmRes = await admin.graphql(
    `
    query ProductModel3dPreviews($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          nodes {
            ... on Model3d {
              id
              status
              sources { url }
              preview { image { url } status }
            }
          }
        }
        variants(first: 250) {
          nodes {
            id
            metafields(identifiers: [
              { namespace: "custom", key: "variant_3d_models" }
              { namespace: "custom", key: "variant_3d_previews" }
            ]) { key value }
          }
        }
      }
    }
  `,
    { variables: { id: productId } },
  );
  const pmData = await pmRes.json();
  const product = pmData.data?.product;
  if (!product) {
    return json({ error: "product not found" }, { status: 404 });
  }

  const mediaNodes = (product.media?.nodes ?? []) as Array<{
    id?: string;
    sources?: { url: string }[];
    preview?: { image?: { url?: string } | null } | null;
  }>;
  const gidToSourceUrl = new Map<string, string>();
  const gidToPreviewUrl = new Map<string, string>();
  const urlToPreviewUrl = new Map<string, string>();
  for (const n of mediaNodes) {
    if (n.id && n.sources?.[0]?.url) gidToSourceUrl.set(n.id, n.sources[0].url);
    if (n.id && n.preview?.image?.url) gidToPreviewUrl.set(n.id, n.preview.image.url);
    const previewUrl = n.preview?.image?.url;
    if (!previewUrl || !n.sources) continue;
    for (const s of n.sources) urlToPreviewUrl.set(s.url, previewUrl);
  }

  type ParsedVariant = {
    id: string;
    models: string[];
    previews: string[];
  };
  const variantNodes = (product.variants?.nodes ?? []) as Array<{
    id: string;
    metafields: Array<{ key: string; value: string }>;
  }>;
  const parsedVariants = new Map<string, ParsedVariant>();
  for (const v of variantNodes) {
    const modelsMf = v.metafields.find((m) => m.key === "variant_3d_models");
    const previewsMf = v.metafields.find((m) => m.key === "variant_3d_previews");
    let models: string[] = [];
    let previews: string[] = [];
    try {
      const parsed = JSON.parse(modelsMf?.value ?? "[]");
      if (Array.isArray(parsed)) models = parsed.filter((x) => typeof x === "string");
    } catch { /* fall through */ }
    try {
      const parsed = JSON.parse(previewsMf?.value ?? "[]");
      if (Array.isArray(parsed)) previews = parsed.filter((x) => typeof x === "string");
    } catch { /* fall through */ }
    parsedVariants.set(v.id, { id: v.id, models, previews });
  }

  // 2. A) Resolve pending models. Group by variant so we can write each
  // variant's metafield once even when several pending entries point at it.
  const updatedModels = new Map<string, string[]>();    // variantId → next models[]
  const updatedPreviews = new Map<string, string[]>();  // variantId → next previews[]
  const resolvedEntries: Array<{ variantId: string; stagingUrl: string; finalUrl: string }> = [];
  let pendingSourceCount = 0;
  for (const pm of pendingModels) {
    const variant = parsedVariants.get(pm.variantId);
    if (!variant) continue;
    const resolvedUrl = gidToSourceUrl.get(pm.modelGid);
    if (!resolvedUrl) {
      pendingSourceCount += 1;
      continue;
    }
    resolvedEntries.push({ variantId: pm.variantId, stagingUrl: pm.stagingUrl, finalUrl: resolvedUrl });
    const currentModels = updatedModels.get(pm.variantId) ?? [...variant.models];
    const currentPreviews = updatedPreviews.get(pm.variantId) ?? [...variant.previews];
    // Replace the staging-URL slot in-place if we can find it, otherwise
    // append. Keeps positional alignment with variant_gallery_order intact.
    const stalIdx = currentModels.indexOf(pm.stagingUrl);
    if (stalIdx >= 0) {
      currentModels[stalIdx] = resolvedUrl;
      const previewAtIdx = gidToPreviewUrl.get(pm.modelGid) ?? "";
      while (currentPreviews.length <= stalIdx) currentPreviews.push("");
      if (currentPreviews[stalIdx] === "") currentPreviews[stalIdx] = previewAtIdx;
      if (!previewAtIdx) pendingSourceCount += 0; // source ok, preview maybe later — counted below
    } else if (!currentModels.includes(resolvedUrl)) {
      currentModels.push(resolvedUrl);
      const previewAtIdx = gidToPreviewUrl.get(pm.modelGid) ?? "";
      currentPreviews.push(previewAtIdx);
    }
    updatedModels.set(pm.variantId, currentModels);
    updatedPreviews.set(pm.variantId, currentPreviews);
  }

  // 2. B) Backfill missing previews for already-saved model URLs.
  let pendingPreviewCount = 0;
  for (const v of parsedVariants.values()) {
    const baseModels = updatedModels.get(v.id) ?? v.models;
    const basePreviews = updatedPreviews.get(v.id) ?? v.previews;
    if (baseModels.length === 0) continue;
    const newPreviews = [...basePreviews];
    while (newPreviews.length < baseModels.length) newPreviews.push("");
    let changed = false;
    for (let i = 0; i < baseModels.length; i++) {
      const u = baseModels[i];
      const existing = newPreviews[i] ?? "";
      if (existing.trim() !== "") continue;
      const fresh = urlToPreviewUrl.get(u);
      if (fresh) {
        newPreviews[i] = fresh;
        changed = true;
      } else {
        pendingPreviewCount += 1;
      }
    }
    if (changed || updatedPreviews.has(v.id)) updatedPreviews.set(v.id, newPreviews);
  }

  // 3. Write metafields for every variant we touched.
  const metafields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
  for (const [variantId, models] of updatedModels) {
    metafields.push({
      ownerId: variantId,
      namespace: "custom",
      key: "variant_3d_models",
      type: "list.url",
      value: JSON.stringify(models),
    });
  }
  for (const [variantId, previews] of updatedPreviews) {
    if (!updatedModels.has(variantId) && JSON.stringify(previews) === JSON.stringify(parsedVariants.get(variantId)?.previews ?? [])) continue;
    metafields.push({
      ownerId: variantId,
      namespace: "custom",
      key: "variant_3d_previews",
      type: "list.url",
      value: JSON.stringify(previews),
    });
  }
  if (metafields.length > 0) {
    const setRes = await admin.graphql(
      `
      mutation SetMetas($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
      { variables: { metafields } },
    );
    const setData = await setRes.json();
    const errs = setData.data?.metafieldsSet?.userErrors ?? [];
    if (errs.length > 0) {
      console.error("[refresh-3d-previews] metafieldsSet userErrors", errs);
      return json({ error: errs[0].message, updated: 0, stillPending: pendingSourceCount + pendingPreviewCount }, { status: 422 });
    }
  }

  return json({
    updated: updatedModels.size + updatedPreviews.size,
    stillPending: pendingSourceCount + pendingPreviewCount,
    resolvedEntries,
  });
};
