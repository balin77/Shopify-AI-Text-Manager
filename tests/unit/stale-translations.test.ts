import { describe, it, expect } from "vitest";
import {
  findStaleTranslations,
  partitionStaleTranslations,
  type PrimaryContentEntry,
  type SyncedTranslation,
} from "../../app/services/translations/stale-translations.shared";

/** A filled primary field, as `translatableContent` reports it. */
function primary(
  entries: Record<string, string>,
  digest = "digest-1",
): Record<string, PrimaryContentEntry> {
  const out: Record<string, PrimaryContentEntry> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { value, digest };
  return out;
}

function translation(over: Partial<SyncedTranslation> = {}): SyncedTranslation {
  return { key: "title", value: "Titel", locale: "fr", marketId: "", ...over };
}

describe("findStaleTranslations", () => {
  it("returns nothing when every translation matches a filled primary value", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: false }), translation({ key: "body_html", outdated: false })],
      primary({ title: "Box", body_html: "<p>Box</p>" }),
    );
    expect(stale).toEqual([]);
  });

  it("flags a translation Shopify itself reports as outdated", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: true })],
      primary({ title: "Box" }),
    );
    expect(stale).toEqual([
      { key: "title", locale: "fr", reason: "outdated", primaryValue: "Box", digest: "digest-1" },
    ]);
  });

  it("flags a translation whose primary value was CLEARED — the key is then absent", () => {
    // Shopify's translatableContent only lists keys that HAVE a value, so
    // "meta_description is missing" IS "the merchant deleted it".
    const stale = findStaleTranslations(
      [translation({ key: "meta_description", outdated: false })],
      primary({ title: "Box" }),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ key: "meta_description", reason: "primary-empty" });
  });

  it("treats a whitespace-only primary value as cleared", () => {
    const stale = findStaleTranslations([translation({ key: "title" })], {
      title: { value: "   ", digest: "d" },
    });
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe("primary-empty");
  });

  it("leaves market-specific overrides alone", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: true, marketId: "gid://shopify/Market/1" })],
      primary({ title: "Box" }),
    );
    expect(stale).toEqual([]);
  });

  it("does not use the cleared-primary rule for keys this app does not manage", () => {
    const stale = findStaleTranslations(
      [translation({ key: "some_theme_key", outdated: false })],
      primary({ title: "Box" }),
    );
    expect(stale).toEqual([]);
  });

  it("still trusts Shopify's outdated flag on a key this app does not manage", () => {
    const stale = findStaleTranslations(
      [translation({ key: "some_theme_key", outdated: true })],
      primary({ title: "Box" }),
    );
    expect(stale).toHaveLength(1);
  });

  it("skips the cleared-primary rule entirely when NO primary content was fetched", () => {
    // An empty map is indistinguishable from a failed/partial fetch, and
    // "every field is empty" must never be inferred from it.
    const stale = findStaleTranslations(
      [translation({ key: "title" }), translation({ key: "body_html" })],
      {},
    );
    expect(stale).toEqual([]);
  });

  it("reports one entry per (locale, key), not one per fetched layer", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: true }), translation({ outdated: true })],
      primary({ title: "Box" }),
    );
    expect(stale).toHaveLength(1);
  });

  it("treats a missing outdated flag as 'not asked', never as 'outdated'", () => {
    const stale = findStaleTranslations([translation({})], primary({ title: "Box" }));
    expect(stale).toEqual([]);
  });
});

describe("partitionStaleTranslations", () => {
  const outdatedTitle = {
    key: "title",
    locale: "fr",
    reason: "outdated" as const,
    primaryValue: "Box",
    digest: "d",
  };

  it("purges everything when auto-translation is off", () => {
    const { retranslate, purge } = partitionStaleTranslations([outdatedTitle], false);
    expect(retranslate).toEqual([]);
    expect(purge).toEqual([outdatedTitle]);
  });

  it("re-translates a changed field when auto-translation is on", () => {
    const { retranslate, purge } = partitionStaleTranslations([outdatedTitle], true);
    expect(retranslate).toEqual([outdatedTitle]);
    expect(purge).toEqual([]);
  });

  it("purges a CLEARED field even with auto-translation on — there is nothing to translate", () => {
    const cleared = { ...outdatedTitle, reason: "primary-empty" as const, primaryValue: "" };
    const { retranslate, purge } = partitionStaleTranslations([cleared], true);
    expect(retranslate).toEqual([]);
    expect(purge).toEqual([cleared]);
  });

  it("purges when no digest is available — the write could not be registered", () => {
    const noDigest = { ...outdatedTitle, digest: null };
    const { retranslate, purge } = partitionStaleTranslations([noDigest], true);
    expect(purge).toEqual([noDigest]);
  });

  it("never auto-translates a handle — a slug is a URL", () => {
    const handle = { ...outdatedTitle, key: "handle" };
    const { retranslate, purge } = partitionStaleTranslations([handle], true);
    expect(retranslate).toEqual([]);
    expect(purge).toEqual([handle]);
  });
});
