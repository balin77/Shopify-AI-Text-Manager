/**
 * Unit tests for the product metafield-definition scanner.
 *
 * Covers:
 *  - owner categorization (shop / contentpilot / third-party allowlist + app--)
 *  - ContentService.getProductMetafieldDefinitions() pagination + mapping
 *  - ContentService.updateMetafieldDefinitionTranslatable() success + userError
 *
 * No real Shopify or DB needed.
 */

import { describe, it, expect, vi } from "vitest";
import { categorizeMetafieldOwner } from "~/config/known-third-party-apps";
import { ContentService } from "~/services/content.service";
import { scanProductMetafields } from "~/services/metafield-enablement.server";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("categorizeMetafieldOwner()", () => {
  it("classifies our own namespace as contentpilot", () => {
    expect(categorizeMetafieldOwner("contentpilot").category).toBe("contentpilot");
    expect(categorizeMetafieldOwner("contentpilot.ai_summary").category).toBe("contentpilot");
  });

  it("classifies known third-party namespaces with an app name", () => {
    expect(categorizeMetafieldOwner("judgeme")).toEqual({ category: "third-party", appName: "Judge.me" });
    expect(categorizeMetafieldOwner("loox").appName).toBe("Loox");
    // suffixed namespaces still match the prefix
    expect(categorizeMetafieldOwner("judgeme.widget").category).toBe("third-party");
  });

  it("classifies Shopify app-reserved namespaces as third-party", () => {
    expect(categorizeMetafieldOwner("app--1234567--reviews").category).toBe("third-party");
  });

  it("classifies everything else as shop-owned", () => {
    expect(categorizeMetafieldOwner("custom")).toEqual({ category: "shop" });
    expect(categorizeMetafieldOwner("my_fields").category).toBe("shop");
  });
});

/** Build an admin mock whose graphql() returns the given metafieldDefinitions pages. */
function makeDefinitionsAdmin(
  pages: Array<{ nodes: Array<Record<string, unknown>>; hasNextPage: boolean; endCursor?: string | null }>,
) {
  let call = 0;
  return {
    graphql: vi.fn().mockImplementation(async () => {
      const page = pages[Math.min(call++, pages.length - 1)];
      return {
        json: async () => ({
          data: {
            metafieldDefinitions: {
              edges: page.nodes.map((node) => ({ node })),
              pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor ?? null },
            },
          },
        }),
      };
    }),
  };
}

describe("ContentService.getProductMetafieldDefinitions()", () => {
  it("paginates across pages and maps + categorizes each definition", async () => {
    const admin = makeDefinitionsAdmin([
      {
        nodes: [
          {
            id: "gid://shopify/MetafieldDefinition/1",
            namespace: "custom",
            key: "care_instructions",
            name: "Care instructions",
            description: null,
            type: { name: "single_line_text_field" },
            access: { storefront: "NONE" },
          },
        ],
        hasNextPage: true,
        endCursor: "cursor-1",
      },
      {
        nodes: [
          {
            id: "gid://shopify/MetafieldDefinition/2",
            namespace: "judgeme",
            key: "product_review_html",
            name: "Reviews",
            description: "Judge.me reviews",
            type: { name: "multi_line_text_field" },
            access: { storefront: "PUBLIC_READ" },
          },
        ],
        hasNextPage: false,
      },
    ]);

    const service = new ContentService(admin as never);
    const defs = await service.getProductMetafieldDefinitions();

    expect(admin.graphql).toHaveBeenCalledTimes(2);
    expect(defs).toHaveLength(2);

    expect(defs[0]).toMatchObject({
      id: "gid://shopify/MetafieldDefinition/1",
      namespace: "custom",
      key: "care_instructions",
      type: "single_line_text_field",
      translatable: false,
      ownerCategory: "shop",
    });

    expect(defs[1]).toMatchObject({
      namespace: "judgeme",
      translatable: true,
      ownerCategory: "third-party",
      appName: "Judge.me",
    });
  });

  it("throws on a GraphQL error", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({ errors: [{ message: "boom" }] }),
      }),
    };
    const service = new ContentService(admin as never);
    await expect(service.getProductMetafieldDefinitions()).rejects.toThrow(/boom/);
  });
});

describe("ContentService.updateMetafieldDefinitionTranslatable()", () => {
  it("returns ok:true when the mutation succeeds", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({
          data: { metafieldDefinitionUpdate: { updatedDefinition: { id: "x" }, userErrors: [] } },
        }),
      }),
    };
    const service = new ContentService(admin as never);
    const res = await service.updateMetafieldDefinitionTranslatable("custom", "care_instructions");
    expect(res.ok).toBe(true);
    // Lock the correct activation shape: storefront access PUBLIC_READ, not a
    // (non-existent) translatable capability.
    const [, opts] = admin.graphql.mock.calls[0];
    expect(opts.variables.definition).toMatchObject({
      namespace: "custom",
      key: "care_instructions",
      ownerType: "PRODUCT",
      access: { storefront: "PUBLIC_READ" },
    });
  });

  it("returns ok:false with the message on a userError (app-owned definition)", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({
          data: {
            metafieldDefinitionUpdate: {
              userErrors: [{ message: "Definition is owned by another app" }],
            },
          },
        }),
      }),
    };
    const service = new ContentService(admin as never);
    const res = await service.updateMetafieldDefinitionTranslatable("judgeme", "product_review_html");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/another app/);
  });
});

describe("scanProductMetafields() — data-driven", () => {
  /**
   * Admin mock that routes by query: the definitions query returns a page; the
   * translatableResource probe returns content per resourceId.
   */
  function makeScanAdmin(opts: {
    definitions: Array<Record<string, unknown>>;
    translatableGids: Set<string>;
  }) {
    return {
      graphql: vi.fn().mockImplementation(async (query: string, options?: { variables?: Record<string, unknown> }) => {
        if (query.includes("metafieldDefinitions(ownerType")) {
          return {
            json: async () => ({
              data: {
                metafieldDefinitions: {
                  edges: opts.definitions.map((node) => ({ node })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          };
        }
        // translatableResource probe
        const rid = String(options?.variables?.resourceId ?? "");
        const content = opts.translatableGids.has(rid) ? [{ key: "value" }] : [];
        return { json: async () => ({ data: { translatableResource: { translatableContent: content } } }) };
      }),
    };
  }

  it("surfaces definition-less third-party metafields and probes translatability", async () => {
    const admin = makeScanAdmin({
      definitions: [], // no merchant-visible definitions (app-owned / none)
      translatableGids: new Set(["gid://shopify/Metafield/2"]), // judgeme is translatable
    });
    const db = {
      productMetafield: {
        findMany: vi.fn().mockResolvedValue([
          { id: "gid://shopify/Metafield/1", namespace: "custom", key: "care", type: "single_line_text_field" },
          { id: "gid://shopify/Metafield/2", namespace: "judgeme", key: "reviews", type: "multi_line_text_field" },
          { id: "gid://shopify/Metafield/3", namespace: "custom", key: "specs", type: "json" }, // non-text → skipped
        ]),
      },
    };

    const scanned = await scanProductMetafields(admin as never, db as never, "shop.myshopify.com");

    // json type excluded
    expect(scanned).toHaveLength(2);

    const care = scanned.find((d) => d.key === "care")!;
    expect(care).toMatchObject({
      id: "custom.care", // synthetic id (no definition)
      ownerCategory: "shop",
      hasDefinition: false,
      translatable: false,
    });

    const reviews = scanned.find((d) => d.key === "reviews")!;
    expect(reviews).toMatchObject({
      id: "judgeme.reviews",
      ownerCategory: "third-party",
      appName: "Judge.me",
      hasDefinition: false,
      translatable: true, // confirmed via probe
    });
  });

  it("marks a public shop definition as translatable without probing", async () => {
    const admin = makeScanAdmin({
      definitions: [
        {
          id: "gid://shopify/MetafieldDefinition/9",
          namespace: "custom",
          key: "care",
          name: "Care",
          description: null,
          type: { name: "single_line_text_field" },
          access: { storefront: "PUBLIC_READ" },
        },
      ],
      translatableGids: new Set(),
    });
    const db = {
      productMetafield: {
        findMany: vi.fn().mockResolvedValue([
          { id: "gid://shopify/Metafield/1", namespace: "custom", key: "care", type: "single_line_text_field" },
        ]),
      },
    };

    const scanned = await scanProductMetafields(admin as never, db as never, "shop.myshopify.com");
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({
      id: "gid://shopify/MetafieldDefinition/9", // definition GID
      hasDefinition: true,
      translatable: true,
    });
    // The probe must NOT run for an already-public definition.
    const probeCalls = (admin.graphql.mock.calls as Array<[string]>).filter(([q]) => q.includes("translatableResource"));
    expect(probeCalls).toHaveLength(0);
  });
});
