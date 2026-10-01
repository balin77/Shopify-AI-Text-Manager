/**
 * PLAN_CONTENT_CREATION §2.5a–d — the create modal's AI mapping.
 *
 * The whole file exists because of one silent failure mode: `/api/ai` resolves
 * its prompt, its character limit and its merchant instructions from the
 * EDITOR's field list, keyed by field name. A create-form key sent straight
 * through resolves to `undefined` — which does not error. It produces a
 * generic prompt with no limit and no instructions, and the merchant sees a
 * worse result with nothing to tell them why.
 *
 * So these tests assert that every key this config claims actually EXISTS on
 * the other side, against the real `CONTENT_CONFIGS` and the real create specs.
 */

import { describe, it, expect } from "vitest";
import {
  CREATE_AI_SPECS,
  createAiSpecFor,
  translatableCreateFields,
  LONG_TEXT_KEY_BY_RESOURCE,
} from "../../app/config/create-ai.shared";
import { CREATE_SPECS, type CreatableResource } from "../../app/config/create-fields.config";
import {
  PRODUCTS_CONFIG,
  COLLECTIONS_CONFIG,
  PAGES_CONFIG,
  BLOGS_CONFIG,
} from "../../app/config/content-fields.config";

const EDITOR_CONFIGS: Record<string, { fieldDefinitions: Array<{ key: string }> }> = {
  products: PRODUCTS_CONFIG,
  collections: COLLECTIONS_CONFIG,
  pages: PAGES_CONFIG,
  blogs: BLOGS_CONFIG,
};

describe("CREATE_AI_SPECS", () => {
  it("names a contentType the AI route actually knows", () => {
    for (const [resource, spec] of Object.entries(CREATE_AI_SPECS)) {
      expect(EDITOR_CONFIGS[spec!.contentType], `${resource} → ${spec!.contentType}`).toBeDefined();
    }
  });

  it("every editorKey exists in that contentType's field definitions", () => {
    // The silent-failure test. A key that does not resolve produces a generic
    // prompt with no character limit and no merchant instructions.
    for (const [resource, spec] of Object.entries(CREATE_AI_SPECS)) {
      const keys = new Set(EDITOR_CONFIGS[spec!.contentType].fieldDefinitions.map((f) => f.key));
      for (const field of spec!.fields) {
        expect(keys.has(field.editorKey), `${resource}: editor key "${field.editorKey}"`).toBe(true);
      }
    }
  });

  it("every createKey exists in that resource's create form", () => {
    // The mirror image: a create key nothing renders would be a field the
    // button claims to fill and never does.
    for (const [resource, spec] of Object.entries(CREATE_AI_SPECS)) {
      const keys = new Set(CREATE_SPECS[resource as CreatableResource].fields.map((f) => f.key));
      for (const field of spec!.fields) {
        expect(keys.has(field.createKey), `${resource}: create key "${field.createKey}"`).toBe(true);
      }
    }
  });

  it("writes the long text BEFORE the fields that summarise it", () => {
    // A meta description generated before the description exists summarises
    // the title — the exact result a merchant would rewrite by hand.
    for (const [resource, spec] of Object.entries(CREATE_AI_SPECS)) {
      const longTextKey = LONG_TEXT_KEY_BY_RESOURCE[resource as CreatableResource];
      expect(longTextKey, resource).toBeDefined();
      const longIndex = spec!.fields.findIndex((f) => f.createKey === longTextKey);
      const metaIndex = spec!.fields.findIndex((f) => f.createKey === "metaDescription");
      expect(longIndex).toBeGreaterThanOrEqual(0);
      expect(longIndex, resource).toBeLessThan(metaIndex);
    }
  });

  it("offers nothing for blogs and metaobjects", () => {
    // A blog has a title and a handle; a metaobject's fields come from a
    // merchant-defined definition whose meaning this app cannot read. A button
    // that produces noise is worse than no button.
    expect(createAiSpecFor("blog")).toBeNull();
    expect(createAiSpecFor("metaobject")).toBeNull();
    expect(createAiSpecFor(null)).toBeNull();
  });

  it("never claims a create field the form does not offer as a long text", () => {
    for (const [resource, key] of Object.entries(LONG_TEXT_KEY_BY_RESOURCE)) {
      const keys = new Set(CREATE_SPECS[resource as CreatableResource].fields.map((f) => f.key));
      expect(keys.has(key!), `${resource}: ${key}`).toBe(true);
    }
  });
});

describe("translatableCreateFields", () => {
  it("carries the title, which no AI spec lists", () => {
    // The merchant always writes the title themselves, so it appears in no
    // generation spec — and would silently go untranslated if this derived
    // its list from that spec alone.
    const fields = translatableCreateFields("product");
    expect(fields[0]).toEqual({ createKey: "title", editorKey: "title" });
  });

  it("maps every create key to its editor twin", () => {
    // `translateAll` reads its values off the form BY EDITOR KEY. Sending
    // `descriptionHtml` would leave the description untranslated with no error.
    const fields = translatableCreateFields("product");
    expect(fields).toContainEqual({ createKey: "descriptionHtml", editorKey: "description" });
  });

  it("is empty for a resource with no AI spec", () => {
    expect(translatableCreateFields("blog")).toEqual([]);
    expect(translatableCreateFields(null)).toEqual([]);
  });
});
