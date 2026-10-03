/**
 * The ORIGINAL image of a theme `image_picker` setting is chosen in the app.
 *
 * What the primary save must guarantee: the reference written into the theme
 * file is derived on the SERVER from a fresh read of the picked file (never the
 * client's text), it lands in the file the key's resource type routes to, a key
 * with no theme file or a file that is not a READY image is refused LOUDLY
 * (nothing written), and a changed original never purges / re-translates the
 * foreign replacement images.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => ({
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    autoTranslateHandles: false,
  })),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async () => true),
}));
vi.mock("~/services/theme-selection.server", () => ({
  resolveSelectedThemeId: vi.fn(async () => "gid://shopify/OnlineStoreTheme/1"),
}));

import { handleUpdateContent } from "../../app/actions/templates/templates-update.action";

const FILE_ID = "gid://shopify/MediaImage/77";
const OLD = "shopify://shop_images/old-logo.png";
const NEW = "shopify://shop_images/new-logo.png";

type Node = { filename: string; body: { content: string } };
let upserts: Array<{ filename: string; value: string }> = [];
let queries: string[] = [];
let fileAnswer: any;

function themeFile(filename: string, json: unknown): Node {
  return { filename, body: { content: JSON.stringify(json) } };
}

function makeCtx(opts: {
  files: Node[];
  edits: Record<string, { old: string; next: string; type: string }>;
  fileIds?: Record<string, string>;
  changed?: string[];
}) {
  const admin = {
    graphql: vi.fn(async (query: string, o?: { variables?: any }) => {
      queries.push(query);
      if (query.includes("themeFilesUpsert")) {
        for (const f of o?.variables?.files ?? []) upserts.push({ filename: f.filename, value: f.body.value });
        return {
          json: async () => ({
            data: {
              themeFilesUpsert: {
                upsertedThemeFiles: (o?.variables?.files ?? []).map((f: any) => ({ filename: f.filename })),
                userErrors: [],
              },
            },
          }),
        };
      }
      if (query.includes("themeImageFile")) return { json: async () => fileAnswer };
      if (query.includes("files(")) return { json: async () => ({ data: { theme: { files: { nodes: opts.files } } } }) };
      if (query.includes("shopLocales")) {
        return {
          json: async () => ({
            data: { shopLocales: [{ locale: "de", primary: true, published: true }, { locale: "en", primary: false, published: true }] },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    }),
  };
  const db = {
    aISettings: { findUnique: vi.fn(async () => null) },
    themeContent: { updateMany: vi.fn(async () => ({ count: 1 })) },
    themeTranslation: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  };
  const formData = new FormData();
  formData.set("locale", "de");
  formData.set("primaryLocale", "de");
  for (const [key, edit] of Object.entries(opts.edits)) formData.set(key, edit.next);
  formData.set("changedFields", JSON.stringify(opts.changed ?? Object.keys(opts.edits)));
  if (opts.fileIds) formData.set("themeImageFileIds", JSON.stringify(opts.fileIds));
  const group = {
    groupId: "g",
    resourceId: "gid://shopify/OnlineStoreThemeSettingsCategory/1",
    translatableContent: Object.entries(opts.edits).map(([key, edit]) => ({ key, value: edit.old, digest: "d" })),
  };
  return {
    ctx: {
      admin,
      db,
      session: { shop: "s.myshopify.com" },
      formData,
      domain: "theme",
      groupId: "g",
      themeGroups: [group],
      firstGroup: group,
      resourceId: group.resourceId,
      keyToResourceId: new Map(Object.keys(opts.edits).map((key) => [key, group.resourceId])),
      keyToResourceType: new Map(Object.entries(opts.edits).map(([key, e]) => [key, e.type])),
      selectedThemeId: "gid://shopify/OnlineStoreTheme/1",
    } as never,
    db,
  };
}

const readyFile = (url = "https://cdn.shopify.com/s/files/1/0001/files/new-logo.png?v=123") => ({
  data: { node: { id: FILE_ID, fileStatus: "READY", image: { url } } },
});

beforeEach(() => {
  upserts = [];
  queries = [];
  fileAnswer = readyFile();
});

const SETTINGS_KEY = "general.logo";

describe("primary theme image save", () => {
  it("writes the SERVER-derived reference into config/settings_data.json and mirrors what was pushed", async () => {
    const { ctx, db } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      // The client's text names another file than the one it picked: the id wins.
      edits: { [SETTINGS_KEY]: { old: OLD, next: "shopify://shop_images/client-made-up.png", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    expect(upserts.map((u) => u.filename)).toEqual(["config/settings_data.json"]);
    expect(JSON.parse(upserts[0].value).current.logo).toBe(NEW);
    const mirrored = (db.themeContent.updateMany.mock.calls[0] as any)[0].data.translatableContent;
    expect(mirrored[0].value).toBe(NEW);
  });

  it("routes a JSON-template image key to its template file", async () => {
    const key = "section.index.json.hero.image";
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { hero: { settings: { image: OLD } } } })],
      edits: { [key]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_JSON_TEMPLATE" } },
      fileIds: { [key]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    expect(upserts.map((u) => u.filename)).toEqual(["templates/index.json"]);
    expect(JSON.parse(upserts[0].value).sections.hero.settings.image).toBe(NEW);
  });

  it("routes a section-group image key to its group file", async () => {
    const key = "section.sections/header-group.json.header.logo";
    const { ctx } = makeCtx({
      files: [themeFile("sections/header-group.json", { sections: { header: { settings: { logo: OLD } } } })],
      edits: { [key]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SECTION_GROUP" } },
      fileIds: { [key]: FILE_ID },
    });
    await handleUpdateContent(ctx);
    expect(upserts.map((u) => u.filename)).toEqual(["sections/header-group.json"]);
  });

  it("REFUSES a key whose resource type maps to no theme file - loudly, nothing written", async () => {
    const { ctx } = makeCtx({
      files: [],
      edits: { "app.embed.image": { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_APP_EMBED" } },
      fileIds: { "app.embed.image": FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeImageNoFile");
    expect(upserts).toEqual([]);
    expect(queries.some((q) => q.includes("themeImageFile"))).toBe(false);
  });

  it("refuses a pick that names no file id (the client's text alone is never enough)", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeImageInvalid");
    expect(upserts).toEqual([]);
  });

  it("refuses a file that is still processing", async () => {
    fileAnswer = { data: { node: { id: FILE_ID, fileStatus: "PROCESSING", image: null } } };
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeImageNotReady");
    expect(upserts).toEqual([]);
  });

  it("refuses a file that is not on Shopify's CDN or has an unsafe name", async () => {
    for (const url of ["https://evil.example.com/files/new-logo.png", 'https://cdn.shopify.com/s/files/a"b.png']) {
      fileAnswer = readyFile(url);
      const { ctx } = makeCtx({
        files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
        edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
        fileIds: { [SETTINGS_KEY]: FILE_ID },
      });
      const body = ((await handleUpdateContent(ctx)) as any);
      expect((body?.data ?? body).errorKey).toBe("themeImageInvalid");
    }
    expect(upserts).toEqual([]);
  });

  it("refuses a failed read of the file rather than guessing", async () => {
    fileAnswer = { errors: [{ message: "boom" }], data: null };
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeImageReadFailed");
  });

  it("never turns an image slot into text, and an empty original stays blocked", async () => {
    const text = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: "some text", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const a = (await handleUpdateContent(text.ctx)) as any;
    expect((a?.data ?? a).errorKey).toBe("themeImageNoClear");

    const empty = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: "", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const b = (await handleUpdateContent(empty.ctx)) as any;
    expect((b?.data ?? b).errorKey).toBe("emptyPrimaryFieldsError");
    expect(upserts).toEqual([]);
  });

  it("refuses to guess when the old image is used in more places than the save names", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD, footer_logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(upserts).toEqual([]);
  });

  it("does NOT purge the foreign replacement images (or ask Shopify to), while a text key still is", async () => {
    const image = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const res = (await handleUpdateContent(image.ctx)) as any;
    expect((res?.data ?? res).success).toBe(true);
    expect(queries.some((q) => q.includes("translationsRemove"))).toBe(false);
    expect(image.db.themeTranslation.deleteMany).not.toHaveBeenCalled();

    // Control: the same save for a TEXT key purges, so the assertion above is not vacuous.
    queries = [];
    const text = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { headline: "Alt" } })],
      edits: { "general.headline": { old: "Alt", next: "Neu", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    await handleUpdateContent(text.ctx);
    expect(queries.some((q) => q.includes("translationsRemove"))).toBe(true);
  });

  it("an image and a text key in one save: only the text key is purged", async () => {
    const { ctx, db } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD, headline: "Alt" } })],
      edits: {
        [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" },
        "general.headline": { old: "Alt", next: "Neu", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" },
      },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    await handleUpdateContent(ctx);
    expect(JSON.parse(upserts[0].value).current).toEqual({ logo: NEW, headline: "Neu" });
    const removal = (ctx as any).admin.graphql.mock.calls.filter((c: any[]) => String(c[0]).includes("translationsRemove"));
    expect(removal.length).toBeGreaterThan(0);
    for (const call of removal) expect(call[1].variables.translationKeys).toEqual(["general.headline"]);
    void db;
  });
});
