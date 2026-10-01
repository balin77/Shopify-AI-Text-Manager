/**
 * Video upload dates: the piece Liquid cannot know.
 *
 * The map is written by the sync and read by the storefront block, so the two
 * halves only meet through its SHAPE — numeric media ids as keys, ISO days as
 * values. Every rule here exists because getting it wrong is silent: the
 * markup would still be emitted, just without the property Google requires.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  numericMediaId,
  isoTimestamp,
  videoUploadDatesFromMedia,
  serializeVideoUploadDates,
  videoSchemaChanged,
  PRODUCT_VIDEO_MEDIA_FIELDS,
  VIDEO_SCHEMA_KEY,
  VIDEO_SCHEMA_NAMESPACE,
  VIDEO_SCHEMA_TYPE,
  failedBatchIndices,
} from "~/services/seo/video-schema.shared";

describe("numericMediaId", () => {
  it("reduces a GID to the number Liquid exposes as media.id", () => {
    expect(numericMediaId("gid://shopify/Video/20995642294316")).toBe("20995642294316");
    expect(numericMediaId("gid://shopify/ExternalVideo/42")).toBe("42");
  });

  it("refuses anything that is not a plain number", () => {
    // A non-numeric tail could never be looked up on the storefront, so an
    // empty result (entry dropped) beats a key nothing will ever match.
    expect(numericMediaId("gid://shopify/Video/abc")).toBe("");
    expect(numericMediaId("")).toBe("");
    expect(numericMediaId(null)).toBe("");
  });
});

describe("isoTimestamp", () => {
  it("keeps the time AND the zone, because Google rejects a date-only uploadDate", () => {
    expect(isoTimestamp("2026-05-03T14:22:31Z")).toBe("2026-05-03T14:22:31.000Z");
  });

  it("normalises a zoned timestamp to UTC rather than dropping the offset", () => {
    expect(isoTimestamp("2026-05-03T14:22:31+02:00")).toBe("2026-05-03T12:22:31.000Z");
  });

  it("returns empty for an unusable value instead of an Invalid Date", () => {
    expect(isoTimestamp("soon")).toBe("");
    expect(isoTimestamp(null)).toBe("");
  });
});

describe("videoUploadDatesFromMedia", () => {
  const video = (id: string, createdAt: string) => ({ node: { id, createdAt } });

  it("maps every video to its full creation timestamp", () => {
    expect(
      videoUploadDatesFromMedia([
        video("gid://shopify/Video/1", "2026-05-03T10:00:00Z"),
        video("gid://shopify/ExternalVideo/2", "2026-06-01T23:59:59Z"),
      ]),
    ).toEqual({ "1": "2026-05-03T10:00:00.000Z", "2": "2026-06-01T23:59:59.000Z" });
  });

  it("ignores image media, which carry no createdAt", () => {
    const images = [{ node: { id: "gid://shopify/MediaImage/9" } }];
    expect(videoUploadDatesFromMedia(images)).toEqual({});
  });

  it("returns an empty map for a product without media at all", () => {
    // {} is a REAL answer — the caller uses it to clear a stale metafield.
    expect(videoUploadDatesFromMedia(null)).toEqual({});
    expect(videoUploadDatesFromMedia([])).toEqual({});
  });
});

describe("serializeVideoUploadDates", () => {
  it("sorts the keys so an unchanged catalog serializes identically", () => {
    const a = serializeVideoUploadDates({ "20": "2026-01-01", "3": "2026-02-02" });
    const b = serializeVideoUploadDates({ "3": "2026-02-02", "20": "2026-01-01" });
    expect(a).toBe(b);
    // The SORTED order, not JavaScript's own: an object literal reorders
    // integer-like keys numerically, which would put "3" first and make the
    // claimed order a lie the mirror comparison depends on.
    expect(a).toBe('{"20":"2026-01-01","3":"2026-02-02"}');
  });

  it("expresses 'no videos' as null, never as an empty object", () => {
    // metafieldsSet rejects an empty value, so the caller has to DELETE the
    // metafield instead — null is what tells it to.
    expect(serializeVideoUploadDates({})).toBeNull();
  });
});

describe("videoSchemaChanged", () => {
  it("is quiet when the freshly built value equals the mirror", () => {
    expect(videoSchemaChanged('{"1":"2026-05-03"}', '{"1":"2026-05-03"}')).toBe(false);
    expect(videoSchemaChanged(null, null)).toBe(false);
  });

  it("fires on a new value, a changed value and a removal", () => {
    expect(videoSchemaChanged(null, '{"1":"2026-05-03"}')).toBe(true);
    expect(videoSchemaChanged('{"1":"2026-05-03"}', '{"1":"2026-05-04"}')).toBe(true);
    expect(videoSchemaChanged('{"1":"2026-05-03"}', null)).toBe(true);
  });

  it("treats undefined (column never written) like null", () => {
    expect(videoSchemaChanged(undefined, null)).toBe(false);
  });
});

describe("the metafield contract with the storefront block", () => {
  const liquid = readFileSync(
    join(__dirname, "../../extensions/storefront/blocks/structured-data.liquid"),
    "utf8",
  );

  it("is read by the block under exactly the namespace and key we write", () => {
    expect(VIDEO_SCHEMA_NAMESPACE).toBe("custom");
    expect(VIDEO_SCHEMA_TYPE).toBe("json");
    expect(liquid).toContain(`product.metafields.${VIDEO_SCHEMA_NAMESPACE}.${VIDEO_SCHEMA_KEY}.value`);
  });

  it("is looked up by the numeric media id, as a string key", () => {
    // `media.id` is a NUMBER in Liquid and JSON object keys are strings, so
    // the lookup has to coerce — without it every lookup silently misses.
    expect(liquid).toContain("assign v_media_key = v_media.id | append: ''");
    expect(liquid).toContain("v_upload_map[v_media_key]");
  });

  it("lets a merchant-set date win over ours", () => {
    expect(liquid).toContain("assign v_upload = v_upload_override");
  });
});

describe("PRODUCT_VIDEO_MEDIA_FIELDS", () => {
  const sync = readFileSync(join(__dirname, "../../app/services/product-sync.service.ts"), "utf8");
  const fullRoute = readFileSync(join(__dirname, "../../app/routes/api.sync-products.tsx"), "utf8");
  const narrowRoute = readFileSync(
    join(__dirname, "../../app/routes/api.sync-missing-products.tsx"),
    "utf8",
  );

  it("selects both video types with their creation date", () => {
    expect(PRODUCT_VIDEO_MEDIA_FIELDS).toContain("... on Video");
    expect(PRODUCT_VIDEO_MEDIA_FIELDS).toContain("... on ExternalVideo");
    expect(PRODUCT_VIDEO_MEDIA_FIELDS.match(/createdAt/g)).toHaveLength(2);
  });

  it("is interpolated into every product query with the FULL media window", () => {
    // Both queries in the sync service (bulk + single/webhook) and the route.
    expect(sync.match(/\$\{PRODUCT_VIDEO_MEDIA_FIELDS\}/g)).toHaveLength(2);
    expect(fullRoute).toContain("${PRODUCT_VIDEO_MEDIA_FIELDS}");
  });

  it("is NOT used by the narrow path, which cannot see all media", () => {
    // api.sync-missing-products selects media(first: 20): it cannot tell "no
    // videos" from "outside the window", and a truncated map would drop a
    // real video's uploadDate.
    expect(narrowRoute).toContain("media(first: 20)");
    expect(narrowRoute).not.toContain("PRODUCT_VIDEO_MEDIA_FIELDS");
  });
});

/**
 * The two loop-breakers, pinned at their source.
 *
 * Both are invisible in a passing sync: a webhook feedback loop and a mirror
 * that advances on an unconfirmed write only show up as churn on someone's
 * production shop.
 */
describe("write-path safety rails", () => {
  const sync = readFileSync(join(__dirname, "../../app/services/product-sync.service.ts"), "utf8");
  const webhook = readFileSync(join(__dirname, "../../app/routes/webhooks.products.tsx"), "utf8");
  const server = readFileSync(join(__dirname, "../../app/services/seo/video-schema.server.ts"), "utf8");
  const mutations = readFileSync(join(__dirname, "../../app/graphql/content.mutations.ts"), "utf8");

  it("writes the metafield on the webhook path too, because the diff ends the echo", () => {
    // Suppressing it here (what this did first) bought nothing — the pass is
    // diff-driven and the product upsert never touches the mirror column, so
    // the echo run finds nothing to write — and it cost the case the feature
    // exists for: a video added in the Shopify admin fires ONLY this webhook.
    expect(webhook).not.toContain("writeVideoSchema");
    expect(sync).not.toContain("writeVideoSchema");
    // The mirror is written by video-schema.server alone. If a sync path ever
    // ASSIGNED the column (any `videoSchemaJson:` in a Prisma payload), the
    // echo run would see a difference and the loop this once guarded against
    // would become real.
    expect(sync).not.toContain("videoSchemaJson:");
  });

  it("stops the bulk pass when the sync was aborted", () => {
    const passIndex = sync.indexOf("uploadDates: videoUploadDatesFromMedia(product.media?.edges)");
    expect(passIndex).toBeGreaterThan(-1);
    // The abort check sits immediately before the pass, not somewhere earlier.
    expect(sync.slice(Math.max(0, passIndex - 700), passIndex)).toContain("checkAborted();");
  });

  it("confirms writes by owner id, which the shared mutation now selects", () => {
    expect(mutations).toContain("owner {");
    expect(server).toContain("m?.owner?.id");
    // A value match would confirm the wrong product as soon as two carry the
    // same map.
    expect(server).not.toContain("byValue");
  });

  it("treats a missing mutation payload as unconfirmed, in BOTH directions", () => {
    const setGuard = server.indexOf("const payload = body?.data?.metafieldsSet;");
    const clearGuard = server.indexOf("const payload = body?.data?.metafieldsDelete;");
    expect(setGuard).toBeGreaterThan(-1);
    expect(clearGuard).toBeGreaterThan(-1);
    // `data: null` (throttled / top-level error) also has an empty userErrors
    // list, so emptiness alone must never count as success.
    expect(server).toContain("if (!payload) return confirmed;");
    // Both directions guard on the payload, and NEITHER lets a userError
    // anywhere in the batch discard the entries Shopify did confirm.
    expect(server).not.toContain("if (!payload || errors.length > 0) return confirmed;");
  });
});

/**
 * Failure in a bulk metafield mutation is per ENTRY. One stale product id in a
 * batch of 25 must not strand the other 24 — they would be retried on every
 * sync forever, and the warning would name a batch instead of the row to fix.
 */
describe("failedBatchIndices", () => {
  it("reads the entry index out of Shopify's field path", () => {
    const failed = failedBatchIndices([
      { field: ["metafields", "3", "ownerId"] },
      { field: ["metafields", "7", "value"] },
    ]);
    expect(failed).toEqual(new Set([3, 7]));
  });

  it("returns an empty set for no errors, so every entry stays confirmable", () => {
    expect(failedBatchIndices([])).toEqual(new Set());
  });

  it("gives up on an error it cannot attribute, rather than blaming entry 0", () => {
    // An unattributable error could belong to ANY entry; confirming the rest
    // would advance a mirror past a write that never happened.
    expect(failedBatchIndices([{ field: ["metafields"] }])).toBeNull();
    expect(failedBatchIndices([{}])).toBeNull();
    expect(failedBatchIndices([{ field: null }])).toBeNull();
  });

  it("is unfazed by a null entry in the list", () => {
    expect(failedBatchIndices([null])).toBeNull();
  });
});
