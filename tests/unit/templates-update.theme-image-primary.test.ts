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

  it("refuses to guess when the old image is used in more places than the save names", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD, footer_logo: OLD } })],
      edits: { [SETTINGS_KEY]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_SETTINGS_CATEGORY" } },
      fileIds: { [SETTINGS_KEY]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeImageAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("two blocks holding the SAME old image, both changed in one save: refused, never s2 = s1's image", async () => {
    // Reproduction of the review finding: occurrences == keys let the save through,
    // and both keys (same property name) then hit the first slot.
    const k1 = "section.index.json.s1.image";
    const k2 = "section.index.json.s2.image";
    const files = [themeFile("templates/index.json", { sections: { s1: { settings: { image: OLD } }, s2: { settings: { image: OLD } } } })];
    const { ctx } = makeCtx({
      files,
      edits: {
        [k1]: { old: OLD, next: NEW, type: "ONLINE_STORE_THEME_JSON_TEMPLATE" },
        [k2]: { old: OLD, next: "shopify://shop_images/two.png", type: "ONLINE_STORE_THEME_JSON_TEMPLATE" },
      },
      fileIds: { [k1]: FILE_ID, [k2]: FILE_ID },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeImageAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("an ambiguous image blocks the WHOLE save, text keys included", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("config/settings_data.json", { current: { logo: OLD, footer_logo: OLD, headline: "Alt" } })],
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

describe("primary theme TEXT save is written only where unambiguous", () => {
  const TYPE = "ONLINE_STORE_THEME_JSON_TEMPLATE";

  it("two headings with the same old text: changing one refuses the save, the other is never rewritten", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { a: { settings: { heading: "Hi" } }, b: { settings: { heading: "Hi" } } } })],
      edits: { "section.index.json.a.heading": { old: "Hi", next: "Ho", type: TYPE } },
    });
    const result = (await handleUpdateContent(ctx)) as any;
    const body = result?.data ?? result;
    expect(body.success).toBe(false);
    expect(body.errorKey).toBe("themeTextAmbiguous");
    expect(upserts).toEqual([]);
  });

  it("two keys carrying the same old text in one file are refused too", async () => {
    const { ctx } = makeCtx({
      files: [themeFile("templates/index.json", { sections: { a: { settings: { heading: "Hi" } }, b: { settings: { heading: "Hi" } } } })],
      edits: {
        "section.index.json.a.heading": { old: "Hi", next: "Ho", type: TYPE },
        "section.index.json.b.heading": { old: "Hi", next: "Hu", type: TYPE },
      },
    });
    const body = ((await handleUpdateContent(ctx)) as any);
    expect((body?.data ?? body).errorKey).toBe("themeTextAmbiguous");
    expect(upserts).toEqual([]);
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
});
