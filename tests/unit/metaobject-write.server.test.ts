/**
 * The ONE echo-verified metaobject field writer, which both editors now call.
 *
 * `userErrors: []` is not success — Shopify can accept a `metaobjectUpdate`
 * and store nothing, which is the silent-no-op class CLAUDE.md names. So the
 * only thing that counts as written is a field that comes back with OUR value,
 * and the cache is mirrored only then. These tests pin exactly that, plus the
 * per-FIELD granularity: a refused field must not fail its neighbours.
 */

import { describe, it, expect, vi } from "vitest";
import { writeMetaobjectFields } from "~/services/metaobject-write.server";

const SHOP = "shop.myshopify.com";
const ID = "gid://shopify/Metaobject/1";

function gatewayWith(body: unknown) {
  return { graphql: vi.fn(async () => ({ json: async () => body })) } as never;
}

function dbWith(cached: { type: string } | null) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    db: {
      metaobject: {
        findUnique: vi.fn(async () => cached),
        update: vi.fn(async (args: Record<string, unknown>) => {
          updates.push(args);
          return {};
        }),
      },
    } as never,
  };
}

function echo(fields: Array<{ key: string; value: string | null }>, displayName = "Rot") {
  return {
    data: {
      metaobjectUpdate: {
        metaobject: {
          id: ID,
          displayName,
          fields: fields.map((f) => ({ ...f, type: "single_line_text_field" })),
        },
        userErrors: [],
      },
    },
  };
}

describe("writeMetaobjectFields", () => {
  it("confirms only the fields Shopify echoed with OUR value", async () => {
    const { db, updates } = dbWith({ type: "colour" });
    const result = await writeMetaobjectFields({
      gateway: gatewayWith(echo([{ key: "label", value: "Rot" }, { key: "note", value: "something else" }])),
      db,
      shop: SHOP,
      id: ID,
      writes: [
        { ref: "a", key: "label", value: "Rot" },
        { ref: "b", key: "note", value: "what we sent" },
      ],
    });
    expect(result.confirmedRefs).toEqual(["a"]);
    expect(result.confirmedKeys).toEqual(["label"]);
    expect(result.failures).toEqual([
      { ref: "b", message: "Shopify did not confirm the field write.", reason: "noEcho" },
    ]);
    // Partial success still mirrors — the confirmed half is real.
    expect(updates).toHaveLength(1);
  });

  it("fails a field whose key is missing from the echo entirely", async () => {
    const { db, updates } = dbWith({ type: "colour" });
    const result = await writeMetaobjectFields({
      gateway: gatewayWith(echo([{ key: "label", value: "Rot" }])),
      db,
      shop: SHOP,
      id: ID,
      writes: [{ ref: "b", key: "colour", value: "#ff0000" }],
    });
    expect(result.confirmedRefs).toEqual([]);
    expect(result.failures[0].reason).toBe("noEcho");
    // NOTHING confirmed ⇒ nothing mirrored. A cache write here would tell the
    // merchant the value was saved.
    expect(updates).toHaveLength(0);
  });

  it("treats a cleared field as written when Shopify echoes it back empty", async () => {
    const { db } = dbWith({ type: "colour" });
    const result = await writeMetaobjectFields({
      gateway: gatewayWith(echo([{ key: "note", value: null }])),
      db,
      shop: SHOP,
      id: ID,
      writes: [{ ref: "b", key: "note", value: "" }],
    });
    expect(result.confirmedRefs).toEqual(["b"]);
  });

  it("refuses an entry that is not in the cache — that is also the tenancy check", async () => {
    const { db, updates } = dbWith(null);
    const gateway = gatewayWith(echo([]));
    const result = await writeMetaobjectFields({
      gateway,
      db,
      shop: SHOP,
      id: ID,
      writes: [{ ref: "a", key: "label", value: "Rot" }],
    });
    expect(result.fatal?.reason).toBe("notCached");
    expect(result.failures).toHaveLength(1);
    expect(result.cachedType).toBeNull();
    // A foreign shop's metaobject must not reach Shopify at all.
    expect((gateway as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("reports a SCHEMA error and a userError as different failures, and never as success", async () => {
    const { db } = dbWith({ type: "colour" });
    const schema = await writeMetaobjectFields({
      gateway: gatewayWith({ data: null, errors: [{ message: "bad document" }] }),
      db,
      shop: SHOP,
      id: ID,
      writes: [{ ref: "a", key: "label", value: "Rot" }],
    });
    expect(schema.fatal).toEqual({ message: "bad document", reason: "schemaError" });

    const user = await writeMetaobjectFields({
      gateway: gatewayWith({
        data: { metaobjectUpdate: { metaobject: null, userErrors: [{ message: "Value can't be blank" }] } },
      }),
      db,
      shop: SHOP,
      id: ID,
      writes: [{ ref: "a", key: "label", value: "" }],
    });
    expect(user.fatal).toEqual({ message: "Value can't be blank", reason: "userError" });
    expect(user.confirmedRefs).toEqual([]);
  });

  it("turns a transport failure into a failure, not an exception", async () => {
    const { db } = dbWith({ type: "colour" });
    const gateway = { graphql: vi.fn(async () => { throw new Error("socket hang up"); }) } as never;
    const result = await writeMetaobjectFields({
      gateway,
      db,
      shop: SHOP,
      id: ID,
      writes: [{ ref: "a", key: "label", value: "Rot" }],
    });
    expect(result.fatal).toEqual({ message: "socket hang up", reason: "transport" });
  });

  it("does nothing at all for an empty write list", async () => {
    const { db } = dbWith({ type: "colour" });
    const gateway = gatewayWith(echo([]));
    const result = await writeMetaobjectFields({ gateway, db, shop: SHOP, id: ID, writes: [] });
    expect(result).toMatchObject({ cachedType: "colour", confirmedRefs: [], failures: [] });
    expect((gateway as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });
});
