/**
 * The REAL VariantImageManager rendered with its real hooks, state and drag handler;
 * only the network (appFetch), the router fetcher, the DnD context (so a drag can be
 * fired as the event dnd-kit would deliver) and the grid (a prop probe) are replaced.
 * What is pinned is the wiring the pure tests cannot see: what the editor sends on
 * Save for each gesture (explicit intents only), what it shows, and what never happens
 * (opening a product, a product-gallery reorder, a replayed removal).
 *
 * MOCK-ONLY: the answers of /api/product-variants and the save route are scripted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act, fireEvent, screen } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { I18nProvider } from "~/contexts/I18nContext";
import { PlanProvider } from "~/contexts/PlanContext";
import { InfoBoxProvider, useInfoBox } from "~/contexts/InfoBoxContext";

const gid = (n: number) => `gid://shopify/MediaImage/${n}`;
const url = (n: number) => `https://cdn.shopify.com/s/files/${n}.jpg?v=1`;
const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";

// ── probes ───────────────────────────────────────────────────────────────────
const grids: Record<string, any> = {};
vi.mock("~/components/image-manager/SortableImageGrid", () => ({
  SortableImageGrid: (p: any) => {
    grids[p.containerId] = p;
    return <div data-testid={`grid-${p.containerId}`} />;
  },
}));
const picker: { onAdd?: (items: any[]) => void } = {};
vi.mock("~/components/image-manager/FilePickerModal", () => ({
  FilePickerModal: (p: any) => {
    picker.onAdd = p.onAdd;
    return null;
  },
}));
const dnd: { onDragEnd?: (e: any) => void } = {};
vi.mock("@dnd-kit/core", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    DndContext: (p: any) => {
      dnd.onDragEnd = p.onDragEnd;
      return <>{p.children}</>;
    },
  };
});
vi.mock("react-router", async (orig) => {
  const actual: any = await orig();
  return { ...actual, useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(), load: vi.fn(), Form: "form" }) };
});

let apiCalls: Array<{ path: string; body: any }>;
// When set, /api/product-variants answers only after this promise settles (a read in flight).
let variantsGate: Promise<void> | null = null;
// The next N variants reads are refused by the rate limiter (HTTP 429), then they answer normally.
let variantsRefuse = 0;
let variantsAnswer: () => any;
let saveAnswer: (path: string, body: any) => any;
vi.mock("~/utils/app-fetch", () => ({
  appFetch: vi.fn(async (input: string, init?: { body?: string }) => {
    const path = String(input).split("?")[0];
    const body = init?.body ? JSON.parse(init.body) : undefined;
    apiCalls.push({ path, body });
    if (path === "/api/product-variants" && variantsGate) await variantsGate;
    if (path === "/api/product-variants" && variantsRefuse > 0) {
      variantsRefuse--;
      return { ok: false, status: 429, json: async () => ({ error: "Many requests right now", rateLimited: true }) };
    }
    const payload = path === "/api/product-variants" ? variantsAnswer() : saveAnswer(path, body);
    return { ok: true, status: 200, json: async () => payload };
  }),
  appFetchJson: vi.fn(),
}));

let stagedGate: Promise<void> = Promise.resolve();
vi.mock("~/utils/staged-upload.client", () => ({ uploadToStagedTarget: vi.fn(async () => { await stagedGate; }) }));
import { VariantImageManager, VARIANTS_RETRY_DELAYS_MS, composeOnLanded } from "~/components/image-manager/VariantImageManager";
import { planVariantWrite, validateMainMoves, type MoveIntentView } from "~/services/variant-main-image.shared";

function variantsPayload(over: { v1Gallery?: string[]; v1Main?: number | null; v1Order?: string | null } = {}) {
  const mainN = over.v1Main === undefined ? 1 : over.v1Main;
  return {
    variants: [
      {
        shopifyGid: V1,
        title: "Red",
        sku: "r",
        position: 1,
        galleryJson: JSON.stringify(over.v1Gallery ?? [gid(2), gid(3)]),
        galleryOrderJson: over.v1Order ?? null,
        image: mainN ? { url: url(mainN) } : null,
        selectedOptions: [],
      },
      { shopifyGid: V2, title: "Blue", sku: "b", position: 2, galleryJson: "[]", image: { url: url(4) }, selectedOptions: [] },
    ],
    mediaMap: Object.fromEntries([1, 2, 3, 4].map((n) => [gid(n), url(n)])),
    mediaMetaMap: Object.fromEntries([1, 2, 3, 4].map((n) => [gid(n), { kind: "image", previewUrl: url(n) }])),
  };
}

const productImages = [1, 2, 3, 4].map((n) => ({ url: url(n), mediaId: gid(n), id: gid(n), altText: null }));
let onPendingChange: ReturnType<typeof vi.fn>;
let onDirtyChange: ReturnType<typeof vi.fn>;
let onGalleryOrderChange: ReturnType<typeof vi.fn>;

function InfoProbe() {
  const { infoBox } = useInfoBox();
  return <div data-testid="infobox">{infoBox?.message ?? ""}</div>;
}

function ui(extra: Record<string, unknown> = {}) {
  return (
    <AppProvider i18n={en}>
      <I18nProvider locale="en"><PlanProvider plan={"max" as any} newFeaturesEnabled><InfoBoxProvider>
        <InfoProbe />
        <VariantImageManager
          productId="gid://shopify/Product/1"
          productImages={productImages}
          bulkItems={[]}
          activeAction={null}
          selectedBulkIds={new Set()}
          onRemoveBulk={() => {}}
          onSetAction={() => {}}
          imageManagerSettings={{ firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 }}
          onPendingChange={onPendingChange as any}
          onDirtyChange={onDirtyChange as any}
          onGalleryOrderChange={onGalleryOrderChange as any}
          {...extra}
        />
      </InfoBoxProvider></PlanProvider></I18nProvider>
    </AppProvider>
  );
}
async function mount(extra: Record<string, unknown> = {}) {
  const r = render(ui(extra));
  // The manager starts as a product-image preview: "Show all" opens the full view with the variant galleries.
  fireEvent.click(await screen.findByText("Show all"));
  // The variant galleries start collapsed: open the first one like a merchant does.
  fireEvent.click(await screen.findByText("Red"));
  try {
    await waitFor(() => expect(grids[V1]?.imageUrls?.length).toBeGreaterThan(0));
  } catch (e) {
    console.log("DEBUG", Object.keys(grids), JSON.stringify(apiCalls), document.body.textContent?.slice(0, 600));
    throw e;
  }
  return r;
}
const drag = (container: string, from: string, to: string, ctrl = false) =>
  act(() => {
    if (ctrl) fireEvent.keyDown(window, { key: "Control" });
    dnd.onDragEnd?.({ active: { id: `${container}::${from}`, data: { current: { url: from, containerId: container } } }, over: { id: `${container}::${to}` } });
  });
const lastEmission = () => onPendingChange.mock.calls.at(-1) as any[];

beforeEach(() => {
  for (const k of Object.keys(grids)) delete grids[k];
  apiCalls = [];
  variantsGate = null;
  variantsRefuse = 0;
  onPendingChange = vi.fn();
  onDirtyChange = vi.fn();
  onGalleryOrderChange = vi.fn();
  variantsAnswer = () => variantsPayload();
  saveAnswer = () => ({ success: true, deletedMediaIds: [] });
});
afterEach(cleanup);

describe("opening a product", () => {
  it("writes and queues nothing: no pending state is emitted and nothing is posted", async () => {
    await mount();
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(apiCalls.filter((c) => c.body !== undefined)).toEqual([]); // reads only, no POST
    // The main image is shown once, first, with the border; nothing was inferred from the list.
    expect(grids[V1].imageUrls).toEqual([url(1), url(2), url(3)]);
    expect(grids[V1].mainUrl).toBe(url(1));
  });

  it("a legacy stored order [2,1,3] shows the main where the order puts it (no pinning) and opening still writes nothing", async () => {
    variantsAnswer = () =>
      variantsPayload({
        v1Gallery: [gid(2), gid(3)],
        v1Order: JSON.stringify([{ kind: "file", value: gid(2) }, { kind: "file", value: gid(1) }, { kind: "file", value: gid(3) }]),
      });
    await mount();
    expect(grids[V1].imageUrls).toEqual([url(2), url(1), url(3)]);
    expect(grids[V1].mainUrl).toBe(url(1));
    expect(onPendingChange).not.toHaveBeenCalled();
  });
});

describe("dragging an image to the first slot of the variant's own gallery", () => {
  it("makes it the main image (explicit intent with the expected old main), the old main stays in the gallery", async () => {
    await mount();
    drag(V1, url(3), url(1));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    expect(grids[V1].imageUrls[0]).toBe(url(3));
    const [galleries, , , removed] = lastEmission();
    expect(galleries).toEqual([{ variantId: V1, fileGids: [gid(3), gid(1), gid(2)], mainGid: gid(3), expectedMainGid: gid(1) }]);
    expect(removed).toEqual([]);
  });

  it("a drag that keeps the first slot chooses NO main image (plain galleryOnly)", async () => {
    await mount();
    drag(V1, url(3), url(2));
    await waitFor(() => expect(onPendingChange).toHaveBeenCalled());
    const [galleries] = lastEmission();
    // shown [1, 2, 3]; 3 dropped on 2 gives [1, 3, 2]: the first slot is unchanged, the main is not re-chosen
    expect(galleries).toEqual([{ variantId: V1, fileGids: [gid(3), gid(2)], galleryOnly: true, expectedMainGid: gid(1) }]);
    expect(grids[V1].mainUrl).toBe(url(1));
  });

  it("Discard (the reset key) takes the choice back: the old main is shown and the emission is cleared", async () => {
    const { rerender } = await mount();
    drag(V1, url(3), url(1));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    rerender(ui({ resetKey: 1 }));
    // A reset re-reads the variants IN PLACE: the open gallery stays open (round 3, point 2).
    await waitFor(() => expect(apiCalls.filter((c) => c.path === "/api/product-variants").length).toBeGreaterThan(1));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(1)));
    expect(grids[V1].imageUrls).toEqual([url(1), url(2), url(3)]);
    const [galleries, , , removed] = lastEmission();
    expect(galleries).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("a video or 3D model dragged to the first slot is refused with a visible message, the main is unchanged", async () => {
    variantsAnswer = () => ({
      ...variantsPayload(),
      variants: [{ ...variantsPayload().variants[0], externalVideosJson: JSON.stringify(["https://youtu.be/dQw4w9WgXcQ"]) }, variantsPayload().variants[1]],
    });
    await mount();
    const video = "https://youtu.be/dQw4w9WgXcQ";
    expect(grids[V1].imageUrls).toContain(video);
    drag(V1, video, url(1));
    await screen.findByText(/Only a saved image can be the main image/);
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(grids[V1].mainUrl).toBe(url(1));
  });

  it("the main dragged away from slot one hands it to the next IMAGE ([M,V,A] -> [A,V,M])", async () => {
    variantsAnswer = () => ({
      ...variantsPayload({ v1Gallery: [gid(2)] }),
      variants: [
        { ...variantsPayload({ v1Gallery: [gid(2)] }).variants[0], externalVideosJson: JSON.stringify(["https://youtu.be/dQw4w9WgXcQ"]) },
        variantsPayload().variants[1],
      ],
    });
    await mount();
    // shown: [1 (main), 2, video]; move the main to the end
    drag(V1, url(1), "https://youtu.be/dQw4w9WgXcQ");
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
    expect(grids[V1].imageUrls[0]).toBe(url(2));
  });
});

describe("a product-gallery reorder never changes a variant's main image", () => {
  it("the emission carries the same explicit intents as before (galleryOnly / pending main), nothing new", async () => {
    await mount();
    drag(V1, url(3), url(1)); // a pending choice exists
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    onPendingChange.mockClear();
    drag("product", url(4), url(1));
    await waitFor(() => expect(onPendingChange).toHaveBeenCalled());
    const [galleries, mediaOrder] = lastEmission();
    expect(mediaOrder.length).toBeGreaterThan(0);
    expect(galleries).toEqual([{ variantId: V1, fileGids: [gid(3), gid(1), gid(2)], mainGid: gid(3), expectedMainGid: gid(1) }]);
  });

  it("with no pending variant edit it emits no variant change at all", async () => {
    await mount();
    drag("product", url(4), url(1));
    await waitFor(() => expect(onPendingChange).toHaveBeenCalled());
    expect(lastEmission()[0]).toEqual([]);
  });
});

describe("B1: deleting a variant's main image while a gallery edit is pending", () => {
  async function deleteMainOfV1() {
    drag(V1, url(3), url(2)); // a pending gallery edit on V1
    await waitFor(() => expect(onPendingChange).toHaveBeenCalled());
    // select the main image's tile in the PRODUCT gallery, then Delete -> confirm
    act(() => grids.product.onSelect(url(1), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
  }

  beforeEach(() => {
    saveAnswer = (path, body) => (path === "/api/delete-product-images" ? { success: true, deletedMediaIds: body.mediaIds } : { success: true });
  });

  it("the delete answers, the removal names the deleted GID, and it never reaches a later save once the read has brought the promoted image", async () => {
    await mount();
    // the pending edit is [1,3,2]: the editor SHOWS image 3 as the promoted main (not the stored
    // gallery's first image, 2), and the server must promote the same one
    let afterDelete = false;
    variantsAnswer = () => (afterDelete ? variantsPayload({ v1Main: 3, v1Gallery: [gid(2)] }) : variantsPayload());
    const origSave = saveAnswer;
    saveAnswer = (p, b) => {
      if (p === "/api/update-variant-galleries") afterDelete = true;
      return origSave(p, b);
    };
    await deleteMainOfV1();
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    const clear = apiCalls.find((c) => c.path === "/api/update-variant-galleries")!;
    // H3: the removal travels WITH the pending list and order, so the server promotes what the editor shows
    expect(clear.body.removedMainImages).toEqual([]);
    expect(clear.body.variantGalleries).toEqual([{ variantId: V1, fileGids: [gid(3), gid(2)], removedMainGid: gid(1) }]);
    expect(clear.body.variantGalleryOrder).toEqual([
      { variantId: V1, orderJson: JSON.stringify([{ kind: "file", value: gid(3) }, { kind: "file", value: gid(2) }]) },
    ]);
    expect(clear.body.clearVariantMainImages).toBeUndefined();
    // the deleted file is gone from the pending order as well
    expect(JSON.stringify(onGalleryOrderChange.mock.calls.at(-1)?.[0])).not.toContain(gid(1));
    // once the read landed, the removal is over: the emission no longer replays it, and the main
    // image shown is the one the server promoted (3), not merely "something else than the deleted one"
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    await waitFor(() => {
      const [galleries, , , removed] = lastEmission();
      expect(removed).toEqual([]);
      expect(JSON.stringify(galleries)).not.toContain("removedMainGid");
    });
  });

  it("while the read has NOT landed (or fails) the deleted main is not shown as a gold tile and a save does not carry another removal", async () => {
    await mount();
    variantsAnswer = () => {
      throw new Error("read failed");
    };
    await deleteMainOfV1();
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    // the deleted image is gone from the shown gallery; the promoted one is shown as the main
    await waitFor(() => expect(grids[V1].imageUrls).not.toContain(url(1)));
    expect(grids[V1].mainUrl).not.toBe(url(1));
    // the pending edit carries the removal of exactly the GID that was deleted (a replay is a no-op on the server)
    const [galleries] = lastEmission();
    expect(galleries[0]).toMatchObject({ variantId: V1, removedMainGid: gid(1) });
    expect(JSON.stringify(galleries)).not.toContain(`"fileGids":["${gid(1)}"`);
  });

  it("a LATER read (any read) that shows the promoted image ends the removal: the next save does not remove it again", async () => {
    const { rerender } = await mount();
    variantsAnswer = () => {
      throw new Error("read failed"); // the read the delete asked for fails: the removal stays
    };
    await deleteMainOfV1();
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    expect(lastEmission()[0][0]).toMatchObject({ removedMainGid: gid(1) });
    // another read (a poll, a reload) lands with the promoted image as the native one
    variantsAnswer = () => variantsPayload({ v1Main: 2, v1Gallery: [gid(3)] });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(grids[V1]?.mainUrl).toBe(url(2)));
    await waitFor(() => expect(JSON.stringify(lastEmission()[0])).not.toContain("removedMainGid"));
    expect(lastEmission()[3]).toEqual([]);
  });
});

describe("H3: the delete keeps the merchant's explicit main choice", () => {
  it("a pending main choice (image 3) goes with the removal as mainGid and survives the delete", async () => {
    saveAnswer = (path, body) => (path === "/api/delete-product-images" ? { success: true, deletedMediaIds: body.mediaIds } : { success: true });
    await mount();
    drag(V1, url(3), url(1)); // 3 becomes the main (explicit), the old main 1 is second
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    act(() => grids.product.onSelect(url(1), true)); // delete the OLD main (still native)
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    const clear = apiCalls.find((c) => c.path === "/api/update-variant-galleries")!;
    expect(clear.body.variantGalleries[0]).toMatchObject({ variantId: V1, removedMainGid: gid(1), mainGid: gid(3) });
    expect(grids[V1].mainUrl).toBe(url(3)); // the choice was not dropped
  });
});

describe("handleVariantReorder takes the basis of a main choice from the EFFECTIVE pending choice", () => {
  it("after a read changed the main, a new first-slot drag is based on the fresh main", async () => {
    const { rerender } = await mount();
    drag(V1, url(3), url(1)); // pending choice 3, expected 1
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    variantsAnswer = () => variantsPayload({ v1Main: 4, v1Gallery: [gid(1), gid(2), gid(3)] }); // somebody set 4 meanwhile
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(grids[V1]?.mainUrl).toBe(url(4)));
    drag(V1, url(1), grids[V1].imageUrls[0]);
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(1)));
    const [galleries] = lastEmission();
    expect(galleries[0]).toMatchObject({ variantId: V1, mainGid: gid(1), expectedMainGid: gid(4) });
  });
});

describe("second review: delete with pending state", () => {
  beforeEach(() => {
    saveAnswer = (path, body) => (path === "/api/delete-product-images" ? { success: true, deletedMediaIds: body.mediaIds } : { success: true });
  });
  const confirmDelete = async (tileUrl: string) => {
    act(() => grids.product.onSelect(tileUrl, true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
  };
  const withVideo = (extra: Record<string, unknown> = {}) => () => {
    const base = variantsPayload();
    return { ...base, variants: [{ ...base.variants[0], externalVideosJson: JSON.stringify(["https://youtu.be/dQw4w9WgXcQ"]), ...extra }, base.variants[1]] };
  };
  const VIDEO = "https://youtu.be/dQw4w9WgXcQ";

  it("HIGH 1: a pending order [M, link, file] still starts with a file after M is deleted", async () => {
    variantsAnswer = withVideo();
    await mount();
    drag(V1, VIDEO, url(2)); // order becomes [1, link, 2, 3]
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    await confirmDelete(url(1));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/delete-product-images")).toBe(true));
    await waitFor(() => {
      const order = JSON.parse(onGalleryOrderChange.mock.calls.at(-1)![0][V1]);
      expect(order[0]).toEqual({ kind: "file", value: gid(2) });
      expect(JSON.stringify(order)).not.toContain(gid(1));
    });
  });

  it("MEDIUM 2: a pending main choice dies with its own medium (the save no longer carries a deleted file)", async () => {
    await mount();
    drag(V1, url(3), url(1)); // 3 chosen as main
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    await confirmDelete(url(3)); // delete the CHOSEN image (the native main 1 is untouched)
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/delete-product-images")).toBe(true));
    await waitFor(() => expect(JSON.stringify(lastEmission()[0])).not.toContain(gid(3)));
    expect(JSON.stringify(lastEmission()[0])).not.toContain("mainGid");
  });

  it("MEDIUM 4: an unsaved 3D model in the pending order does not reach the server through a delete", async () => {
    const MODEL = "https://cdn.shopify.com/m.glb";
    await mount({ resetKey: 1, seedThreeDModelUrls: { [V1]: [MODEL] }, seedThreeDPreviewUrls: { [V1]: [""] } });
    await waitFor(() => expect(grids[V1].imageUrls).toContain(MODEL));
    drag(V1, MODEL, url(2)); // the unsaved model is now inside the pending order
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    expect(onGalleryOrderChange.mock.calls.at(-1)![0][V1]).toContain(MODEL);
    await confirmDelete(url(1));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    const body = apiCalls.find((c) => c.path === "/api/update-variant-galleries")!.body;
    const sent = JSON.stringify(body.variantGalleryOrder);
    expect(sent).not.toContain(MODEL);
    expect(body.variantGalleryOrder[0] ? JSON.parse(body.variantGalleryOrder[0].orderJson)[0].kind : "file").toBe("file");
  });

  it("LOW 12: a successful drag does not clear an unrelated error", async () => {
    await mount();
    drag(V1, url(2), url(1)); // 2 becomes main: a plain successful drag
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
    // an unrelated error is shown (a delete that fails)
    saveAnswer = (path) => (path === "/api/delete-product-images" ? { success: false } : { success: true });
    act(() => grids.product.onSelect(url(4), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await screen.findByText(/could not be deleted/i);
    drag(V1, url(3), url(2));
    await waitFor(() => expect(grids[V1].imageUrls[0]).toBe(url(3)));
    expect(screen.queryByText(/could not be deleted/i)).not.toBeNull();
  });
});

describe("third review: renders", () => {
  const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
  const withVideoAndOrder = (orderEntries: Array<[string, string]>) => () => {
    const base = variantsPayload({ v1Order: JSON.stringify(orderEntries.map(([kind, value]) => ({ kind, value }))) });
    return { ...base, variants: [{ ...base.variants[0], externalVideosJson: JSON.stringify([VIDEO]) }, base.variants[1]] };
  };
  const clickRemove = async () => fireEvent.click(await screen.findByRole("button", { name: /^Remove \(\d+\)$/ }));

  it("M1: a main choice made right after deleting the main is based on the promoted image and survives the next read", async () => {
    saveAnswer = (path, body) => (path === "/api/delete-product-images" ? { success: true, deletedMediaIds: body.mediaIds } : { success: true });
    const { rerender } = await mount();
    variantsAnswer = () => {
      throw new Error("read failed");
    };
    act(() => grids.product.onSelect(url(1), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2))); // the promoted image is shown
    drag(V1, url(3), grids[V1].imageUrls[0]);
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    expect(lastEmission()[0][0]).toMatchObject({ variantId: V1, removedMainGid: gid(1), mainGid: gid(3) });
    // a later read shows the promoted image as the native one: the choice is still pending, based on it
    variantsAnswer = () => variantsPayload({ v1Main: 2, v1Gallery: [gid(3)] });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(lastEmission()[0][0]).toMatchObject({ variantId: V1, mainGid: gid(3), expectedMainGid: gid(2) }));
  });

  it("M3: a library image the product does not hold is referenced through its clone (the asset url), never the original", async () => {
    await mount();
    act(() => grids[V1].onOpenPicker());
    act(() =>
      picker.onAdd!([{ source: "library", gid: "gid://shopify/MediaImage/55", kind: "image", previewUrl: "https://p/55.jpg", assetUrl: "https://a/55.jpg", alt: null }]),
    );
    await waitFor(() => expect(onPendingChange).toHaveBeenCalled());
    const [galleries, , productNew] = lastEmission();
    expect(JSON.stringify(galleries)).toContain("https://a/55.jpg");
    expect(JSON.stringify(galleries)).not.toContain("MediaImage/55");
    expect(productNew.map((m: any) => m.resourceUrl)).toContain("https://a/55.jpg");
  });

  it("M4: removing a stored link also takes it out of the order (the embed renders order entries live)", async () => {
    variantsAnswer = withVideoAndOrder([["file", gid(1)], ["url", VIDEO], ["file", gid(2)], ["file", gid(3)]]);
    await mount();
    act(() => grids[V1].onSelect(VIDEO, true));
    await clickRemove();
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    const sent = JSON.parse(onGalleryOrderChange.mock.calls.at(-1)![0][V1]);
    expect(JSON.stringify(sent)).not.toContain(VIDEO);
    expect(sent[0].kind).toBe("file");
  });

  it("L4: removing a chosen main hands the first slot to the next image in the visible order", async () => {
    await mount();
    drag(V1, url(3), url(1)); // choice 3, order [3,1,2]
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    drag(V1, url(2), url(1)); // [3,2,1]: the first slot is unchanged
    await waitFor(() => expect(grids[V1].imageUrls).toEqual([url(3), url(2), url(1)]));
    act(() => grids[V1].onSelect(url(3), true));
    await clickRemove();
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
    expect(lastEmission()[0][0]).toMatchObject({ variantId: V1, mainGid: gid(2), expectedMainGid: gid(1) });
  });

  it("L5: dragging back to the stored order leaves nothing pending (Save is not lit for a no-op)", async () => {
    await mount();
    drag(V1, url(3), url(2)); // [1,3,2]
    await waitFor(() => expect(lastEmission()[0]).toHaveLength(1));
    drag(V1, url(2), url(3)); // back to [1,2,3]
    await waitFor(() => expect(lastEmission()[0]).toEqual([]));
    expect(onGalleryOrderChange.mock.calls.at(-1)![0][V1]).toBeUndefined();
  });
});

describe("fourth review: one tile -> reference resolver", () => {
  const CLONE_ASSET = "https://a/55.jpg";
  const CLONE_PREVIEW = "https://p/55.jpg";
  const pickClone = async () => {
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([{ source: "library", gid: "gid://shopify/MediaImage/55", kind: "image", previewUrl: CLONE_PREVIEW, assetUrl: CLONE_ASSET, alt: null }]));
    await waitFor(() => expect(grids[V1].imageUrls).toContain(CLONE_PREVIEW));
  };

  it("HIGH 1: a library clone tile reordered stays a FILE entry (its asset url), never a link", async () => {
    await mount();
    await pickClone();
    drag(V1, CLONE_PREVIEW, url(2));
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    const order = JSON.parse(onGalleryOrderChange.mock.calls.at(-1)![0][V1]);
    expect(order.some((e: any) => e.kind === "url")).toBe(false);
    expect(order).toContainEqual({ kind: "file", value: CLONE_ASSET });
    const [galleries] = lastEmission();
    expect(galleries[0].fileGids).toContain(CLONE_ASSET);
    expect(JSON.stringify(galleries)).not.toContain(CLONE_PREVIEW);
  });

  it("MEDIUM: an upload's blob preview never reaches the lists after a reorder (its staged url does)", async () => {
    await mount();
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([{ source: "upload", resourceUrl: "https://staged/x.jpg", kind: "image", previewUrl: "blob:http://localhost/x" }]));
    await waitFor(() => expect(grids[V1].imageUrls).toContain("blob:http://localhost/x"));
    drag(V1, "blob:http://localhost/x", url(2));
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    expect(JSON.stringify(lastEmission()[0])).not.toContain("blob:");
    expect(JSON.stringify(onGalleryOrderChange.mock.calls.at(-1)![0])).not.toContain("blob:");
    expect(lastEmission()[0][0].fileGids).toContain("https://staged/x.jpg");
  });

  it("LOW: a clone tile copied to another variant (Ctrl) keeps its reference", async () => {
    await mount();
    await pickClone();
    act(() => {
      fireEvent.keyDown(window, { key: "Control" });
      dnd.onDragEnd?.({ active: { id: `${V1}::${CLONE_PREVIEW}`, data: { current: { url: CLONE_PREVIEW, containerId: V1 } } }, over: { id: `${V2}::${url(4)}` } });
    });
    await waitFor(() => expect(JSON.stringify(lastEmission()[0])).toContain(V2));
    const v2 = lastEmission()[0].find((g: any) => g.variantId === V2);
    expect(v2.fileGids).toContain(CLONE_ASSET);
  });

  it("HIGH 2: the editor's REAL emission after delete-then-choose is accepted by the route's rules", async () => {
    saveAnswer = (path, body) => (path === "/api/delete-product-images" ? { success: true, deletedMediaIds: body.mediaIds } : { success: true });
    await mount();
    variantsAnswer = () => { throw new Error("read failed"); };
    act(() => grids.product.onSelect(url(1), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
    drag(V1, url(3), grids[V1].imageUrls[0]);
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    const em = lastEmission()[0][0];
    const ord = onGalleryOrderChange.mock.calls.at(-1)?.[0]?.[V1] ?? null;
    expect(em.expectedMainGid).toBe(gid(2)); // the displayed promoted image is the basis
    const plan = planVariantWrite({
      fileGids: em.fileGids, removedMainGid: em.removedMainGid, mainGid: em.mainGid, expectedMainGid: em.expectedMainGid ?? null,
      lookup: { main: gid(2), gallery: [gid(3)], order: null }, clientOrderJson: ord,
      productMedia: new Map([2, 3, 4].map((n) => [gid(n), "IMAGE"])),
    });
    expect(plan).toMatchObject({ action: "write", mediaId: gid(3) });
  });

  it("MEDIUM: a removed link stays off even when no file entry is left in the stored order (the order is cleared)", async () => {
    const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
    variantsAnswer = () => {
      const base = variantsPayload({ v1Order: JSON.stringify([{ kind: "url", value: VIDEO }]) });
      return { ...base, variants: [{ ...base.variants[0], externalVideosJson: JSON.stringify([VIDEO]) }, base.variants[1]] };
    };
    await mount();
    act(() => grids[V1].onSelect(VIDEO, true));
    fireEvent.click(await screen.findByRole("button", { name: /^Remove \(\d+\)$/ }));
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    expect(onGalleryOrderChange.mock.calls.at(-1)![0][V1]).toBe("");
  });

  it("LOW: dragging back to the stored state also clears links / models that equal the stored ones", async () => {
    const MODEL = "https://cdn.shopify.com/m.glb";
    variantsAnswer = () => {
      const base = variantsPayload();
      return { ...base, variants: [{ ...base.variants[0], threeDModelsJson: JSON.stringify([MODEL]), threeDPreviewsJson: JSON.stringify([""]) }, base.variants[1]] };
    };
    const onThreeD = vi.fn();
    await mount({ resetKey: 1, seedThreeDModelUrls: { [V1]: [MODEL] }, seedThreeDPreviewUrls: { [V1]: [""] }, onThreeDModelsChange: onThreeD });
    drag(V1, url(3), url(2));
    await waitFor(() => expect(lastEmission()[0]).toHaveLength(1));
    drag(V1, url(2), url(3));
    await waitFor(() => expect(lastEmission()[0]).toEqual([]));
    expect(onThreeD).toHaveBeenCalledWith({});
  });
});

describe("fifth review: renders", () => {
  const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
  it("H-1: a variant with no native image shows the first own image as the main one once it has a pending gallery (an upload included)", async () => {
    variantsAnswer = () => variantsPayload({ v1Main: null, v1Gallery: [] });
    render(ui());
    fireEvent.click(await screen.findByText("Show all"));
    fireEvent.click(await screen.findByText("Red"));
    await waitFor(() => expect(grids[V1]).toBeDefined());
    expect(grids[V1].mainUrl).toBeNull(); // opening promotes nothing
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([{ source: "upload", resourceUrl: "https://staged/x.jpg", kind: "image", previewUrl: "blob:http://localhost/x" }]));
    await waitFor(() => expect(grids[V1].mainUrl).toBe("blob:http://localhost/x"));
    expect(lastEmission()[0][0]).toMatchObject({ variantId: V1, promoteIfEmpty: true });
  });

  it("M-1: deleting every image of a variant whose remaining order holds only a link keeps a links-only order", async () => {
    saveAnswer = (path, body) => (path === "/api/delete-product-images" ? { success: true, deletedMediaIds: body.mediaIds } : { success: true });
    variantsAnswer = () => {
      const base = variantsPayload({ v1Gallery: [gid(2)], v1Order: JSON.stringify([{ kind: "file", value: gid(1) }, { kind: "url", value: VIDEO }, { kind: "file", value: gid(2) }]) });
      return { ...base, variants: [{ ...base.variants[0], externalVideosJson: JSON.stringify([VIDEO]) }, base.variants[1]] };
    };
    await mount();
    drag(V1, url(2), VIDEO); // a pending order exists: [1, 2, link] or similar
    await waitFor(() => expect(onGalleryOrderChange).toHaveBeenCalled());
    act(() => { grids.product.onSelect(url(1), true); grids.product.onSelect(url(2), true); });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await waitFor(() => expect(JSON.parse(onGalleryOrderChange.mock.calls.at(-1)![0][V1] || "null")).toEqual([{ kind: "url", value: VIDEO }]));
  });

  it("M-2: a pending 3D model of the product gallery cannot be dropped into a variant gallery as a file (translated message)", async () => {
    await mount();
    act(() => grids.product.onOpenPicker());
    act(() => picker.onAdd!([{ source: "upload", resourceUrl: "https://staged/m.glb", kind: "model", previewUrl: "blob:http://localhost/m", persistentPreviewUrl: "" }]));
    await waitFor(() => expect(grids.product.imageUrls).toContain("blob:http://localhost/m"));
    onPendingChange.mockClear();
    act(() => {
      dnd.onDragEnd?.({ active: { id: "product::blob:http://localhost/m", data: { current: { url: "blob:http://localhost/m", containerId: "product" } } }, over: { id: `${V1}::${url(2)}` } });
    });
    await screen.findByText(/cannot be dragged into a variant's image gallery/);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("L-3: dragging back to the stored state keeps pending 3D previews that differ from the stored ones", async () => {
    const MODEL = "https://cdn.shopify.com/m.glb";
    variantsAnswer = () => {
      const base = variantsPayload();
      return { ...base, variants: [{ ...base.variants[0], threeDModelsJson: JSON.stringify([MODEL]), threeDPreviewsJson: JSON.stringify([""]) }, base.variants[1]] };
    };
    const onPrev = vi.fn();
    await mount({ resetKey: 1, seedThreeDModelUrls: { [V1]: [MODEL] }, seedThreeDPreviewUrls: { [V1]: ["https://p/new.jpg"] }, onThreeDPreviewsChange: onPrev });
    drag(V1, url(3), url(2));
    await waitFor(() => expect(lastEmission()[0]).toHaveLength(1));
    drag(V1, url(2), url(3));
    await waitFor(() => expect(lastEmission()[0]).toEqual([]));
    expect(onPrev).not.toHaveBeenCalledWith({});
  });
});

describe("sixth review: renders", () => {
  it("L3: an empty variant's display skips a reference without a visible file and shows the first visible image", async () => {
    variantsAnswer = () => variantsPayload({ v1Main: null, v1Gallery: [gid(99), gid(2)] }); // 99 has no url anywhere
    render(ui());
    fireEvent.click(await screen.findByText("Show all"));
    fireEvent.click(await screen.findByText("Red"));
    await waitFor(() => expect(grids[V1]).toBeDefined());
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([{ source: "upload", resourceUrl: "https://staged/x.jpg", kind: "image", previewUrl: "blob:http://localhost/x" }]));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
  });
});

describe("point 2: a variant's MAIN image dragged onto another variant (plain = move, Ctrl/Cmd = copy)", () => {
  const twoGalleries = () => {
    const b = variantsPayload();
    b.variants[1] = { ...b.variants[1], galleryJson: JSON.stringify([gid(2)]) };
    return b;
  };
  const dragTo = (from: { container: string; url: string }, to: { container: string; url: string }, ctrl = false) =>
    act(() => {
      if (ctrl) fireEvent.keyDown(window, { key: "Control" });
      dnd.onDragEnd?.({
        active: { id: `${from.container}::${from.url}`, data: { current: { url: from.url, containerId: from.container } } },
        over: { id: `${to.container}::${to.url}` },
      });
      if (ctrl) fireEvent.keyUp(window, { key: "Control" });
    });
  async function mountBoth(extra: Record<string, unknown> = {}) {
    variantsAnswer = twoGalleries;
    const r = await mount(extra);
    fireEvent.click(await screen.findByText("Blue"));
    await waitFor(() => expect(grids[V2]?.imageUrls?.length).toBeGreaterThan(0));
    expect(grids[V2].imageUrls).toEqual([url(4), url(2)]);
    return r;
  }

  it("a plain drag onto a LATER slot MOVES it: one explicit intent names both variants, the source shows its next image as main, the target keeps its main", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
    expect(grids[V1].imageUrls).toEqual([url(2), url(3)]);
    expect(grids[V2].mainUrl).toBe(url(4));
    expect(grids[V2].imageUrls).toEqual([url(4), url(1), url(2)]);
    const [galleries, , , removed, moves] = lastEmission();
    expect(removed).toEqual([{ variantId: V1, removedMainGid: gid(1) }]);
    expect(galleries).toEqual([{ variantId: V2, fileGids: [gid(1), gid(2)], galleryOnly: true, expectedMainGid: gid(4) }]);
    expect(moves).toEqual([{ gid: gid(1), sourceVariantId: V1, sourceExpectedMainGid: gid(1), targetVariantId: V2, targetExpectedMainGid: gid(4), targetPosition: 1 }]);
    // the order the target saves places the moved image exactly where it was dropped
    expect(JSON.parse(onGalleryOrderChange.mock.calls.at(-1)![0][V2]).map((e: any) => e.value)).toEqual([gid(4), gid(1), gid(2)]);
  });

  it("a plain drag onto the FIRST slot makes it the target's main image and the target's old main goes into its gallery", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(4) });
    await waitFor(() => expect(grids[V2].mainUrl).toBe(url(1)));
    expect(grids[V2].imageUrls).toEqual([url(1), url(4), url(2)]);
    expect(grids[V1].mainUrl).toBe(url(2));
    const [galleries, , , removed, moves] = lastEmission();
    expect(removed).toEqual([{ variantId: V1, removedMainGid: gid(1) }]);
    expect(galleries).toEqual([{ variantId: V2, fileGids: [gid(1), gid(4), gid(2)], mainGid: gid(1), expectedMainGid: gid(4) }]);
    expect(moves).toEqual([expect.objectContaining({ gid: gid(1), targetVariantId: V2, targetExpectedMainGid: gid(4), targetPosition: 0 })]);
  });

  it("Ctrl/Cmd COPIES: the source keeps its main image, nothing is removed, no move is declared", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) }, true);
    await waitFor(() => expect(grids[V2].imageUrls).toContain(url(1)));
    expect(grids[V1].mainUrl).toBe(url(1));
    expect(grids[V1].imageUrls).toEqual([url(1), url(2), url(3)]);
    const [galleries, , , removed, moves] = lastEmission();
    expect(removed).toEqual([]);
    expect(moves).toEqual([]);
    expect(galleries.map((g: any) => g.variantId)).toEqual([V2]);
    expect(galleries[0].fileGids).toContain(gid(1));
  });

  it("a gallery image (not the main) still moves on a plain drag and is no main-image move", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(3) }, { container: V2, url: url(2) });
    await waitFor(() => expect(grids[V1].imageUrls).toEqual([url(1), url(2)]));
    const [galleries, , , removed, moves] = lastEmission();
    expect(removed).toEqual([]);
    expect(moves).toEqual([]);
    expect(galleries.map((g: any) => g.variantId).sort()).toEqual([V1, V2]);
  });

  it("Discard (the reset key) takes the whole move back: both galleries show what is stored and the emission is empty", async () => {
    const { rerender } = await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(4) });
    await waitFor(() => expect(grids[V2].mainUrl).toBe(url(1)));
    rerender(ui({ resetKey: 1 }));
    await waitFor(() => expect(apiCalls.filter((c) => c.path === "/api/product-variants").length).toBeGreaterThan(1));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(1)));
    const [galleries, , , removed, moves] = lastEmission();
    expect(galleries).toEqual([]);
    expect(removed).toEqual([]);
    expect(moves).toEqual([]);
  });

  it("a target with its own unsaved main-image change refuses the move with a message and changes nothing", async () => {
    await mountBoth();
    // the target's own main image is removed (Ctrl-drop onto the product gallery): an unsaved main-image change
    dragTo({ container: V2, url: url(4) }, { container: "product", url: url(1) }, true);
    await waitFor(() => expect(lastEmission()[3]).toEqual([{ variantId: V2, removedMainGid: gid(4) }]));
    onPendingChange.mockClear();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await screen.findByText(/Save the pending main image changes of these variants first/);
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(grids[V1].mainUrl).toBe(url(1));
  });

  it("taking the moved image out of the target again (Ctrl-drop onto the product gallery) is refused while the move is pending", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await waitFor(() => expect(lastEmission()[4]).toHaveLength(1));
    onPendingChange.mockClear();
    dragTo({ container: V2, url: url(1) }, { container: "product", url: url(3) }, true);
    await screen.findByText(/Save the pending main image changes of these variants first/);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("the editor's REAL emission of a move (slot one and a later slot) is accepted by the route's validation", async () => {
    for (const overUrl of [url(4), url(2)]) {
      for (const k of Object.keys(grids)) delete grids[k];
      onPendingChange.mockClear();
      const { unmount } = await mountBoth();
      dragTo({ container: V1, url: url(1) }, { container: V2, url: overUrl });
      await waitFor(() => expect(lastEmission()[4]).toHaveLength(1));
      const [galleries, , , removed, moves] = lastEmission();
      const intents = new Map<string, MoveIntentView>();
      for (const g of galleries) intents.set(g.variantId, { fileGids: g.fileGids, removedMainGid: g.removedMainGid ?? null, mainGid: g.mainGid ?? null });
      for (const r of removed) intents.set(r.variantId, { fileGids: null, removedMainGid: r.removedMainGid, mainGid: null });
      expect(validateMainMoves(moves, intents)).toEqual([]);
      unmount();
      cleanup();
    }
  });

  it("H1: dragging the moved image BACK to the source takes the move back: the image is on the source again and on no other variant only by choice", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(2)));
    dragTo({ container: V2, url: url(1) }, { container: V1, url: url(2) });
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(1)));
    expect(grids[V2].imageUrls).not.toContain(url(1));
    const [galleries, , , removed, moves] = lastEmission();
    expect(removed).toEqual([]);
    expect(moves).toEqual([]);
    expect(JSON.stringify(galleries)).not.toContain("removedMainGid");
  });

  it("M1: a variant that is part of a pending move (as target) cannot start another move of ITS main image: save first", async () => {
    await mountBoth();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await waitFor(() => expect(lastEmission()[4]).toHaveLength(1));
    onPendingChange.mockClear();
    dragTo({ container: V2, url: url(4) }, { container: V1, url: url(2) });
    await screen.findByText(/Save the pending main image changes of these variants first/);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("L6: a target whose own main image cannot be named is refused (never guessed at)", async () => {
    variantsAnswer = () => {
      const b = variantsPayload();
      b.variants[1] = { ...b.variants[1], image: { url: "https://cdn.shopify.com/s/files/99.jpg?v=1" } };
      return b;
    };
    await mount();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await screen.findByText(/This main image cannot be identified right now/);
    expect(grids[V1].mainUrl).toBe(url(1));
  });

  it("M1: a chained move (the target of one move is the SOURCE of the next) is refused with save first, so validateMainMoves never sees a variant twice", async () => {
    const V3 = "gid://shopify/ProductVariant/3";
    variantsAnswer = () => {
      const b = variantsPayload();
      b.variants[1] = { ...b.variants[1], galleryJson: JSON.stringify([gid(2)]) };
      b.variants.push({ shopifyGid: V3, title: "Green", sku: "g", position: 3, galleryJson: "[]", image: { url: url(3) }, selectedOptions: [] } as any);
      return b;
    };
    await mount();
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await waitFor(() => expect(lastEmission()[4]).toHaveLength(1));
    onPendingChange.mockClear();
    dragTo({ container: V2, url: url(4) }, { container: V3, url: url(3) });
    await screen.findByText(/Save the pending main image changes of these variants first/);
    expect(onPendingChange).not.toHaveBeenCalled();
  });
});

describe("pending move: ONE guard refuses every gesture that would contradict it", () => {
  const dragTo = (from: { container: string; url: string }, to: { container: string; url: string }, ctrl = false) =>
    act(() => {
      if (ctrl) fireEvent.keyDown(window, { key: "Control" });
      dnd.onDragEnd?.({
        active: { id: `${from.container}::${from.url}`, data: { current: { url: from.url, containerId: from.container } } },
        over: { id: `${to.container}::${to.url}` },
      });
      if (ctrl) fireEvent.keyUp(window, { key: "Control" });
    });
  const SAVE_FIRST = /Save the pending main image changes of these variants first/;
  async function moved() {
    const V3 = "gid://shopify/ProductVariant/3";
    variantsAnswer = () => {
      const b = variantsPayload();
      b.variants[1] = { ...b.variants[1], galleryJson: JSON.stringify([gid(2)]) };
      b.variants.push({ shopifyGid: V3, title: "Green", sku: "g", position: 3, galleryJson: "[]", image: { url: url(3) }, selectedOptions: [] } as any);
      return b;
    };
    await mount();
    fireEvent.click(await screen.findByText("Blue"));
    await waitFor(() => expect(grids[V2]?.imageUrls?.length).toBeGreaterThan(0));
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(2) });
    await waitFor(() => expect(lastEmission()[4]).toHaveLength(1));
    onPendingChange.mockClear();
    return V3;
  }

  it("(1) another image of the SOURCE dragged to its slot one", async () => {
    await moved();
    dragTo({ container: V1, url: url(3) }, { container: V1, url: url(2) });
    await screen.findByText(SAVE_FIRST);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("(2) an image dragged to the TARGET's slot one", async () => {
    await moved();
    dragTo({ container: V2, url: url(2) }, { container: V2, url: url(4) });
    await screen.findByText(SAVE_FIRST);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("(3) removing the target's old main image", async () => {
    await moved();
    act(() => grids[V2].onSelect(url(4), true));
    fireEvent.click(await screen.findByRole("button", { name: /^Remove \(\d+\)$/ }));
    await screen.findByText(SAVE_FIRST);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("(3b) deleting the target's old main image from the product gallery is refused before anything is sent", async () => {
    await moved();
    apiCalls.length = 0;
    act(() => grids.product.onSelect(url(4), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await screen.findByText(SAVE_FIRST);
    expect(apiCalls.some((c) => c.path === "/api/delete-product-images")).toBe(false);
  });

  it("M-b: the moved image dragged ONWARD to a third variant is refused", async () => {
    await moved();
    dragTo({ container: V2, url: url(1) }, { container: "gid://shopify/ProductVariant/3", url: url(3) });
    await screen.findByText(SAVE_FIRST);
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("move BACK leaves no pending write behind (the source gallery is as stored again)", async () => {
    await moved();
    dragTo({ container: V2, url: url(1) }, { container: V1, url: url(2) });
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(1)));
    await waitFor(() => expect(lastEmission()[0]).toEqual([]));
    expect(lastEmission()[3]).toEqual([]);
    expect(lastEmission()[4]).toEqual([]);
  });
});

describe("round 3, point 1: a medium the target variant already has is refused BEFORE any state change", () => {
  const dragTo = (from: { container: string; url: string }, to: { container: string; url: string }, ctrl = false) =>
    act(() => {
      if (ctrl) fireEvent.keyDown(window, { key: "Control" });
      dnd.onDragEnd?.({
        active: { id: `${from.container}::${from.url}`, data: { current: { url: from.url, containerId: from.container } } },
        over: { id: `${to.container}::${to.url}` },
      });
      if (ctrl) fireEvent.keyUp(window, { key: "Control" });
    });
  async function mountWith(v2: { gallery: number[]; main: number }, extraMedia: Record<string, string> = {}) {
    variantsAnswer = () => {
      const b: any = variantsPayload();
      b.variants[1] = { ...b.variants[1], galleryJson: JSON.stringify(v2.gallery.map(gid)), image: { url: url(v2.main) } };
      Object.assign(b.mediaMap, extraMedia);
      for (const k of Object.keys(extraMedia)) b.mediaMetaMap[k] = { kind: "image", previewUrl: extraMedia[k] };
      return b;
    };
    const r = await mount();
    fireEvent.click(await screen.findByText("Blue"));
    await waitFor(() => expect(grids[V2]?.imageUrls?.length).toBeGreaterThan(0));
    return r;
  }
  const untouched = (callsBefore: number) => {
    expect(onPendingChange.mock.calls.length).toBe(callsBefore);
    expect(grids[V1].imageUrls).toEqual([url(1), url(2), url(3)]);
    expect(screen.getByTestId("infobox").textContent).toContain("Blue");
    expect(screen.getByTestId("infobox").textContent).toContain("already has this image");
  };

  it("a gallery image moved to a variant that has it in its gallery stays on the source, nothing is pending", async () => {
    await mountWith({ gallery: [2], main: 4 });
    const before = onPendingChange.mock.calls.length;
    dragTo({ container: V1, url: url(2) }, { container: V2, url: url(4) });
    untouched(before);
    expect(grids[V2].imageUrls).toEqual([url(4), url(2)]);
  });

  it("a gallery image moved to a variant whose MAIN image it is is refused", async () => {
    await mountWith({ gallery: [], main: 3 });
    const before = onPendingChange.mock.calls.length;
    dragTo({ container: V1, url: url(3) }, { container: V2, url: url(3) });
    untouched(before);
    expect(grids[V2].mainUrl).toBe(url(3));
  });

  it("a MAIN image moved to a variant that has it in its gallery is refused", async () => {
    await mountWith({ gallery: [1], main: 4 });
    const before = onPendingChange.mock.calls.length;
    dragTo({ container: V1, url: url(1) }, { container: V2, url: url(4) });
    expect(onPendingChange.mock.calls.length).toBe(before);
    expect(grids[V1].mainUrl).toBe(url(1));
    expect(screen.getByTestId("infobox").textContent).toContain("Blue");
  });

  it("a Ctrl/Cmd copy of an image the target has is refused with the message too", async () => {
    await mountWith({ gallery: [2], main: 4 });
    const before = onPendingChange.mock.calls.length;
    dragTo({ container: V1, url: url(2) }, { container: V2, url: url(4) }, true);
    untouched(before);
  });

  it("the SAME FILE under another GID (a library file of a product medium) counts as held", async () => {
    // gid 5 is a library file whose address is image 2's: V2 holds it, V1 drags medium 2
    await mountWith({ gallery: [5], main: 4 }, { [gid(5)]: "https://cdn.shopify.com/s/files/2.jpg?v=9" });
    const before = onPendingChange.mock.calls.length;
    dragTo({ container: V1, url: url(2) }, { container: V2, url: url(4) });
    untouched(before);
  });

  it("product gallery -> variant that already shows the image (its main): refused, nothing pending", async () => {
    await mountWith({ gallery: [2], main: 4 });
    onPendingChange.mockClear();
    dragTo({ container: "product", url: url(1) }, { container: V1, url: url(2) });
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("infobox").textContent).toContain("Red");
  });

  it("a medium the target does NOT hold still moves (regression)", async () => {
    await mountWith({ gallery: [], main: 4 });
    dragTo({ container: V1, url: url(3) }, { container: V2, url: url(4) });
    await waitFor(() => expect(grids[V1].imageUrls).toEqual([url(1), url(2)]));
    expect(grids[V2].imageUrls).toContain(url(3));
  });
});

describe("round 3, point 2: open variant galleries stay open through the post-save re-read", () => {
  const variantReads = () => apiCalls.filter((c) => c.path === "/api/product-variants").length;

  it("a save cycle (reset key bump + variant reload) keeps the same gallery element mounted, also while the read is in flight", async () => {
    const { rerender } = await mount();
    const gridBefore = await screen.findByTestId(`grid-${V1}`);
    const readsBefore = variantReads();

    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ resetKey: 1, variantReloadKey: 1 }));
    await waitFor(() => expect(variantReads()).toBeGreaterThan(readsBefore));
    // the read is still out: the gallery has not been swapped for a spinner
    expect(screen.getByTestId(`grid-${V1}`)).toBe(gridBefore);
    expect(screen.getByText("Red")).toBeTruthy();

    await act(async () => { release(); variantsGate = null; });
    await waitFor(() => expect(variantReads()).toBeGreaterThan(readsBefore));
    expect(screen.getByTestId(`grid-${V1}`)).toBe(gridBefore);
  });

  it("the filter toggle (all / unassigned) stays through the re-read and keeps its mode", async () => {
    const { rerender } = await mount();
    fireEvent.click(await screen.findByText("Unassigned"));
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ resetKey: 1 }));
    expect(screen.getByText("Unassigned")).toBeTruthy();
    await act(async () => { release(); variantsGate = null; });
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect((screen.getByText("Unassigned") as HTMLElement).style.fontWeight || (screen.getByText("Unassigned").closest("button") as HTMLElement).style.fontWeight).toBe("700");
  });

  it("a DIFFERENT product still starts from the loading state (the old product's galleries are not shown)", async () => {
    const { rerender } = await mount();
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ productId: "gid://shopify/Product/2" }));
    await waitFor(() => expect(screen.queryByTestId(`grid-${V1}`)).toBeNull());
    await act(async () => { release(); variantsGate = null; });
  });
});

describe("round 3, point 3: the manager is a switch between a product-image preview and a full view", () => {
  const view = () => document.querySelector("[data-im-view]") as HTMLElement;
  const hidden = (el: Element | null) => {
    for (let n = el as HTMLElement | null; n; n = n.parentElement) if (n.style?.display === "none") return true;
    return false;
  };

  it("starts as a preview: only the product images and \"Show all\", no variant galleries, no controls", async () => {
    render(ui());
    await screen.findByText("Show all");
    expect(view().dataset.imView).toBe("preview");
    expect(hidden(await screen.findByText("Red"))).toBe(true);
    expect(hidden(await screen.findByTestId("grid-product"))).toBe(false);
    expect(screen.queryByText("Back to the product")).toBeNull();
    // the product preview is clipped to one row and not operable
    const clip = screen.getByTestId("grid-product").parentElement!.parentElement as HTMLElement;
    expect(clip.style.maxHeight).toBe("104px");
  });

  it("\"Show all\" opens the full view: variant galleries and controls are shown, the product row is unclipped", async () => {
    render(ui());
    fireEvent.click(await screen.findByText("Show all"));
    expect(view().dataset.imView).toBe("full");
    expect(hidden(screen.getByText("Red"))).toBe(false);
    expect(screen.getByText("Back to the product")).toBeTruthy();
    const clip = screen.getByTestId("grid-product").parentElement!.parentElement as HTMLElement;
    expect(clip.style.maxHeight).toBe("");
    // no inner scroller any more
    expect(view().querySelector("[style*='max-height: 320']")).toBeNull();
  });

  it("closing returns to the preview, the scroll position before opening and focus on the opener; opening scrolls to the top and focuses the close button", async () => {
    const r = render(<div className="field-editor-area">{ui()}</div>);
    const scroller = r.container.querySelector(".field-editor-area") as HTMLElement;
    scroller.scrollTop = 420;
    fireEvent.click(await screen.findByText("Show all"));
    expect(scroller.scrollTop).toBe(0);
    expect(document.activeElement?.textContent).toBe("Back to the product");
    scroller.scrollTop = 900;
    fireEvent.click(screen.getByText("Back to the product"));
    expect(view().dataset.imView).toBe("preview");
    expect(scroller.scrollTop).toBe(420);
    expect(document.activeElement?.textContent).toBe("Show all");
  });

  it("closing is not Discard: a pending gallery change and its emission survive the switch both ways", async () => {
    await mount();
    drag(V1, url(3), url(1));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
    const emissions = onPendingChange.mock.calls.length;
    fireEvent.click(screen.getByText("Back to the product"));
    expect(view().dataset.imView).toBe("preview");
    expect(grids[V1].mainUrl).toBe(url(3));
    fireEvent.click(screen.getByText("Show all"));
    expect(grids[V1].mainUrl).toBe(url(3));
    expect(lastEmission()[0]).toEqual([expect.objectContaining({ variantId: V1, mainGid: gid(3) })]);
    expect(onPendingChange.mock.calls.length).toBeGreaterThanOrEqual(emissions);
  });

  it("a save cycle (re-read in flight) while switching views changes neither view nor the open galleries", async () => {
    const { rerender } = await mount();
    const gridBefore = screen.getByTestId(`grid-${V1}`);
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ resetKey: 1, variantReloadKey: 1 }));
    fireEvent.click(screen.getByText("Back to the product"));
    expect(view().dataset.imView).toBe("preview");
    await act(async () => { release(); variantsGate = null; });
    expect(view().dataset.imView).toBe("preview");
    fireEvent.click(screen.getByText("Show all"));
    expect(screen.getByTestId(`grid-${V1}`)).toBe(gridBefore);
  });

  it("switching to another product keeps the full view (it loads the new product's variants)", async () => {
    const { rerender } = await mount();
    rerender(ui({ productId: "gid://shopify/Product/2" }));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/product-variants")).toBe(true));
    expect(view().dataset.imView).toBe("full");
    expect(screen.getByText("Back to the product")).toBeTruthy();
  });

  it("an owner that holds the state drives the view (the editor hides its text fields from it)", async () => {
    const onFullViewChange = vi.fn();
    const { rerender } = render(ui({ fullView: false, onFullViewChange }));
    fireEvent.click(await screen.findByText("Show all"));
    expect(onFullViewChange).toHaveBeenCalledWith(true);
    // not owned by the manager now: nothing switched until the owner says so
    expect(view().dataset.imView).toBe("preview");
    rerender(ui({ fullView: true, onFullViewChange }));
    expect(view().dataset.imView).toBe("full");
    fireEvent.click(screen.getByText("Back to the product"));
    expect(onFullViewChange).toHaveBeenLastCalledWith(false);
  });
});

describe("round 3, point 4: a variants read refused by the rate limiter (429)", () => {
  const variantReads = () => apiCalls.filter((c) => c.path === "/api/product-variants").length;
  const realDelays = [...VARIANTS_RETRY_DELAYS_MS];
  afterEach(() => { VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length, ...realDelays); });

  it("the galleries come back by themselves, without leaving the product", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length, 20, 20, 20);
    variantsRefuse = 2;
    render(ui());
    fireEvent.click(await screen.findByText("Show all"));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    // nothing of the variants is shown or editable meanwhile
    expect(grids[V1]).toBeUndefined();
    await waitFor(() => expect(grids.product).toBeDefined());
    fireEvent.click(await screen.findByText("Red", {}, { timeout: 3000 }));
    await waitFor(() => expect(grids[V1]?.imageUrls?.length).toBeGreaterThan(0));
    expect(variantReads()).toBe(3);
    expect(screen.queryByText("Could not load variants.")).toBeNull();
  });

  it("when the automatic tries are used up the banner offers \"Try again\" and that brings them back", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    variantsRefuse = 1;
    render(ui());
    fireEvent.click(await screen.findByText("Show all"));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByText("Red"));
    await waitFor(() => expect(grids[V1]?.imageUrls?.length).toBeGreaterThan(0));
  });

  it("while the variants are unknown the Delete control is disabled with the reason", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    variantsRefuse = 5;
    render(ui());
    fireEvent.click(await screen.findByText("Show all"));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    await waitFor(() => expect(grids.product).toBeDefined());
    act(() => grids.product.onSelect(url(1), true));
    const del = await screen.findByRole("button", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(apiCalls.some((c) => c.path === "/api/delete-product-images")).toBe(false);
  });

  it("a delete whose confirmation was already open is still refused when the variants became unknown meanwhile", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    const { rerender } = await mount();
    act(() => grids.product.onSelect(url(1), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    variantsRefuse = 5;
    rerender(ui({ variantReloadKey: 1 }));
    // the reload is non-silent and fails: the banner replaces the list, the confirmation is still open
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    expect(apiCalls.some((c) => c.path === "/api/delete-product-images")).toBe(false);
    expect(screen.getByText(/variants of this product are not loaded/)).toBeTruthy();
  });

  it("a refused RE-READ of an already loaded product retries by itself and brings the galleries back", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length, 20, 20, 20);
    const { rerender } = await mount();
    const before = variantReads();
    variantsRefuse = 1;
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("Could not load variants.")).toBeNull(), { timeout: 3000 });
    expect(variantReads()).toBe(before + 2);
  });

  it("a refused re-read of a loaded product keeps the open galleries mounted with the banner above them", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    const { rerender } = await mount();
    const gridBefore = screen.getByTestId(`grid-${V1}`);
    variantsRefuse = 1;
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    expect(screen.getByTestId(`grid-${V1}`)).toBe(gridBefore);
    const list = document.querySelector("[data-variants-list]") as HTMLElement;
    expect(list.getAttribute("aria-busy")).toBe("true");
    // nothing locks the whole list any more (text stays editable)
    expect(list.style.pointerEvents).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Could not load variants.")).toBeNull());
    expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy") === "true").toBe(false);
    expect(screen.getByTestId(`grid-${V1}`)).toBe(gridBefore);
  });

  const NOT_LOADED = /variants of this product are not loaded right now/;
  const dragToV1 = () => act(() => {
    dnd.onDragEnd?.({ active: { id: `product::${url(4)}`, data: { current: { url: url(4), containerId: "product" } } }, over: { id: `${V1}::${url(2)}` } });
  });

  it("HIGH: a product -> variant drag while the re-read FAILED changes nothing pending and says why", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    const { rerender } = await mount();
    variantsRefuse = 1;
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    onPendingChange.mockClear();
    dragToV1();
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(screen.getByText(NOT_LOADED)).toBeTruthy();
    // once the read lands the same drag works
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Could not load variants.")).toBeNull());
    dragToV1();
    await waitFor(() => expect(lastEmission()[0][0].fileGids).toContain(gid(4)));
  });

  it("HIGH: a re-read IN FLIGHT refuses the drag too (stale list), and the gallery drop is disabled", async () => {
    const { rerender } = await mount();
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy") === "true").toBe(true));
    onPendingChange.mockClear();
    dragToV1();
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(screen.getByText(NOT_LOADED)).toBeTruthy();
    await act(async () => { release(); variantsGate = null; });
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy") === "true").toBe(false));
  });

  it("MEDIUM: the manager reports not-current to the page while a re-read is in flight or failed, current when it landed", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    const cur = vi.fn();
    const { rerender } = await mount({ onVariantsCurrentChange: cur });
    expect(cur).toHaveBeenLastCalledWith(true);
    variantsRefuse = 1;
    rerender(ui({ onVariantsCurrentChange: cur, variantReloadKey: 1 }));
    await waitFor(() => expect(cur).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cur).toHaveBeenLastCalledWith(true));
  });

  it("HIGH: a library pick through the still-open picker is refused while the variants are not current", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    const { rerender } = await mount();
    act(() => grids[V1].onOpenPicker());
    variantsRefuse = 1;
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    onPendingChange.mockClear();
    act(() => picker.onAdd!([{ source: "library", kind: "image", alt: null, gid: gid(4), previewUrl: url(4), assetUrl: url(4) }]));
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(screen.getByText(NOT_LOADED)).toBeTruthy();
  });

  it("L1: unmounting the manager while the variants are not current resets the page's flag", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length);
    const cur = vi.fn();
    const { rerender, unmount } = await mount({ onVariantsCurrentChange: cur });
    variantsRefuse = 1;
    rerender(ui({ onVariantsCurrentChange: cur, variantReloadKey: 1 }));
    await waitFor(() => expect(cur).toHaveBeenLastCalledWith(false));
    unmount();
    expect(cur).toHaveBeenLastCalledWith(true);
  });

  it("H1: a silent settling poll never supersedes an in-flight re-read: the list stays NOT current until that read lands", async () => {
    const cur = vi.fn();
    const { rerender } = await mount({ onVariantsCurrentChange: cur, settlingMedia: [{ productId: "gid://shopify/Product/1", mediaId: gid(99), kind: "image" }] });
    const readsBefore = variantReads();
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ onVariantsCurrentChange: cur, variantReloadKey: 1, settlingMedia: [{ productId: "gid://shopify/Product/1", mediaId: gid(99), kind: "image" }] }));
    await waitFor(() => expect(cur).toHaveBeenLastCalledWith(false));
    // the poll tick (about 1.5 s) would refuse (429) -- but it must not even run while R1 is out
    variantsRefuse = 1;
    await new Promise((r) => setTimeout(r, 2200));
    expect(variantReads()).toBe(readsBefore + 1);
    expect(cur).toHaveBeenLastCalledWith(false);
    expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy") === "true").toBe(true);
    await act(async () => { release(); variantsGate = null; });
    await waitFor(() => expect(cur).toHaveBeenLastCalledWith(true));
    // the parked poll ran after R1 (not lost): one more read than R1 alone, well before the next poll tick
    await waitFor(() => expect(variantReads()).toBeGreaterThanOrEqual(readsBefore + 2), { timeout: 900 });
  }, 12000);

  it("post-delete: a parked silent read (with its landing callback) runs after the in-flight re-read and ends the removal", async () => {
    let n = 0;
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((r) => { releaseUpdate = r; });
    saveAnswer = (path, body) => {
      if (path === "/api/delete-product-images") return { success: true, deletedMediaIds: body.mediaIds };
      if (path === "/api/update-variant-galleries") return updateGate.then(() => ({ success: true }));
      return { success: true };
    };
    // read 1 = mount, read 2 = the held re-read (still the pre-delete data), read 3 = the parked post-delete read
    variantsAnswer = () => (++n >= 3 ? variantsPayload({ v1Main: 3, v1Gallery: [gid(2)] }) : variantsPayload());
    const { rerender } = await mount();
    act(() => grids.product.onSelect(url(1), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    await waitFor(() => expect(apiCalls.some((c) => c.path === "/api/update-variant-galleries")).toBe(true));
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy")).toBe("true"));
    // the delete's own silent read is parked behind the re-read
    await act(async () => { releaseUpdate(); });
    const before = apiCalls.filter((c) => c.path === "/api/product-variants").length;
    await act(async () => { release(); variantsGate = null; });
    await waitFor(() => expect(apiCalls.filter((c) => c.path === "/api/product-variants").length).toBeGreaterThan(before));
    await waitFor(() => expect(grids[V1].mainUrl).toBe(url(3)));
  });

  it("L1: parked reads hand their landing callbacks on (both run, in order; one alone is kept)", () => {
    const order: string[] = [];
    composeOnLanded(() => order.push("a"), () => order.push("b"))!();
    expect(order).toEqual(["a", "b"]);
    const only = () => order.push("c");
    expect(composeOnLanded(undefined, only)).toBe(only);
    expect(composeOnLanded(only, undefined)).toBe(only);
    expect(composeOnLanded()).toBeUndefined();
  });

  it("L2: skipped AND failed uploads are both said", async () => {
    let call = 0;
    saveAnswer = (path) => {
      if (path !== "/api/staged-upload") return { success: true };
      call++;
      return call === 1 ? { error: "nope" } : { url: "https://staged/up", resourceUrl: "https://staged/new.jpg", parameters: [], httpMethod: "PUT" };
    };
    const { rerender } = await mount();
    let releaseUpload!: () => void;
    stagedGate = new Promise<void>((r) => { releaseUpload = r; });
    let uploading!: Promise<void>;
    act(() => { uploading = grids[V1].onUploadToGallery([new File(["x"], "bad.jpg", { type: "image/jpeg" }), new File(["x"], "late.jpg", { type: "image/jpeg" })]); });
    let releaseRead!: () => void;
    variantsGate = new Promise<void>((r) => { releaseRead = r; });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy")).toBe("true"));
    await act(async () => { releaseUpload(); stagedGate = Promise.resolve(); await uploading; });
    expect(screen.getByText(/Not added: late\.jpg/)).toBeTruthy();
    expect(screen.getByText(/Upload failed for: bad\.jpg/)).toBeTruthy();
    await act(async () => { releaseRead(); variantsGate = null; });
  });

  it("M3: typing in a variant alt input during a re-read keeps the element, focus and value", async () => {
    const { rerender } = await mount();
    act(() => grids[V1].onSelect(url(2), true));
    const input = (await screen.findAllByRole("textbox"))[0] as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Typed alt" } });
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy")).toBe("true"));
    const after = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    expect(after).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Typed alt");
    fireEvent.change(input, { target: { value: "Typed alt more" } });
    expect(input.value).toBe("Typed alt more");
    await act(async () => { release(); variantsGate = null; });
  });

  it("M2: an upload that finishes while the variants are being re-read is NOT appended to the stale list, and the file is named", async () => {
    saveAnswer = (path) => (path === "/api/staged-upload" ? { url: "https://staged/up", resourceUrl: "https://staged/new.jpg", parameters: [], httpMethod: "PUT" } : { success: true });
    const { rerender } = await mount();
    let releaseUpload!: () => void;
    stagedGate = new Promise<void>((r) => { releaseUpload = r; });
    let uploading!: Promise<void>;
    act(() => { uploading = grids[V1].onUploadToGallery([new File(["x"], "pic.jpg", { type: "image/jpeg" })]); });
    let releaseRead!: () => void;
    variantsGate = new Promise<void>((r) => { releaseRead = r; });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy")).toBe("true"));
    onPendingChange.mockClear();
    await act(async () => { releaseUpload(); stagedGate = Promise.resolve(); await uploading; });
    expect(onPendingChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Not added: pic\.jpg/)).toBeTruthy();
    await act(async () => { releaseRead(); variantsGate = null; });
  });

  it("M1: the delete control is disabled while a re-read is IN FLIGHT, and a confirmation already open is refused", async () => {
    const { rerender } = await mount();
    act(() => grids.product.onSelect(url(1), true));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    let release!: () => void;
    variantsGate = new Promise<void>((r) => { release = r; });
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect((document.querySelector("[data-variants-list]") as HTMLElement).getAttribute("aria-busy") === "true").toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, delete now" }));
    expect(apiCalls.some((c) => c.path === "/api/delete-product-images")).toBe(false);
    expect(screen.getByText(/variants of this product are not loaded/)).toBeTruthy();
    await act(async () => { release(); variantsGate = null; });
  });

  it("a silent settling poll that itself fails does not cancel the scheduled retry", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length, 2500);
    variantsRefuse = 2; // the first read and the first (silent) poll are refused
    render(ui({ settlingMedia: [{ productId: "gid://shopify/Product/1", mediaId: gid(99), kind: "image" }] }));
    fireEvent.click(await screen.findByText("Show all"));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    await waitFor(() => expect(variantReads()).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // the retry scheduled by the first failure still fires and brings the variants back
    // (the next poll would only come at about 4.5 s: the banner going away earlier is the retry)
    await waitFor(() => expect(screen.queryByText("Could not load variants.")).toBeNull(), { timeout: 1800 });
  }, 12000);

  it("a silent settling poll that lands ends the error banner and leaves no stale retry", async () => {
    VARIANTS_RETRY_DELAYS_MS.splice(0, VARIANTS_RETRY_DELAYS_MS.length, 60000);
    variantsRefuse = 1;
    render(ui({ settlingMedia: [{ productId: "gid://shopify/Product/1", mediaId: gid(99), kind: "image" }] }));
    fireEvent.click(await screen.findByText("Show all"));
    await waitFor(() => expect(screen.getByText("Could not load variants.")).toBeTruthy());
    // the first settling poll (about 1.5 s) is silent and answers normally
    await waitFor(() => expect(screen.queryByText("Could not load variants.")).toBeNull(), { timeout: 4000 });
    fireEvent.click(await screen.findByText("Red"));
    await waitFor(() => expect(grids[V1]?.imageUrls?.length).toBeGreaterThan(0));
  });
});

describe("round 3 review fix: the gallery selection survives a save cycle of the same product", () => {
  it("a reset + re-read keeps a selected tile (and the selection bar), a product switch clears it", async () => {
    const { rerender } = await mount();
    act(() => grids.product.onSelect(url(2), true));
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(true));
    rerender(ui({ resetKey: 1, variantReloadKey: 1 }));
    await waitFor(() => expect(apiCalls.filter((c) => c.path === "/api/product-variants").length).toBeGreaterThan(1));
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(true));
    // a medium that no longer exists is dropped from the selection
    variantsAnswer = () => {
      const b: any = variantsPayload();
      delete b.mediaMap[gid(2)];
      delete b.mediaMetaMap[gid(2)];
      return b;
    };
    rerender(ui({ resetKey: 2, variantReloadKey: 2 }));
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(false));
  });

  it("M2: Discard clears the selection (also after a Ctrl copy) and the parent hears about it", async () => {
    const altDraftApiRef: any = { current: null };
    const onSel = vi.fn();
    await mount({ altDraftApiRef, onGallerySelectionGidsChange: onSel, activeAction: "copy" });
    act(() => grids.product.onSelect(url(2), true));
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(true));
    await waitFor(() => expect(onSel).toHaveBeenLastCalledWith([gid(2)]));
    // a copy to V2 keeps the selection (the action stays on)
    act(() => grids[V2]?.onDropToPlaceholder?.());
    expect(grids.product.selectedUrls.has(url(2))).toBe(true);
    act(() => altDraftApiRef.current.discard());
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(false));
    await waitFor(() => expect(onSel).toHaveBeenLastCalledWith([]));
  });

  it("M2: a re-read keeps a selected 3D url, drops a non-CDN key no gallery shows any more", async () => {
    const MODEL = "https://cdn.shopify.com/m.glb";
    variantsAnswer = () => {
      const base = variantsPayload();
      return { ...base, variants: [{ ...base.variants[0], threeDModelsJson: JSON.stringify([MODEL]), threeDPreviewsJson: JSON.stringify([""]) }, base.variants[1]] };
    };
    const { rerender } = await mount();
    act(() => grids[V1].onSelect(MODEL, true));
    act(() => grids.product.onSelect("blob:http://localhost/gone", true));
    await waitFor(() => expect(grids[V1].selectedUrls.has(MODEL)).toBe(true));
    rerender(ui({ resetKey: 1, variantReloadKey: 1 }));
    await waitFor(() => expect(apiCalls.filter((c) => c.path === "/api/product-variants").length).toBeGreaterThan(1));
    await waitFor(() => expect(grids.product.selectedUrls.has("blob:http://localhost/gone")).toBe(false));
    expect(grids[V1].selectedUrls.has(MODEL)).toBe(true);
  });

  it("M2: a library-pick tile (not product media) stays selected through a re-read while its gallery shows it", async () => {
    const { rerender } = await mount();
    const before = new Set<string>(grids[V1].imageUrls);
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([{ source: "library", kind: "image", alt: null, gid: "gid://shopify/MediaImage/77", previewUrl: "https://cdn.shopify.com/s/files/lib77.jpg", assetUrl: "https://cdn.shopify.com/s/files/lib77.jpg" }]));
    await waitFor(() => expect(grids[V1].imageUrls.some((u: string) => !before.has(u))).toBe(true));
    const tile = grids[V1].imageUrls.find((u: string) => !before.has(u));
    act(() => grids[V1].onSelect(tile, true));
    await waitFor(() => expect(grids[V1].selectedUrls.has(tile)).toBe(true));
    rerender(ui({ variantReloadKey: 1 }));
    await waitFor(() => expect(apiCalls.filter((c) => c.path === "/api/product-variants").length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(grids[V1].selectedUrls.has(tile)).toBe(true);
  });

  it("switching to another product clears the selection", async () => {
    const { rerender } = await mount();
    act(() => grids.product.onSelect(url(2), true));
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(true));
    rerender(ui({ productId: "gid://shopify/Product/2", resetKey: 1 }));
    await waitFor(() => expect(grids.product.selectedUrls.has(url(2))).toBe(false));
  });
});

describe("round 3 review fix: library picks and the selection drop refuse a medium the variant already has", () => {
  const MSG = "already has:";
  const pick = (item: Record<string, unknown>) => {
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([{ source: "library", kind: "image", alt: null, ...item }]));
  };

  it("a library pick of an image in the variant's gallery or its main image changes nothing and says why", async () => {
    await mount();
    const before = onPendingChange.mock.calls.length;
    pick({ gid: gid(2), previewUrl: url(2), assetUrl: url(2) });
    expect(screen.getByTestId("infobox").textContent).toContain(MSG);
    pick({ gid: gid(1), previewUrl: url(1), assetUrl: url(1) });
    expect(onPendingChange.mock.calls.length).toBe(before);
  });

  it("a batch with a held image and a new one adds the new one and names only the refused one", async () => {
    await mount();
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([
      { source: "library", kind: "image", alt: "Held one", gid: gid(2), previewUrl: url(2), assetUrl: url(2) },
      { source: "library", kind: "image", alt: "Fresh one", gid: gid(4), previewUrl: url(4), assetUrl: url(4) },
    ]));
    const msg = screen.getByTestId("infobox").textContent ?? "";
    expect(msg).toContain("Held one");
    expect(msg).not.toContain("Fresh one");
    await waitFor(() => expect(lastEmission()[0][0].fileGids).toContain(gid(4)));
  });

  it("a same-file-other-GID item next to a fresh one: the held one is NOT added, the fresh one is", async () => {
    variantsAnswer = () => {
      const b: any = variantsPayload();
      b.mediaMap[gid(55)] = "https://cdn.shopify.com/s/files/2.jpg?v=9";
      b.mediaMetaMap[gid(55)] = { kind: "image", previewUrl: "https://cdn.shopify.com/s/files/2.jpg?v=9" };
      return b;
    };
    await mount();
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([
      { source: "library", kind: "image", alt: "Twin", gid: gid(55), previewUrl: url(2), assetUrl: "https://cdn.shopify.com/s/files/2.jpg?v=9" },
      { source: "library", kind: "image", alt: "Fresh", gid: gid(4), previewUrl: url(4), assetUrl: url(4) },
    ]));
    await waitFor(() => expect(lastEmission()[0][0].fileGids).toContain(gid(4)));
    expect(lastEmission()[0][0].fileGids).not.toContain(gid(55));
    expect(screen.getByTestId("infobox").textContent).toContain("Twin");
  });

  it("L3: picking the same library file (not on the product yet) a second time is recognised as held", async () => {
    await mount();
    const item = { source: "library", kind: "image", alt: "Lib", gid: "gid://shopify/MediaImage/77", previewUrl: "https://cdn.shopify.com/s/files/lib77.jpg", assetUrl: "https://cdn.shopify.com/s/files/lib77.jpg" };
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([item]));
    expect(screen.getByTestId("infobox").textContent).toBe("");
    act(() => grids[V1].onOpenPicker());
    act(() => picker.onAdd!([item]));
    expect(screen.getByTestId("infobox").textContent).toContain("Lib");
  });

  it("the same file under another GID is recognised; a different medium is still added", async () => {
    variantsAnswer = () => {
      const b: any = variantsPayload();
      b.mediaMap[gid(55)] = "https://cdn.shopify.com/s/files/2.jpg?v=9";
      b.mediaMetaMap[gid(55)] = { kind: "image", previewUrl: "https://cdn.shopify.com/s/files/2.jpg?v=9" };
      return b;
    };
    await mount();
    const before = onPendingChange.mock.calls.length;
    pick({ gid: gid(55), previewUrl: url(2), assetUrl: "https://cdn.shopify.com/s/files/2.jpg?v=9" });
    expect(onPendingChange.mock.calls.length).toBe(before);
    pick({ gid: gid(4), previewUrl: url(4), assetUrl: url(4) });
    await waitFor(() => expect(lastEmission()[0][0].fileGids).toContain(gid(4)));
  });

  it("the selection drop (move) of an image the target already has is refused whole, the source keeps it", async () => {
    variantsAnswer = () => {
      const b: any = variantsPayload();
      b.variants[1] = { ...b.variants[1], galleryJson: JSON.stringify([gid(2)]) };
      return b;
    };
    const r = render(ui({ activeAction: "move" }));
    fireEvent.click(await screen.findByText("Show all"));
    fireEvent.click(await screen.findByText("Red"));
    fireEvent.click(await screen.findByText("Blue"));
    await waitFor(() => expect(grids[V2]?.imageUrls?.length).toBeGreaterThan(0));
    act(() => grids[V1].onSelect(url(2), true));
    const before = onPendingChange.mock.calls.length;
    expect(typeof grids[V2].onDropToPlaceholder).toBe("function");
    act(() => grids[V2].onDropToPlaceholder());
    expect(screen.getByTestId("infobox").textContent).toContain("Blue");
    expect(onPendingChange.mock.calls.length).toBe(before);
    expect(grids[V1].imageUrls).toEqual([url(1), url(2), url(3)]);
    r.unmount();
  });

  it("L3: a refused drop (target holds the image) shows ONLY that message, not also the 3D/video one", async () => {
    variantsAnswer = () => {
      const b: any = variantsPayload();
      b.variants[1] = { ...b.variants[1], galleryJson: JSON.stringify([gid(2)]) };
      return b;
    };
    const r = render(ui({ activeAction: "copy" }));
    fireEvent.click(await screen.findByText("Show all"));
    fireEvent.click(await screen.findByText("Red"));
    fireEvent.click(await screen.findByText("Blue"));
    await waitFor(() => expect(grids[V2]?.imageUrls?.length).toBeGreaterThan(0));
    act(() => grids.product.onOpenPicker());
    act(() => picker.onAdd!([{ source: "upload", resourceUrl: "https://staged/m.glb", kind: "model", previewUrl: "blob:http://localhost/m", persistentPreviewUrl: "" }]));
    await waitFor(() => expect(grids.product.imageUrls).toContain("blob:http://localhost/m"));
    act(() => grids.product.onSelect("blob:http://localhost/m", true));
    act(() => grids.product.onSelect(url(2), true));
    act(() => grids[V2].onDropToPlaceholder());
    const msg = screen.getByTestId("infobox").textContent ?? "";
    expect(msg).toContain("Blue");
    expect(screen.queryByText(/cannot be dragged into a variant's image gallery/)).toBeNull();
    r.unmount();
  });
});
