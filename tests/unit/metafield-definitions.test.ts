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
            capabilities: { translatable: { enabled: false } },
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
            capabilities: { translatable: { enabled: true } },
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
