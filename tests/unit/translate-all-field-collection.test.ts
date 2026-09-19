/**
 * Unit tests — which fields a whole-item translation carries.
 *
 * The bug this pins: the editor submits every field definition it renders, so
 * "translate everything" on a product sent `status` and `vendor` along with the
 * title. Both are merchandising attributes — one value per item, no Shopify
 * translation key — so the AI translated them, the save stage refused them for
 * want of a key mapping, and the merchant was told two fields "could not be
 * saved to Shopify" on every single run.
 *
 * The gate is the ONE canonical field→key map, so what is translated is exactly
 * what the save stage would accept.
 */

import { describe, it, expect, vi } from "vitest";
import { collectTranslatableFields } from "../../app/actions/content/translation.action";
import { PRODUCTS_CONFIG, POLICIES_CONFIG } from "../../app/config/content-fields.config";

const form = (entries: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
};

describe("collectTranslatableFields", () => {
  it("drops the merchandising attributes a product renders beside its content", () => {
    const fields = collectTranslatableFields(
      form({
        title: "Kumiko Box",
        description: "<p>Handmade</p>",
        seoTitle: "Kumiko Box | Shop",
        metaDescription: "A handmade box.",
        productType: "Box",
        handle: "kumiko-box",
        status: "ACTIVE",
        vendor: "Kumiko Works",
        tags: "wood,handmade",
        templateSuffix: "wide",
        category: "gid://shopify/TaxonomyCategory/ae-2-1",
      }),
      PRODUCTS_CONFIG.fieldDefinitions,
      "Product",
    );

    expect(Object.keys(fields).sort()).toEqual([
      "description",
      "handle",
      "metaDescription",
      "productType",
      "seoTitle",
      "title",
    ]);
    // The two fields the merchant saw in the failure notice.
    expect(fields).not.toHaveProperty("status");
    expect(fields).not.toHaveProperty("vendor");
  });

  it("keeps a field out when the form carries no value for it", () => {
    const fields = collectTranslatableFields(
      form({ title: "Kumiko Box", seoTitle: "" }),
      PRODUCTS_CONFIG.fieldDefinitions,
      "Product",
    );
    expect(fields).toEqual({ title: "Kumiko Box" });
  });

  it("carries a ShopPolicy body, which maps to 'body' rather than 'body_html'", () => {
    const fields = collectTranslatableFields(
      form({ body: "<p>Refunds within 30 days.</p>" }),
      POLICIES_CONFIG.fieldDefinitions,
      "ShopPolicy",
    );
    expect(fields).toEqual({ body: "<p>Refunds within 30 days.</p>" });
  });

  it("never invents a field the definitions do not declare", () => {
    const fields = collectTranslatableFields(
      form({ title: "Kumiko Box", summary: "Not a product field" }),
      PRODUCTS_CONFIG.fieldDefinitions,
      "Product",
    );
    expect(fields).toEqual({ title: "Kumiko Box" });
  });

  // Synthetic: `getItemFieldValue` answers "" for the images field, so no value
  // for it ever reaches this form in production. Pinned anyway, because the
  // drop is what keeps alt texts on their own `translateAllAltTexts*` request.
  it("drops `images`: alt texts ride on their own request, not on this form", () => {
    const withImages = [
      ...PRODUCTS_CONFIG.fieldDefinitions.filter((f) => f.key === "title"),
      { key: "images", translationKey: "images", supportsTranslation: true },
    ] as typeof PRODUCTS_CONFIG.fieldDefinitions;

    const fields = collectTranslatableFields(
      form({ title: "Kumiko Box", images: "[]" }),
      withImages,
      "Product",
    );
    expect(fields).toEqual({ title: "Kumiko Box" });
  });
});

describe("collectTranslatableFields — the drop is not a silent hole", () => {
  it("warns when a field that claims translation support has no key mapping", async () => {
    const { logger } = await import("../../app/utils/logger.server");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

    const withOrphan = [
      ...PRODUCTS_CONFIG.fieldDefinitions.filter((f) => f.key === "title"),
      { key: "subtitle", translationKey: "subtitle", supportsTranslation: true },
    ] as typeof PRODUCTS_CONFIG.fieldDefinitions;

    const fields = collectTranslatableFields(
      form({ title: "Kumiko Box", subtitle: "Handmade in Bern" }),
      withOrphan,
      "Product",
    );

    expect(fields).toEqual({ title: "Kumiko Box" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("subtitle");
    warn.mockRestore();
  });

  it("stays quiet about the merchandising attributes — dropping those is the point", async () => {
    const { logger } = await import("../../app/utils/logger.server");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

    collectTranslatableFields(
      form({ title: "Kumiko Box", status: "ACTIVE", vendor: "Kumiko Works" }),
      PRODUCTS_CONFIG.fieldDefinitions,
      "Product",
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
