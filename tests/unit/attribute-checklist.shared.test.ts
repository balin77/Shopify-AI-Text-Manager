/**
 * PLAN_CONTENT_CREATION §7 (Phase 2) — the attribute checklist.
 *
 * The one property worth most of these tests: `null` before the first
 * attribute sync means UNKNOWN, not MISSING. Getting that wrong lights up the
 * whole sidebar red for every shop that has not re-synced — a day of
 * confident, wrong findings, which is worse than a day of honest "unknown".
 */

import { describe, it, expect } from "vitest";
import {
  attributesKnown,
  buildAttributeChecklist,
  countFindings,
  needsAttributeSync,
  type AttributeInput,
} from "~/services/attribute-checklist.shared";

const SYNCED = new Date("2026-08-16T00:00:00Z");

function product(overrides: Partial<AttributeInput> = {}): AttributeInput {
  return { resource: "product", attributesSyncedAt: SYNCED, ...overrides };
}

function statusOf(rows: ReturnType<typeof buildAttributeChecklist>, key: string) {
  return rows.find((r) => r.key === key)?.status;
}

describe("attributesKnown", () => {
  it("is the discriminator, and nothing else is", () => {
    expect(attributesKnown({ attributesSyncedAt: null })).toBe(false);
    expect(attributesKnown({ attributesSyncedAt: undefined })).toBe(false);
    expect(attributesKnown({ attributesSyncedAt: SYNCED })).toBe(true);
    expect(attributesKnown({ attributesSyncedAt: SYNCED.toISOString() })).toBe(true);
  });
});

describe("before the first attribute sync", () => {
  const rows = buildAttributeChecklist({ resource: "product", attributesSyncedAt: null });

  it("reports UNKNOWN, never MISSING, for every gated row", () => {
    for (const key of ["status", "tags", "vendor", "category", "productType", "template"]) {
      expect(statusOf(rows, key)).toBe("unknown");
    }
  });

  it("produces no finding from any GATED row", () => {
    // Nothing gated is red, because nothing gated is known, and the sidebar
    // offers a reload instead of a checklist that would be confidently wrong.
    //
    // Note the precision: rows that do NOT come from the attribute block —
    // the featured image, which every sync has always written — are still
    // judged normally. An earlier version of this test claimed "no findings at
    // all" and was simply too broad; the code was right.
    const gatedKeys = ["status", "tags", "vendor", "category", "productType", "template"];
    const gatedFindings = rows.filter((r) => gatedKeys.includes(r.key) && (r.status === "missing" || r.status === "warning"));
    expect(gatedFindings).toEqual([]);
    expect(needsAttributeSync(rows)).toBe(true);
  });

  it("shows no VALUES either — a default is not data", () => {
    // Rendering "0 tags" from the migration default would be the same lie as
    // colouring the row red.
    expect(rows.find((r) => r.key === "tags")?.value).toBeUndefined();
  });
});

describe("after a sync", () => {
  it("distinguishes set from empty", () => {
    const rows = buildAttributeChecklist(product({ vendor: "Acme", productType: "" }));
    expect(statusOf(rows, "vendor")).toBe("ok");
    expect(statusOf(rows, "productType")).toBe("missing");
  });

  it("treats whitespace as empty", () => {
    expect(statusOf(buildAttributeChecklist(product({ vendor: "   " })), "vendor")).toBe("missing");
  });

  it("calls a draft a WARNING, not an error", () => {
    // A draft is a state, not a mistake — the merchant may simply not be
    // finished. Red would be wrong; silent would be unhelpful.
    expect(statusOf(buildAttributeChecklist(product({ status: "DRAFT" })), "status")).toBe("warning");
    expect(statusOf(buildAttributeChecklist(product({ status: "ACTIVE" })), "status")).toBe("ok");
  });
});

describe("status and channels are separate rows (§2.3)", () => {
  it("keeps them apart even when the product is ACTIVE", () => {
    // ACTIVE alone does NOT make a product visible; that needs a publication.
    // A single "published" line would hide exactly that.
    const rows = buildAttributeChecklist(product({ status: "ACTIVE" }));
    expect(statusOf(rows, "status")).toBe("ok");
    expect(statusOf(rows, "channels")).toBe("unknown");
  });

  it("marks channels UNKNOWN and admin-only while there is no scope for them", () => {
    // Before Phase 4 there is no cache and no scope. "0 channels" would be a
    // red finding for something the app simply cannot see.
    const row = buildAttributeChecklist(product()).find((r) => r.key === "channels")!;
    expect(row.status).toBe("unknown");
    expect(row.adminOnly).toBe(true);
  });

  it("judges channels once a count IS available", () => {
    expect(statusOf(buildAttributeChecklist(product({ publicationCount: 0 })), "channels")).toBe("warning");
    expect(statusOf(buildAttributeChecklist(product({ publicationCount: 2 })), "channels")).toBe("ok");
  });
});

describe("rows whose data is loaded separately", () => {
  it("does not read a missing price as free", () => {
    // The price lives on ProductVariant and is not in the editor item (§2.3).
    expect(statusOf(buildAttributeChecklist(product()), "price")).toBe("unknown");
    expect(statusOf(buildAttributeChecklist(product({ defaultVariantPrice: "" })), "price")).toBe("missing");
    expect(statusOf(buildAttributeChecklist(product({ defaultVariantPrice: "19.99" })), "price")).toBe("ok");
  });

  it("marks a truncated membership count as truncated", () => {
    // "100 collections" must not read as complete when the window was cut.
    const row = buildAttributeChecklist(product({ collectionCount: 100, hasMoreCollections: true })).find(
      (r) => r.key === "collections",
    )!;
    expect(row.value).toBe("100+");
  });

  it("answers the keyword row even when attributes are unknown", () => {
    // Keywords live in their own tables, so they are not gated on the
    // attribute block — reporting them as unknown would be needlessly coy.
    const rows = buildAttributeChecklist({ resource: "product", attributesSyncedAt: null, hasKeyword: true });
    expect(statusOf(rows, "keyword")).toBe("ok");
  });
});

describe("per-type rows", () => {
  it("gives a product the merchandising rows and no author", () => {
    const keys = buildAttributeChecklist(product()).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["status", "channels", "tags", "vendor", "category", "collections", "price"]));
    expect(keys).not.toContain("author");
  });

  it("gives an article an author and a published state", () => {
    const keys = buildAttributeChecklist({ resource: "article", attributesSyncedAt: SYNCED }).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["author", "tags", "published"]));
    expect(keys).not.toContain("vendor");
  });

  it("gives a collection its sort order and no tags", () => {
    const keys = buildAttributeChecklist({ resource: "collection", attributesSyncedAt: SYNCED }).map((r) => r.key);
    expect(keys).toContain("sortOrder");
    expect(keys).not.toContain("tags");
  });

  it("does not offer a featured image row for pages", () => {
    // Pages have no featured image in this app's model.
    const keys = buildAttributeChecklist({ resource: "page", attributesSyncedAt: SYNCED }).map((r) => r.key);
    expect(keys).not.toContain("featuredImage");
  });

  it("keeps the featured image ungated — it predates the attribute block", () => {
    const rows = buildAttributeChecklist({ resource: "product", attributesSyncedAt: null, featuredImageUrl: "https://x/y.jpg" });
    expect(statusOf(rows, "featuredImage")).toBe("ok");
  });
});

describe("needsAttributeSync", () => {
  it("is false once the block is known", () => {
    expect(needsAttributeSync(buildAttributeChecklist(product({ vendor: "Acme" })))).toBe(false);
  });

  it("ignores rows that are unknown for a reason a sync cannot fix", () => {
    // Channels stay unknown until Phase 4 — offering "reload" for that would
    // send the merchant round a loop that changes nothing.
    const rows = buildAttributeChecklist(product({ vendor: "Acme", defaultVariantPrice: "1", collectionCount: 1, hasKeyword: true }));
    expect(needsAttributeSync(rows)).toBe(false);
  });
});
