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
  over: { order?: unknown; list?: string[]; status?: string } = {},
) => ({
  id: `gid://shopify/ProductVariant/${Math.random()}`,
  product: { id: productId, title, status: over.status ?? "ACTIVE" },
  galleryOrder: over.order ? { value: JSON.stringify(over.order) } : null,
  externalVideos: over.list ? { value: JSON.stringify(over.list) } : null,
});

/** Admin stub: one variant page, then the upload-date lookup. */
function adminStub(
  nodes: any[],
  dates: Record<string, string | null> = {},
  opts: { pages?: any[][]; media?: Record<string, any[]>; uploadDates?: Record<string, string> } = {},
) {
  const media = opts.media ?? {};
  const pages = opts.pages ?? [nodes];
  let page = 0;
  return {
    graphql: async (query: string, args?: any) => {
      if (query.includes("seoGalleryVideoProducts")) {
        return {
          json: async () => ({
            data: {
              nodes: (args?.variables?.ids ?? []).map((id: string) => ({
                id,
                uploadDate: dates[id] ? { value: dates[id] } : null,
                uploadDates: opts.uploadDates?.[id] ? { value: opts.uploadDates[id] } : null,
                media: { nodes: media[id] ?? [] },
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
    // No GALLERY video prints past the cap. The five media videos do print,
    // and their missing dates are the other finding.
    expect(out!.missingDate).toBe(0);
    expect(out!.products[0]?.youtube ?? 0).toBe(0);
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
    expect(out!.withVimeo).toBe(1);
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
        if (query.includes("seoGalleryVideoProducts")) {
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
        if (query.includes("seoGalleryVideoProducts")) throw new Error("throttled");
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

  it("does NOT report a video the product's own media already carries", async () => {
    // The harmful case. The block seeds its dedup set from product media, so
    // this video is emitted once — from the media loop, WITH the automatic date
    // from custom.video_upload_dates. Reporting it as "missing a date" would
    // push the merchant to set custom.video_upload_date, which is the
    // product-WIDE override: it would replace the accurate File.createdAt stamp
    // of every media video on that product with one guessed date.
    const out = await runGalleryVideoAudit(
      adminStub([variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })], {}, {
        media: {
          [P1]: [
            { mediaContentType: "EXTERNAL_VIDEO", originUrl: "https://www.youtube.com/watch?v=ABC12345678" },
          ],
        },
      }),
      "s.myshopify.com",
    );
    // The GALLERY finding is what this test is about, and it stays zero.
    // The product IS still listed, for the other reason: its media video
    // carries no date either — a separate defect with a separate remedy.
    expect(out!.missingDate).toBe(0);
    expect(out!.products[0]?.youtube ?? 0).toBe(0);
  });

  it("still reports the gallery videos the media do NOT carry", async () => {
    const out = await runGalleryVideoAudit(
      adminStub(
        [variant(P1, "Kumiko", { list: ["https://youtu.be/AAA11111111", "https://youtu.be/BBB22222222"] })],
        {},
        {
          media: {
            [P1]: [{ mediaContentType: "EXTERNAL_VIDEO", originUrl: "https://youtu.be/AAA11111111" }],
          },
        },
      ),
      "s.myshopify.com",
    );
    expect(out!.totalProducts).toBe(1);
    expect(out!.products[0].youtube).toBe(1);
  });

  it("stays quiet once the product's media fill the block's 5-video cap", async () => {
    // `v_printed >= 5` counts media videos first, so no gallery video prints —
    // advice about markup that never appears is noise.
    const out = await runGalleryVideoAudit(
      adminStub([variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })], {}, {
        media: { [P1]: Array.from({ length: 5 }, () => ({ mediaContentType: "VIDEO" })) },
      }),
      "s.myshopify.com",
    );
    // No GALLERY video prints past the cap. The five media videos DO print,
    // and their missing dates are the other finding of this sweep.
    expect(out!.missingDate).toBe(0);
    expect(out!.products[0]?.youtube ?? 0).toBe(0);
  });

  it("skips draft and archived products", async () => {
    // No storefront page at all — reporting one as a defect reports merchant
    // intent as a defect, the rule catalog-readiness.service.ts already follows.
    const out = await runGalleryVideoAudit(
      adminStub([
        variant(P1, "Draft", { list: ["https://youtu.be/ABC12345678"], status: "DRAFT" }),
        variant(P2, "Archived", { list: ["https://youtu.be/BBB22222222"], status: "ARCHIVED" }),
      ]),
      "s.myshopify.com",
    );
    expect(out!.totalProducts).toBe(0);
    expect(out!.scannedVariants).toBe(2);
  });

  it("names the Vimeo problem even when the product also has a YouTube video", async () => {
    // vimeoOnly required youtube === 0, so "1 YouTube, 1 Vimeo · date set" read
    // as "both fine" while the Vimeo entry emitted nothing at all.
    const out = await runGalleryVideoAudit(
      adminStub(
        [variant(P1, "Mixed", { list: ["https://youtu.be/ABC12345678", "https://vimeo.com/123456789"] })],
        { [P1]: "2024-01-01" },
      ),
      "s.myshopify.com",
    );
    expect(out!.withVimeo).toBe(1);
    expect(out!.missingDate).toBe(0);
  });

  it("retries a throttled page instead of giving up on the sweep", async () => {
    // Shopify reports throttling as HTTP 200 with a THROTTLED entry in
    // `errors`, which the transport does not retry. Without this the feature
    // mostly answers "we did not look" on exactly the shops that have galleries.
    let calls = 0;
    const admin = {
      graphql: async (query: string, args?: any) => {
        if (query.includes("seoGalleryVideoProducts")) {
          return { json: async () => ({ data: { nodes: (args?.variables?.ids ?? []).map((id: string) => ({ id, uploadDate: null, media: { nodes: [] } })) } }) };
        }
        calls += 1;
        if (calls === 1) {
          return {
            json: async () => ({
              errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
              extensions: {
                cost: { requestedQueryCost: 302, throttleStatus: { currentlyAvailable: 300, restoreRate: 1000 } },
              },
            }),
          };
        }
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
    expect(calls).toBe(2);
    expect(out!.capped).toBe(false);
    expect(out!.totalProducts).toBe(1);
  });

  it("does not restart the sweep when a cursor is missing", async () => {
    // hasNextPage with no endCursor would re-read page one twenty times and
    // report 2000 scanned variants on a 1-variant shop.
    let calls = 0;
    const admin = {
      graphql: async (query: string, args?: any) => {
        if (query.includes("seoGalleryVideoProducts")) {
          return { json: async () => ({ data: { nodes: (args?.variables?.ids ?? []).map((id: string) => ({ id, uploadDate: null, media: { nodes: [] } })) } }) };
        }
        calls += 1;
        return {
          json: async () => ({
            data: {
              productVariants: {
                pageInfo: { hasNextPage: true, endCursor: null },
                nodes: [variant(P1, "Kumiko", { list: ["https://youtu.be/ABC12345678"] })],
              },
            },
          }),
        };
      },
    } as any;
    const out = await runGalleryVideoAudit(admin, "s.myshopify.com");
    expect(calls).toBe(1);
    expect(out!.scannedVariants).toBe(1);
    expect(out!.capped).toBe(true);
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

  describe("videos in the product's OWN media", () => {
    // The half nothing reported before. A media video gets its date from the
    // product sync (File.createdAt -> custom.video_upload_dates), so the
    // remedy is a resync rather than a date typed by hand — which is why it
    // is counted apart from the gallery case.
    const vid = (n: number) => ({ mediaContentType: "VIDEO", id: `gid://shopify/Video/${n}` });

    it("reports a media video whose id is missing from the date map", async () => {
      const out = await runGalleryVideoAudit(
        adminStub([variant(P1, "Kumiko", {})], {}, { media: { [P1]: [vid(111)] } }),
        "s.myshopify.com",
      );
      expect(out!.mediaMissingDate).toBe(1);
      expect(out!.products[0].mediaMissingDate).toBe(1);
      // …and it is NOT a gallery finding: no gallery URL was involved at all.
      expect(out!.missingDate).toBe(0);
    });

    it("stays quiet when the map carries the media id", async () => {
      const out = await runGalleryVideoAudit(
        adminStub([variant(P1, "Kumiko", {})], {}, {
          media: { [P1]: [vid(111)] },
          uploadDates: { [P1]: JSON.stringify({ "111": "2026-08-18T20:12:50.000Z" }) },
        }),
        "s.myshopify.com",
      );
      expect(out!.mediaMissingDate).toBe(0);
      expect(out!.totalProducts).toBe(0);
    });

    it("treats the product-wide override as a date for every media video", async () => {
      // custom.video_upload_date wins for the whole product in the block, so
      // one date set by hand clears all of them — telling the merchant to set
      // it again would be advice about something already done.
      const out = await runGalleryVideoAudit(
        adminStub([variant(P1, "Kumiko", {})], { [P1]: "2026-08-18" }, {
          media: { [P1]: [vid(111), vid(222)] },
        }),
        "s.myshopify.com",
      );
      expect(out!.mediaMissingDate).toBe(0);
    });

    it("ignores an unreadable date map instead of throwing the sweep", async () => {
      // A hand-edited metafield can hold anything. It contributes no dates,
      // which reports a product that may be fine — the milder error.
      const out = await runGalleryVideoAudit(
        adminStub([variant(P1, "Kumiko", {})], {}, {
          media: { [P1]: [vid(111)] },
          uploadDates: { [P1]: "not json" },
        }),
        "s.myshopify.com",
      );
      expect(out!.mediaMissingDate).toBe(1);
    });

    it("counts only the videos the block would actually print", async () => {
      // Past the 5-video cap nothing is emitted, so a sixth dateless video is
      // not a defect on any live page.
      const out = await runGalleryVideoAudit(
        adminStub([variant(P1, "Kumiko", {})], {}, {
          media: { [P1]: Array.from({ length: 7 }, (_, i) => vid(i + 1)) },
        }),
        "s.myshopify.com",
      );
      expect(out!.products[0].mediaMissingDate).toBe(5);
    });
  });
});
