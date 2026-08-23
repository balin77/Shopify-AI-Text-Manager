/**
 * saveMenuTree — the write that states a merchant's whole navigation.
 *
 * The rename path's tests are about what it refuses. These are about what it
 * must GET RIGHT while deliberately doing the dangerous thing: sending a tree
 * in which positions, parents and membership are all the merchant's intent.
 *
 * Two of them are the reason the module exists at all. Re-parenting destroys
 * translations (measured), so the values have to be captured BEFORE the write
 * and restored after — and the capture has to cover the descendants that came
 * along. Everything else is the same posture as every other write path here:
 * refuse in front of the mutation, verify the echo, never trust userErrors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const captureLinkTranslations = vi.fn();
const restoreLinkTranslations = vi.fn();
const loadTranslationChangePolicy = vi.fn();
const reconcileAfterPrimarySave = vi.fn();
/** The separator `removeAndVerifyAcrossLocales` joins a confirmed pair with,
 *  written as an ESCAPE: a literal NUL makes git treat this file as binary, and
 *  the tests that decide which translations get deleted would then be invisible
 *  in every diff (CLAUDE.md). Repeated inside the `vi.mock` factory below
 *  because that call is HOISTED and cannot see a top-level const. */
const LOCALE_KEY_SEP = "\u0000";
const removeAndVerifyAcrossLocales = vi.fn();

vi.mock("~/services/menu-translation-repair.server", () => ({
  captureLinkTranslations: (...args: unknown[]) => captureLinkTranslations(...args),
  restoreLinkTranslations: (...args: unknown[]) => restoreLinkTranslations(...args),
}));
vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: (...args: unknown[]) => loadTranslationChangePolicy(...args),
}));
vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  reconcileAfterPrimarySave: (...args: unknown[]) => reconcileAfterPrimarySave(...args),
}));
vi.mock("~/services/bulk-editor/translations.server", () => ({
  removeAndVerifyAcrossLocales: (...args: unknown[]) => removeAndVerifyAcrossLocales(...args),
  LOCALE_KEY_SEP: "\u0000",
}));

import { saveMenuTree } from "~/services/menu-tree.server";
import { menuStructureFingerprint } from "~/services/menu-write.shared";
import { editorNodesFromRawTree, type MenuEditorNode } from "~/services/menu-tree.shared";

const SHOP = "s.myshopify.com";

/** What Shopify holds: Produkte > Stifthalter > Holz, plus Kontakt (a page). */
const freshItems = [
  {
    id: "gid://shopify/MenuItem/1",
    title: "Produkte",
    type: "HTTP",
    url: "https://shop.test/produkte",
    tags: [],
    items: [
      {
        id: "gid://shopify/MenuItem/2",
        title: "Stifthalter",
        type: "COLLECTION",
        url: "https://shop.test/collections/stifthalter",
        resourceId: "gid://shopify/Collection/5",
        tags: ["a"],
        items: [
          {
            id: "gid://shopify/MenuItem/3",
            title: "Holz",
            type: "HTTP",
            url: "https://shop.test/holz",
            tags: [],
            items: [],
          },
        ],
      },
    ],
  },
  {
    id: "gid://shopify/MenuItem/4",
    title: "Kontakt",
    type: "PAGE",
    resourceId: "gid://shopify/Page/9",
    tags: [],
    items: [],
  },
];

const menu = { id: "gid://shopify/Menu/1", title: "Hauptmenü", handle: "main-menu", items: freshItems };
const fingerprint = menuStructureFingerprint(freshItems);
const baseTree = editorNodesFromRawTree(freshItems);

const translationDeleteMany = vi.fn();
const db = { contentTranslation: { deleteMany: translationDeleteMany } } as never;

function makeGateway(responses: unknown[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const graphql = vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: options?.variables ?? {} });
    return { json: async () => responses.shift() ?? {} };
  });
  return { gateway: { graphql } as never, calls };
}

const readOk = { data: { menu } };
/** A healthy echo: the tree exactly as sent, with ids filled in by position. */
function echoOf(sent: Array<Record<string, unknown>>, mint: (index: number) => string = () => "gid://shopify/MenuItem/new") {
  let counter = 0;
  const walk = (nodes: Array<Record<string, unknown>>): unknown[] =>
    nodes.map((node) => ({
      id: node.id ?? mint(counter++),
      title: node.title,
      type: node.type,
      url: node.url ?? null,
      resourceId: node.resourceId ?? null,
      tags: node.tags ?? [],
      items: walk((node.items as Array<Record<string, unknown>>) ?? []),
    }));
  return { data: { menuUpdate: { menu: { id: menu.id, items: walk(sent) }, userErrors: [] } } };
}

/** Runs the save and echoes back whatever the mutation was handed. */
async function runSave(
  tree: MenuEditorNode[],
  options: { locales?: string[]; markets?: string[]; primaryLocale?: string } = {},
) {
  const responses: unknown[] = [readOk];
  const { gateway, calls } = makeGateway(responses);
  // The echo is produced from the ACTUAL input, so a test cannot accidentally
  // assert against a tree the code never sent.
  (gateway as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql.mockImplementation(
    async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: opts?.variables ?? {} });
      if (query.includes("menuTreeForWrite")) return { json: async () => readOk };
      if (query.includes("menuTreeUpdate")) {
        return { json: async () => echoOf(opts?.variables?.items as Array<Record<string, unknown>>) };
      }
      return { json: async () => ({}) };
    },
  );
  const result = await saveMenuTree(gateway, db, SHOP, {
    menuId: menu.id,
    fingerprint,
    tree,
    foreignLocales: options.locales ?? [],
    primaryLocale: options.primaryLocale ?? "de",
    marketIds: options.markets ?? [],
  });
  return { result, calls };
}

/**
 * Same as runSave, but hands the capture mock a look at how many Shopify calls
 * have been made so far. Separate rather than an extra parameter on runSave,
 * so the ordinary tests stay readable.
 */
async function runSaveWithHook(
  tree: MenuEditorNode[],
  options: { locales?: string[]; markets?: string[] },
  onCapture: (gatewayCallCount: number) => void,
) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables ?? {} });
    if (query.includes("menuTreeForWrite")) return { json: async () => readOk };
    if (query.includes("menuTreeUpdate")) {
      return { json: async () => echoOf(opts?.variables?.items as Array<Record<string, unknown>>) };
    }
    return { json: async () => ({}) };
  });
  const previous = captureLinkTranslations.getMockImplementation();
  captureLinkTranslations.mockImplementation(async (...args: unknown[]) => {
    onCapture(calls.length);
    return previous ? previous(...args) : [];
  });
  const result = await saveMenuTree({ graphql } as never, db, SHOP, {
    menuId: menu.id,
    fingerprint,
    tree,
    foreignLocales: options.locales ?? [],
    primaryLocale: "de",
    marketIds: options.markets ?? [],
  });
  return { result, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  translationDeleteMany.mockResolvedValue({ count: 0 });
  loadTranslationChangePolicy.mockResolvedValue({
    purgeOnPrimaryChange: false,
    purgeUnreconciledSurfaces: false,
    autoTranslateExternalChanges: false,
    plan: "max",
  });
  reconcileAfterPrimarySave.mockResolvedValue({ removed: 0, retranslating: 0 });
  captureLinkTranslations.mockResolvedValue([]);
  restoreLinkTranslations.mockResolvedValue({ restored: 0, failed: [] });
  removeAndVerifyAcrossLocales.mockResolvedValue({ confirmedPairs: new Set<string>(), userErrors: [] });
});

describe("saveMenuTree", () => {
  it("carries over the fields the editor never shows", async () => {
    // The assertion a write-back built from the editor alone would fail: the
    // collection binding and the tags come from Shopify's own read.
    const reordered = [baseTree[1], baseTree[0]];
    const { result, calls } = await runSave(reordered);

    expect(result.status).toBe("ok");
    const sent = calls[1].variables.items as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({ id: "gid://shopify/MenuItem/4", type: "PAGE", resourceId: "gid://shopify/Page/9" });
    const child = (sent[1].items as Array<Record<string, unknown>>)[0];
    expect(child).toMatchObject({
      type: "COLLECTION",
      resourceId: "gid://shopify/Collection/5",
      url: "https://shop.test/collections/stifthalter",
      tags: ["a"],
    });
    // The menu's own title and handle ride along unchanged.
    expect(calls[1].variables.title).toBe("Hauptmenü");
    expect(calls[1].variables.handle).toBe("main-menu");
  });

  it("sends a new item WITHOUT an id and resolves its real id by position", async () => {
    const withNew: MenuEditorNode[] = [
      ...baseTree,
      { id: null, key: "tmp-1", title: "Neu", type: "HTTP", url: "https://shop.test/neu", children: [] },
    ];
    const { result, calls } = await runSave(withNew);

    const sent = calls[1].variables.items as Array<Record<string, unknown>>;
    expect(sent[2]).not.toHaveProperty("id");
    // MEASURED: it comes back at exactly the position it was sent at, which is
    // the editor's only handle on it.
    expect(result.createdIds["tmp-1"]).toBe("gid://shopify/MenuItem/new");
    expect(result.diff.created).toEqual(["tmp-1"]);
  });

  it("omits a deleted item and drops its local translation rows", async () => {
    const withoutKontakt = [baseTree[0]];
    const { result, calls } = await runSave(withoutKontakt);

    const sent = calls[1].variables.items as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(result.diff.deleted).toEqual(["gid://shopify/MenuItem/4"]);
    // Shopify already took the translation with the item (measured), so this
    // is bookkeeping — but leaving the row would strand it forever.
    expect(translationDeleteMany.mock.calls[0][0].where.resourceId).toEqual({
      in: ["gid://shopify/Link/4"],
    });
  });

  it("captures the moved branch BEFORE the write and restores it after", async () => {
    captureLinkTranslations.mockResolvedValue([
      { linkId: "gid://shopify/Link/2", values: [{ locale: "en", marketId: "", value: "Pen holders" }] },
    ]);
    restoreLinkTranslations.mockResolvedValue({ restored: 1, failed: [] });

    const hoisted = [
      { ...baseTree[0], children: [] },
      baseTree[0].children[0],
      baseTree[1],
    ];
    // Recorded INSIDE the capture: how many Shopify calls had gone out by the
    // time it ran. Comparing it against the mutation afterwards is the only
    // way to prove the ordering rather than infer it — and the ordering is the
    // whole feature, because after the write there is nothing left to read.
    let gatewayCallsAtCapture = -1;
    const { result, calls } = await runSaveWithHook(
      hoisted,
      { locales: ["en"], markets: ["gid://shopify/Market/1"] },
      (callCount) => {
        gatewayCallsAtCapture = callCount;
      },
    );

    // The moved item AND the child that came along — measured: both lose it.
    const capturedIds = captureLinkTranslations.mock.calls[0][1] as string[];
    expect(capturedIds.sort()).toEqual(["gid://shopify/Link/2", "gid://shopify/Link/3"]);
    // Markets are part of the repair's scope, not just the global layer.
    expect(captureLinkTranslations.mock.calls[0][3]).toEqual(["gid://shopify/Market/1"]);
    expect(result.translationRepair.restored).toBe(1);

    // Only the fresh READ had happened when the capture ran — the mutation
    // that destroys the values had not gone out yet.
    expect(gatewayCallsAtCapture).toBe(1);
    expect(calls[1].query).toContain("menuTreeUpdate");
  });

  it("does not capture anything for a pure reorder", async () => {
    // Measured: reordering within the same parent keeps the translation, so
    // paying for a repair here would be pure cost.
    await runSave([baseTree[1], baseTree[0]], { locales: ["en"] });
    expect(captureLinkTranslations).not.toHaveBeenCalled();
  });

  it("reports a failed restore without failing the save", async () => {
    captureLinkTranslations.mockResolvedValue([
      { linkId: "gid://shopify/Link/2", values: [{ locale: "en", marketId: "", value: "Pen holders" }] },
    ]);
    restoreLinkTranslations.mockResolvedValue({
      restored: 0,
      failed: [{ linkId: "gid://shopify/Link/2", message: "no digest" }],
    });
    const hoisted = [{ ...baseTree[0], children: [] }, baseTree[0].children[0], baseTree[1]];
    const { result } = await runSave(hoisted, { locales: ["en"] });

    // The tree IS written; telling the merchant it failed would send them into
    // a retry that rewrites a tree that is already correct.
    expect(result.status).toBe("ok");
    expect(result.translationRepair.failed).toHaveLength(1);
  });

  it("RE-TRANSLATES a rename instead of deleting it when auto-translate is on", async () => {
    // A menu has no webhook and no sync of its own, so this save is the only
    // event that will ever notice — which is why the deletion used to stand
    // regardless of the switch.
    loadTranslationChangePolicy.mockResolvedValue({
      purgeOnPrimaryChange: false,
      purgeUnreconciledSurfaces: true,
      autoTranslateExternalChanges: true,
      plan: "max",
    });
    captureLinkTranslations.mockResolvedValue([]);
    restoreLinkTranslations.mockResolvedValue({ restored: 0, failed: [] });
    // The repair took responsibility for this rename.
    reconcileAfterPrimarySave.mockResolvedValue({ removed: 0, retranslating: 1 });

    const tree = [
      { ...baseTree[0] },
      { ...baseTree[1], title: "Kontakt & Anfahrt" },
    ];
    const { result } = await runSave(tree, { locales: ["en"] });

    expect(removeAndVerifyAcrossLocales).not.toHaveBeenCalled();
    expect(result.purgedTranslationCount).toBe(0);
    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);

    const args = reconcileAfterPrimarySave.mock.calls[0][0] as Record<string, unknown>;
    // The GROUP is the menu; each entry names the LINK its translation lives on.
    expect(args.resourceId).toBe(menu.id);
    expect(args.taskResourceType).toBe("menu");
    expect(args.changed).toEqual([
      {
        resourceId: "gid://shopify/Link/4",
        resourceType: "Link",
        key: "title",
        // A rename keeps the translation and only flags it outdated, so the
        // read-back must show the NEW title before anything is translated
        // against it.
        expectedValue: "Kontakt & Anfahrt",
      },
    ]);
  });

  it("falls back to the deletion when the repair did NOTHING", async () => {
    // A throttled read-back, a spent detection budget, a locale whose query
    // failed — the repair legitimately reports nothing. Menus have no webhook
    // and no sync, so "nothing happened" means the stale title stays live for
    // good unless the deletion takes over.
    loadTranslationChangePolicy.mockResolvedValue({
      purgeOnPrimaryChange: false,
      purgeUnreconciledSurfaces: true,
      autoTranslateExternalChanges: true,
      plan: "max",
    });
    reconcileAfterPrimarySave.mockResolvedValue({ removed: 0, retranslating: 0 });
    removeAndVerifyAcrossLocales.mockResolvedValue({
      confirmedPairs: new Set([`en${LOCALE_KEY_SEP}title`]),
      userErrors: [],
    });
    captureLinkTranslations.mockResolvedValue([]);
    restoreLinkTranslations.mockResolvedValue({ restored: 0, failed: [] });

    const tree = [
      { ...baseTree[0] },
      { ...baseTree[1], title: "Kontakt & Anfahrt" },
    ];
    const { result } = await runSave(tree, { locales: ["en"] });

    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    expect(result.purgedTranslationCount).toBe(1);
  });

  it("falls back to the deletion when the primary locale is unknown", async () => {
    // Nothing to translate FROM, so the repair cannot run — and leaving the
    // stale title translation live is the one direction this never takes.
    loadTranslationChangePolicy.mockResolvedValue({
      purgeOnPrimaryChange: false,
      purgeUnreconciledSurfaces: true,
      autoTranslateExternalChanges: true,
      plan: "max",
    });
    removeAndVerifyAcrossLocales.mockResolvedValue({
      confirmedPairs: new Set([`en${LOCALE_KEY_SEP}title`]),
      userErrors: [],
    });
    captureLinkTranslations.mockResolvedValue([]);
    restoreLinkTranslations.mockResolvedValue({ restored: 0, failed: [] });

    const tree = [
      { ...baseTree[0] },
      { ...baseTree[1], title: "Kontakt & Anfahrt" },
    ];
    const { result } = await runSave(tree, { locales: ["en"], primaryLocale: "" });

    expect(reconcileAfterPrimarySave).not.toHaveBeenCalled();
    expect(result.purgedTranslationCount).toBe(1);
  });

  it("purges a renamed item's translations, but never one that also moved", async () => {
    loadTranslationChangePolicy.mockResolvedValue({
      purgeOnPrimaryChange: true,
      purgeUnreconciledSurfaces: true,
      autoTranslateExternalChanges: false,
      plan: "max",
    });
    removeAndVerifyAcrossLocales.mockResolvedValue({
      confirmedPairs: new Set([`en${LOCALE_KEY_SEP}title`]),
      userErrors: [],
    });
    captureLinkTranslations.mockResolvedValue([
      { linkId: "gid://shopify/Link/2", values: [{ locale: "en", marketId: "", value: "Pen holders" }] },
    ]);
    restoreLinkTranslations.mockResolvedValue({ restored: 1, failed: [] });

    // Item 2 is renamed AND hoisted; item 4 is only renamed.
    const tree = [
      { ...baseTree[0], children: [] },
      { ...baseTree[0].children[0], title: "Stiftehalter" },
      { ...baseTree[1], title: "Kontakt & Anfahrt" },
    ];
    const { result } = await runSave(tree, { locales: ["en"] });

    // Purging the moved-and-renamed item would delete the repair that just put
    // its translation back — the rename's intent is served by the value being
    // flagged outdated instead.
    expect(removeAndVerifyAcrossLocales).toHaveBeenCalledTimes(1);
    expect(removeAndVerifyAcrossLocales.mock.calls[0][1]).toBe("gid://shopify/Link/4");
    expect(result.purgedTranslationCount).toBe(1);
  });

  it("refuses a tree Shopify would reject, before the mutation", async () => {
    const bad = [{ ...baseTree[1], title: "  " }];
    const { result, calls } = await runSave(bad);
    expect(result.status).toBe("invalidTree");
    expect(result.problems[0].code).toBe("emptyTitle");
    expect(calls).toHaveLength(1);
  });

  it("refuses and DESCRIBES a tree that changed in Shopify meanwhile", async () => {
    const { gateway, calls } = makeGateway([readOk]);
    const result = await saveMenuTree(gateway, db, SHOP, {
      menuId: menu.id,
      // What the page saw: one item, differently named. Four fields since the
      // fingerprint covers the TARGET too — the editor substitutes it.
      fingerprint: "1\tgid://shopify/MenuItem/1\tHTTP|/produkte\tProdukte alt",
      tree: baseTree,
      foreignLocales: [],
      primaryLocale: "de",
      marketIds: [],
    });

    expect(result.status).toBe("structureChanged");
    expect(calls).toHaveLength(1);
    // "The menu changed" is not actionable; naming what changed is.
    expect(result.foreignChanges?.renamed).toEqual([{ from: "Produkte alt", to: "Produkte" }]);
    expect(result.foreignChanges?.added.sort()).toEqual(["Holz", "Kontakt", "Stifthalter"]);
  });

  it("refuses an id the fresh tree does not know", async () => {
    const bogus: MenuEditorNode[] = [
      { id: "gid://shopify/MenuItem/777", key: "gid://shopify/MenuItem/777", title: "Fremd", type: "HTTP", url: "https://x.test", children: [] },
      ...baseTree,
    ];
    // The fingerprint is of the FRESH tree, so this is a malformed payload
    // rather than a race — and half-applying it is worse than refusing.
    const { gateway } = makeGateway([readOk]);
    const result = await saveMenuTree(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      tree: bogus,
      foreignLocales: [],
      primaryLocale: "de",
      marketIds: [],
    });
    expect(result.status).toBe("unknownItems");
  });

  it("reports a schema-level error instead of reading it as success", async () => {
    const { gateway } = makeGateway([readOk, { data: null, errors: [{ message: "Field 'nope'" }] }]);
    const result = await saveMenuTree(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      tree: [baseTree[1], baseTree[0]],
      foreignLocales: [],
      primaryLocale: "de",
      marketIds: [],
    });
    expect(result.status).toBe("writeFailed");
    expect(result.message).toContain("nope");
  });

  it("reports userErrors as a failed write", async () => {
    const { gateway } = makeGateway([
      readOk,
      { data: { menuUpdate: { menu: null, userErrors: [{ message: "Menu has more than 3 levels of nesting" }] } } },
    ]);
    const result = await saveMenuTree(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      tree: [baseTree[1], baseTree[0]],
      foreignLocales: [],
      primaryLocale: "de",
      marketIds: [],
    });
    expect(result.status).toBe("writeFailed");
    expect(result.message).toContain("3 levels");
  });

  it("reports a menu that is gone", async () => {
    const { gateway } = makeGateway([{ data: { menu: null } }]);
    const result = await saveMenuTree(gateway, db, SHOP, {
      menuId: menu.id,
      fingerprint,
      tree: baseTree,
      foreignLocales: [],
      primaryLocale: "de",
      marketIds: [],
    });
    expect(result.status).toBe("menuMissing");
  });
});
