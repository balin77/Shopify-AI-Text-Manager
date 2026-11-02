/**
 * app.metaobjects.tsx with the real page, the real router and the real
 * useBackgroundJson (the heavy editor is replaced by a prop capture).
 *
 * The entries used to ride on a router fetcher, which the router re-ran on every
 * revalidate(). Over plain fetch that has to be done explicitly - and the editor
 * must be told the revalidation is still running until the fresh entries landed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

const ENTRY = "gid://shopify/Metaobject/1";
const fetched: string[] = [];
let entryValue = "A";
let translation = "fr-old";
let entriesStatus = 200;
let usageStatus = 200;
let gate: Promise<void> | null = null;

let requestedPage = 1;
const entriesBody = () => ({
  success: true,
  metaobject: {
    id: "metaobject_type_x",
    metaobjects: [{ id: ENTRY, handle: "h", displayName: entryValue, fields: [{ key: "label", value: entryValue, type: "single_line_text_field" }] }],
    fieldDefinitions: [],
    translations: [{ key: `${ENTRY}#label`, value: translation, locale: "fr" }],
    pagination: { page: requestedPage, limit: 10, totalCount: 30, totalPages: 3 },
  },
});

const appFetchJson = vi.fn(async (url: string) => {
  fetched.push(url);
  if (url.startsWith("/api/metaobject-usage")) {
    return usageStatus === 200
      ? { response: { ok: true, status: 200 }, data: { success: true, usage: { [ENTRY]: { known: true, products: 0, options: 0 } } } }
      : { response: { ok: false, status: usageStatus }, data: { error: "Too many requests" } };
  }
  if (url.startsWith("/api/metaobjects/")) requestedPage = Number(new URL(url, "http://x").searchParams.get("page") ?? 1);
  if (gate && fetched.filter((u) => u.startsWith("/api/metaobjects/")).length > 1) await gate;
  return entriesStatus === 200
    ? { response: { ok: true, status: 200 }, data: entriesBody() }
    : { response: { ok: false, status: entriesStatus }, data: { error: "Too many requests" } };
});
vi.mock("~/utils/app-fetch", async (orig) => ({
  ...(await (orig as () => Promise<object>)()),
  appFetchJson: (...a: unknown[]) => (appFetchJson as any)(...a),
}));

let editorProps: any = null;
let cardProps: any[] = [];
vi.mock("~/components/UnifiedContentEditor", () => ({
  UnifiedContentEditor: (p: any) => {
    editorProps = p;
    return null;
  },
}));
vi.mock("~/hooks/useUnifiedContentEditor", () => ({
  useUnifiedContentEditor: () => ({ state: { selectedItemId: "metaobject_type_x", currentLanguage: "en" } }),
}));
const STABLE_I18N = { t: { content: {} } };
vi.mock("~/contexts/I18nContext", () => ({ useI18n: () => STABLE_I18N }));
vi.mock("~/hooks/useAppNavigation", () => ({ useAppNavigation: () => ({ handleNavigate: () => {} }) }));
vi.mock("~/contexts/InfoBoxContext", () => ({ useInfoBox: () => ({ showInfoBox: () => {} }) }));
vi.mock("~/components/PlanAccessGate", () => ({ PlanAccessGate: ({ children }: any) => children }));
vi.mock("~/components/metaobjects/MetaobjectEntryCard", () => ({
  MetaobjectEntryCard: (p: any) => {
    cardProps.push(p);
    return null;
  },
}));
vi.mock("~/components/create/DeleteItemModal", () => ({ DeleteItemModal: () => null }));
vi.mock("~/hooks/useDeleteItem", () => ({ useDeleteItem: () => ({ target: null, request: () => {} }) }));
vi.mock("~/utils/performance.client", () => ({ measurePageLoad: () => {} }));
vi.mock("~/utils/loader-factory.server", () => ({ createContentLoader: () => async () => ({}) }));
vi.mock("~/utils/content-route-action.server", () => ({ makeContentRouteAction: () => async () => ({}) }));
vi.mock("~/utils/logger.server", () => ({ logger: { info() {}, error() {}, warn() {}, debug() {} } }));

import Page from "~/routes/app.metaobjects";

const typeRow = { id: "metaobject_type_x", type: "x", title: "X", translations: [], contentCount: 1, definitionId: "gid://d" };
const entryRequests = () => fetched.filter((u) => u.startsWith("/api/metaobjects/")).length;
const usageRequests = () => fetched.filter((u) => u.startsWith("/api/metaobject-usage")).length;

async function mount() {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <Page />,
      // Async like a real loader: the revalidation is visibly "loading" for a moment.
      loader: async () => (await new Promise((r) => setTimeout(r, 20)), { items: [typeRow], metaobjects: [typeRow], shopLocales: [{ locale: "en", primary: true }, { locale: "fr" }], primaryLocale: "en", markets: [] }),
    },
  ]);
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(editorProps?.items?.[0]?.metaobjects?.length).toBe(1));
}

beforeEach(() => {
  fetched.length = 0;
  entryValue = "A";
  translation = "fr-old";
  entriesStatus = 200;
  usageStatus = 200;
  gate = null;
  requestedPage = 1;
  editorProps = null;
  cardProps = [];
});

describe("metaobjects page: entries after a revalidation", () => {
  it("re-reads the entries ONCE when a revalidation ends and the editor sees the fresh values", async () => {
    await mount();
    expect(entryRequests()).toBe(1);
    entryValue = "B";
    translation = "fr-NEW-after-AI-run";
    act(() => {
      void editorProps.revalidator.revalidate();
    });
    await waitFor(() => expect(editorProps.items[0].metaobjects[0].fields[0].value).toBe("B"));
    expect(editorProps.items[0].translations[0].value).toBe("fr-NEW-after-AI-run");
    expect(entryRequests()).toBe(2);
  });

  it("keeps the old entries on screen meanwhile (no flicker, no spinner) and tells the editor the revalidation is still running until they landed", async () => {
    await mount();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    entryValue = "B";
    const states: string[] = [];
    act(() => {
      void editorProps.revalidator.revalidate();
    });
    await waitFor(() => expect(entryRequests()).toBe(2));
    states.push(editorProps.revalidator.state);
    expect(editorProps.items[0].metaobjects[0].fields[0].value).toBe("A"); // still the old entries
    expect(editorProps.isFieldsLoading).toBe(false);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(editorProps.items[0].metaobjects[0].fields[0].value).toBe("B"));
    states.push(editorProps.revalidator.state);
    expect(states).toEqual(["loading", "idle"]);
  });

  it("a refused re-read keeps the entries it had and lets the revalidation end", async () => {
    await mount();
    entriesStatus = 429;
    act(() => {
      void editorProps.revalidator.revalidate();
    });
    await waitFor(() => expect(editorProps.revalidator.state).toBe("idle"));
    expect(editorProps.items[0].metaobjects[0].fields[0].value).toBe("A");
    expect(editorProps.isFieldsLoading).toBe(false);
  });

  it("one revalidation is one entries request and one usage request", async () => {
    await mount();
    const usageBefore = usageRequests();
    act(() => {
      void editorProps.revalidator.revalidate();
    });
    await waitFor(() => expect(editorProps.revalidator.state).toBe("idle"));
    await new Promise((r) => setTimeout(r, 30));
    expect(entryRequests()).toBe(2);
    expect(usageRequests() - usageBefore).toBe(1);
  });
});

describe("metaobjects page: failed reads can be recovered", () => {
  it("a failed usage read is 'unknown', not an endless 'checking'", async () => {
    usageStatus = 429;
    await mount();
    await waitFor(() => expect(usageRequests()).toBe(1));
    const usageOfCard = () => {
      cardProps = [];
      const { unmount } = render(<>{editorProps.renderFieldGroup(ENTRY, [])}</>);
      unmount();
      return cardProps.at(-1)?.usage;
    };
    await waitFor(() => expect(usageOfCard()).toEqual({ state: "unknown", reason: "lookupFailed" }));
  });

  it("after a failed page change the same page can be asked for again", async () => {
    await mount();
    entriesStatus = 429;
    await act(async () => {
      editorProps.onFieldPageChange(2);
    });
    await waitFor(() => expect(entryRequests()).toBe(2));
    await waitFor(() => expect(editorProps.isFieldsLoading).toBe(false));
    entriesStatus = 200;
    await act(async () => {
      editorProps.onFieldPageChange(2); // "Next" again: entryPage is already 2
    });
    await waitFor(() => expect(entryRequests()).toBe(3));
  });
});
