/**
 * The option write paths, which are the first ones in this app that change a
 * product's VARIANT MATRIX.
 *
 * Renaming an option value has no consequences. Adding one creates variants;
 * deleting one DELETES them, with their stock, prices, SKUs and image
 * assignments. So the tests here are mostly about two things: that the
 * variant-changing argument is sent exactly when the matrix actually moves, and
 * that nothing is mirrored into the cache that Shopify did not echo back.
 */

import { describe, it, expect, vi } from "vitest";
import { parseValueOrderPayload } from "~/services/product-options.shared";
import {
  applyOptionChange,
  countVariantsPerValue,
  createOption,
  deleteOption,
  reorderOptions,
  variantCountKey,
} from "~/services/product-options.server";

const PRODUCT = "gid://shopify/Product/1";
const OPTION = "gid://shopify/ProductOption/10";

function adminWith(body: unknown) {
  return { graphql: vi.fn().mockResolvedValue({ json: async () => body }) } as never;
}

/** Records what reached the cache. */
function dbRecorder() {
  const upserts: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  return {
    upserts,
    deletes,
    db: {
      productOption: {
        upsert: vi.fn(async (args: Record<string, unknown>) => {
          upserts.push(args);
          return {};
        }),
        deleteMany: vi.fn(async (args: Record<string, unknown>) => {
          deletes.push(args);
          return { count: 0 };
        }),
      },
    } as never,
  };
}

const echo = (field: string, options: unknown) => ({
  data: { [field]: { product: { id: PRODUCT, options }, userErrors: [] } },
});

const OPTION_ECHO = [
  {
    id: OPTION,
    name: "Colour",
    position: 1,
    optionValues: [
      { id: "gid://shopify/ProductOptionValue/1", name: "Red" },
      { id: "gid://shopify/ProductOptionValue/2", name: "Blue" },
    ],
  },
];

const sent = (admin: never) =>
  (admin as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;

describe("applyOptionChange", () => {
  it("sends NO variant strategy for a plain rename", async () => {
    // Renaming does not move the matrix, and asking Shopify to reconcile one
    // that did not move is a request for work with a chance of going wrong.
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db } = dbRecorder();

    await applyOptionChange(admin, db, "s", {
      productId: PRODUCT,
      optionId: OPTION,
      values: { toUpdate: [{ id: "gid://shopify/ProductOptionValue/1", name: "Crimson" }] },
    });

    expect(sent(admin).variantStrategy).toBeUndefined();
    expect(sent(admin).optionValuesToUpdate).toEqual([
      { id: "gid://shopify/ProductOptionValue/1", name: "Crimson" },
    ]);
  });

  it("sends MANAGE when a value is added, so the variants come with it", async () => {
    // LEAVE_AS_IS would leave a value nobody can order — the merchant added
    // "red" because they now sell red.
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db } = dbRecorder();

    await applyOptionChange(admin, db, "s", {
      productId: PRODUCT,
      optionId: OPTION,
      values: { toAdd: ["Green"] },
    });

    expect(sent(admin).variantStrategy).toBe("MANAGE");
    expect(sent(admin).optionValuesToAdd).toEqual([{ name: "Green" }]);
  });

  it("sends MANAGE when a value is deleted", async () => {
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db } = dbRecorder();

    await applyOptionChange(admin, db, "s", {
      productId: PRODUCT,
      optionId: OPTION,
      values: { toDelete: ["gid://shopify/ProductOptionValue/2"] },
    });

    expect(sent(admin).variantStrategy).toBe("MANAGE");
    expect(sent(admin).optionValuesToDelete).toEqual(["gid://shopify/ProductOptionValue/2"]);
  });

  it("does not call Shopify when there is nothing to change", async () => {
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db } = dbRecorder();

    expect(
      await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, values: {} }),
    ).toBeUndefined();
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("refuses an empty name or value rather than sending it", async () => {
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db } = dbRecorder();

    expect(await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "  " }))
      .toBe("optionNameEmpty");
    expect(
      await applyOptionChange(admin, db, "s", {
        productId: PRODUCT,
        optionId: OPTION,
        values: { toUpdate: [{ id: "gid://shopify/ProductOptionValue/1", name: " " }] },
      }),
    ).toBe("optionValueEmpty");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("mirrors the ECHOED values, with their Shopify GIDs", async () => {
    // The added value's id is assigned by Shopify, and every translation write
    // addresses values BY GID — a mirror built from the request would have none.
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db, upserts } = dbRecorder();

    await applyOptionChange(admin, db, "s", {
      productId: PRODUCT,
      optionId: OPTION,
      values: { toAdd: ["Green"] },
    });

    const values = JSON.parse((upserts[0] as { update: { values: string } }).update.values);
    // The same shape the sync writes -- `linked` included, so a value that is
    // not metaobject-backed says so rather than leaving the flag missing.
    expect(values).toEqual([
      { id: "gid://shopify/ProductOptionValue/1", name: "Red", linked: false },
      { id: "gid://shopify/ProductOptionValue/2", name: "Blue", linked: false },
    ]);
  });

  it("mirrors NOTHING when Shopify reports userErrors", async () => {
    const admin = adminWith({
      data: { productOptionUpdate: { product: null, userErrors: [{ message: "nope" }] } },
    });
    const { db, upserts } = dbRecorder();

    expect(
      await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "Colour" }),
    ).toBe("optionsFailed");
    expect(upserts).toEqual([]);
  });

  it("treats a schema-level error as a failure, not as an empty answer", async () => {
    // `data: null` plus a top-level `errors` array never reaches `userErrors`.
    // Read as "no options came back" it would look like a product with none.
    const admin = adminWith({ data: null, errors: [{ message: "Field does not exist" }] });
    const { db, deletes } = dbRecorder();

    expect(
      await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "Colour" }),
    ).toBe("optionsFailed");
    // Crucially: no deleteMany ran. A mirror of "no options" would wipe the
    // cache for a product whose options are untouched.
    expect(deletes).toEqual([]);
  });

  it("mirrors against the GID, which is what ProductOption.productId holds", async () => {
    // `Product.id` is the GID (product-sync.service.ts writes it straight from
    // GraphQL), so a numeric id matches no row: deleteMany cleans nothing, the
    // caller's remainingCount counts 0, and the create branch violates the
    // foreign key -- swallowed as "mirror failed", leaving a created option
    // invisible until a full resync.
    const admin = adminWith(echo("productOptionUpdate", OPTION_ECHO));
    const { db, upserts, deletes } = dbRecorder();

    await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "Colour" });

    expect((deletes[0] as { where: { productId: string } }).where.productId).toBe(PRODUCT);
    expect((upserts[0] as { create: { productId: string } }).create.productId).toBe(PRODUCT);
  });

  it("keeps the metaobject link when it rewrites a row", async () => {
    // Every one of these mutations echoes ALL of the product's options, so a
    // rename of one rewrites the rows of the others. A mirror that dropped the
    // link would make a metaobject-linked option look editable and
    // translatable, which the app forbids for one.
    const admin = adminWith(
      echo("productOptionUpdate", [
        {
          id: OPTION,
          name: "Colour",
          position: 1,
          linkedMetafield: { namespace: "shopify", key: "color-pattern" },
          optionValues: [{ id: "gid://shopify/ProductOptionValue/1", name: "Red", linkedMetafieldValue: "red" }],
        },
      ]),
    );
    const { db, upserts } = dbRecorder();

    await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "Colour" });

    const row = upserts[0] as { update: { values: string; linkedMetafieldKey: string | null } };
    expect(row.update.linkedMetafieldKey).toBe("shopify--color-pattern");
    expect(JSON.parse(row.update.values)).toEqual([
      { id: "gid://shopify/ProductOptionValue/1", name: "Red", linked: true, linkedValue: "red" },
    ]);
  });

  it("treats an EMPTY option echo as unconfirmed, and mirrors nothing", async () => {
    // Shopify keeps every product on at least one option, so `[]` is a response
    // that did not carry the block. Mirrored as data it becomes
    // `deleteMany({ id: { notIn: [] } })`, which matches every row of a product
    // whose options are untouched.
    const admin = adminWith(echo("productOptionUpdate", []));
    const { db, deletes, upserts } = dbRecorder();

    expect(
      await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "Colour" }),
    ).toBe("optionsNotConfirmed");
    expect(deletes).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it("treats a missing product echo as unconfirmed", async () => {
    const admin = adminWith({ data: { productOptionUpdate: { product: null, userErrors: [] } } });
    const { db, upserts } = dbRecorder();

    expect(
      await applyOptionChange(admin, db, "s", { productId: PRODUCT, optionId: OPTION, name: "Colour" }),
    ).toBe("optionsNotConfirmed");
    expect(upserts).toEqual([]);
  });
});

describe("createOption", () => {
  it("requires a name and at least one value", async () => {
    const admin = adminWith(echo("productOptionsCreate", OPTION_ECHO));
    const { db } = dbRecorder();

    expect(await createOption(admin, db, "s", { productId: PRODUCT, name: " ", values: ["Red"] }))
      .toBe("optionNameEmpty");
    // Shopify rejects an option with no values; saying so beats forwarding it.
    expect(await createOption(admin, db, "s", { productId: PRODUCT, name: "Colour", values: ["  "] }))
      .toBe("optionValueEmpty");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("sends the values as objects, dropping blank entries", async () => {
    const admin = adminWith(echo("productOptionsCreate", OPTION_ECHO));
    const { db } = dbRecorder();

    await createOption(admin, db, "s", { productId: PRODUCT, name: "Colour", values: ["Red", " ", "Blue"] });

    expect(sent(admin).options).toEqual([{ name: "Colour", values: [{ name: "Red" }, { name: "Blue" }] }]);
  });
});

describe("deleteOption", () => {
  it("refuses to remove the LAST option", async () => {
    // Shopify keeps every product on at least one option, and its rejection
    // would arrive as a generic failure that says nothing about why.
    const admin = adminWith(echo("productOptionsDelete", []));
    const { db } = dbRecorder();

    expect(
      await deleteOption(admin, db, "s", { productId: PRODUCT, optionId: OPTION, remainingCount: 1 }),
    ).toBe("optionLastOne");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("removes the cache rows of options Shopify no longer returns", async () => {
    const admin = adminWith(echo("productOptionsDelete", OPTION_ECHO));
    const { db, deletes } = dbRecorder();

    await deleteOption(admin, db, "s", { productId: PRODUCT, optionId: "gid://shopify/ProductOption/11", remainingCount: 2 });

    // A stale option row is one the editor would still offer to translate.
    expect((deletes[0] as { where: { id: { notIn: string[] } } }).where.id.notIn).toEqual([OPTION]);
  });
});

describe("reorderOptions", () => {
  it("counts positions from 1, the way Shopify does", async () => {
    const admin = adminWith(echo("productOptionsReorder", OPTION_ECHO));
    const { db } = dbRecorder();

    await reorderOptions(admin, db, "s", { productId: PRODUCT, orderedIds: ["a", "b", "c"] });

    expect(sent(admin).options).toEqual([
      { id: "a", position: 1 },
      { id: "b", position: 2 },
      { id: "c", position: 3 },
    ]);
  });

  it("carries the VALUE order nested under its option", async () => {
    // The first option and its first value decide which variant the storefront
    // shows first, so this is not tidiness — it is which product a customer
    // sees before touching anything.
    const admin = adminWith(echo("productOptionsReorder", OPTION_ECHO));
    const { db } = dbRecorder();

    await reorderOptions(admin, db, "s", {
      productId: PRODUCT,
      orderedIds: ["a", "b"],
      valueOrder: { a: ["v2", "v1"] },
    });

    expect(sent(admin).options).toEqual([
      { id: "a", position: 1, values: [{ id: "v2", position: 1 }, { id: "v1", position: 2 }] },
      // Option b's values are untouched, so they are not restated: an
      // unchanged order is work with a chance of going wrong and nothing to
      // achieve, and it would make the option reorder depend on it.
      { id: "b", position: 2 },
    ]);
  });
});

describe("countVariantsPerValue", () => {
  it("counts each value across the product's variants", async () => {
    const admin = adminWith({
      data: {
        product: {
          variants: {
            nodes: [
              { selectedOptions: [{ name: "Colour", value: "Red" }, { name: "Size", value: "S" }] },
              { selectedOptions: [{ name: "Colour", value: "Red" }, { name: "Size", value: "M" }] },
              { selectedOptions: [{ name: "Colour", value: "Blue" }, { name: "Size", value: "S" }] },
            ],
          },
        },
      },
    });

    const counts = await countVariantsPerValue(admin, "s", PRODUCT);

    // The number a merchant decides an irreversible delete on.
    expect(counts[variantCountKey("Colour", "Red")]).toBe(2);
    expect(counts[variantCountKey("Size", "S")]).toBe(2);
    expect(counts[variantCountKey("Colour", "Blue")]).toBe(1);
  });

  it("pages, so a product above 250 variants is not undercounted", async () => {
    // An undercount is the quiet version of the zero this function refuses to
    // report: it would be read as "fewer variants at stake than there are", on
    // the number a merchant approves an irreversible delete with.
    const pages = [
      {
        data: {
          product: {
            variants: {
              nodes: [{ selectedOptions: [{ name: "Colour", value: "Red" }] }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        },
      },
      {
        data: {
          product: {
            variants: {
              nodes: [{ selectedOptions: [{ name: "Colour", value: "Red" }] }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ];
    const graphql = vi.fn(async (_doc: string, _opts: { variables: Record<string, unknown> }) => ({
      json: async () => pages.shift(),
    }));
    const admin = { graphql } as never;

    const counts = await countVariantsPerValue(admin, "s", PRODUCT);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1]?.[1].variables.after).toBe("c1");
    expect(counts[variantCountKey("Colour", "Red")]).toBe(2);
  });

  it("returns an empty map when the count fails, rather than zeros", async () => {
    // A zero would read as "no variants use this, delete freely" — the exact
    // opposite of what an unanswered question means.
    const admin = { graphql: vi.fn().mockRejectedValue(new Error("429")) } as never;

    expect(await countVariantsPerValue(admin, "s", PRODUCT)).toEqual({});
  });

  it("keys on a separator that merchant text cannot contain", async () => {
    // Option and value names are free text and both can contain a slash or a
    // space, which would make two different pairs collide on one key.
    expect(variantCountKey("A/B", "C")).not.toBe(variantCountKey("A", "B/C"));
  });
});

describe("parseValueOrderPayload", () => {
  const gid = (id: string) => id.startsWith("gid://shopify/");

  it("takes a well-formed map", () => {
    expect(
      parseValueOrderPayload(
        JSON.stringify({ "gid://shopify/ProductOption/1": ["gid://shopify/ProductOptionValue/2", "gid://shopify/ProductOptionValue/1"] }),
        gid,
      ),
    ).toEqual({
      "gid://shopify/ProductOption/1": ["gid://shopify/ProductOptionValue/2", "gid://shopify/ProductOptionValue/1"],
    });
  });

  it("drops the WHOLE option when one id is unusable", () => {
    // This is a positional payload: filtering the bad id out would not
    // sanitise the request, it would apply a different order than the merchant
    // dragged — quietly, to real variants.
    expect(
      parseValueOrderPayload(
        JSON.stringify({
          "gid://shopify/ProductOption/1": ["gid://shopify/ProductOptionValue/1", "nonsense", "gid://shopify/ProductOptionValue/2"],
          "gid://shopify/ProductOption/2": ["gid://shopify/ProductOptionValue/3"],
        }),
        gid,
      ),
    ).toEqual({ "gid://shopify/ProductOption/2": ["gid://shopify/ProductOptionValue/3"] });
  });

  it("survives anything that is not the expected shape", () => {
    // A malformed payload must not fail the save, whose other halves are valid.
    expect(parseValueOrderPayload("", gid)).toEqual({});
    expect(parseValueOrderPayload("{oops", gid)).toEqual({});
    expect(parseValueOrderPayload("[]", gid)).toEqual({});
    expect(parseValueOrderPayload("null", gid)).toEqual({});
    expect(parseValueOrderPayload(JSON.stringify({ "gid://shopify/ProductOption/1": "not a list" }), gid)).toEqual({});
    expect(parseValueOrderPayload(JSON.stringify({ nonsense: ["gid://shopify/ProductOptionValue/1"] }), gid)).toEqual({});
  });
});
