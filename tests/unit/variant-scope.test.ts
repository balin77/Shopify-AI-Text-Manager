/**
 * What "the thing I am editing" means in the variants panel.
 *
 * The scopes decide which variants a bulk edit writes to, so a wrong group is
 * a price applied to the wrong products. Two rules carry most of the weight:
 * which groups are offered at all, and what a bulk field shows when its
 * members disagree.
 */

import { describe, it, expect } from "vitest";
import {
  buildVariantScopes,
  commonValue,
  pickScopeImages,
  type ScopeVariant,
} from "~/services/variant-scope.shared";

const labels = {
  all: "All variants",
  groupLabel: (_option: string, value: string) => `All ${value}`,
};

/** Three colours × two sizes, each with its own picture. */
function catalogue(): ScopeVariant[] {
  const out: ScopeVariant[] = [];
  for (const colour of ["Weiss", "Schwarz", "Rot"]) {
    for (const size of ["20cm", "30cm"]) {
      out.push({
        id: `${colour}-${size}`,
        title: `${colour} / ${size}`,
        sku: null,
        imageUrl: `https://cdn/${colour}.png`,
        imageAlt: colour,
        selectedOptions: [
          { name: "Farbe", value: colour },
          { name: "Grösse", value: size },
        ],
      });
    }
  }
  return out;
}

describe("buildVariantScopes", () => {
  it("offers one scope per variant, one per option value, and one for all", () => {
    const scopes = buildVariantScopes(catalogue(), labels);

    expect(scopes.filter((s) => s.kind === "variant")).toHaveLength(6);
    // Three colours and two sizes.
    expect(scopes.filter((s) => s.kind === "group").map((s) => s.label)).toEqual([
      "All Weiss",
      "All 20cm",
      "All 30cm",
      "All Schwarz",
      "All Rot",
    ]);
    expect(scopes.filter((s) => s.kind === "all")).toHaveLength(1);
  });

  it("puts exactly the right variants in a group", () => {
    const scopes = buildVariantScopes(catalogue(), labels);

    const weiss = scopes.find((s) => s.label === "All Weiss");
    expect(weiss?.variantIds).toEqual(["Weiss-20cm", "Weiss-30cm"]);
    const twenty = scopes.find((s) => s.label === "All 20cm");
    expect(twenty?.variantIds).toEqual(["Weiss-20cm", "Schwarz-20cm", "Rot-20cm"]);
  });

  it("does not offer a group that IS every variant", () => {
    // "All white" and "all variants" would be the same set under two names,
    // and the merchant is left wondering what the difference is.
    const oneColour = catalogue().map((v) => ({
      ...v,
      selectedOptions: [
        { name: "Farbe", value: "Weiss" },
        ...v.selectedOptions.filter((o) => o.name !== "Farbe"),
      ],
    }));

    const scopes = buildVariantScopes(oneColour, labels);
    expect(scopes.some((s) => s.label === "All Weiss")).toBe(false);
    expect(scopes.some((s) => s.kind === "all")).toBe(true);
  });

  it("does not offer a group of one", () => {
    const scopes = buildVariantScopes(catalogue().slice(0, 3), labels);
    // "Rot" appears once in the first three, so it is not a group.
    expect(scopes.some((s) => s.label === "All Rot")).toBe(false);
  });

  it("offers no groups and no 'all' for a single variant", () => {
    // A picker with one entry asks a question with a single answer.
    const scopes = buildVariantScopes(catalogue().slice(0, 1), labels);
    expect(scopes).toHaveLength(1);
    expect(scopes[0].kind).toBe("variant");
  });

  it("survives a variant whose options were not reported", () => {
    // A narrower query or an older cache row is a MISSING answer; the
    // per-variant scopes still work.
    const variants = catalogue().map((v) => ({ ...v, selectedOptions: undefined as never }));
    const scopes = buildVariantScopes(variants, labels);
    expect(scopes.filter((s) => s.kind === "group")).toHaveLength(0);
    expect(scopes.filter((s) => s.kind === "variant")).toHaveLength(6);
  });

  it("groups on the reported pairs, not on the title", () => {
    // A merchant writes "20 / 30 cm", and splitting the title on " / " would
    // invent two options out of one value.
    const variants: ScopeVariant[] = [
      { id: "a", title: "20 / 30 cm", sku: null, imageUrl: null, imageAlt: null,
        selectedOptions: [{ name: "Grösse", value: "20 / 30 cm" }] },
      { id: "b", title: "20 / 30 cm", sku: null, imageUrl: null, imageAlt: null,
        selectedOptions: [{ name: "Grösse", value: "20 / 30 cm" }] },
    ];
    // Both variants share the one value, so it covers everything and is not a
    // group — what matters is that the VALUE survived intact.
    const scopes = buildVariantScopes(variants, {
      all: "All",
      groupLabel: (_o, value) => value,
    });
    expect(scopes.some((s) => s.label.includes("20 / 30 cm"))).toBe(true);
  });
});

describe("pickScopeImages", () => {
  it("shows one picture per distinct image, never the same one four times", () => {
    const members = catalogue().filter((v) => v.id.startsWith("Weiss"));
    // Both Weiss variants carry the same URL.
    expect(pickScopeImages(members)).toEqual([{ url: "https://cdn/Weiss.png", alt: "Weiss" }]);
  });

  it("spreads across the list for ALL variants", () => {
    // Taking the first four off a catalogue sorted by colour would show four
    // pictures of the same colour for a scope that means everything.
    const picked = pickScopeImages(catalogue(), { spread: true });
    expect(picked.map((p) => p.alt)).toEqual(["Weiss", "Schwarz", "Rot"]);
  });

  it("caps at four", () => {
    const many: ScopeVariant[] = Array.from({ length: 12 }, (_, i) => ({
      id: `v${i}`, title: `v${i}`, sku: null,
      imageUrl: `https://cdn/${i}.png`, imageAlt: `v${i}`, selectedOptions: [],
    }));
    expect(pickScopeImages(many)).toHaveLength(4);
  });

  it("returns nothing when no member has a picture", () => {
    const none = catalogue().map((v) => ({ ...v, imageUrl: null }));
    expect(pickScopeImages(none)).toEqual([]);
  });
});

describe("commonValue", () => {
  it("answers null when the members disagree", () => {
    // Showing the first member's price for twelve variants that each have
    // their own invites the merchant either to leave it alone believing they
    // are all that price, or to overwrite eleven values they never saw.
    expect(commonValue(["9.90", "9.90"])).toBe("9.90");
    expect(commonValue(["9.90", "12.00"])).toBeNull();
    expect(commonValue([])).toBeNull();
    expect(commonValue([""])).toBe("");
  });
});
