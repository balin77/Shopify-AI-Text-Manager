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

type FileNode = { filename: string; body: { content: string } };

function makeCtx(
  files: FileNode[],
  edits: Record<string, { old: string; next: string }> = { [KEY]: { old: "Seite nicht gefunden", next: "Diese Seite gibt es nicht" } },
) {
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
  for (const [key, edit] of Object.entries(edits)) formData.set(key, edit.next);
  formData.set("changedFields", JSON.stringify(Object.keys(edits)));
  const group = {
    groupId: "g",
    resourceId: "gid://shopify/OnlineStoreThemeLocaleContent/1",
    translatableContent: Object.entries(edits).map(([key, edit]) => ({ key, value: edit.old, digest: "d" })),
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
    keyToResourceId: new Map(Object.keys(edits).map((key) => [key, group.resourceId])),
    keyToResourceType: new Map(Object.keys(edits).map((key) => [key, "ONLINE_STORE_THEME_LOCALE_CONTENT"])),
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

  it("writes each key to the file that holds it — a PARTIAL de.json splits one save", async () => {
    const files = [
      { filename: "locales/en.default.json", body: { content: JSON.stringify({ a: { title: "Titel A" }, b: { title: "Titel B" } }) } },
      { filename: "locales/de.json", body: { content: JSON.stringify({ a: { title: "Titel A" } }) } },
    ];
    await handleUpdateContent(
      makeCtx(files, { "a.title": { old: "Titel A", next: "Neu A" }, "b.title": { old: "Titel B", next: "Neu B" } }),
    );
    const byFile = Object.fromEntries(upserts.map((u) => [u.filename, JSON.parse(u.value)]));
    expect(Object.keys(byFile).sort()).toEqual(["locales/de.json", "locales/en.default.json"]);
    expect(byFile["locales/de.json"].a.title).toBe("Neu A");
    expect(byFile["locales/en.default.json"].b.title).toBe("Neu B");
    // The default file's copy of A is not the one the storefront serves.
    expect(byFile["locales/en.default.json"].a.title).toBe("Titel A");
  });

  it("never rewrites ANOTHER key that happens to hold the same words", async () => {
    // K is not in de.json (the storefront falls back to the default file for
    // it); J in de.json holds the same text. A value search would take J.
    const files = [
      { filename: "locales/en.default.json", body: { content: JSON.stringify({ k: { label: "Suchen" } }) } },
      { filename: "locales/de.json", body: { content: JSON.stringify({ j: { label: "Suchen" } }) } },
    ];
    await handleUpdateContent(makeCtx(files, { "k.label": { old: "Suchen", next: "Finden" } }));
    expect(upserts.map((u) => u.filename)).toEqual(["locales/en.default.json"]);
    expect(JSON.parse(upserts[0].value).k.label).toBe("Finden");
  });
});
