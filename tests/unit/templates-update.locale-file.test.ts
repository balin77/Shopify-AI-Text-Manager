/**
 * Which theme file a PRIMARY locale-content value is written to.
 *
 * A shop whose primary language is not the theme's default one (Dawn ships
 * `locales/en.default.json`; a German shop's texts live in `locales/de.json`)
 * had every such save fail: the value was searched in the default file, not
 * found, nothing was pushed ("Primary locale save did not fully persist",
 * pushedCount 0). The file that HOLDS the old value is the one written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => ({
    purgeOnPrimaryChange: false,
    purgeUnreconciledSurfaces: false,
    autoTranslateExternalChanges: false,
    autoTranslateHandles: false,
  })),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async () => false),
}));
vi.mock("~/services/theme-selection.server", () => ({
  resolveSelectedThemeId: vi.fn(async () => "gid://shopify/OnlineStoreTheme/1"),
}));

import { handleUpdateContent } from "../../app/actions/templates/templates-update.action";

const KEY = "templates.404.title";

function file(filename: string, title: string) {
  return {
    filename,
    body: { content: JSON.stringify({ templates: { "404": { title, subtext: "404" } } }) },
  };
}

let upserts: Array<{ filename: string; value: string }> = [];

function makeCtx(files: ReturnType<typeof file>[]) {
  const admin = {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      if (query.includes("themeFilesUpsert")) {
        for (const f of opts?.variables?.files ?? []) upserts.push({ filename: f.filename, value: f.body.value });
        return {
          json: async () => ({
            data: {
              themeFilesUpsert: {
                upsertedThemeFiles: (opts?.variables?.files ?? []).map((f: any) => ({ filename: f.filename })),
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("files(")) {
        return { json: async () => ({ data: { theme: { files: { nodes: files } } } }) };
      }
      return { json: async () => ({ data: {} }) };
    }),
  };
  const db = {
    aISettings: { findUnique: vi.fn(async () => null) },
    themeContent: { updateMany: vi.fn(async () => ({ count: 1 })) },
    themeTranslation: { deleteMany: vi.fn(async () => ({ count: 0 })), upsert: vi.fn(async () => ({})) },
  };
  const formData = new FormData();
  formData.set("locale", "de");
  formData.set("primaryLocale", "de");
  formData.set(KEY, "Diese Seite gibt es nicht");
  formData.set("changedFields", JSON.stringify([KEY]));
  const group = {
    groupId: "g",
    resourceId: "gid://shopify/OnlineStoreThemeLocaleContent/1",
    translatableContent: [{ key: KEY, value: "Seite nicht gefunden", digest: "d" }],
  };
  return {
    admin,
    db,
    session: { shop: "s.myshopify.com" },
    formData,
    domain: "theme",
    groupId: "g",
    themeGroups: [group],
    firstGroup: group,
    resourceId: group.resourceId,
    keyToResourceId: new Map([[KEY, group.resourceId]]),
    keyToResourceType: new Map([[KEY, "ONLINE_STORE_THEME_LOCALE_CONTENT"]]),
    selectedThemeId: "gid://shopify/OnlineStoreTheme/1",
  } as never;
}

beforeEach(() => {
  upserts = [];
});

describe("primary locale-content save — which locale file", () => {
  it("writes the primary language's OWN file when the default file is another language", async () => {
    const result = (await handleUpdateContent(
      makeCtx([file("locales/en.default.json", "Page not found"), file("locales/de.json", "Seite nicht gefunden")]),
    )) as any;
    const body = result?.data ?? result;

    expect(upserts.map((u) => u.filename)).toEqual(["locales/de.json"]);
    expect(upserts[0].value).toContain("Diese Seite gibt es nicht");
    expect(body.success).toBe(true);
  });

  it("still writes the default file when that is where the primary value lives", async () => {
    await handleUpdateContent(
      makeCtx([file("locales/de.default.json", "Seite nicht gefunden")]),
    );
    expect(upserts.map((u) => u.filename)).toEqual(["locales/de.default.json"]);
  });

  it("falls back to the theme's default file when the primary value is there", async () => {
    // A German shop on a theme with an English default file and no de.json:
    // the storefront serves the default file's text.
    await handleUpdateContent(
      makeCtx([file("locales/en.default.json", "Seite nicht gefunden")]),
    );
    expect(upserts.map((u) => u.filename)).toEqual(["locales/en.default.json"]);
  });
});
