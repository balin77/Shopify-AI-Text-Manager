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
  isoDay,
  videoUploadDatesFromMedia,
  serializeVideoUploadDates,
  videoSchemaChanged,
  PRODUCT_VIDEO_MEDIA_FIELDS,
  VIDEO_SCHEMA_KEY,
  VIDEO_SCHEMA_NAMESPACE,
  VIDEO_SCHEMA_TYPE,
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

describe("isoDay", () => {
  it("reduces a Shopify timestamp to a calendar day", () => {
    expect(isoDay("2026-05-03T14:22:31Z")).toBe("2026-05-03");
  });

  it("returns empty for an unusable value instead of an Invalid Date", () => {
    expect(isoDay("soon")).toBe("");
    expect(isoDay(null)).toBe("");
  });
});

describe("videoUploadDatesFromMedia", () => {
  const video = (id: string, createdAt: string) => ({ node: { id, createdAt } });

  it("maps every video to its creation day", () => {
    expect(
      videoUploadDatesFromMedia([
        video("gid://shopify/Video/1", "2026-05-03T10:00:00Z"),
        video("gid://shopify/ExternalVideo/2", "2026-06-01T23:59:59Z"),
      ]),
    ).toEqual({ "1": "2026-05-03", "2": "2026-06-01" });
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
