/**
 * A foreign alt text of an image WITHOUT a main-language alt text.
 *
 * Owner report (2026-10-02, collections, foreign language): the alt text of
 * the collection image could not be saved and the save bar stayed open for
 * good, with no message. Shopify offers an image's `alt` for translation only
 * when it has a primary value (`translatableContent` lists only keys with a
 * primary value), so there is no digest and nothing can be registered. The
 * save answered `failedAltTextIndices: [0]`, the editor kept the text as a
 * draft (the rule for every failed alt), and no retry could ever store it.
 *
 * Two halves are pinned here:
 *  - the field: in a foreign language it is locked, with the reason, while
 *    the image has no main-language alt, so no such draft can be made;
 *  - the backstop: a save answered "not stored, no main-language alt" says so
 *    by name and does not leave the save bar standing over it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { ImageGalleryField } from "~/components/unified/ImageGalleryField";
import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { COLLECTIONS_CONFIG } from "~/config/content-fields.config";

const HINT = "Enter a main-language alt text first";

function gallery(featuredAlt: string, isPrimaryLocale: boolean) {
  return (
    <AppProvider i18n={en}>
      <ImageGalleryField
        images={[]}
        featuredImage={{ url: "https://cdn.shopify.com/c.jpg", altText: featuredAlt, altTextTranslations: [] }}
        currentLanguage={isPrimaryLocale ? "de" : "fr"}
        primaryLocale="de"
        isPrimaryLocale={isPrimaryLocale}
        altTexts={{}}
        onAltTextChange={vi.fn()}
        onGenerateAltText={vi.fn()}
        onTranslateAltText={vi.fn()}
        onAcceptSuggestion={vi.fn()}
        onRejectSuggestion={vi.fn()}
        t={{ altTextForImage: "Bild-Beschreibung", altNeedsPrimaryHint: HINT }}
      />
    </AppProvider>
  );
}

describe("the foreign alt field of an image with no main-language alt", () => {
  it("is locked, and says why", () => {
    render(gallery("", false));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it("is editable once the image has a main-language alt", () => {
    render(gallery("Ein Bild", false));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("is editable in the main language, where the alt is written", () => {
    render(gallery("", true));
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false);
  });
});

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function mountCollection() {
  const id = "gid://shopify/Collection/1";
  const item = {
    id,
    title: "Sommer",
    handle: "sommer",
    descriptionHtml: "",
    seo: { title: "", description: "" },
    translations: [{ key: "title", locale: "fr", value: "Été" }],
    images: [],
    featuredImage: { url: "https://cdn.shopify.com/c.jpg", altText: "", altTextTranslations: [] },
  };
  const posts: Array<Record<string, string>> = [];
  let answer: (body: Record<string, unknown>) => void = () => {};
  const showInfoBox = vi.fn();
  const editor: { current: any } = { current: null };
  function Page() {
    const { items } = useLoaderData() as { items: unknown[] };
    const fetcher = useFetcher();
    editor.current = useUnifiedContentEditor({
      config: COLLECTIONS_CONFIG,
      items,
      shopLocales: [
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
      ],
      primaryLocale: "de",
      fetcher,
      showInfoBox,
      t: { content: { altTextNeedsPrimary: "NEEDS PRIMARY {failedImages}" } },
      initialItemId: id,
    } as any);
    return null;
  }
  const router = createMemoryRouter([
    {
      path: "/",
      element: <Page />,
      loader: async () => ({ items: [item] }),
      action: async ({ request }) => {
        posts.push(Object.fromEntries((await request.formData()) as any) as Record<string, string>);
        return new Promise((resolve) => { answer = resolve; });
      },
    },
  ]);
  render(<RouterProvider router={router} />);
  return { editor, posts, showInfoBox, respond: (body: Record<string, unknown>) => act(async () => { answer(body); }) };
}

describe("a foreign alt save refused for want of a main-language alt", () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

  it("names the reason and does not leave the save bar standing", async () => {
    const h = mountCollection();
    await tick(50);
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("fr"); });
    await tick(50);

    // A draft made some other way (an older page, a copy): the backstop.
    await act(async () => { h.editor.current.handlers.handleAltTextChange(0, "Une image"); });
    expect(h.editor.current.state.hasChanges).toBe(true);
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].imageAltTexts).toBe(JSON.stringify({ 0: "Une image" }));

    // What the server answers (shopify-content.service): stored nothing, and why.
    await h.respond({
      success: true,
      actionType: "updateContent",
      failedAltTextIndices: [0],
      altTextNoPrimaryIndices: [0],
    });
    await tick(50);

    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("NEEDS PRIMARY 1"), "warning");
    expect(h.editor.current.state.hasChanges).toBe(false);
  });

  it("any OTHER failed alt still stays a draft for the next Save", async () => {
    const h = mountCollection();
    await tick(50);
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("fr"); });
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleAltTextChange(0, "Une image"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond({ success: true, actionType: "updateContent", failedAltTextIndices: [0] });
    await tick(50);
    expect(h.editor.current.state.hasChanges).toBe(true);
    expect(h.editor.current.state.imageAltTexts[0]).toBe("Une image");
  });
});

describe("the collection's featured alt in the MAIN language", () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

  it("is sent with its change flag and clears the save bar once stored", async () => {
    const h = mountCollection();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleAltTextChange(0, "Sommerkollektion"); });
    expect(h.editor.current.state.hasChanges).toBe(true);
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].imageAltTexts).toBe(JSON.stringify({ 0: "Sommerkollektion" }));
    expect(h.posts[0].changedAltTextIndices).toBe(JSON.stringify([0]));
    await h.respond({ success: true, actionType: "updateContent" });
    await tick(50);
    expect(h.editor.current.state.hasChanges).toBe(false);
  });
});
