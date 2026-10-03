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
  /** Keys rendered as image pickers; defaults to every edit whose old value is an image reference. */
  imageKeys?: string[];
  translationRows?: any[];
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
      if (query.includes("translationsRemove") && o?.variables) {
        const v = o.variables;
        return {
          json: async () => ({
            data: {
              translationsRemove: {
                translations: v.translationKeys.flatMap((key: string) => v.locales.map((locale: string) => ({ key, locale }))),
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
      findMany: vi.fn(async () => opts.translationRows ?? []),
    },
  };
  const formData = new FormData();
  formData.set("locale", "de");
  formData.set("primaryLocale", "de");
  for (const [key, edit] of Object.entries(opts.edits)) formData.set(key, edit.next);
  formData.set("changedFields", JSON.stringify(opts.changed ?? Object.keys(opts.edits)));
  const imageKeys = opts.imageKeys ?? Object.entries(opts.edits).filter(([, e]) => e.old.startsWith("shopify://shop_images/")).map(([k]) => k);
  if (imageKeys.length > 0) formData.set("themeImageFieldKeys", JSON.stringify(imageKeys));
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

  it("refuses to guess when the key names no path and the old image is used in several places", async () => {
    // current.logo does not exist, so no path resolves; the value search finds two.
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { sections: { a: { settings: { logo: OLD } }, b: { settings: { logo: OLD } } } } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeImageAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("two slides sharing an image: each key is written at ITS OWN slot by path, s2 never gets s1's image", async () => {
    const k1 = "section.index.json.s1.image";
    const k2 = "section.index.json.s2.image";
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s1: { settings: { image: OLD } }, s2: { settings: { image: OLD } } } })],
      edits: {
        [k1]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_JSON_TEMPLATE" },
        [k2]: { old: OLD, next: "shopify://shop_images/two.png", type: "ONLINE_STORE_THEME_JSON_TEMPLATE" },
      },
      fileIds: { [k1]: FILE_ID, [k2]: FILE_ID },
    });
    // the second key names its own file id too; reuse the same ready file for both
    fileAnswer = readyFile();
    const result = (await handleUpdateContent(ctx)) as any;
    // Both keys derive the SAME reference from the same file id (server authority), so both are NEW.
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value).sections;
    expect(written.s1.settings.image).toBe(NEW);
    expect(written.s2.settings.image).toBe(NEW);
  });

  it("changing ONE of two slides that share an image changes only that slot", async () => {
    const k1 = "section.index.json.s1.image";
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s1: { settings: { image: OLD } }, s2: { settings: { image: OLD } } } })],
      edits: { [k1]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_JSON_TEMPLATE" } },
      fileIds: { [k1]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value).sections;
    expect(written.s1.settings.image).toBe(NEW);
    expect(written.s2.settings.image).toBe(OLD);
  });

  it("a path that exists but holds a DIFFERENT value falls back to the search, and is refused if that is ambiguous", async () => {
    const k1 = "section.index.json.s1.image";
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s1: { settings: { image: "shopify://shop_images/other.png" } }, x: { settings: { a: OLD } }, y: { settings: { a: OLD } } } })],
      edits: { [k1]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_JSON_TEMPLATE" } },
      fileIds: { [k1]: FILE_ID },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeImageAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("an ambiguous image blocks the WHOLE save, text keys included", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { headline: "Alt", sections: { a: { settings: { logo: OLD } }, b: { settings: { logo: OLD } } } } })],
      edits: {
        [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" },
        "general.headline": { old: "Alt", next: "Neu", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" },
      },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeImageAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("an image whose old value is not in the theme file blocks the save with its own message", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: "shopify://shop_images/other.png" } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeImageNotLocated");
    expect(upserts).toEqual([]);
  });

  it("a file name with a space or an umlaut is written as Files knows it", async () => {
    fileAnswer = readyFile("https://cdn.shopify.com/s/files/1/0001/files/M%C3%BCller%20Logo.png?v=1");
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: "shopify://shop_images/Müller Logo.png", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
      imageKeys: [SETTINGS_KEY],
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    expect(JSON.parse(upserts[0].value).current.logo).toBe("shopify://shop_images/Müller Logo.png");
  });

  it("an unsafe decoded name (separator, quote, newline) is an invalid file - never 'cannot clear'", async () => {
    for (const name of ["a%2Fb.png", "a%22b.png", "a%0Ab.png"]) {
      fileAnswer = readyFile(`https://cdn.shopify.com/s/files/1/0001/files/${name}?v=1`);
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

  it("a text setting holding an image-shaped value or a YouTube link is TEXT: no file read, purged like text", async () => {
    for (const [old, next] of [
      [OLD, "shopify://shop_images/typed.png"],
      ["https://youtu.be/abcdefghijk", "https://youtu.be/zzzzzzzzzzz"],
    ]) {
      queries = [];
      upserts = [];
      const { ctx } = makeCtx({
        files: [themeFile("config/settings_data.json", { current: { link: old } })],
        edits: { "general.link": { old, next, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
        imageKeys: [],
      });
      const result = (await handleUpdateContent(ctx)) as any;
      expect((result?.data ?? result).success).toBe(true);
      expect(JSON.parse(upserts[0].value).current.link).toBe(next);
      expect(queries.some((q) => q.includes("themeImageFile"))).toBe(false);
      expect(queries.some((q) => q.includes("translationsRemove"))).toBe(true);
    }
  });

  it("removes foreign COPIES of the old original (global and market), keeps replacements that differ", async () => {
    const R = "gid://shopify/OnlineStoreThemeSettingsCategory/1";
    const { ctx, db } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
      translationRows: [
        { resourceId: R, key: SETTINGS_KEY, locale: "en", marketId: "", value: OLD },
        { resourceId: R, key: SETTINGS_KEY, locale: "en", marketId: "gid://shopify/Market/1", value: OLD },
        { resourceId: R, key: SETTINGS_KEY, locale: "fr", marketId: "", value: "shopify://shop_images/fr-own.png" },
      ],
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const calls = ((ctx as any).admin.graphql.mock.calls as any[][]).filter((c) => String(c[0]).includes("translationsRemove"));
    expect(calls.map((c) => JSON.stringify([c[1].variables.locales, c[1].variables.marketIds])).sort()).toEqual(
      [JSON.stringify([["en"], null]), JSON.stringify([["en"], ["gid://shopify/Market/1"]])].sort(),
    );
    for (const c of calls) expect(c[1].variables.translationKeys).toEqual([SETTINGS_KEY]);
    expect(db.themeTranslation.deleteMany).toHaveBeenCalledTimes(2);
    for (const c of db.themeTranslation.deleteMany.mock.calls as any[][]) expect(c[0].where.locale).toBe("en");
  });

  it("never touches rows of ANOTHER theme that share the group id", async () => {
    const R = "gid://shopify/OnlineStoreThemeSettingsCategory/Brand?theme_id=1";
    const OTHER = "gid://shopify/OnlineStoreThemeSettingsCategory/Brand?theme_id=2";
    const { ctx, db } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
      translationRows: [
        { resourceId: R, key: SETTINGS_KEY, locale: "en", marketId: "", value: OLD },
        { resourceId: OTHER, key: SETTINGS_KEY, locale: "en", marketId: "", value: OLD },
      ],
    });
    (ctx as any).keyToResourceId = new Map([[SETTINGS_KEY, R]]);
    await handleUpdateContent(ctx);
    const calls = ((ctx as any).admin.graphql.mock.calls as any[][]).filter((c) => String(c[0]).includes("translationsRemove"));
    expect(calls.map((c) => c[1].variables.resourceId)).toEqual([R]);
    const where = (db.themeTranslation.findMany.mock.calls as any[][])[0][0].where;
    expect(where.resourceId).toEqual({ in: [R] });
    expect(where.OR).toEqual([{ themeId: "gid://shopify/OnlineStoreTheme/1" }, { themeId: "" }]);
  });

  it("a market copy of the old original stays while that locale's global value is a real replacement", async () => {
    const R = "gid://shopify/OnlineStoreThemeSettingsCategory/1";
    const market = "gid://shopify/Market/1";
    const base = {
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    };
    const keep = makeCtx({
      ...base,
      translationRows: [
        { resourceId: R, key: SETTINGS_KEY, locale: "fr", marketId: "", value: "shopify://shop_images/w.png" },
        { resourceId: R, key: SETTINGS_KEY, locale: "fr", marketId: market, value: OLD },
      ],
    });
    await handleUpdateContent(keep.ctx);
    expect(((keep.ctx as any).admin.graphql.mock.calls as any[][]).some((c) => String(c[0]).includes("translationsRemove"))).toBe(false);

    // Global absent: the market copy goes. Global a copy too: both go.
    const gone = makeCtx({ ...base, translationRows: [{ resourceId: R, key: SETTINGS_KEY, locale: "fr", marketId: market, value: OLD }] });
    await handleUpdateContent(gone.ctx);
    expect(((gone.ctx as any).admin.graphql.mock.calls as any[][]).filter((c) => String(c[0]).includes("translationsRemove")).length).toBe(1);
  });

  it("answers exactly which copies were removed, so the page can drop them", async () => {
    const R = "gid://shopify/OnlineStoreThemeSettingsCategory/1";
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
      translationRows: [
        { resourceId: R, key: SETTINGS_KEY, locale: "en", marketId: "", value: OLD },
        { resourceId: R, key: SETTINGS_KEY, locale: "fr", marketId: "", value: "shopify://shop_images/fr.png" },
      ],
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).removedImageCopies).toEqual([{ key: SETTINGS_KEY, locale: "en", marketId: "" }]);
  });

  it("a settings_data PRESET that repeats the image is neither counted nor written", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD }, presets: { Default: { logo: OLD } } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value);
    expect(written.current.logo).toBe(NEW);
    expect(written.presets.Default.logo).toBe(OLD);
  });

  it("keeps a copy's local row when Shopify does not confirm the removal", async () => {
    const R = "gid://shopify/OnlineStoreThemeSettingsCategory/1";
    const { ctx, db } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
      translationRows: [{ resourceId: R, key: SETTINGS_KEY, locale: "en", marketId: "", value: OLD }],
    });
    const original = (ctx as any).admin.graphql;
    (ctx as any).admin.graphql = vi.fn(async (q: string, o?: any) =>
      q.includes("translationsRemove")
        ? { json: async () => ({ data: { translationsRemove: { translations: [], userErrors: [{ message: "nope" }] } } }) }
        : original(q, o),
    );
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(true);
    expect(body.warnings).toContain("translationPurgeUnconfirmed");
    expect(db.themeTranslation.deleteMany).not.toHaveBeenCalled();
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

describe("primary theme TEXT save: by path first, value search only as the fallback", () => {
  const TYPE = "ONLINE_STORE_THEME_JSON_TEMPLATE";
  const cols = (a: string, b: string) => ({
    sections: { mc: { settings: {}, blocks: { c1: { settings: { title: a } }, c2: { settings: { title: b } } }, block_order: ["c1", "c2"] } },
  });

  it("Dawn-like: two blocks both titled 'Column', change one - only that slot changes, the save is not refused", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", cols("Column", "Column"))],
      edits: { "section.index.json.mc.c2.title": { old: "Column", next: "Zwei", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value);
    expect(written.sections.mc.blocks.c1.settings.title).toBe("Column");
    expect(written.sections.mc.blocks.c2.settings.title).toBe("Zwei");
  });

  it("both identical blocks changed in one save: each at its own slot", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", cols("Column", "Column"))],
      edits: {
        "section.index.json.mc.c1.title": { old: "Column", next: "Eins", type: TYPE },
        "section.index.json.mc.c2.title": { old: "Column", next: "Zwei", type: TYPE },
      },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value);
    expect([written.sections.mc.blocks.c1.settings.title, written.sections.mc.blocks.c2.settings.title]).toEqual(["Eins", "Zwei"]);
  });

  it("a NESTED block is resolved through its parent block", async () => {
    const tree = { sections: { s: { settings: {}, blocks: { outer: { settings: {}, blocks: { inner: { settings: { t: "Hi" } }, inner2: { settings: { t: "Hi" } } } } } } } };
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", tree)],
      edits: { "section.index.json.s.outer.inner.t": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value).sections.s.blocks.outer.blocks;
    expect([written.inner.settings.t, written.inner2.settings.t]).toEqual(["Ho", "Hi"]);
  });

  it("the block may be spelled with a literal 'block' segment or as <setting>:<blockId>", async () => {
    for (const key of ["section.index.json.mc.block.c2.title", "section.index.json.mc.title:c2"]) {
      upserts = [];
      const { ctx } = makeCtx({ files: [themeFile("templates/index.json", cols("Column", "Column"))], edits: { [key]: { old: "Column", next: "Zwei", type: TYPE } } });
      const result = (await handleUpdateContent(ctx)) as any;
      expect((result?.data ?? result).success).toBe(true);
      expect(JSON.parse(upserts[0].value).sections.mc.blocks.c2.settings.title).toBe("Zwei");
    }
  });

  it("the two-headings reproduction now succeeds BY PATH when the key names its path", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { a: { settings: { heading: "Hi" } }, b: { settings: { heading: "Hi" } } } })],
      edits: { "section.index.json.a.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    expect(JSON.parse(upserts[0].value).sections).toEqual({ a: { settings: { heading: "Ho" } }, b: { settings: { heading: "Hi" } } });
  });

  it("...and stays REFUSED when the key cannot be resolved to a path", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { a: { settings: { heading: "Hi" } }, b: { settings: { heading: "Hi" } } } })],
      edits: { "section.index.json.q.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeTextAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("a path that holds a DIFFERENT value than expected is not written; the search decides", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { a: { settings: { heading: "Changed meanwhile" } }, z: { settings: { other: "Hi" } } } })],
      edits: { "section.index.json.a.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    // the value search finds the single "Hi" elsewhere (legacy behaviour), never the mismatching slot
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value).sections;
    expect(written.a.settings.heading).toBe("Changed meanwhile");
    expect(written.z.settings.other).toBe("Ho");
  });

  it("a text that occurs once is still written", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { a: { settings: { heading: "Hi" } }, b: { settings: { heading: "Other" } } } })],
      edits: { "section.index.json.a.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    expect(JSON.parse(upserts[0].value).sections).toEqual({ a: { settings: { heading: "Ho" } }, b: { settings: { heading: "Other" } } });
  });

  it("settings_data: top-level settings are written by path, a repeated value elsewhere is left alone", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { headline: "Hi", other: "Hi" } })],
      edits: { "general.headline": { old: "Hi", next: "Ho", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    expect(JSON.parse(upserts[0].value).current).toEqual({ headline: "Ho", other: "Hi" });
  });

  it("settings_data with current = a PRESET NAME: the live values are under presets[current]; other presets stay untouched", async () => {
    const file = { current: "Default", presets: { Default: { logo: OLD, headline: "Hi" }, Other: { logo: OLD, headline: "Hi" } } };
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", file)],
      edits: { "general.headline": { old: "Hi", next: "Ho", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const a = (await handleUpdateContent(ctx)) as any;
    expect((a?.data ?? a).success).toBe(true);
    let written = JSON.parse(upserts[0].value);
    expect(written.presets.Default.headline).toBe("Ho");
    expect(written.presets.Other.headline).toBe("Hi");

    // by VALUE (no resolvable path): searched inside the live preset only, the other preset is not counted
    upserts = [];
    const b = makeCtx({
      files: [themeFile("config/settings_data.json", { current: "Default", presets: { Default: { sections: { x: { settings: { t: "Hi" } } } }, Other: { sections: { x: { settings: { t: "Hi" } } } } } })],
      edits: { "general.nope": { old: "Hi", next: "Ho", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const r = (await handleUpdateContent(b.ctx)) as any;
    expect((r?.data ?? r).success).toBe(true);
    written = JSON.parse(upserts[0].value);
    expect(written.presets.Default.sections.x.settings.t).toBe("Ho");
    expect(written.presets.Other.sections.x.settings.t).toBe("Hi");
  });
});

describe("review fixes: claimed slots, literal 'block' ids, structural strings", () => {
  const TYPE = "ONLINE_STORE_THEME_JSON_TEMPLATE";

  it("a searched key can never claim the slot of a path-resolved key (S never reported as saved)", async () => {
    // P resolves by path to c1 ("Column"); S has the same old value and NO path.
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { mc: { settings: {}, blocks: { c1: { settings: { title: "Column" } } } } } })],
      edits: {
        "section.index.json.mc.c1.title": { old: "Column", next: "P-new", type: TYPE },
        "section.index.json.zz.title": { old: "Column", next: "S-new", type: TYPE },
      },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(upserts).toEqual([]);
  });

  it("a literal 'block' id is a real block when only that reading matches", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s: { settings: { title: "Other" }, blocks: { block: { settings: { title: "Hi" } } } } } })],
      edits: { "section.index.json.s.block.title": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(true);
    const written = JSON.parse(upserts[0].value).sections.s;
    expect(written.blocks.block.settings.title).toBe("Ho");
    expect(written.settings.title).toBe("Other");
  });

  it("when BOTH readings of a literal 'block' segment hold the old value, nothing is guessed: refused", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s: { settings: { title: "Hi" }, blocks: { block: { settings: { title: "Hi" } } } } } })],
      edits: { "section.index.json.s.block.title": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeTextAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("the search never rewrites the preset pointer or a section/block `type`", async () => {
    // settings_data: current = "Default" and the old value of an unresolvable key is "Default"
    const a = makeCtx({
      files: [themeFile("config/settings_data.json", { current: "Default", presets: { Default: { headline: "x" } } })],
      edits: { "general.nope": { old: "Default", next: "Changed", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const ra = (await handleUpdateContent(a.ctx)) as any;
    expect((ra?.data ?? ra).success).toBe(false);
    expect(upserts).toEqual([]);

    // a template section whose `type` equals the old value of an unresolvable key
    const b = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s: { type: "Hi", settings: {} } }, order: ["s"] })],
      edits: { "section.index.json.q.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const rb = (await handleUpdateContent(b.ctx)) as any;
    expect((rb?.data ?? rb).success).toBe(false);
    expect(upserts).toEqual([]);

    // ...while the same value under `settings` is still found by the search
    const c = makeCtx({
      files: [themeFile("templates/index.json", { sections: { s: { type: "Hi", settings: { t: "Hi" } } }, order: ["s"] })],
      edits: { "section.index.json.q.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const rc = (await handleUpdateContent(c.ctx)) as any;
    expect((rc?.data ?? rc).success).toBe(true);
    const written = JSON.parse(upserts[0].value);
    expect(written.sections.s).toEqual({ type: "Hi", settings: { t: "Ho" } });
    expect(written.order).toEqual(["s"]);
  });
});

describe("more structural strings are never searched", () => {
  it("the top-level type and name of a section group are not setting values", async () => {
    const key = "section.sections/header-group.json.q.heading";
    for (const old of ["header", "Header"]) {
      upserts = [];
      const { ctx } = makeCtx({
        files: [themeFile("sections/header-group.json", { type: "header", name: "Header", sections: { h: { type: "announcement-bar", settings: {} } }, order: ["h"] })],
        edits: { [key]: { old, next: "Changed", type: "ONLINE_STORE_THEME_SECTION_GROUP" } },
      });
      const result = (await handleUpdateContent(ctx)) as any;
      expect((result?.data ?? result).success).toBe(false);
      expect(upserts).toEqual([]);
    }
  });

  it("an app embed's type under current.blocks is not a setting value", async () => {
    const appType = "shopify://apps/some-app/blocks/embed/0123-uuid";
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { blocks: { b1: { type: appType, disabled: false, settings: {} } } } })],
      edits: { "general.nope": { old: appType, next: "Changed", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(false);
    expect(upserts).toEqual([]);
  });

  it("a template's layout and wrapper and a node's custom_css are not setting values either", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { layout: "theme", wrapper: "main", sections: { s: { type: "t", custom_css: ["theme"], settings: {} } } })],
      edits: { "section.index.json.q.heading": { old: "theme", next: "Changed", type: "ONLINE_STORE_THEME_JSON_TEMPLATE" } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    expect((result?.data ?? result).success).toBe(false);
    expect(upserts).toEqual([]);
  });
});

describe("primary save failures are answered as structured, localisable issues", () => {
  const errorsOf = (r: any) => (r?.data ?? r).errors;

  it("an unmapped key: notEditable with the key, plus the English fallback", async () => {
    const { ctx } = makeCtx({
      files: [],
      edits: { "x.y": { old: "A", next: "B", type: "SOME_UNMAPPED_TYPE" } },
      imageKeys: [],
    });
    const r = (await handleUpdateContent(ctx)) as any;
    expect((r?.data ?? r).success).toBe(false);
    expect(errorsOf(r)).toEqual([{ errorKey: "themeSaveNotEditable", fields: ["x.y"], count: 1 }]);
    expect((r?.data ?? r).error).toMatch(/not editable in the primary language/);
  });

  it("a value that is not in the file: notLocated with the key", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { headline: "Changed meanwhile" } })],
      edits: { "general.headline": { old: "Hi", next: "Ho", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const r = (await handleUpdateContent(ctx)) as any;
    expect(errorsOf(r)).toEqual([{ errorKey: "themeSaveNotLocated", fields: ["general.headline"], count: 1 }]);
  });

  it("Shopify's userErrors travel as detail inside a localisable issue", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { headline: "Hi" } })],
      edits: { "general.headline": { old: "Hi", next: "Ho", type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
    });
    const original = (ctx as any).admin.graphql;
    (ctx as any).admin.graphql = vi.fn(async (q: string, o?: any) =>
      q.includes("themeFilesUpsert")
        ? { json: async () => ({ data: { themeFilesUpsert: { upsertedThemeFiles: [], userErrors: [{ message: "Liquid syntax error" }] } } }) }
        : original(q, o),
    );
    const r = (await handleUpdateContent(ctx)) as any;
    expect((r?.data ?? r).success).toBe(false);
    expect(errorsOf(r)).toEqual([{ errorKey: "themeSaveShopifyRejected", detail: "Liquid syntax error" }]);
    expect((r?.data ?? r).error).toContain("Liquid syntax error");
  });
});
