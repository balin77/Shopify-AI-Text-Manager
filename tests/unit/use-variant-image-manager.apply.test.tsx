/**
 * What the gallery save hands back to the page (hook level): a variant the server left alone is a
 * WARNING on a save that went through (never an error: the media exist, the alt drafts must be sent,
 * the reload must run), and media a failed save already created are not uploaded again.
 * MOCK-ONLY: the route's answers are scripted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let calls: any[];
let answer: (body: any) => any;
vi.mock("~/utils/app-fetch", () => ({
  appFetch: vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, status: 200, json: async () => answer(body) };
  }),
}));

import { useVariantImageManager } from "~/hooks/useVariantImageManager";
import { SortableImageGrid } from "~/components/image-manager/SortableImageGrid";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { I18nProvider } from "~/contexts/I18nContext";
import { VariantGallerySection } from "~/components/image-manager/VariantGallerySection";

const V1 = "gid://shopify/ProductVariant/1";

beforeEach(() => {
  calls = [];
});

describe("H1: a refused variant on a save that went through is a warning, not an error", () => {
  it("success with refusedVariants: error null, warning names the variant", async () => {
    answer = () => ({ success: true, createdMedia: [], refusedVariants: [{ variantId: V1, code: "mainChangedElsewhere" }] });
    const { result } = renderHook(() => useVariantImageManager());
    act(() => result.current.handlePendingChange([{ variantId: V1, fileGids: [], galleryOnly: true }], [], []));
    let out: any;
    await act(async () => {
      out = await result.current.handleApply("gid://shopify/Product/1");
    });
    expect(out.error).toBeNull();
    expect(out.warning).toContain("changed elsewhere");
  });

  it("a plain success has neither", async () => {
    answer = () => ({ success: true, createdMedia: [], refusedVariants: [] });
    const { result } = renderHook(() => useVariantImageManager());
    let out: any;
    await act(async () => {
      out = await result.current.handleApply("gid://shopify/Product/1");
    });
    expect(out).toEqual({ error: null, warning: null });
  });

  it("a failed save is an error", async () => {
    answer = () => ({ success: false, errors: ["boom"] });
    const { result } = renderHook(() => useVariantImageManager());
    let out: any;
    await act(async () => {
      out = await result.current.handleApply("gid://shopify/Product/1");
    });
    expect(out).toEqual({ error: "boom", warning: null });
  });
});

describe("H2: media a failed save created are not uploaded again", () => {
  it("the retry sends the GID instead of the staged reference and no newMedia", async () => {
    const STAGED = "https://staged/x.jpg";
    let n = 0;
    answer = () =>
      ++n === 1
        ? { success: false, errors: ["variants: could not be read"], refusals: [{ variantId: V1, code: "lookupFailed" }], createdMedia: [{ resourceUrl: STAGED, mediaId: "gid://shopify/MediaImage/77", kind: "image" }] }
        : { success: true, createdMedia: [] };
    const { result } = renderHook(() => useVariantImageManager());
    act(() => result.current.handlePendingChange([{ variantId: V1, fileGids: [STAGED], promoteIfEmpty: true }], [], [{ resourceUrl: STAGED, kind: "image" }]));
    await act(async () => {
      await result.current.handleApply("gid://shopify/Product/1");
    });
    await act(async () => {
      await result.current.handleApply("gid://shopify/Product/1");
    });
    expect(calls[0].newMedia).toEqual([{ resourceUrl: STAGED, kind: "image" }]);
    expect(calls[1].newMedia).toEqual([]);
    expect(calls[1].variantGalleries[0].fileGids).toEqual(["gid://shopify/MediaImage/77"]);
  });
});

describe("the gold border: no main url means no border, not the first tile", () => {
  const wrap = (mainUrl: string | null | undefined) =>
    render(
      <AppProvider i18n={en}>
        <I18nProvider locale="en">
          <DndContext>
            <SortableImageGrid containerId="v" onReorder={() => {}} imageUrls={["https://a/1.jpg", "https://a/2.jpg"]} skipDndContext onUploadToGallery={() => {}} hasMainImage mainUrl={mainUrl} />
          </DndContext>
        </I18nProvider>
      </AppProvider>,
    );
  it("mainUrl null: no tile is marked as the main image", () => {
    wrap(null);
    expect(screen.queryAllByTitle(/Main image/i).length + screen.queryAllByLabelText(/Main image/i).length).toBe(0);
  });
  it("mainUrl undefined keeps the old rule (first tile); a given url marks exactly that tile", () => {
    const { unmount } = wrap(undefined);
    const first = screen.queryAllByTitle(/Main image/i).length + screen.queryAllByLabelText(/Main image/i).length;
    unmount();
    wrap("https://a/2.jpg");
    const second = screen.queryAllByTitle(/Main image/i).length + screen.queryAllByLabelText(/Main image/i).length;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  });
});

describe("the gold border in a variant gallery whose main image has no known url", () => {
  it("marks no tile (it used to mark the first one)", () => {
    const variant: any = { id: V1, title: "Red", sku: null, galleryFileGids: ["gid://shopify/MediaImage/2"], galleryOrderJson: null, externalVideoUrls: [], threeDModelUrls: [] };
    const props = {
      variant,
      fileUrlMap: { "gid://shopify/MediaImage/2": "https://a/2.jpg" },
      activeAction: null,
      selectedUrls: new Set<string>(),
      onSelect: () => {},
      onReorder: () => {},
      onDrop: () => {},
      onRemoveFromGallery: () => {},
      onGenerateAltFromSku: () => {},
      onUploadToGallery: () => {},
      forceOpen: true,
      skipDndContext: true,
      hasMainImage: true,
    };
    const count = (mainFileGid: string) => {
      const r = render(
        <AppProvider i18n={en}>
          <I18nProvider locale="en">
            <DndContext>
              <VariantGallerySection {...props} mainFileGid={mainFileGid} />
            </DndContext>
          </I18nProvider>
        </AppProvider>,
      );
      const n = screen.queryAllByTitle(/Main image/i).length + screen.queryAllByLabelText(/Main image/i).length;
      r.unmount();
      return n;
    };
    expect(count("gid://shopify/MediaImage/2")).toBeGreaterThan(0);
    expect(count("gid://shopify/MediaImage/999")).toBe(0);
  });
});

describe("second review: hook", () => {
  it("MEDIUM 3: media a failed save created are settling after the successful retry (the alt draft and tile survive)", async () => {
    const STAGED = "https://staged/y.jpg";
    let n = 0;
    answer = () =>
      ++n === 1
        ? { success: false, errors: ["x"], refusals: [], createdMedia: [{ resourceUrl: STAGED, mediaId: "gid://shopify/MediaImage/78", kind: "image" }] }
        : { success: true, createdMedia: [] };
    const { result } = renderHook(() => useVariantImageManager());
    act(() => result.current.handlePendingChange([], [], [{ resourceUrl: STAGED, kind: "image", previewUrl: "blob:y" }]));
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    expect(result.current.settlingMedia.map(m => m.mediaId)).toEqual(["gid://shopify/MediaImage/78"]);
  });

  it("LOW 6: the read-failed text does not claim uploaded images when nothing was uploaded; identical texts appear once", async () => {
    answer = () => ({ success: false, errors: ["x"], createdMedia: [], refusals: [{ variantId: V1, code: "lookupFailed" }, { variantId: "v2", code: "lookupFailed" }] });
    const a = renderHook(() => useVariantImageManager());
    let out: any;
    await act(async () => { out = await a.result.current.handleApply("p"); });
    expect(out.error).not.toMatch(/already uploaded/i);
    expect(out.error.match(/Nothing was uploaded/g)).toHaveLength(1);
    answer = () => ({ success: false, errors: ["x"], createdMedia: [{ resourceUrl: "s", mediaId: "gid://shopify/MediaImage/5", kind: "image" }], refusals: [{ variantId: V1, code: "lookupFailed" }] });
    const b = renderHook(() => useVariantImageManager());
    await act(async () => { out = await b.result.current.handleApply("p"); });
    expect(out.error).toMatch(/already uploaded/i);
  });
});

describe("fifth review: hook", () => {
  it("L-1: order file entries of a retried save are written by GID too", async () => {
    const STAGED = "https://staged/z.jpg";
    let n = 0;
    answer = () =>
      ++n === 1
        ? { success: false, errors: ["x"], refusals: [], createdMedia: [{ resourceUrl: STAGED, mediaId: "gid://shopify/MediaImage/79", kind: "image" }] }
        : { success: true, createdMedia: [] };
    const { result } = renderHook(() => useVariantImageManager());
    act(() => {
      result.current.handlePendingChange([{ variantId: V1, fileGids: [STAGED], galleryOnly: true }], [], [{ resourceUrl: STAGED, kind: "image" }]);
      result.current.setPendingGalleryOrder({ [V1]: JSON.stringify([{ kind: "file", value: STAGED }]) });
    });
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    expect(calls[1].variantGalleryOrder[0].orderJson).toContain("gid://shopify/MediaImage/79");
    expect(calls[1].variantGalleryOrder[0].orderJson).not.toContain(STAGED);
  });
});

describe("sixth review: hook", () => {
  it("M1: the retry names the media the failed attempt created", async () => {
    const STAGED = "https://staged/q.jpg";
    let n = 0;
    answer = () =>
      ++n === 1
        ? { success: false, errors: ["x"], refusals: [], createdMedia: [{ resourceUrl: STAGED, mediaId: "gid://shopify/MediaImage/80", kind: "image" }] }
        : { success: true, createdMedia: [] };
    const { result } = renderHook(() => useVariantImageManager());
    act(() => result.current.handlePendingChange([{ variantId: V1, fileGids: [STAGED], galleryOnly: true }], [], [{ resourceUrl: STAGED, kind: "image" }]));
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    expect(calls[0].retainedCreatedGids).toEqual([]);
    expect(calls[1].retainedCreatedGids).toEqual(["gid://shopify/MediaImage/80"]);
  });
});

describe("point 2: a main-image move", () => {
  const V2 = "gid://shopify/ProductVariant/2";
  const move = { gid: "gid://shopify/MediaImage/1", sourceVariantId: V1, sourceExpectedMainGid: "gid://shopify/MediaImage/1", targetVariantId: V2, targetExpectedMainGid: null, targetPosition: 0 };

  it("the save carries the move; a partner refusal is worded for the merchant and the failed save keeps the move pending", async () => {
    let n = 0;
    answer = () =>
      ++n === 1
        ? { success: false, errors: ["x"], refusals: [{ variantId: V1, code: "mainChangedElsewhere" }, { variantId: V2, code: "moveCounterpartRefused" }] }
        : { success: true, createdMedia: [] };
    const { result } = renderHook(() => useVariantImageManager());
    act(() => result.current.handlePendingChange([{ variantId: V2, fileGids: ["gid://shopify/MediaImage/1"], mainGid: "gid://shopify/MediaImage/1", expectedMainGid: null }], [], [], [{ variantId: V1, removedMainGid: "gid://shopify/MediaImage/1" }], [move]));
    let out: any;
    await act(async () => { out = await result.current.handleApply("gid://shopify/Product/1"); });
    expect(calls[0].mainMoves).toEqual([move]);
    expect(out.error).toContain("not moved");
    // the failed save keeps everything pending: the retry sends the same move
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    expect(calls[1].mainMoves).toEqual([move]);
  });

  it("Discard (resetForProduct) clears the move", async () => {
    answer = () => ({ success: true, createdMedia: [] });
    const { result } = renderHook(() => useVariantImageManager());
    act(() => result.current.handlePendingChange([], [], [], [], [move]));
    act(() => result.current.resetForProduct());
    await act(async () => { await result.current.handleApply("gid://shopify/Product/1"); });
    expect(calls[0].mainMoves).toEqual([]);
  });
});

describe("second review: a rejected move is worded", () => {
  it("errorCode mainMoveInvalid becomes the merchant's text, never the raw English errors", async () => {
    answer = () => ({ success: false, errors: ["mainMoves[0]: the target does not hold the moved image"], errorCode: "mainMoveInvalid" });
    const { result } = renderHook(() => useVariantImageManager());
    let out: any;
    await act(async () => { out = await result.current.handleApply("gid://shopify/Product/1"); });
    expect(out.error).toContain("could not be saved");
    expect(out.error).not.toContain("mainMoves[0]");
  });
});
