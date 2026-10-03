/**
 * Accepting an AI suggestion SAVES that field, and the save bar never treats
 * the accepted value as a draft.
 *
 * Owner report (2026-10-02, products page): "Übernehmen" on a ✨ suggestion
 * did not read as saved — the save bar (Save / Discard) appeared and stayed.
 * The accept did submit its one-field save, but the change detection compared
 * the field against a baseline that only moves when the ANSWER lands, and a
 * primary product save (product write, locale lookup, purge or re-translation
 * hand-off) takes long enough for the bar to stand there for its whole round
 * trip. The value such a save is writing is now covered while it is in flight
 * (own-save-in-flight.shared.ts); a refused save, or a keystroke on top of it,
 * is a draft again.
 *
 * Driven through a REAL React Router data router (fetcher, action, loader
 * revalidation), because the timing between the fetcher's answer and the
 * revalidated loader data is exactly what the editor's save handling depends
 * on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG, COLLECTIONS_CONFIG } from "~/config/content-fields.config";
import { setFieldSuggestion } from "~/hooks/useAISuggestionStore";

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

type Answer = Record<string, unknown>;

function mount(kind: "products" | "collections") {
  const id = kind === "products" ? "gid://shopify/Product/1" : "gid://shopify/Collection/1";
  const store = {
    id,
    title: "Alt",
    descriptionHtml: "<p>alt</p>",
    handle: "alt",
    seo: { title: "SEO alt", description: "Meta alt" },
    translations: [{ key: "title", locale: "fr", value: "Titre" }],
    images: [],
    status: "ACTIVE",
  };
  const posts: Array<Record<string, string>> = [];
  // The action waits until the test answers it: "in flight" is a state the
  // test can look at, not a race against a timer.
  let answer: (body: Answer) => void = () => {};
  const editor: { current: any } = { current: null };
  const showInfoBox = vi.fn();

  function Page() {
    const { items } = useLoaderData() as { items: unknown[] };
    const fetcher = useFetcher();
    editor.current = useUnifiedContentEditor({
      config: kind === "products" ? PRODUCTS_CONFIG : COLLECTIONS_CONFIG,
      items,
      shopLocales: [
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
      ],
      primaryLocale: "de",
      fetcher,
      showInfoBox,
      t: {},
      initialItemId: id,
    } as any);
    return null;
  }

  const router = createMemoryRouter([
    // The product editor loads its images on demand.
    { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
    {
      path: "/",
      element: <Page />,
      loader: async () => ({ items: [{ ...store, seo: { ...store.seo } }] }),
      action: async ({ request }) => {
        const form = Object.fromEntries((await request.formData()) as any) as Record<string, string>;
        posts.push(form);
        const body = await new Promise<Answer>((resolve) => { answer = resolve; });
        if (body.success && form.locale === "de") {
          if (form.title !== undefined) store.title = form.title;
          if (form.description !== undefined) store.descriptionHtml = form.description;
          if (form.seoTitle !== undefined) store.seo.title = form.seoTitle;
          if (form.metaDescription !== undefined) store.seo.description = form.metaDescription;
        }
        return body;
      },
    },
  ]);
  render(<RouterProvider router={router} />);
  return { id, editor, posts, showInfoBox, respond: (body: Answer) => act(async () => { answer(body); }) };
}

async function accept(h: ReturnType<typeof mount>, locale: string, field: string, text: string) {
  act(() => setFieldSuggestion({ resourceId: h.id, locale, marketId: "" }, field, text));
  await tick();
  await act(async () => { h.editor.current.handlers.handleAcceptSuggestion(field); });
  await tick(20);
}

describe("accepting an AI suggestion saves the field without a save bar", () => {
  // The editor remembers the last item and language per page.
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

  it.each(["title", "description", "seoTitle", "metaDescription"])(
    "products, primary language: %s",
    async (field) => {
      const h = mount("products");
      await tick(50);
      expect(h.editor.current.state.hasChanges).toBe(false);

      await accept(h, "de", field, "Neu von der KI");
      // Submitted at once, carrying that one field only.
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0].action).toBe("updateContent");
      expect(h.posts[0][field]).toBe("Neu von der KI");
      expect(h.posts[0].changedFields).toBe(JSON.stringify([field]));
      // While Shopify is still writing it, the accepted text is not a draft.
      expect(h.editor.current.state.editableValues[field]).toBe("Neu von der KI");
      expect(h.editor.current.state.hasChanges).toBe(false);

      await h.respond({ success: true, actionType: "updateContent" });
      await tick(50);
      expect(h.editor.current.state.hasChanges).toBe(false);
      expect(h.editor.current.state.editableValues[field]).toBe("Neu von der KI");
    },
  );

  it("products, foreign language", async () => {
    const h = mount("products");
    await tick(50);
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("fr"); });
    await tick(50);
    expect(h.editor.current.state.hasChanges).toBe(false);

    await accept(h, "fr", "title", "Nouveau titre");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].locale).toBe("fr");
    expect(h.editor.current.state.hasChanges).toBe(false);

    await h.respond({ success: true, actionType: "updateContent" });
    await tick(50);
    expect(h.editor.current.state.hasChanges).toBe(false);
  });

  it("collections behave the same", async () => {
    const h = mount("collections");
    await tick(50);
    await accept(h, "de", "title", "Neue Kollektion");
    expect(h.posts).toHaveLength(1);
    expect(h.editor.current.state.hasChanges).toBe(false);
    await h.respond({ success: true, actionType: "updateContent" });
    await tick(50);
    expect(h.editor.current.state.hasChanges).toBe(false);
  });

  it("a refused save leaves the accepted text as a draft the Save button can send", async () => {
    const h = mount("products");
    await tick(50);
    await accept(h, "de", "title", "Neu von der KI");
    expect(h.editor.current.state.hasChanges).toBe(false);

    await h.respond({ success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(50);
    expect(h.editor.current.state.editableValues.title).toBe("Neu von der KI");
    expect(h.editor.current.state.hasChanges).toBe(true);
  });

  it("typing over the accepted text while it is being saved is a draft again", async () => {
    const h = mount("products");
    await tick(50);
    await accept(h, "de", "title", "Neu von der KI");
    expect(h.editor.current.state.hasChanges).toBe(false);

    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Neu von der KI!"); });
    expect(h.editor.current.state.hasChanges).toBe(true);
  });

  it("a view switch during that save is REFUSED with a message, never queued", async () => {
    const h = mount("products");
    await tick(50);
    await accept(h, "de", "title", "Neu von der KI");
    expect(h.editor.current.state.hasChanges).toBe(false);

    // Language, market and item switches are all refused while it is out.
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("fr"); });
    await act(async () => { await h.editor.current.handlers.handleItemSelect("gid://shopify/Product/2"); });
    await tick(20);
    expect(h.editor.current.state.currentLanguage).toBe("de");
    expect(h.editor.current.state.selectedItemId).toBe(h.id);
    const refusals = () => h.showInfoBox.mock.calls.filter(([msg, tone]) => tone === "info" && String(msg).startsWith("Still saving"));
    expect(refusals()).toHaveLength(2);

    // Answered: nothing was queued, and the next click switches.
    await h.respond({ success: true, actionType: "updateContent" });
    await tick(50);
    expect(h.editor.current.state.currentLanguage).toBe("de");
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("fr"); });
    await tick(20);
    expect(h.editor.current.state.currentLanguage).toBe("fr");
    expect(refusals()).toHaveLength(2);
  });
});
