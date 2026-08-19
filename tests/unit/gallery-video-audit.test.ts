import { describe, it, expect } from "vitest";
import { runGalleryVideoAudit } from "~/services/seo/gallery-video-audit.server";

/**
 * PLAN_MARKUP_ACTIVATION §3.2 — which products carry a video that lives only in
 * a variant gallery, and which of those can produce a rich result at all.
 *
 * The interesting cases are the two the report must not merge (a missing date,
 * which one metafield fixes, versus a Vimeo-only product, for which no markup
 * is emitted at all) and the failure modes, where "we could not look" must
 * never come out as "nothing found".
 */

const variant = (
  productId: string,
  title: string,
  over: { order?: unknown; list?: string[] } = {},
) => ({
  id: `gid://shopify/ProductVariant/${Math.random()}`,
  product: { id: productId, title, handle: title.toLowerCase() },
  galleryOrder: over.order ? { value: JSON.stringify(over.order) } : null,
  externalVideos: over.list ? { value: JSON.stringify(over.list) } : null,
});

/** Admin stub: one variant page, then the upload-date lookup. */
function adminStub(nodes: any[], dates: Record<string, string | null> = {}, opts: { pages?: any[][] } = {}) {
  const pages = opts.pages ?? [nodes];
  let page = 0;
  return {
    graphql: async (query: string, args?: any) => {
      if (query.includes("seoGalleryVideoDates")) {
        return {
          json: async () => ({
            data: {
              nodes: (args?.variables?.ids ?? []).map((id: string) => ({
                id,
                uploadDate: dates[id] ? { value: dates[id] } : null,
              })),
            },
          }),
        };
      }
      const current = pages[page] ?? [];
      const hasNext = page < pages.length - 1;
      page += 1;
      return {
        json: async () => ({
          data: {
            productVariants: {
              pageInfo: { hasNextPage: hasNext, endCursor: `c${page}` },
              nodes: current,
            },
          },
        }),
      };
    },
  } as any;
}

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";

describe("runGalleryVideoAudit", () => {
  it("finds nothing in a shop with no gallery videos, and says how much it looked at", async () => {
    const out = await runGalleryVideoAudit(
      adminStub([variant(P1, "Plain"), variant(P2, "Also plain")]),
      "s.myshopify.com",
    );
    expect(out!.totalProducts).toBe(0);
    expect(out!.scannedVariants).toBe(2);
    expect(out!.capped).toBe(false);
  });

  it("reads BOTH metafields and deduplicates a video product-wide", async () => {
    // The normal case: the same YouTube video hangs on several variants, in
    // both spellings and through both metafields. One video, one entry.
    const out = await runGalleryVideoAudit(
      adminStub([
        variant(P1, "Box", { order: [{ kind: "url", value: "https://www.youtube.com/watch?v=ABC12345678" }] }),
        variant(P1, "Box", { list: ["https://youtu.be/ABC12345678"] }),
        variant(P1, "Box", { order: [{ kind: "url", value: "https://www.youtube.com/shorts/ABC12345678" }] }),
      ]),
      "s.myshopify.com",
    );
    expect(out!.totalProducts).toBe(1);
    expect(out!.products[0].youtube).toBe(1);
    expect(out!.products[0].vimeo).toBe(0);
  });

  it("ignores gallery entries that are not URLs", async () => {
    const out = await runGalleryVideoAudit(
      adminStub([
        variant(P1, "Box", {
          order: [
            { kind: "file", value: "12345" },
            { kind: "model", value: "https://cdn/x.glb" },
          ],
        }),
      ]),
      "s.myshopify.com",
    );
    expect(out!.totalProducts).toBe(0);
  });

  it("separates 'needs a date' from 'gets no markup at all'", async () => {
    // Two different problems with two different answers: P1 is one metafield
    // away from a rich result, P2 emits nothing no matter what the merchant
    // sets, because a Vimeo link yields no thumbnail.
    const out = await runGalleryVideoAudit(
      adminStub(
        [
          variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] }),
          variant(P2, "Vase", { list: ["https://vimeo.com/123456789"] }),
        ],
        {},
      ),
      "s.myshopify.com",
    );
    expect(out!.totalProducts).toBe(2);
    expect(out!.missingDate).toBe(1);
    expect(out!.vimeoOnly).toBe(1);
  });

  it("does not count a product whose date IS set as missing", async () => {
    const out = await runGalleryVideoAudit(
      adminStub([variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })], {
        [P1]: "2024-03-05",
      }),
      "s.myshopify.com",
    );
    expect(out!.missingDate).toBe(0);
    expect(out!.products[0].hasUploadDate).toBe(true);
  });

  it("treats a blank date metafield as missing", async () => {
    const out = await runGalleryVideoAudit(
      adminStub([variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })], { [P1]: "   " }),
      "s.myshopify.com",
    );
    expect(out!.missingDate).toBe(1);
  });

  it("lists the fixable products first", async () => {
    const out = await runGalleryVideoAudit(
      adminStub(
        [
          variant(P1, "Has date", { list: ["https://youtu.be/AAA11111111"] }),
          variant(P2, "No date", { list: ["https://youtu.be/BBB22222222"] }),
        ],
        { [P1]: "2024-01-01" },
      ),
      "s.myshopify.com",
    );
    expect(out!.products[0].title).toBe("No date");
  });

  it("survives an unreadable metafield instead of failing the sweep", async () => {
    const admin = adminStub([
      { ...variant(P1, "Broken"), galleryOrder: { value: "{not json" } },
      variant(P2, "Fine", { list: ["https://youtu.be/ABC12345678"] }),
    ]);
    const out = await runGalleryVideoAudit(admin, "s.myshopify.com");
    expect(out!.totalProducts).toBe(1);
    expect(out!.products[0].title).toBe("Fine");
  });

  it("returns null for a sweep refused before it read anything", async () => {
    // A throttle, a permission error or a query the API version does not know
    // all land here. Reporting `totalProducts: 0` would render as "no gallery
    // videos found" — a confident false negative from a query that never ran.
    const admin = {
      graphql: async () => ({ json: async () => ({ errors: [{ message: "Throttled" }] }) }),
    } as any;
    expect(await runGalleryVideoAudit(admin, "s.myshopify.com")).toBeNull();
  });

  it("keeps a PARTIAL sweep's numbers and flags them as incomplete", async () => {
    // Some variants read, then refused: that is real information, unlike the
    // case above, and it must not be thrown away — only labelled.
    let call = 0;
    const admin = {
      graphql: async (query: string, args?: any) => {
        if (query.includes("seoGalleryVideoDates")) {
          return { json: async () => ({ data: { nodes: (args?.variables?.ids ?? []).map((id: string) => ({ id, uploadDate: null })) } }) };
        }
        call += 1;
        if (call === 1) {
          return {
            json: async () => ({
              data: {
                productVariants: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  nodes: [variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })],
                },
              },
            }),
          };
        }
        return { json: async () => ({ errors: [{ message: "Throttled" }] }) };
      },
    } as any;
    const out = await runGalleryVideoAudit(admin, "s.myshopify.com");
    expect(out!.capped).toBe(true);
    expect(out!.scannedVariants).toBe(1);
    expect(out!.totalProducts).toBe(1);
  });

  it("returns null when the sweep throws — 'not checked', not 'nothing found'", async () => {
    const admin = {
      graphql: async () => {
        throw new Error("boom");
      },
    } as any;
    expect(await runGalleryVideoAudit(admin, "s.myshopify.com")).toBeNull();
  });

  it("keeps a failed date lookup on the safe side", async () => {
    // Unset reads as "no date", which sends a merchant to look at a product
    // that may already be fine. The opposite error would tell them nothing is
    // wrong when something is.
    const admin = {
      graphql: async (query: string) => {
        if (query.includes("seoGalleryVideoDates")) throw new Error("throttled");
        return {
          json: async () => ({
            data: {
              productVariants: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })],
              },
            },
          }),
        };
      },
    } as any;
    const out = await runGalleryVideoAudit(admin, "s.myshopify.com");
    expect(out!.missingDate).toBe(1);
  });

  it("pages through the sweep and keeps the totals whole", async () => {
    const out = await runGalleryVideoAudit(
      adminStub([], {}, {
        pages: [
          [variant(P1, "One", { list: ["https://youtu.be/AAA11111111"] })],
          [variant(P2, "Two", { list: ["https://youtu.be/BBB22222222"] })],
        ],
      }),
      "s.myshopify.com",
    );
    expect(out!.scannedVariants).toBe(2);
    expect(out!.totalProducts).toBe(2);
    expect(out!.capped).toBe(false);
  });
});
