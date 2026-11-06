/**
 * The write path of the variant galleries (route level): the main image is never
 * stored in the gallery metafield, it changes only on an EXPLICIT intent that is
 * compared with a FRESH read, a variant that loses its main image gets the next image
 * of its own gallery in the same write, and a failed read refuses instead of guessing.
 * The real route action runs against a scripted Shopify (graphql) and a fake database;
 * the script APPLIES the writes it receives, so a replay is a real replay.
 *
 * MOCK-ONLY: Shopify's answers (fileUpdate with referencesToAdd, the variant input
 * carrying mediaId + two metafields, the lookup shapes) are scripted from the documented
 * schema, not measured against a shop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const PRODUCT = "gid://shopify/Product/1";
const img = (n: number) => `gid://shopify/MediaImage/${n}`;
const vid = (n: number) => `gid://shopify/Video/${n}`;
const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";

type VariantState = { main: string | null; gallery: string[]; order?: string | null; links?: string[] };
let variants: Record<string, VariantState>;
let productMedia: Record<string, string>; // gid -> mediaContentType
let libraryFiles: Record<string, string>; // files that exist but are not product media: gid -> fileStatus
let calls: Array<{ name: string; variables: any }>;
let bulkErrors: Array<{ message: string }>;
let attachErrors: Array<{ message: string }>;
let lookupFails: "none" | "variants" | "errors-array";
let failVariantsFromCall: number | null; // fail the Nth variants query and every later one
let variantsCalls: number;
let attachLag: boolean; // the attach is accepted but the next read does not show it yet
let fileExistenceThrows: boolean;
let createMediaErrors: Array<{ message: string }>;
let model3dReady: boolean;
let deleteAnswerNull: boolean;
let deleteEcho: any[] | null;
let onAttach: (() => void) | null;
let attachFailFor: string | null;
let attachLagFor: string | null;
let createdCounter: number;
// Requested media indices Shopify refuses to create (no slot in the answer), the filename each created medium reports,
// whether the filename re-read fails, and a rename rule (Shopify appending a suffix to an existing name).
let refuseCreateIdx: number[];
let createdNames: Record<string, string | null>;
let createdFilesFail: boolean;
let renameCreated: ((filename: string) => string) | null;
// How many variants the product has: defaults to the number of scripted variants; undefined answer = not answered.
let variantCountOverride: number | null | undefined;
let variantCountMode: "count" | "fallback" | "none";
const updateMany = vi.fn();

vi.mock("~/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      admin: {
        graphql: async (query: string, opts?: { variables?: any }) => {
          const name = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "?";
          calls.push({ name, variables: opts?.variables });
          const reply = (data: unknown) => ({ json: async () => data });
          if (name === "productMediaPage") {
            return reply({
              data: {
                product: {
                  media: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: Object.entries(productMedia).map(([id, mediaContentType]) => ({ id, mediaContentType })),
                  },
                },
              },
            });
          }
          // The variant count is its own small document. "count": the first answers; "fallback": the first is
          // refused (schema level) and `variants(first: 2)` answers; "none": both fail (unknown).
          if (name === "productVariantCount" || name === "productVariantsFirstTwo") {
            const n = variantCountOverride === undefined ? Object.keys(variants).length : variantCountOverride;
            const refuse = () => {
              const e: any = new Error("GraphQL query failed");
              e.body = { errors: [{ message: "Field 'variantsCount' doesn't exist on type 'Product'" }] };
              throw e;
            };
            if (name === "productVariantCount") {
              if (variantCountMode !== "count" || n === null) refuse();
              return reply({ data: { product: { variantsCount: { count: n } } } });
            }
            if (variantCountMode === "none" || n === null) refuse();
            return reply({ data: { product: { variants: { nodes: Array.from({ length: Math.min(2, n as number) }, (_, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}` })) } } } });
          }
          if (name === "variantsForGalleries") {
            variantsCalls += 1;
            // admin.graphql THROWS on a top-level errors array, it does not return it
            const throwLike = (errors: unknown[]) => {
              const e: any = new Error("GraphQL query failed");
              e.body = { errors };
              throw e;
            };
            if (lookupFails === "variants") throwLike([{ message: "Throttled", extensions: { code: "THROTTLED" } }]);
            if (lookupFails === "errors-array") throwLike([{ message: "boom" }]);
            if (failVariantsFromCall !== null && variantsCalls >= failVariantsFromCall) throwLike([{ message: "Throttled", extensions: { code: "THROTTLED" } }]);
            const ids: string[] = opts?.variables?.ids ?? [];
            return reply({
              data: {
                nodes: ids.map((id) => {
                  const v = variants[id];
                  if (!v) return null;
                  return {
                    id,
                    media: { nodes: v.main ? [{ id: v.main }] : [] },
                    gallery: { value: JSON.stringify(v.gallery) },
                    order: v.order ? { value: v.order } : null,
                    links: v.links ? { value: JSON.stringify(v.links) } : null,
                    models: null,
                  };
                }),
              },
            });
          }
          if (name === "fileExistence") {
            if (fileExistenceThrows) throw new Error("existence boom");
            const ids: string[] = opts?.variables?.ids ?? [];
            return reply({ data: { nodes: ids.map((id) => (productMedia[id] || libraryFiles[id] ? { id } : null)) } });
          }
          if (name === "fileStatusForAttach") {
            const id = opts?.variables?.ids?.[0];
            return reply({ data: { nodes: [libraryFiles[id] ? { id, fileStatus: libraryFiles[id] } : null] } });
          }
          if (name === "fileAttachToProduct") {
            if (attachFailFor && opts?.variables?.files?.[0]?.id === attachFailFor) {
              return reply({ data: { fileUpdate: { files: [], userErrors: [{ message: "refused" }] } } });
            }
            if (attachErrors.length === 0) {
              const f = opts?.variables?.files?.[0];
              onAttach?.();
              if (!attachLag && f.id !== attachLagFor) productMedia[f.id] = "IMAGE"; // the reference is added: the file is product media now
            }
            return reply({ data: { fileUpdate: { files: [{ id: "x" }], userErrors: attachErrors } } });
          }
          if (name === "productCreateMedia") {
            const media = opts?.variables?.media ?? [];
            const created = media.flatMap((m: { originalSource: string }, i: number) => {
              if (refuseCreateIdx.includes(i)) return [];
              const id = img(100 + ++createdCounter);
              productMedia[id] = "IMAGE";
              const base = decodeURIComponent((m.originalSource.split("?")[0].split("/").pop() ?? ""));
              createdNames[id] = renameCreated ? renameCreated(base) : base;
              return [{ id }];
            });
            return reply({ data: { productCreateMedia: { media: created, mediaUserErrors: createMediaErrors } } });
          }
          if (name === "createdMediaFiles") {
            if (createdFilesFail) {
              const e: any = new Error("GraphQL query failed");
              e.body = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
              throw e;
            }
            const ids: string[] = opts?.variables?.ids ?? [];
            return reply({ data: { nodes: ids.map((id) => ({ id, image: createdNames[id] ? { url: `https://cdn.shopify.com/s/files/1/0/${createdNames[id]}?v=1` } : null })) } });
          }
          if (name === "productVariantsBulkUpdate") {
            if (bulkErrors.length === 0) {
              for (const v of opts?.variables?.variants ?? []) {
                const st = variants[v.id];
                if (!st) continue;
                if ("mediaId" in v) st.main = v.mediaId;
                for (const m of v.metafields ?? []) {
                  if (m.key === "variant_gallery") st.gallery = JSON.parse(m.value);
                  if (m.key === "variant_gallery_order") st.order = m.value;
                }
              }
            }
            return reply({ data: { productVariantsBulkUpdate: { userErrors: bulkErrors } } });
          }
          if (name === "metafieldsDelete") {
            if (deleteAnswerNull) return reply({ data: null });
            if (deleteEcho) return reply({ data: { metafieldsDelete: { deletedMetafields: deleteEcho, userErrors: [] } } });
            return reply({ data: { metafieldsDelete: { deletedMetafields: (opts?.variables?.metafields ?? []).map((m: any) => ({ ownerId: m.ownerId, namespace: m.namespace, key: m.key })), userErrors: [] } } });
          }
          if (name === "GetModel3dSources") {
            const ids: string[] = opts?.variables?.ids ?? [];
            return reply({
              data: {
                nodes: ids.map((id) => ({
                  id,
                  status: model3dReady ? "READY" : "PROCESSING",
                  sources: model3dReady ? [{ url: "https://cdn.shopify.com/x.glb", format: "model/gltf-binary" }] : [],
                  preview: null,
                })),
              },
            });
          }
          if (name === "metafieldsSet") return reply({ data: { metafieldsSet: { userErrors: [] } } });
          return reply({ data: {} });
        },
      },
      session: { shop: "s.myshopify.com" },
    }),
  },
}));
vi.mock("~/db.server", () => ({ db: { productVariant: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));
vi.mock("~/routes/api.product-variants", () => ({ invalidateVariantDefsCache: vi.fn() }));

import { action } from "~/routes/api.update-variant-galleries";

async function post(body: Record<string, unknown>) {
  const request = new Request("http://localhost/api/update-variant-galleries", { method: "POST", body: JSON.stringify({ productId: PRODUCT, ...body }) });
  const res: any = await action({ request, params: {}, context: {} } as any);
  return res.data ?? res;
}
const names = () => calls.map((c) => c.name);
const bulk = () => calls.find((c) => c.name === "productVariantsBulkUpdate")?.variables.variants as any[] | undefined;
const bulkCount = () => calls.filter((c) => c.name === "productVariantsBulkUpdate").length;
const metaOf = (v: any, key: string) => v.metafields.find((m: any) => m.key === key)?.value as string | undefined;
const galleryOf = (v: any) => JSON.parse(metaOf(v, "variant_gallery")!);
const orderOf = (v: any) => (metaOf(v, "variant_gallery_order") ? JSON.parse(metaOf(v, "variant_gallery_order")!) : undefined);
const removal = (variantId: string, removedMainGid: string) => ({ removedMainImages: [{ variantId, removedMainGid }] });

beforeEach(() => {
  calls = [];
  bulkErrors = [];
  attachErrors = [];
  lookupFails = "none";
  failVariantsFromCall = null;
  variantsCalls = 0;
  attachLag = false;
  fileExistenceThrows = false;
  createMediaErrors = [];
  model3dReady = false;
  deleteAnswerNull = false;
  deleteEcho = null;
  onAttach = null;
  attachFailFor = null;
  attachLagFor = null;
  createdCounter = 0;
  refuseCreateIdx = [];
  createdNames = {};
  createdFilesFail = false;
  renameCreated = null;
  variantCountOverride = undefined;
  variantCountMode = "count";
  updateMany.mockReset();
  productMedia = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [img(n), "IMAGE"]));
  libraryFiles = {};
  variants = {
    [V1]: { main: img(1), gallery: [img(2), img(3)] },
    [V2]: { main: img(4), gallery: [img(5)] },
  };
});

describe("the main image is never stored in the gallery", () => {
  it("galleryOnly: a main image the client sent along is stripped, mediaId untouched", async () => {
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(1), img(2), img(3)], galleryOnly: true }] });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([img(2), img(3)]);
    expect("mediaId" in v).toBe(false);
  });
});

describe("B4: the main image changes only on an explicit intent", () => {
  it("legacy stored order [2,1,3] with main 1 plus a plain add: the main is not changed", async () => {
    variants[V1] = { main: img(1), gallery: [img(2), img(3)], order: JSON.stringify([{ kind: "file", value: img(2) }, { kind: "file", value: img(1) }, { kind: "file", value: img(3) }]) };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(1), img(3), img(5)], galleryOnly: true }] });
    const v = bulk()![0];
    expect("mediaId" in v).toBe(false);
    expect(galleryOf(v)).toEqual([img(2), img(3), img(5)]);
  });

  it("explicit main (dragged to slot one): set in the SAME variant input as gallery and order; the old main stays in the gallery", async () => {
    const orderJson = JSON.stringify([{ kind: "file", value: img(3) }, { kind: "file", value: img(1) }, { kind: "file", value: img(2) }]);
    const res = await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(3), img(1), img(2)], mainGid: img(3), expectedMainGid: img(1) }],
      variantGalleryOrder: [{ variantId: V1, orderJson }],
    });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([img(1), img(2)]);
    expect(metaOf(v, "variant_gallery_order")).toBe(orderJson);
    // ONE variant input carries mediaId + both metafields: nothing half-applied between calls.
    expect(bulkCount()).toBe(1);
    expect(names().includes("metafieldsSet")).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({ where: { shopifyGid: V1 }, data: { galleryJson: JSON.stringify([img(1), img(2)]) } });
  });

  it("equal to the fresh main: a no-op for the main (mediaId not sent)", async () => {
    variants[V1].main = img(3);
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(3), img(1), img(2)], mainGid: img(3), expectedMainGid: img(1) }] });
    const v = bulk()![0];
    expect("mediaId" in v).toBe(false);
    expect(galleryOf(v)).toEqual([img(1), img(2)]);
  });

  it("mismatch (the main was changed elsewhere): the variant is refused with a code, nothing is written", async () => {
    variants[V1].main = img(2);
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(3), img(1)], mainGid: img(3), expectedMainGid: img(1) }] });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "mainChangedElsewhere" }]);
    expect(bulkCount()).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a refused variant does not stop the others, and new media are not replayed (success + refusedVariants)", async () => {
    variants[V1].main = img(2);
    const res = await post({
      newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }],
      variantGalleries: [
        { variantId: V1, fileGids: [img(3), img(1)], mainGid: img(3), expectedMainGid: img(1) },
        { variantId: V2, fileGids: [img(4), img(5)], galleryOnly: true },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.refusedVariants).toEqual([{ variantId: V1, code: "mainChangedElsewhere" }]);
    expect(bulk()!.map((v) => v.id)).toEqual([V2]);
  });

  it("a main that is not a MediaImage (generic file, video) is refused", async () => {
    for (const bad of ["gid://shopify/GenericFile/9", vid(1)]) {
      calls = [];
      const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [bad, img(1)], mainGid: bad, expectedMainGid: img(1) }] });
      expect(res.success).toBe(false);
      expect(res.refusals[0].code).toBe("notAnImage");
      expect(bulkCount()).toBe(0);
    }
  });

  it("write order: create media, attach, fresh lookup, reorder, bulk update, mirror, metafieldsSet", async () => {
    libraryFiles[img(50)] = "READY";
    variants[V1].gallery = [img(2)];
    await post({
      newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }],
      mediaOrder: [{ mediaId: img(2), position: 0 }],
      variantGalleries: [{ variantId: V1, fileGids: [img(50), img(1), img(2)], mainGid: img(50), expectedMainGid: img(1) }],
      variantExternalVideos: [{ variantId: V1, urls: ["https://youtu.be/dQw4w9WgXcQ"] }],
    });
    const seq = names().filter((n) => ["productCreateMedia", "fileAttachToProduct", "productMediaPage", "productReorderMedia", "productVariantsBulkUpdate", "metafieldsSet"].includes(n));
    // a pre-flight read comes BEFORE anything is created, then: create, read, attach, fresh read, reorder, bulk, videos
    expect(seq[0]).toBe("productMediaPage");
    expect(seq.slice(1)).toEqual([
      "productCreateMedia",
      "productMediaPage",
      "fileAttachToProduct",
      "productMediaPage",
      "productReorderMedia",
      "productVariantsBulkUpdate",
      "metafieldsSet",
    ]);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("the main image is removed: the next gallery image moves up in the same write", () => {
  it("delete of the medium (removal only): promoted from the stored gallery, and it leaves the metafield", async () => {
    variants[V1].main = null; // Shopify already dropped the deleted medium from the variant
    const res = await post(removal(V1, img(1)));
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
    expect(updateMany).toHaveBeenCalledWith({ where: { shopifyGid: V1 }, data: { galleryJson: JSON.stringify([img(3)]) } });
  });

  it("B2: the same removal sent three times promotes ONCE (the replays find another main and do nothing)", async () => {
    await post(removal(V1, img(1)));
    await post(removal(V1, img(1)));
    await post(removal(V1, img(1)));
    expect(bulkCount()).toBe(1);
    expect(variants[V1].main).toBe(img(2));
    expect(variants[V1].gallery).toEqual([img(3)]);
  });

  it("B2: a failed bulk update is retried safely, a retry after a metafield failure does not promote twice", async () => {
    await post({ ...removal(V1, img(1)), variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)] }] });
    expect(variants[V1].main).toBe(img(2));
    // the client kept its pending state (answer lost) and sends the same save again
    const again = await post({ ...removal(V1, img(1)), variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)] }] });
    expect(again.success).toBe(true);
    expect(variants[V1].main).toBe(img(2));
    expect(variants[V1].gallery).toEqual([img(3)]);
  });

  it("B3: a stale tab clears nothing the merchant never removed (the main was changed elsewhere)", async () => {
    variants[V1].main = img(3); // somebody set another main image in the meantime
    const res = await post(removal(V1, img(1)));
    expect(res.success).toBe(true);
    expect(bulkCount()).toBe(0);
    expect(variants[V1].main).toBe(img(3));
  });

  it("B3: a stale removal that carries a list is refused, not applied", async () => {
    variants[V1] = { main: img(4), gallery: [img(2)] };
    const res = await post({ ...removal(V1, img(1)), variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)] }] });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "mainChangedElsewhere" }]);
    expect(bulkCount()).toBe(0);
  });

  it("main moved away on Save (removal + the editor gallery): same", async () => {
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)], removedMainGid: img(1) }] });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
  });

  it("the old main is stripped even when the editor still sent it in the gallery", async () => {
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(1), img(2), img(3)], removedMainGid: img(1) }] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
  });

  it("nothing left in the gallery: the only case that ends with no main image, and no order entry", async () => {
    variants[V1].gallery = [];
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBeNull();
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toBeUndefined();
  });

  it("only videos in the gallery: nothing can be a native image, the videos stay in the gallery", async () => {
    variants[V1].gallery = [vid(1), vid(2)];
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBeNull();
    expect(galleryOf(v)).toEqual([vid(1), vid(2)]);
    expect(orderOf(v)).toBeUndefined();
  });

  it("a video first, an image behind it: the image moves up, the video stays", async () => {
    variants[V1].gallery = [vid(1), img(3)];
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([vid(1)]);
  });

  it("a GenericFile at the head is not promoted (not an image)", async () => {
    variants[V1].gallery = ["gid://shopify/GenericFile/7", img(3)];
    await post(removal(V1, img(1)));
    expect(bulk()![0].mediaId).toBe(img(3));
  });

  it("a DEAD reference (the file no longer exists) is skipped and not written back", async () => {
    variants[V1].gallery = [img(99), img(3)];
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([]);
  });

  it("the visible order decides: the order JSON puts the third image first", async () => {
    variants[V1].links = ["https://youtu.be/x"];
    variants[V1].order = JSON.stringify([
      { kind: "file", value: img(1) },
      { kind: "file", value: img(3) },
      { kind: "url", value: "https://youtu.be/x" },
      { kind: "file", value: img(2) },
    ]);
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(3));
    expect(galleryOf(v)).toEqual([img(2)]);
    expect(orderOf(v)).toEqual([
      { kind: "file", value: img(3) },
      { kind: "url", value: "https://youtu.be/x" },
      { kind: "file", value: img(2) },
    ]);
  });

  it("several variants lose their main image at once: each promotes its own next image", async () => {
    await post({ removedMainImages: [{ variantId: V1, removedMainGid: img(1) }, { variantId: V2, removedMainGid: img(4) }] });
    const [a, b] = bulk()!;
    expect([a.id, a.mediaId, galleryOf(a)]).toEqual([V1, img(2), [img(3)]]);
    expect([b.id, b.mediaId, galleryOf(b)]).toEqual([V2, img(5), []]);
  });

  it("Shopify refuses the promoted media: the save reports failure, nothing else is written", async () => {
    bulkErrors = [{ message: "Media does not belong to the product" }];
    const res = await post({
      ...removal(V1, img(1)),
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: img(2) }]) }],
    });
    expect(res.success).toBe(false);
    expect(res.errors.join(" ")).toContain("Media does not belong");
    expect(updateMany).not.toHaveBeenCalled();
    expect(names().includes("metafieldsSet")).toBe(false);
  });
});

describe("M1 and H1: the lookup", () => {
  it("a failed lookup refuses a removal and writes NOTHING (it used to write mediaId null and an empty gallery)", async () => {
    lookupFails = "variants";
    const res = await post(removal(V1, img(1)));
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "lookupFailed" }]);
    expect(bulkCount()).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a failed lookup refuses an explicit main change too, and a promoteIfEmpty", async () => {
    lookupFails = "errors-array";
    for (const g of [
      { variantId: V1, fileGids: [img(3), img(1)], mainGid: img(3), expectedMainGid: img(1) },
      { variantId: V1, fileGids: [img(3)], promoteIfEmpty: true },
    ]) {
      const res = await post({ variantGalleries: [g] });
      expect(res.success).toBe(false);
      expect(res.refusals[0].code).toBe("lookupFailed");
    }
    expect(bulkCount()).toBe(0);
  });

  it("where no main image is touched the plain write still goes through without a lookup", async () => {
    lookupFails = "variants";
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)], galleryOnly: true }] });
    expect(res.success).toBe(true);
    expect(galleryOf(bulk()![0])).toEqual([img(2), img(3)]);
  });

  it("the lookup is logged, never silent (throttling / errors array)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lookupFails = "variants";
    await post(removal(V1, img(1)));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("variants lookup threw") && String(c[0]).includes("THROTTLED"))).toBe(true);
    warn.mockRestore();
  });

  it("the cost is bounded: media in pages of 100, only the NAMED variants, at most 50 per query", async () => {
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }] });
    const media = calls.filter((c) => c.name === "productMediaPage");
    expect(media.every((c) => c.variables.first <= 100)).toBe(true);
    const vq = calls.filter((c) => c.name === "variantsForGalleries");
    expect(vq).toHaveLength(1);
    expect(vq[0].variables.ids).toEqual([V1]); // not "every variant of the product"
    expect(calls.some((c) => c.variables?.first === 250)).toBe(false);
  });

  it("80 variants are read in chunks of 50, never in one query", async () => {
    const many = Array.from({ length: 80 }, (_, i) => `gid://shopify/ProductVariant/${1000 + i}`);
    for (const id of many) variants[id] = { main: img(1), gallery: [] };
    await post({ variantGalleries: many.map((id) => ({ variantId: id, fileGids: [], galleryOnly: true })) });
    const sizes = calls.filter((c) => c.name === "variantsForGalleries").map((c) => c.variables.ids.length);
    expect(sizes).toEqual([50, 30]);
  });
});

describe("H2: a library image that is not product media is attached before it becomes the main image", () => {
  it("removal: the first image of the gallery is a library file: fileUpdate referencesToAdd, confirmed by a re-read, then promoted", async () => {
    libraryFiles[img(60)] = "READY";
    variants[V1].gallery = [img(60), img(3)];
    const res = await post(removal(V1, img(1)));
    expect(res.success).toBe(true);
    const attach = calls.find((c) => c.name === "fileAttachToProduct")!;
    expect(attach.variables.files).toEqual([{ id: img(60), referencesToAdd: [PRODUCT] }]);
    expect(JSON.stringify(calls.map((c) => c.variables))).not.toContain("referencesToRemove");
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(60));
    expect(galleryOf(v)).toEqual([img(3)]);
  });

  it("attach refused by Shopify: the variant is unchanged, NO silent next image and NO null main", async () => {
    libraryFiles[img(60)] = "READY";
    attachErrors = [{ message: "Cannot add reference" }];
    variants[V1].gallery = [img(60), img(3)];
    const res = await post(removal(V1, img(1)));
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "attachFailed" }]);
    expect(bulkCount()).toBe(0);
    expect(variants[V1].main).toBe(img(1));
  });

  it("a file that is not READY is not attempted (refused)", async () => {
    libraryFiles[img(60)] = "PROCESSING";
    variants[V1].gallery = [img(60), img(3)];
    const res = await post(removal(V1, img(1)));
    expect(res.refusals).toEqual([{ variantId: V1, code: "attachFailed" }]);
    expect(names().includes("fileAttachToProduct")).toBe(false);
  });
});

describe("H4 and M4: a variant with no native image", () => {
  it("a real edit promotes its first OWN image (promoteIfEmpty)", async () => {
    variants[V1] = { main: null, gallery: [] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)], promoteIfEmpty: true }] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([img(3)]);
  });

  it("one that has a main image is not touched by promoteIfEmpty", async () => {
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)], promoteIfEmpty: true }] });
    expect("mediaId" in bulk()![0]).toBe(false);
  });

  it("a galleryOnly write (the editor could not name the native image) never clears or sets it", async () => {
    variants[V1] = { main: img(1), gallery: [] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }] });
    expect("mediaId" in bulk()![0]).toBe(false);
  });
});

describe("R4: the variant is left with a promoted main and an empty gallery", () => {
  it("two images, the main is deleted: the order metafield is written in the same variant input, so the embed shows ONLY the remaining image", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toEqual([{ kind: "file", value: img(2) }]);
    expect(names().includes("metafieldsSet")).toBe(false); // same write, nothing half-applied
    expect(variants[V1].order).toBe(JSON.stringify([{ kind: "file", value: img(2) }]));
    expect(updateMany).toHaveBeenCalledWith({ where: { shopifyGid: V1 }, data: { galleryJson: "[]" } });
  });

  it("two images, the main is moved away on Save (removal + list): same entry", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], removedMainGid: img(1) }] });
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(2) }]);
  });

  it("NOT written (R3): a variant whose stored list is only its own main image [main] that becomes [] after an edit loses nothing", async () => {
    variants[V1] = { main: img(1), gallery: [img(1)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true }] });
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toBeUndefined();
    expect("mediaId" in v).toBe(false);
  });

  it("NOT written: a variant with a main image and an empty stored list stays as it is (nothing was lost)", async () => {
    variants[V1] = { main: img(1), gallery: [] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true }] });
    expect(orderOf(bulk()![0])).toBeUndefined();
  });

  it("NOT written: a variant left with no image at all", async () => {
    variants[V1] = { main: img(1), gallery: [] };
    await post(removal(V1, img(1)));
    expect(orderOf(bulk()![0])).toBeUndefined();
  });

  it("a gallery image added LATER is not hidden by the stale single-entry order: the order is widened to include it", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post(removal(V1, img(1)));
    expect(variants[V1].main).toBe(img(2));
    calls = [];
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(5)], galleryOnly: true }] });
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([img(5)]);
    expect(orderOf(v)).toEqual([{ kind: "file", value: img(2) }, { kind: "file", value: img(5) }]);
  });
});

describe("point 1: a variant left with only its main image shows only that image (more than one variant)", () => {
  const MAIN_ONLY = (g: string) => JSON.stringify([{ kind: "file", value: g }]);

  it("the last non-main gallery image is removed: the main-only entry is written in the same variant input", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(res.success).toBe(true);
    const v = bulk()![0];
    expect("mediaId" in v).toBe(false);
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toEqual([{ kind: "file", value: img(1) }]);
    expect(names().includes("metafieldsSet")).toBe(false);
    expect(variants[V1].order).toBe(MAIN_ONLY(img(1)));
  });

  it("ANY edit that empties the list, not only the two-image case (three images, all non-main removed)", async () => {
    variants[V1] = { main: img(1), gallery: [img(2), img(3), img(5)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(1)], galleryOnly: true, expectedMainGid: img(1) }] });
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toEqual([{ kind: "file", value: img(1) }]);
  });

  it("a client order that carries only the main image is the same entry; an EMPTY client order does not delete it", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post({
      variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }],
      variantGalleryOrder: [{ variantId: V1, orderJson: "" }],
    });
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }]);
    expect(names().includes("metafieldsDelete")).toBe(false);
  });

  it("SINGLE variant (Shopify's default variant counts as one): no entry, the fallback to all product media is right", async () => {
    variants = { [V1]: { main: img(1), gallery: [img(2)] } };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toBeUndefined();
  });

  it("SINGLE variant, R4 removal: the promoted image gets no entry either", async () => {
    variants = { [V1]: { main: img(1), gallery: [img(2)] } };
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(orderOf(v)).toBeUndefined();
    expect(variants[V1].order).toBeFalsy();
  });

  it("count not answered: nothing is created (the previous fallback behaviour)", async () => {
    variantCountOverride = null;
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(orderOf(bulk()![0])).toBeUndefined();
  });

  it("R4 with more than one variant keeps working, the variant count is read from Shopify (not from the request)", async () => {
    variants = { [V1]: { main: img(1), gallery: [img(2)] }, [V2]: { main: img(4), gallery: [] }, ["gid://shopify/ProductVariant/3"]: { main: null, gallery: [] } };
    await post(removal(V1, img(1)));
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(2) }]);
    expect(calls.some((c) => c.name === "productMediaPage")).toBe(true);
  });

  it("a gallery that still has images gets no entry; with links in the order the entry is not written", async () => {
    variants[V1] = { main: img(1), gallery: [img(2), img(3)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(3)], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(orderOf(bulk()![0])).toBeUndefined();
    calls = [];
    variants[V1] = { main: img(1), gallery: [img(2)], links: ["https://youtu.be/abcdefghijk"], order: JSON.stringify([{ kind: "file", value: img(1) }, { kind: "file", value: img(2) }, { kind: "url", value: "https://youtu.be/abcdefghijk" }]) };
    await post({
      variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }],
      variantExternalVideos: [{ variantId: V1, urls: ["https://youtu.be/abcdefghijk"] }],
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: img(1) }, { kind: "url", value: "https://youtu.be/abcdefghijk" }]) }],
    });
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }, { kind: "url", value: "https://youtu.be/abcdefghijk" }]);
  });

  it("no image left at all: stays empty, no entry", async () => {
    variants[V1] = { main: img(1), gallery: [] };
    await post(removal(V1, img(1)));
    const v = bulk()![0];
    expect(v.mediaId).toBeNull();
    expect(orderOf(v)).toBeUndefined();
  });

  it("REMOVING the entry: a gallery image added later widens it (no client order)", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(variants[V1].order).toBe(MAIN_ONLY(img(1)));
    calls = [];
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(5)], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }, { kind: "file", value: img(5) }]);
  });

  it("REMOVING the entry: the product now has ONE variant, any write of the variant deletes a stored main-only entry", async () => {
    variants = { [V1]: { main: img(1), gallery: [], order: MAIN_ONLY(img(1)) } };
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(res.success).toBe(true);
    expect(orderOf(bulk()![0])).toBeUndefined();
    const del = calls.find((c) => c.name === "metafieldsDelete");
    expect(del?.variables.metafields).toEqual([{ ownerId: V1, namespace: "custom", key: "variant_gallery_order" }]);
  });

  it("an entry in effect on a multi-variant product survives an unrelated write of the variant (re-written, not deleted)", async () => {
    variants[V1] = { main: img(1), gallery: [], order: MAIN_ONLY(img(1)) };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }]);
    expect(names().includes("metafieldsDelete")).toBe(false);
  });

  it("promoteIfEmpty of a variant whose list holds exactly one image: that image is the main and shown alone (more than one variant only)", async () => {
    variants[V1] = { main: null, gallery: [img(2)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], promoteIfEmpty: true }] });
    const v = bulk()![0];
    expect(v.mediaId).toBe(img(2));
    expect(orderOf(v)).toEqual([{ kind: "file", value: img(2) }]);
    calls = [];
    variants = { [V1]: { main: null, gallery: [img(2)] } };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], promoteIfEmpty: true }] });
    expect(orderOf(bulk()![0])).toBeUndefined();
  });
});

describe("point 2: moving a main image to another variant (both variants, one write, or neither)", () => {
  const mv = (over: Record<string, unknown> = {}) => ({ gid: img(1), sourceVariantId: V1, sourceExpectedMainGid: img(1), targetVariantId: V2, targetExpectedMainGid: img(4), targetPosition: 1, ...over });
  // the editor's statements for a drop on a LATER slot of V2 ([4, 1, 5]) and for slot one ([1, 4, 5])
  const later = () => ({
    removedMainImages: [{ variantId: V1, removedMainGid: img(1) }],
    variantGalleries: [{ variantId: V2, fileGids: [img(4), img(1), img(5)], galleryOnly: true, expectedMainGid: img(4) }],
    variantGalleryOrder: [{ variantId: V2, orderJson: JSON.stringify([{ kind: "file", value: img(4) }, { kind: "file", value: img(1) }, { kind: "file", value: img(5) }]) }],
    mainMoves: [mv()],
  });
  const slotOne = () => ({
    removedMainImages: [{ variantId: V1, removedMainGid: img(1) }],
    variantGalleries: [{ variantId: V2, fileGids: [img(1), img(4), img(5)], mainGid: img(1), expectedMainGid: img(4) }],
    variantGalleryOrder: [{ variantId: V2, orderJson: JSON.stringify([{ kind: "file", value: img(1) }, { kind: "file", value: img(4) }, { kind: "file", value: img(5) }]) }],
    mainMoves: [mv({ targetPosition: 0 })],
  });
  const byId = (id: string) => bulk()!.find((v) => v.id === id);

  it("dropped on a later slot: both variants are written in ONE productVariantsBulkUpdate; the target keeps its main, the source promotes its first own image", async () => {
    const res = await post(later());
    expect(res.success).toBe(true);
    expect(bulkCount()).toBe(1);
    expect(byId(V1).mediaId).toBe(img(2));
    expect(galleryOf(byId(V1))).toEqual([img(3)]);
    expect("mediaId" in byId(V2)).toBe(false);
    expect(galleryOf(byId(V2))).toEqual([img(1), img(5)]);
    // the target's order carries the moved image at exactly the dropped position
    expect(orderOf(byId(V2)).map((e: any) => e.value)).toEqual([img(4), img(1), img(5)]);
    expect(variants[V1].main).toBe(img(2));
    expect(variants[V2].gallery).toEqual([img(1), img(5)]);
  });

  it("dropped on slot one: the moved image becomes the target's main, the target's old main goes into its gallery", async () => {
    const res = await post(slotOne());
    expect(res.success).toBe(true);
    expect(bulkCount()).toBe(1);
    expect(byId(V2).mediaId).toBe(img(1));
    expect(galleryOf(byId(V2))).toEqual([img(4), img(5)]);
    expect(byId(V1).mediaId).toBe(img(2));
    expect(variants[V1].main).toBe(img(2));
    expect(variants[V2].main).toBe(img(1));
  });

  it("the source has no image left: it ends with no main (unset) and no order entry", async () => {
    variants[V1] = { main: img(1), gallery: [] };
    const res = await post(later());
    expect(res.success).toBe(true);
    expect(byId(V1).mediaId).toBeNull();
    expect(orderOf(byId(V1))).toBeUndefined();
    expect(galleryOf(byId(V2))).toEqual([img(1), img(5)]);
  });

  it("the source's next gallery entry is a video: the first IMAGE moves up, the video stays", async () => {
    productMedia[vid(1)] = "VIDEO";
    variants[V1] = { main: img(1), gallery: [vid(1), img(3)] };
    await post(later());
    expect(byId(V1).mediaId).toBe(img(3));
    expect(galleryOf(byId(V1))).toEqual([vid(1)]);
  });

  it("the source is left with only the promoted image (more than one variant): it shows only that image", async () => {
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post(later());
    expect(byId(V1).mediaId).toBe(img(2));
    expect(galleryOf(byId(V1))).toEqual([]);
    expect(orderOf(byId(V1))).toEqual([{ kind: "file", value: img(2) }]);
  });

  it("a stale tab, SOURCE side: its main changed elsewhere: BOTH variants are refused, nothing is written", async () => {
    variants[V1].main = img(2);
    const res = await post(later());
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual(expect.arrayContaining([{ variantId: V1, code: "mainChangedElsewhere" }, { variantId: V2, code: "moveCounterpartRefused" }]));
    expect(bulkCount()).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(names().includes("productReorderMedia")).toBe(false);
  });

  it("a stale tab, TARGET side: its main changed elsewhere: BOTH variants are refused, the source keeps its main", async () => {
    variants[V2].main = img(5);
    const res = await post(later());
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual(expect.arrayContaining([{ variantId: V2, code: "mainChangedElsewhere" }, { variantId: V1, code: "moveCounterpartRefused" }]));
    expect(bulkCount()).toBe(0);
    expect(variants[V1].main).toBe(img(1));
  });

  it("a refusal for another reason (the promoted library image cannot be attached) also refuses the OTHER variant", async () => {
    libraryFiles[img(9)] = "READY";
    variants[V1] = { main: img(1), gallery: [img(9)] };
    attachFailFor = img(9);
    const res = await post(later());
    expect(res.success).toBe(false);
    expect(bulkCount()).toBe(0);
    expect(res.refusals).toEqual(expect.arrayContaining([{ variantId: V1, code: "attachFailed" }, { variantId: V2, code: "moveCounterpartRefused" }]));
    expect(variants[V2].gallery).toEqual([img(5)]);
  });

  it("a failed read refuses both and writes nothing (nothing uploaded either)", async () => {
    lookupFails = "variants";
    const res = await post({ ...later(), newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }] });
    expect(res.success).toBe(false);
    expect(names().includes("productCreateMedia")).toBe(false);
    expect(bulkCount()).toBe(0);
    expect(res.refusals.map((r: any) => r.variantId).sort()).toEqual([V1, V2]);
  });

  it("a retry after the move landed is a no-op for both variants (idempotent), success", async () => {
    expect((await post(later())).success).toBe(true);
    calls = [];
    updateMany.mockReset();
    const again = await post(later());
    expect(again.success).toBe(true);
    expect(bulkCount()).toBe(0);
    expect(variants[V1].main).toBe(img(2));
    expect(variants[V2].gallery).toEqual([img(1), img(5)]);
  });

  it("a retry after a failed write (userErrors) writes the move once, then nothing again", async () => {
    bulkErrors = [{ message: "boom" }];
    const failed = await post(later());
    expect(failed.success).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(variants[V1].main).toBe(img(1));
    bulkErrors = [];
    calls = [];
    expect((await post(slotOne())).success).toBe(true);
    expect(variants[V2].main).toBe(img(1));
    expect(variants[V1].main).toBe(img(2));
    calls = [];
    expect((await post(slotOne())).success).toBe(true);
    expect(bulkCount()).toBe(0);
  });

  it("if the two variants were NOT written atomically and only the SOURCE landed: the retry is refused for both, the image is on no variant but never gone from the product", async () => {
    variants[V1].main = img(2); // the source half of an earlier call landed, the target half did not
    const res = await post(later());
    expect(res.success).toBe(false);
    expect(bulkCount()).toBe(0);
    expect(productMedia[img(1)]).toBe("IMAGE");
  });

  it("only the TARGET landed (image in both): the retry completes the move", async () => {
    variants[V2].gallery = [img(1), img(5)];
    const res = await post(later());
    expect(res.success).toBe(true);
    expect(variants[V1].main).toBe(img(2));
  });

  it("a malformed move is refused before anything is created or written", async () => {
    const bad = { ...later(), variantGalleries: [{ variantId: V2, fileGids: [img(4), img(5)], galleryOnly: true, expectedMainGid: img(4) }] };
    const res = await post({ ...bad, newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }] });
    expect(res.success).toBe(false);
    expect(calls.length).toBe(0);
    expect(res.errors.join(" ")).toMatch(/mainMoves\[0\]/);
  });

  it("a move to a target WITHOUT a main image: dropping on slot one makes the moved image its main", async () => {
    variants[V2] = { main: null, gallery: [img(5)] };
    const res = await post({
      removedMainImages: [{ variantId: V1, removedMainGid: img(1) }],
      variantGalleries: [{ variantId: V2, fileGids: [img(1), img(5)], mainGid: img(1), expectedMainGid: null }],
      mainMoves: [mv({ targetExpectedMainGid: null, targetPosition: 0 })],
    });
    expect(res.success).toBe(true);
    expect(variants[V2].main).toBe(img(1));
    expect(variants[V2].gallery).toEqual([img(5)]);
    expect(variants[V1].main).toBe(img(2));
  });
});

describe("review fixes (route)", () => {
  const MAIN_ONLY = (g: string) => JSON.stringify([{ kind: "file", value: g }]);
  const emptyEdit = () => ({ variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }] });
  const later = () => ({
    removedMainImages: [{ variantId: V1, removedMainGid: img(1) }],
    variantGalleries: [{ variantId: V2, fileGids: [img(4), img(1), img(5)], galleryOnly: true, expectedMainGid: img(4) }],
    variantGalleryOrder: [{ variantId: V2, orderJson: JSON.stringify([{ kind: "file", value: img(4) }, { kind: "file", value: img(1) }, { kind: "file", value: img(5) }]) }],
    mainMoves: [{ gid: img(1), sourceVariantId: V1, sourceExpectedMainGid: img(1), targetVariantId: V2, targetExpectedMainGid: img(4), targetPosition: 1 }],
  });

  it("M2: a move that is already DONE writes nothing for either variant, not even the target's client order", async () => {
    expect((await post(later())).success).toBe(true);
    calls = [];
    variants[V2].order = JSON.stringify([{ kind: "file", value: img(5) }]); // a newer order from another tab
    const res = await post(later());
    expect(res.success).toBe(true);
    expect(names().includes("metafieldsSet")).toBe(false);
    expect(names().includes("metafieldsDelete")).toBe(false);
    expect(bulkCount()).toBe(0);
    expect(variants[V2].order).toBe(JSON.stringify([{ kind: "file", value: img(5) }]));
  });

  it("L1: an unknown count never deletes an entry in effect, even when the editor sends an empty order ([] or empty string)", async () => {
    variantCountOverride = null;
    for (const orderJson of ["[]", ""]) {
      calls = [];
      variants[V1] = { main: img(1), gallery: [], order: MAIN_ONLY(img(1)) };
      await post({ ...emptyEdit(), variantGalleryOrder: [{ variantId: V1, orderJson }] });
      expect(names().includes("metafieldsDelete")).toBe(false);
      expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }]);
    }
  });

  it("L1: with more than one variant an empty order ([]) does not delete the entry either", async () => {
    variants[V1] = { main: img(1), gallery: [], order: MAIN_ONLY(img(1)) };
    await post({ ...emptyEdit(), variantGalleryOrder: [{ variantId: V1, orderJson: "[]" }] });
    expect(names().includes("metafieldsDelete")).toBe(false);
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }]);
  });

  it("L2: a list that held only a DEAD reference is empty after the filter: the entry is written (the rule runs on the filtered list)", async () => {
    delete productMedia[img(2)]; // image 2 no longer exists
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true, expectedMainGid: img(1) }] });
    const v = bulk()![0];
    expect(galleryOf(v)).toEqual([]);
    expect(orderOf(v)).toEqual([{ kind: "file", value: img(1) }]);
  });

  it("L3: when the count document is refused, `variants(first: 2)` answers (2 = more than one, 1 = one)", async () => {
    variantCountMode = "fallback";
    variants[V1] = { main: img(1), gallery: [img(2)] };
    await post(emptyEdit());
    expect(names()).toContain("productVariantsFirstTwo");
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: img(1) }]);
    calls = [];
    variants = { [V1]: { main: img(1), gallery: [img(2)] } };
    await post(emptyEdit());
    expect(orderOf(bulk()![0])).toBeUndefined();
  });

  it("L3: both count documents refused: the save still goes through, nothing is created or deleted for the entry", async () => {
    variantCountMode = "none";
    variants[V1] = { main: img(1), gallery: [img(2)] };
    const res = await post(emptyEdit());
    expect(res.success).toBe(true);
    expect(orderOf(bulk()![0])).toBeUndefined();
    expect(names().includes("metafieldsDelete")).toBe(false);
  });

  it("L3: a main-image save (move / removal) is NOT blocked by a refused count document", async () => {
    variantCountMode = "none";
    const res = await post(later());
    expect(res.success).toBe(true);
    expect(variants[V1].main).toBe(img(2));
  });

  it("L4: mainMoves that is not an array is refused cleanly before anything happens; null / absent mean none", async () => {
    for (const bad of ["x", { a: 1 }, 5]) {
      calls = [];
      const res = await post({ ...later(), mainMoves: bad });
      expect(res.success).toBe(false);
      expect(res.errors.join(" ")).toMatch(/mainMoves/);
      expect(calls.length).toBe(0);
    }
    const ok = await post({ variantGalleries: [{ variantId: V2, fileGids: [img(5)], galleryOnly: true, expectedMainGid: img(4) }], mainMoves: null });
    expect(ok.success).toBe(true);
  });
});

describe("second review fixes (route)", () => {
  it("M-a: ONE variant, stored [M, X], X removed: the stale multi-file order is deleted (the storefront would show only M)", async () => {
    const stale = JSON.stringify([{ kind: "file", value: img(1) }, { kind: "file", value: img(2) }]);
    variants = { [V1]: { main: img(1), gallery: [img(2)], order: stale } };
    const res = await post({
      variantGalleries: [{ variantId: V1, fileGids: [], galleryOnly: true, expectedMainGid: img(1) }],
      variantGalleryOrder: [{ variantId: V1, orderJson: stale }],
    });
    expect(res.success).toBe(true);
    expect(orderOf(bulk()![0])).toBeUndefined();
    expect(calls.find((c) => c.name === "metafieldsDelete")?.variables.metafields).toEqual([{ ownerId: V1, namespace: "custom", key: "variant_gallery_order" }]);
  });

  it("a malformed move answers a worded error code (the editor words it, never the raw English)", async () => {
    const res = await post({
      removedMainImages: [{ variantId: V1, removedMainGid: img(1) }],
      variantGalleries: [{ variantId: V2, fileGids: [img(4)], galleryOnly: true, expectedMainGid: img(4) }],
      mainMoves: [{ gid: img(1), sourceVariantId: V1, sourceExpectedMainGid: img(1), targetVariantId: V2, targetExpectedMainGid: img(4), targetPosition: 1 }],
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("mainMoveInvalid");
    expect((await post({ mainMoves: "x" })).errorCode).toBe("mainMoveInvalid");
  });
});

describe("review round: a failed or refused save never makes the next Save upload the media again", () => {
  const NEW = [{ resourceUrl: "https://staged/x.jpg", kind: "image" }];

  it("H2: a failed read is found BEFORE anything is created (nothing uploaded, a retry cannot duplicate)", async () => {
    lookupFails = "variants";
    const res = await post({ newMedia: NEW, ...removal(V1, img(1)) });
    expect(res.success).toBe(false);
    expect(names().includes("productCreateMedia")).toBe(false);
  });

  it("H2: the read failing AFTER the create reports the created media, so the client converts the staged reference", async () => {
    failVariantsFromCall = 2; // the pre-flight read works, the one after the create does not
    const res = await post({ newMedia: NEW, ...removal(V1, img(1)) });
    expect(res.success).toBe(false);
    expect(res.createdMedia).toEqual([{ resourceUrl: "https://staged/x.jpg", mediaId: img(101), kind: "image" }]);
    expect(res.refusals[0].code).toBe("lookupFailed");
  });

  it("H2: a bulk-update refusal after the create reports the created media too", async () => {
    bulkErrors = [{ message: "boom" }];
    const res = await post({ newMedia: NEW, variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }] });
    expect(res.success).toBe(false);
    expect(res.createdMedia).toHaveLength(1);
  });

  it("M7: an attach Shopify accepted but the read does not show yet is NOT 'refused': nothing written, retry later, created media reported", async () => {
    libraryFiles[img(60)] = "READY";
    attachLag = true;
    variants[V1].gallery = [img(60), img(3)];
    const res = await post({ newMedia: NEW, ...removal(V1, img(1)) });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "attachNotConfirmed" }]);
    expect(bulkCount()).toBe(0);
    expect(res.createdMedia).toHaveLength(1);
  });
});

describe("review round: refused and unknown variants", () => {
  it("M6: a refused variant gets no external videos, 3D models or previews either", async () => {
    variants[V1].main = img(2); // changed elsewhere: V1's explicit main change is refused
    await post({
      variantGalleries: [
        { variantId: V1, fileGids: [img(3), img(1)], mainGid: img(3), expectedMainGid: img(1) },
        { variantId: V2, fileGids: [img(4)], galleryOnly: true },
      ],
      variantExternalVideos: [{ variantId: V1, urls: ["https://youtu.be/dQw4w9WgXcQ"] }, { variantId: V2, urls: ["https://youtu.be/dQw4w9WgXcQ"] }],
    });
    const ops = calls.find((c) => c.name === "metafieldsSet")?.variables.metafields ?? [];
    expect(ops.map((o: any) => o.ownerId)).toEqual([V2]);
  });

  it("an unknown / deleted variant refuses only itself, with its own code", async () => {
    const GONE = "gid://shopify/ProductVariant/404";
    const res = await post({
      variantGalleries: [
        { variantId: V1, fileGids: [img(2)], galleryOnly: true },
        { variantId: GONE, fileGids: [img(2)], galleryOnly: true },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.refusedVariants).toEqual([{ variantId: GONE, code: "variantNotFound" }]);
    expect(bulk()!.map((v) => v.id)).toEqual([V1]);
  });

  it("M5-fix: a stale tab's galleryOnly (expected main differs from the fresh main) is refused, no image leaves the gallery", async () => {
    variants[V1] = { main: img(3), gallery: [img(1), img(2)] }; // tab A made 3 the main
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3), img(9)], galleryOnly: true, expectedMainGid: img(1) }] });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "mainChangedElsewhere" }]);
    expect(bulkCount()).toBe(0);
    expect(variants[V1].gallery).toEqual([img(1), img(2)]);
  });
});

describe("review round: orders of a replayed removal", () => {
  it("a replay that carries a client order does not write back the order still listing the removed main", async () => {
    variants[V1] = { main: img(2), gallery: [img(3)] }; // our earlier write landed
    const orderJson = JSON.stringify([{ kind: "file", value: img(1) }, { kind: "file", value: img(2) }, { kind: "file", value: img(3) }]);
    await post({
      ...removal(V1, img(1)),
      variantGalleries: [{ variantId: V1, fileGids: [img(2), img(3)], removedMainGid: img(1) }],
      variantGalleryOrder: [{ variantId: V1, orderJson }],
    });
    expect(JSON.stringify(orderOf(bulk()![0]))).not.toContain(img(1));
  });

  it("a bare replay (skip) still writes an order-only pending change, without the removed main", async () => {
    variants[V1] = { main: img(2), gallery: [img(3)] };
    const orderJson = JSON.stringify([{ kind: "file", value: img(1) }, { kind: "file", value: img(3) }]);
    await post({ ...removal(V1, img(1)), variantGalleryOrder: [{ variantId: V1, orderJson }] });
    expect(bulkCount()).toBe(0);
    const ops = calls.find((c) => c.name === "metafieldsSet")?.variables.metafields ?? [];
    expect(ops).toHaveLength(1);
    expect(ops[0].value).not.toContain(img(1));
    expect(ops[0].value).toContain(img(3));
  });
});

describe("review round: lookups are logged like production throws them", () => {
  it("a throwing existence check is logged, not swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fileExistenceThrows = true;
    variants[V1].gallery = [img(60), img(3)];
    await post(removal(V1, img(1)));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("file existence lookup threw"))).toBe(true);
    warn.mockRestore();
  });
});

describe("second review: server side", () => {
  it("MEDIUM 2: a chosen main whose file no longer exists is refused with its own code BEFORE any attach", async () => {
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(99), img(1), img(2)], mainGid: img(99), expectedMainGid: img(1) }] });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "mainFileGone" }]);
    expect(names().includes("fileAttachToProduct")).toBe(false);
    expect(bulkCount()).toBe(0);
  });

  it("LOW 7: a variant refused after ONLY a fileUpdate happened is not reported as saved", async () => {
    libraryFiles[img(60)] = "READY";
    onAttach = () => { variants[V1].main = img(2); }; // somebody changes the main while the attach runs
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(60), img(3)], removedMainGid: img(1) }] });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual([{ variantId: V1, code: "mainChangedElsewhere" }]);
    expect(res.completedSteps).toEqual(["fileUpdate"]);
  });

  it("LOW 10: a productCreateMedia answer with userErrors but all media created still reports what was created", async () => {
    createMediaErrors = [{ message: "one warning" }];
    const res = await post({ newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }], variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }] });
    expect(res.success).toBe(false);
    expect(res.createdMedia).toEqual([{ resourceUrl: "https://staged/x.jpg", mediaId: img(101), kind: "image" }]);
  });
});

describe("third review: server", () => {
  it("L3: the early abort names EVERY refused variant, not only the unconfirmed one", async () => {
    libraryFiles[img(60)] = "READY";
    libraryFiles[img(61)] = "READY";
    attachLagFor = img(60);
    attachFailFor = img(61);
    variants[V1].gallery = [img(60), img(3)];
    variants[V2].gallery = [img(61), img(5)];
    const res = await post({ removedMainImages: [{ variantId: V1, removedMainGid: img(1) }, { variantId: V2, removedMainGid: img(4) }] });
    expect(res.success).toBe(false);
    expect(res.refusals).toEqual(expect.arrayContaining([
      { variantId: V1, code: "attachNotConfirmed" },
      { variantId: V2, code: "attachFailed" },
    ]));
  });

  it("M4: link entries of the order that the request does not write as links are dropped (a removed link stays off)", async () => {
    const Y = "https://youtu.be/dQw4w9WgXcQ";
    const orderJson = JSON.stringify([{ kind: "file", value: img(1) }, { kind: "url", value: Y }, { kind: "file", value: img(2) }]);
    await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }],
      variantExternalVideos: [{ variantId: V1, urls: [] }],
      variantGalleryOrder: [{ variantId: V1, orderJson }],
    });
    expect(JSON.stringify(orderOf(bulk()![0]))).not.toContain(Y);
  });

  it("M4: a link that IS written stays in the order", async () => {
    const Y = "https://youtu.be/dQw4w9WgXcQ";
    const orderJson = JSON.stringify([{ kind: "file", value: img(1) }, { kind: "url", value: Y }]);
    await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }],
      variantExternalVideos: [{ variantId: V1, urls: [Y] }],
      variantGalleryOrder: [{ variantId: V1, orderJson }],
    });
    expect(JSON.stringify(orderOf(bulk()![0]))).toContain(Y);
  });
});

describe("fourth review: server side", () => {
  it("HIGH 1: staged / asset urls in the order are written as the created GID, and links the variant does not hold are dropped", async () => {
    const ASSET = "https://a/55.jpg";
    const orderJson = JSON.stringify([
      { kind: "file", value: img(1) },
      { kind: "file", value: ASSET },
      { kind: "url", value: ASSET },
      { kind: "url", value: "https://youtu.be/notmine" },
    ]);
    await post({
      newMedia: [{ resourceUrl: ASSET, kind: "image" }],
      variantGalleries: [{ variantId: V1, fileGids: [img(2), ASSET], galleryOnly: true }],
      variantGalleryOrder: [{ variantId: V1, orderJson }],
    });
    const o = orderOf(bulk()![0]);
    expect(o).toContainEqual({ kind: "file", value: img(101) });
    expect(JSON.stringify(o)).not.toContain("https://");
  });

  it("MEDIUM: an empty order from the client deletes the stored order; a link the request does not write is dropped from the order", async () => {
    await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }], variantGalleryOrder: [{ variantId: V1, orderJson: "" }] });
    let del = calls.find((c) => c.name === "metafieldsDelete")?.variables.metafields;
    expect(del).toEqual([{ ownerId: V1, namespace: "custom", key: "variant_gallery_order" }]);
    calls = [];
    await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }],
      variantExternalVideos: [{ variantId: V1, urls: [] }],
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: "gid://shopify/MediaImage/404" }, { kind: "url", value: "https://youtu.be/dQw4w9WgXcQ" }]) }],
    });
    // the link is not written, the (dead-resolved) file stays: the order keeps only the file entry
    expect(orderOf(bulk()![0])).toEqual([{ kind: "file", value: "gid://shopify/MediaImage/404" }]);
  });

  it("H-1: a variant with NO native image gets its first own image promoted even when it was created in this request", async () => {
    variants[V1] = { main: null, gallery: [] };
    await post({
      newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }],
      variantGalleries: [{ variantId: V1, fileGids: ["https://staged/x.jpg"], promoteIfEmpty: true }],
    });
    expect(bulk()![0].mediaId).toBe(img(101));
  });

  it("H-1: but a REMOVAL does not promote a medium created in this request (it would replace an existing main with an unsaved one)", async () => {
    await post({
      newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }],
      variantGalleries: [{ variantId: V1, fileGids: ["https://staged/x.jpg", img(3)], removedMainGid: img(1) }],
    });
    expect(bulk()![0].mediaId).toBe(img(3));
  });
});

describe("fifth review: server side", () => {
  const Y = "https://youtu.be/dQw4w9WgXcQ";
  it("M-1: an order of only the variant's own links is KEPT (not deleted), so the embed still renders the link", async () => {
    variants[V1].links = [Y];
    await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }],
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "url", value: Y }]) }],
    });
    expect(orderOf(bulk()![0])).toEqual([{ kind: "url", value: Y }]);
    expect(names().includes("metafieldsDelete")).toBe(false);
  });

  it("M-3: an uploaded model's staging url is written to the order as the CDN url the metafield gets", async () => {
    model3dReady = true;
    const STAGED = "https://staged/m.glb";
    await post({
      newMedia: [{ resourceUrl: STAGED, kind: "model" }],
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }],
      variant3dModels: [{ variantId: V1, urls: [STAGED] }],
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: img(1) }, { kind: "model", value: STAGED }]) }],
    });
    expect(orderOf(bulk()![0])).toContainEqual({ kind: "model", value: "https://cdn.shopify.com/x.glb" });
    expect(JSON.stringify(orderOf(bulk()![0]))).not.toContain(STAGED);
  });

  it("M-3: a model that is dropped (still processing) is not in the order either", async () => {
    model3dReady = false;
    const STAGED = "https://staged/m.glb";
    await post({
      newMedia: [{ resourceUrl: STAGED, kind: "model" }],
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }],
      variant3dModels: [{ variantId: V1, urls: [STAGED] }],
      variantGalleryOrder: [{ variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: img(1) }, { kind: "model", value: STAGED }]) }],
    });
    expect(JSON.stringify(orderOf(bulk()![0]))).not.toContain("m.glb");
  });

  it("L-2: a metafieldsDelete answer without a payload (throttled) is a failure, not a success", async () => {
    deleteAnswerNull = true;
    const res = await post({ variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }], variantGalleryOrder: [{ variantId: V1, orderJson: "" }] });
    expect(res.success).toBe(false);
    expect(res.errors.join(" ")).toContain("metafieldsDelete");
  });
});

describe("sixth review: server side", () => {
  it("M1: a retried removal does not promote a medium the FAILED first attempt created, and is not refused", async () => {
    // attempt 1: the media is created, then the bulk update is refused
    bulkErrors = [{ message: "boom" }];
    const first = await post({
      newMedia: [{ resourceUrl: "https://staged/x.jpg", kind: "image" }],
      variantGalleries: [{ variantId: V1, fileGids: ["https://staged/x.jpg", img(3)], removedMainGid: img(1) }],
    });
    expect(first.success).toBe(false);
    const created = first.createdMedia[0].mediaId;
    // attempt 2: the client references it by GID and says it was created by the earlier attempt
    bulkErrors = [];
    calls = []; // look at the RETRY's bulk update only
    const retry = await post({
      variantGalleries: [{ variantId: V1, fileGids: [created, img(3)], removedMainGid: img(1) }],
      retainedCreatedGids: [created],
    });
    expect(retry.success).toBe(true);
    expect(bulk()![0].mediaId).toBe(img(3));
  });

  it("L2: the deletion is confirmed POSITIONALLY (a null slot only answers for its own input)", async () => {
    deleteEcho = [null, { ownerId: V1, namespace: "custom", key: "variant_gallery_order" }]; // slot 2 answers V1, not V2
    const res = await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }, { variantId: V2, fileGids: [img(5)], galleryOnly: true }],
      variantGalleryOrder: [{ variantId: V1, orderJson: "" }, { variantId: V2, orderJson: "" }],
    });
    expect(res.success).toBe(false);
    expect(res.errors.join(" ")).toContain("not confirmed");
    calls = [];
    deleteEcho = [{ ownerId: V1, namespace: "custom", key: "variant_gallery_order" }, null];
    const ok = await post({
      variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }, { variantId: V2, fileGids: [img(5)], galleryOnly: true }],
      variantGalleryOrder: [{ variantId: V1, orderJson: "" }, { variantId: V2, orderJson: "" }],
    });
    expect(ok.success).toBe(true);
  });
});

describe("a productCreateMedia answer with FEWER media than requested is matched by filename", () => {
  const up = (name: string) => ({ resourceUrl: `https://staged.example/tmp/9/products/${name}`, kind: "image" });

  it("the refused file is simply retried; the created ones are mapped by filename, whatever the answer's order", async () => {
    refuseCreateIdx = [0]; // a.jpg refused: the answer lists b.jpg and c.jpg only
    const res = await post({ newMedia: [up("a.jpg"), up("b.jpg"), up("c.jpg")] });
    expect(res.success).toBe(false);
    expect(res.createdMedia.map((c: any) => c.resourceUrl.split("/").pop()).sort()).toEqual(["b.jpg", "c.jpg"]);
    expect(res.uncertainMedia).toBeUndefined();
    expect(bulkCount()).toBe(0);
    // b.jpg is mapped to the medium that actually reports b.jpg
    const b = res.createdMedia.find((c: any) => c.resourceUrl.endsWith("/b.jpg"));
    expect(createdNames[b.mediaId]).toBe("b.jpg");
  });

  it("Shopify renamed a duplicate (stem + suffix): still mapped", async () => {
    refuseCreateIdx = [0];
    renameCreated = (f) => f.replace(/^b\./, "b_1a2b3c.");
    const res = await post({ newMedia: [up("a.jpg"), up("b.jpg"), up("c.jpg")] });
    const b = res.createdMedia.find((c: any) => c.resourceUrl.endsWith("/b.jpg"));
    expect(b).toBeTruthy();
    expect(createdNames[b.mediaId]).toBe("b_1a2b3c.jpg");
    expect(res.uncertainMedia).toBeUndefined();
  });

  it("the same stem twice is AMBIGUOUS: not mapped, named as uncertain", async () => {
    refuseCreateIdx = [0];
    // two uploads from different folders, same filename
    const res = await post({ newMedia: [up("a.jpg"), { resourceUrl: "https://staged.example/tmp/8/products/c.jpg", kind: "image" }, up("c.jpg")] });
    expect(res.success).toBe(false);
    expect(res.createdMedia).toEqual([]);
    expect(res.uncertainMedia.map((u: any) => u.resourceUrl).sort()).toEqual([
      "https://staged.example/tmp/8/products/c.jpg",
      "https://staged.example/tmp/9/products/a.jpg",
      "https://staged.example/tmp/9/products/c.jpg",
    ].sort());
  });

  it("a failed re-read maps nothing and reports every upload as uncertain (no blind re-upload)", async () => {
    refuseCreateIdx = [0];
    createdFilesFail = true;
    const res = await post({ newMedia: [up("a.jpg"), up("b.jpg"), up("c.jpg")] });
    expect(res.success).toBe(false);
    expect(res.createdMedia).toEqual([]);
    expect(res.uncertainMedia).toHaveLength(3);
  });

  it("nothing created at all: no re-read, nothing uncertain (a retry uploads everything, nothing exists)", async () => {
    refuseCreateIdx = [0, 1];
    const res = await post({ newMedia: [up("a.jpg"), up("b.jpg")] });
    expect(res.success).toBe(false);
    expect(res.uncertainMedia).toBeUndefined();
    expect(names().includes("createdMediaFiles")).toBe(false);
  });

  it("equal counts (the normal path) cost no extra call", async () => {
    const res = await post({ newMedia: [up("a.jpg"), up("b.jpg")], variantGalleries: [{ variantId: V1, fileGids: [img(2)], galleryOnly: true }] });
    expect(res.success).toBe(true);
    expect(names().includes("createdMediaFiles")).toBe(false);
  });

  it("a retry that references the mapped media by GID and omits the uncertain ones creates nothing twice", async () => {
    refuseCreateIdx = [0];
    const first = await post({ newMedia: [up("a.jpg"), up("b.jpg"), up("c.jpg")] });
    expect(first.createdMedia).toHaveLength(2);
    // the client resends only the refused file, the others by GID
    calls = [];
    refuseCreateIdx = [];
    const retry = await post({ newMedia: [up("a.jpg")], variantGalleries: [{ variantId: V1, fileGids: [first.createdMedia[0].mediaId], galleryOnly: true }] });
    expect(retry.success).toBe(true);
    const created = calls.find((c) => c.name === "productCreateMedia")!.variables.media;
    expect(created).toHaveLength(1);
  });
});
