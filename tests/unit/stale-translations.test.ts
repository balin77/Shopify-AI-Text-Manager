import { describe, it, expect } from "vitest";
import {
  digestBaselineKey,
  findStaleTranslations,
  partitionStaleTranslations,
  type PrimaryContentEntry,
  type SyncedTranslation,
} from "../../app/services/translations/stale-translations.shared";

const OLD = "digest-old";
const NEW = "digest-new";

/** A filled primary field, as `translatableContent` reports it. */
function primary(
  entries: Record<string, string>,
  digest: string = NEW,
): Record<string, PrimaryContentEntry> {
  const out: Record<string, PrimaryContentEntry> = {};
  for (const [key, value] of Object.entries(entries)) out[key] = { value, digest };
  return out;
}

function translation(over: Partial<SyncedTranslation> = {}): SyncedTranslation {
  return { key: "title", value: "Titel", locale: "fr", marketId: "", outdated: true, ...over };
}

/**
 * The baseline a previous sync left behind, per (locale, key): every row was
 * written against OLD, and the source has since moved.
 */
function movedIn(...locales: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const locale of locales) {
    for (const key of ["title", "body_html", "meta_description", "handle", "some_theme_key"]) {
      out[digestBaselineKey(locale, key)] = OLD;
    }
  }
  return out;
}
const moved = movedIn("fr", "de");

describe("findStaleTranslations — the digest gate", () => {
  it("reports nothing when the source digest is unchanged since our last sync", () => {
    // Shopify still flags the translation outdated (an edit long before this
    // app was installed), but THIS sync saw no change — the case that would
    // otherwise mass-delete a translating shop's history on any webhook.
    const stale = findStaleTranslations([translation({ outdated: true })], primary({ title: "Box" }, OLD), {
      [digestBaselineKey("fr", "title")]: OLD,
    });
    expect(stale).toEqual([]);
  });

  it("reports nothing when there is no previous digest at all (first sync)", () => {
    const stale = findStaleTranslations([translation({ outdated: true })], primary({ title: "Box" }), {});
    expect(stale).toEqual([]);
  });

  it("reports nothing when the stored digest is null (rows predating digest storage)", () => {
    const stale = findStaleTranslations([translation({ outdated: true })], primary({ title: "Box" }), {
      [digestBaselineKey("fr", "title")]: null,
    });
    expect(stale).toEqual([]);
  });

  it("flags a translation once the source digest moved AND Shopify calls it outdated", () => {
    const stale = findStaleTranslations([translation({ outdated: true })], primary({ title: "Box" }), moved);
    expect(stale).toEqual([
      { key: "title", locale: "fr", reason: "outdated", primaryValue: "Box", digest: NEW },
    ]);
  });

  it("leaves a translation alone that was re-registered against the NEW source", () => {
    // Digest moved, but Shopify reports outdated:false — someone already
    // translated the new text (another app, the Shopify admin). Deleting it
    // would throw away the up-to-date translation.
    const stale = findStaleTranslations([translation({ outdated: false })], primary({ title: "Box" }), moved);
    expect(stale).toEqual([]);
  });

  it("flags a translation whose primary value was CLEARED — the key is then absent", () => {
    // Shopify's translatableContent only lists keys that HAVE a value, so
    // "meta_description is missing" IS "the merchant deleted it" — and the
    // missing digest differs from the stored one, so the gate opens.
    const stale = findStaleTranslations(
      [translation({ key: "meta_description", outdated: false })],
      primary({ title: "Box" }),
      moved,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ key: "meta_description", reason: "primary-empty", primaryValue: "" });
  });

  it("treats a whitespace-only primary value as cleared", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: false })],
      { title: { value: "   ", digest: NEW } },
      moved,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe("primary-empty");
  });
});

describe("findStaleTranslations — scope", () => {
  it("leaves market-specific overrides alone", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: true, marketId: "gid://shopify/Market/1" })],
      primary({ title: "Box" }),
      moved,
    );
    expect(stale).toEqual([]);
  });

  it("does not use the cleared-primary rule for keys this app does not manage", () => {
    const stale = findStaleTranslations(
      [translation({ key: "some_theme_key", outdated: false })],
      primary({ title: "Box" }),
      moved,
    );
    expect(stale).toEqual([]);
  });

  it("still trusts Shopify's outdated flag on a key this app does not manage", () => {
    const stale = findStaleTranslations(
      [translation({ key: "some_theme_key", outdated: true })],
      primary({ title: "Box" }),
      moved,
    );
    expect(stale).toHaveLength(1);
  });

  it("judges nothing at all when NO primary content was fetched", () => {
    // An empty map is indistinguishable from a failed or partial fetch. Neither
    // rule may fire on it — not the cleared-primary one, and not the outdated
    // flag either: with no primary content there is no digest that could have
    // moved, so acting would purge the whole resource off a failed query.
    const stale = findStaleTranslations(
      [translation({ key: "body_html", outdated: true }), translation({ key: "title", outdated: true })],
      {},
      moved,
    );
    expect(stale).toEqual([]);
  });

  it("judges each locale against ITS OWN baseline", () => {
    // DE was translated against the old source, FR was re-translated against
    // the new one. Only DE is stale — and which one that is must not depend on
    // the row order the database happens to return.
    const stale = findStaleTranslations(
      [translation({ locale: "de", outdated: true }), translation({ locale: "fr", outdated: false })],
      primary({ title: "Box" }),
      { [digestBaselineKey("de", "title")]: OLD, [digestBaselineKey("fr", "title")]: NEW },
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].locale).toBe("de");
  });

  it("treats a missing outdated flag as 'not asked', never as 'outdated'", () => {
    const stale = findStaleTranslations(
      [translation({ outdated: undefined })],
      primary({ title: "Box" }),
      moved,
    );
    expect(stale).toEqual([]);
  });

  it("reports one entry per (locale, key) even when a key repeats across locales", () => {
    const stale = findStaleTranslations(
      [
        translation({ locale: "fr" }),
        translation({ locale: "de" }),
        translation({ locale: "fr" }), // duplicate global row
      ],
      primary({ title: "Box" }),
      moved,
    );
    expect(stale.map((s) => s.locale).sort()).toEqual(["de", "fr"]);
  });
});

describe("partitionStaleTranslations", () => {
  const outdatedTitle = {
    key: "title",
    locale: "fr",
    reason: "outdated" as const,
    primaryValue: "Box",
    digest: NEW,
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
