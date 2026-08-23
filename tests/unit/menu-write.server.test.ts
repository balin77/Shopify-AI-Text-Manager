/**
 * saveMenuItemTitles — the only write path in this app that sends a merchant's
 * WHOLE navigation back to Shopify.
 *
 * menuUpdate has no per-item form: an item missing from the list is deleted.
 * So almost every test here is about what the function refuses to do, and
 * about the two things it must carry through untouched — the fields it never
 * edits (url, resourceId, tags) and the items nobody renamed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const removeAndVerifyAcrossLocales = vi.fn();
const isPurgeOnPrimaryChangeEnabled = vi.fn();

vi.mock("~/services/bulk-editor/translations.server", () => ({
  removeAndVerifyAcrossLocales: (...args: unknown[]) => removeAndVerifyAcrossLocales(...args),
  // The real separator, not a stand-in: this test also pins that the write
  // path reads confirmations in the sweep's own (locale, key) shape.
  LOCALE_KEY_SEP: "\u0000",
}));
vi.mock("~/services/translations/translation-change-policy.server", () => ({
  isPurgeOnPrimaryChangeEnabled: (...args: unknown[]) => isPurgeOnPrimaryChangeEnabled(...args),
}));

import { saveMenuItemTitles } from "~/services/menu-write.server";
import { menuStructureFingerprint } from "~/services/menu-write.shared";

const SHOP = "s.myshopify.com";

const freshItems = [
  {
    id: "gid://shopify/MenuItem/10",
    title: "Produkte",
    type: "HTTP",
    url: "https://shop.test/produkte",
    tags: [],
    items: [
      {
        id: "gid://shopify/MenuItem/20",
        title: "Stifthalter",
        type: "COLLECTION",
        url: "https://shop.test/collections/stifthalter",
        resourceId: "gid://shopify/Collection/5",
        tags: ["a"],
        items: [],
      },
    ],
  },
  { id: "gid://shopify/MenuItem/40", title: "Kontakt", type: "PAGE", resourceId: "gid://shopify/Page/9", items: [] },
];

const menu = { id: "gid://shopify/Menu/1", title: "Hauptmenü", handle: "main-menu", items: freshItems };
const fingerprint = menuStructureFingerprint(freshItems);

const translationDeleteMany = vi.fn();
const db = { contentTranslation: { deleteMany: translationDeleteMany } } as never;

/** Renames item 20 in the echoed tree — what a healthy Shopify answers. */
function echoWith(title: string, options: { reassign?: boolean } = {}) {
  const items = structuredClone(freshItems) as typeof freshItems;
  items[0].items[0].title = title;
  if (options.reassign) items[0].items[0].id = "gid://shopify/MenuItem/999";
  return items;
}

/**
 * A gateway whose responses are queued in call order: read first, mutation
 * second. Returning the calls lets a test assert on what was SENT, which is
 * the only way to check "everything else was carried over".
 */
function makeGateway(responses: unknown[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: options?.variables ?? {} });
    const body = responses.shift() ?? {};
    return { json: async () => body };
  });
  return { gateway: { graphql } as never, calls };
}

const readOk = { data: { menu } };
const updateOk = (items: unknown) => ({ data: { menuUpdate: { menu: { id: menu.id, items }, userErrors: [] } } });

beforeEach(() => {
  vi.clearAllMocks();
  translationDeleteMany.mockResolvedValue({ count: 1 });
  isPurgeOnPrimaryChangeEnabled.mockResolvedValue(false);
  removeAndVerifyAcrossLocales.mockResolvedValue({ confirmedPairs: new Set<string>(), userErrors: [] });
});

describe("saveMenuItemTitles", () => {
  it("writes the fresh tree back with ONLY the changed title substituted", async () => {
    const { gateway, calls } = makeGateway([readOk, updateOk(echoWith("Stiftehalter"))]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("ok");
    expect(result.savedItemIds).toEqual(["gid://shopify/MenuItem/20"]);

    const sent = calls[1].variables.items as Array<Record<string, unknown>>;
    // The untouched sibling keeps its own title, and the menu's own title and
    // handle ride along unchanged — menuUpdate requires both and would rename
    // the MENU if they were guessed.
    expect(calls[1].variables.title).toBe("Hauptmenü");
    expect(calls[1].variables.handle).toBe("main-menu");
    expect(sent[1].title).toBe("Kontakt");
    // The renamed child keeps everything the rename does not touch. This is
    // the assertion that a cache-built write-back would fail: the cache has no
    // resourceId, so the collection link would have been sent as a bare entry.
    const child = (sent[0].items as Array<Record<string, unknown>>)[0];
    expect(child).toMatchObject({
      id: "gid://shopify/MenuItem/20",
      title: "Stiftehalter",
      type: "COLLECTION",
      url: "https://shop.test/collections/stifthalter",
      resourceId: "gid://shopify/Collection/5",
      tags: ["a"],
    });
    // A null resourceId is not sent as a key at all — an absent key and an
    // explicit null are different inputs to the mutation.
    expect(sent[0]).not.toHaveProperty("resourceId");
  });

  it("refuses the write when the tree changed in Shopify since the page loaded", async () => {
    const { gateway, calls } = makeGateway([readOk]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint: "something the page saw earlier",
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("structureChanged");
    // The decisive part: no mutation went out at all.
    expect(calls).toHaveLength(1);
  });

  it("treats a title Shopify did not echo back as a failure, never as saved", async () => {
    const { gateway } = makeGateway([readOk, updateOk(freshItems)]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: [],
    });

    expect(result.savedItemIds).toEqual([]);
    expect(result.failures[0].menuItemId).toBe("gid://shopify/MenuItem/20");
  });

  it("reports reassigned item ids — the case that would orphan translations", async () => {
    const { gateway } = makeGateway([readOk, updateOk(echoWith("Stiftehalter", { reassign: true }))]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: [],
    });

    expect(result.reassignedItemIds).toEqual([
      { before: "gid://shopify/MenuItem/20", after: "gid://shopify/MenuItem/999" },
    ]);
  });

  it("purges the renamed item's translations when the merchant's setting says so", async () => {
    isPurgeOnPrimaryChangeEnabled.mockResolvedValue(true);
    removeAndVerifyAcrossLocales.mockResolvedValue({
      // Only "en" is confirmed; "fr" is not echoed back.
      confirmedPairs: new Set(["en\u0000title"]),
      userErrors: [],
    });
    const { gateway } = makeGateway([readOk, updateOk(echoWith("Stiftehalter"))]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: ["en", "fr"],
    });

    // The Link GID is derived from the MenuItem's number, the measured rule.
    expect(removeAndVerifyAcrossLocales).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Link/20",
      ["title"],
      ["en", "fr"],
      "",
    );
    // The local row goes only where Shopify confirmed the removal.
    expect(translationDeleteMany.mock.calls[0][0].where.locale).toEqual({ in: ["en"] });
    expect(result.purgedLinkIds).toEqual(["gid://shopify/Link/20"]);
    // Menus are reconciled by no webhook, so they ask the unreconciled side.
    expect(isPurgeOnPrimaryChangeEnabled).toHaveBeenCalledWith(SHOP, db, { reconciled: false });
  });

  it("does not touch translations when the merchant switched the purge off", async () => {
    isPurgeOnPrimaryChangeEnabled.mockResolvedValue(false);
    const { gateway } = makeGateway([readOk, updateOk(echoWith("Stiftehalter"))]);

    await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: ["en"],
    });

    expect(removeAndVerifyAcrossLocales).not.toHaveBeenCalled();
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps the rename when the purge itself fails", async () => {
    isPurgeOnPrimaryChangeEnabled.mockResolvedValue(true);
    removeAndVerifyAcrossLocales.mockRejectedValue(new Error("throttled"));
    const { gateway } = makeGateway([readOk, updateOk(echoWith("Stiftehalter"))]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: ["en"],
    });

    // The primary text is already written; reporting the save as broken would
    // send the merchant into a retry that renames nothing.
    expect(result.status).toBe("ok");
    expect(result.savedItemIds).toEqual(["gid://shopify/MenuItem/20"]);
    expect(result.purgedLinkIds).toEqual([]);
  });

  it("refuses an empty title without failing the other renames", async () => {
    const { gateway, calls } = makeGateway([readOk, updateOk(echoWith("Stiftehalter"))]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [
        { menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" },
        { menuItemId: "gid://shopify/MenuItem/40", title: "   " },
      ],
      foreignLocales: [],
    });

    expect(result.savedItemIds).toEqual(["gid://shopify/MenuItem/20"]);
    expect(result.failures.map((f) => f.menuItemId)).toEqual(["gid://shopify/MenuItem/40"]);
    // The blank one was never sent, so Shopify's rejection of it cannot take
    // the good rename with it.
    const sent = calls[1].variables.items as Array<Record<string, unknown>>;
    expect(sent[1].title).toBe("Kontakt");
  });

  it("writes nothing when every requested title is blank", async () => {
    const { gateway, calls } = makeGateway([readOk]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/40", title: "" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("ok");
    expect(result.savedItemIds).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("refuses an id the fresh tree does not contain", async () => {
    const { gateway, calls } = makeGateway([readOk]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/777", title: "Fremd" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("unknownItems");
    expect(calls).toHaveLength(1);
  });

  it("reports a schema-level error instead of reading it as success", async () => {
    // A wrong input shape comes back as a top-level errors array with
    // data: null and never reaches userErrors.
    const { gateway } = makeGateway([readOk, { data: null, errors: [{ message: "Field 'nope' doesn't exist" }] }]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("writeFailed");
    expect(result.message).toContain("nope");
  });

  it("reports userErrors as a failed write", async () => {
    const { gateway } = makeGateway([
      readOk,
      { data: { menuUpdate: { menu: null, userErrors: [{ field: ["items"], message: "Title can't be blank" }] } } },
    ]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "Stiftehalter" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("writeFailed");
    expect(result.message).toBe("Title can't be blank");
  });

  it("reports a menu that is gone rather than creating one", async () => {
    const { gateway } = makeGateway([{ data: { menu: null } }]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [{ menuItemId: "gid://shopify/MenuItem/20", title: "X" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("menuMissing");
  });

  it("refuses a tree deeper than it can read back", async () => {
    // A level the read query does not cover would be MISSING from the
    // write-back, i.e. deleted. Refusing is the only safe answer.
    // Every level carries a type, or the required-field rail would fire first
    // and this test would pass for the wrong reason.
    const deep = [
      {
        id: "gid://shopify/MenuItem/1",
        title: "L1",
        type: "HTTP",
        items: [
          {
            id: "gid://shopify/MenuItem/2",
            title: "L2",
            type: "HTTP",
            items: [
              {
                id: "gid://shopify/MenuItem/3",
                title: "L3",
                type: "HTTP",
                items: [
                  {
                    id: "gid://shopify/MenuItem/4",
                    title: "L4",
                    type: "HTTP",
                    items: [{ id: "gid://shopify/MenuItem/5", title: "L5", type: "HTTP", items: [] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const { gateway, calls } = makeGateway([{ data: { menu: { ...menu, items: deep } } }]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint: menuStructureFingerprint(deep),
      changes: [{ menuItemId: "gid://shopify/MenuItem/2", title: "L2 neu" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("tooDeep");
    expect(calls).toHaveLength(1);
  });

  it("refuses an item whose required type the read did not return", async () => {
    // MEASURED: MenuItemUpdateInput takes title: String! and type: MenuItemType!.
    // A missing type fails at the schema level, which fails the WHOLE tree —
    // so it is refused before the mutation, not forwarded.
    const noType = [{ id: "gid://shopify/MenuItem/10", title: "Produkte", items: [] }];
    const { gateway, calls } = makeGateway([{ data: { menu: { ...menu, items: noType } } }]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint: menuStructureFingerprint(noType),
      changes: [{ menuItemId: "gid://shopify/MenuItem/10", title: "Produkte neu" }],
      foreignLocales: [],
    });

    expect(result.status).toBe("unwritableItem");
    expect(result.message).toContain("gid://shopify/MenuItem/10");
    expect(calls).toHaveLength(1);
  });

  it("does not read anything when there is nothing to rename", async () => {
    const { gateway, calls } = makeGateway([]);

    const result = await saveMenuItemTitles(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      changes: [],
      foreignLocales: ["en"],
    });

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(0);
  });
});
