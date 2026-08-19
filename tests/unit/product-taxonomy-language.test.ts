/**
 * The category lookup answers in the language the APP is rendered in.
 *
 * Shopify translates its own taxonomy and hands the translation over through
 * `@inContext(language:)`. Without it the names follow the ADMIN SESSION's
 * language — a different setting, and routinely a different language: a German
 * merchant whose shop was set up in English got a German UI with an English
 * category list and could search it in neither.
 *
 * The rule that makes this safe to ship is the second half: a directive the
 * schema refuses fails the WHOLE query, and it arrives as a top-level `errors`
 * array with `data: null`, exactly like every other schema-level error in this
 * app. Read straight through, that would turn a LABEL problem into "the product
 * taxonomy could not be searched". So the localized attempt is retried once
 * without the directive, and only a second failure is a failed lookup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));
vi.mock("~/db.server", () => ({ db: { collection: { findMany: vi.fn(async () => []) } } }));
vi.mock("../../app/db.server", () => ({ db: { collection: { findMany: vi.fn(async () => []) } } }));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { loader } = await import("~/routes/api.product-taxonomy");

const NODE = {
  id: "gid://shopify/TaxonomyCategory/1",
  name: "Bekleidung & Accessoires",
  fullName: "Bekleidung & Accessoires",
  isLeaf: false,
};

/** Every query the route sent, in order. */
let sent: string[] = [];

/**
 * @param failLocalized answer a query CARRYING the directive with a
 *        schema-level error, the way a refused directive actually arrives.
 * @param failAll answer every query that way.
 */
function stubAdmin(opts: { failLocalized?: boolean; failAll?: boolean; throttled?: boolean } = {}) {
  authenticate.admin.mockResolvedValue({
    session: { shop: "test.myshopify.com" },
    admin: {
      graphql: async (query: string) => {
        sent.push(query);
        const refuse = opts.failAll || opts.throttled || (opts.failLocalized && query.includes("@inContext"));
        return {
          json: async () =>
            refuse
              ? {
                  data: null,
                  errors: [
                    opts.throttled
                      ? { message: "Throttled", extensions: { code: "THROTTLED" } }
                      : { message: "Directive 'inContext' is not supported." },
                  ],
                }
              : {
                  data: {
                    taxonomy: { categories: { nodes: [NODE], pageInfo: { hasNextPage: false } } },
                  },
                },
        } as unknown as Response;
      },
    },
  });
}

const call = (query: string) =>
  loader({
    request: new Request(`https://example.com/api/product-taxonomy?${query}`),
    params: {},
    context: {} as any,
  } as any);

/** `data()` from react-router keeps the payload on `.data`. */
const payload = async (result: any) => (result?.data ?? result) as any;

describe("api.product-taxonomy — the language of the names", () => {
  beforeEach(() => {
    sent = [];
    authenticate.admin.mockReset();
  });

  it("browses in the app's language", async () => {
    stubAdmin();
    const result = await payload(await call("kind=taxonomy-children&parent=&lang=de"));

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("@inContext(language: DE)");
  });

  it("searches in the app's language", async () => {
    stubAdmin();
    const result = await payload(await call("kind=taxonomy&q=hemd&lang=es"));

    expect(result.success).toBe(true);
    expect(sent[0]).toContain("@inContext(language: ES)");
  });

  it("sends no directive for a language this app does not have", async () => {
    stubAdmin();
    // Not an app language, and not a rejection either: the merchant gets the
    // shop default rather than an error about a label.
    const result = await payload(await call("kind=taxonomy-children&parent=&lang=fr"));

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("@inContext");
  });

  it("sends no directive when the caller names no language at all", async () => {
    stubAdmin();
    await call("kind=taxonomy-children&parent=");

    expect(sent[0]).not.toContain("@inContext");
  });

  it("falls back to the shop default when the directive is refused, rather than failing", async () => {
    stubAdmin({ failLocalized: true });
    const result = await payload(await call("kind=taxonomy-children&parent=&lang=de"));

    // Two attempts, and the SECOND one carries no directive.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("@inContext");
    expect(sent[1]).not.toContain("@inContext");
    // The merchant gets a list, in whatever language the shop answers in.
    expect(result.success).toBe(true);
    expect(result.level.categories).toHaveLength(1);
  });

  it("still reports a lookup that fails in BOTH attempts as failed", async () => {
    stubAdmin({ failAll: true });
    const response = await call("kind=taxonomy-children&parent=&lang=de");
    const result = await payload(response);

    expect(sent).toHaveLength(2);
    // An empty level would say "this branch has no subcategories", which is a
    // different statement and the wrong one.
    expect(result.success).toBe(false);
    expect((response as any).init?.status ?? (response as any).status).toBe(502);
  });

  it("does not answer a throttle with a second query", async () => {
    stubAdmin({ throttled: true });
    const result = await payload(await call("kind=taxonomy-children&parent=&lang=de"));

    // Asking again in the same breath is the one wrong response to "you are
    // asking too often" — and the retry could not have succeeded anyway.
    expect(sent).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it("retries the search half the same way", async () => {
    stubAdmin({ failLocalized: true });
    const result = await payload(await call("kind=taxonomy&q=hemd&lang=de"));

    expect(sent).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.categories).toHaveLength(1);
  });
});
