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

/**
 * THE FILL — "auto-translate" has to mean translate, not only refresh.
 *
 * Everything above answers "which EXISTING translations moved out from under
 * their source", because a translation row is where the digest baseline lives.
 * A locale that was never translated has no row, so it can never be the one
 * that notices — and on a half-translated shop that read as the switch being
 * off: the primary text changed, the two languages that had a translation got
 * the new one, and the six that had none stayed empty forever.
 */
describe("findStaleTranslations — the fill", () => {
  it("translates a proven key into a locale that holds NO translation of it", () => {
    const stale = findStaleTranslations(
      [translation({ locale: "fr" })],
      primary({ title: "Box" }),
      moved,
      { fillLocales: ["fr", "de", "it"] },
    );
    expect(stale.map((s) => s.locale).sort()).toEqual(["de", "fr", "it"]);
    expect(stale.every((s) => s.key === "title" && s.primaryValue === "Box")).toBe(true);
  });

  it("fills NOTHING when no key got through the gate — the fill adds locales, never keys", () => {
    // Same input, but the digest did not move: the fill may only widen a key
    // this function already proved, or one price edit would translate a whole
    // catalogue on the merchant's own API key.
    const stale = findStaleTranslations(
      [translation({ locale: "fr" })],
      primary({ title: "Box" }, OLD),
      { [digestBaselineKey("fr", "title")]: OLD },
      { fillLocales: ["fr", "de", "it"] },
    );
    expect(stale).toEqual([]);
  });

  it("does not fill a locale that already has a translation — that row is judged on its own evidence", () => {
    // `de` holds a translation whose digest did NOT move, so it is current and
    // must be left alone; the fill must not sneak it back in under `fr`'s
    // evidence.
    const stale = findStaleTranslations(
      [translation({ locale: "fr" }), translation({ locale: "de", outdated: false })],
      primary({ title: "Box" }),
      { [digestBaselineKey("fr", "title")]: OLD },
      { fillLocales: ["fr", "de"] },
    );
    expect(stale.map((s) => s.locale)).toEqual(["fr"]);
  });

  it("never fills a key that would be REMOVED rather than translated", () => {
    // A cleared field, a missing digest and a `handle` all end in the purge —
    // and there is nothing to purge in a locale that holds no translation, so a
    // fill entry there would only send an unechoed removal that logs as
    // unconfirmed.
    const cleared = findStaleTranslations(
      [translation({ key: "body_html", locale: "fr" })],
      // `title` moved and is filled; `body_html` was cleared (no entry at all).
      primary({ title: "Box" }),
      moved,
      { fillLocales: ["fr", "de"] },
    );
    expect(cleared.filter((s) => s.locale === "de")).toEqual([]);

    const handle = findStaleTranslations(
      [translation({ key: "handle", locale: "fr" })],
      primary({ handle: "box" }),
      moved,
      { fillLocales: ["fr", "de"] },
    );
    expect(handle.map((s) => s.locale)).toEqual(["fr"]);
  });

  it("fills a bare-value surface only where the generic prompt can carry the value", () => {
    // `anyKey` is the value surfaces' lift of the content-field allowlist; the
    // value-level refusal (markup, newlines) still stands, and a refused value
    // is a DECLINE, so filling it would promise a translation nothing delivers.
    const filled = findStaleTranslations(
      [translation({ key: "some_theme_key", locale: "fr" })],
      primary({ some_theme_key: "Add to cart" }),
      moved,
      { fillLocales: ["fr", "de"], anyKey: true },
    );
    expect(filled.map((s) => s.locale).sort()).toEqual(["de", "fr"]);

    const refused = findStaleTranslations(
      [translation({ key: "some_theme_key", locale: "fr" })],
      primary({ some_theme_key: "<p>Add to cart</p>" }),
      moved,
      { fillLocales: ["fr", "de"], anyKey: true },
    );
    expect(refused.map((s) => s.locale)).toEqual(["fr"]);
  });

  it("fills a locale whose row came back with NO VALUE — that row is not a translation", () => {
    // `translations(locale:)` answers with a row per translatable KEY and
    // `value: null` where the locale has nothing, and every sync in this repo
    // hands those rows straight through. Counting them as "already translated"
    // made the fill a no-op on exactly the shops it is for: a shop publishing
    // de and it with only de translated stayed empty in it forever.
    const stale = findStaleTranslations(
      [
        translation({ locale: "de" }),
        { key: "title", value: null as unknown as string, locale: "it", marketId: "" },
        { key: "title", value: "   ", locale: "es", marketId: "" },
      ],
      primary({ title: "Box" }),
      moved,
      { fillLocales: ["de", "it", "es"] },
    );
    expect(stale.map((s) => s.locale).sort()).toEqual(["de", "es", "it"]);
  });

  it("marks a filled entry, and the partition DROPS it when the auto-translation is off", () => {
    // A fill has nothing to fall back to: with the switch off it is not a purge
    // candidate, it is not a candidate at all — a removal for a translation
    // that does not exist echoes nothing back and reports a deletion the
    // merchant never had.
    const stale = findStaleTranslations(
      [translation({ locale: "de" })],
      primary({ title: "Box" }),
      moved,
      { fillLocales: ["de", "it"] },
    );
    const filled = stale.find((s) => s.locale === "it");
    expect(filled?.filled).toBe(true);
    expect(stale.find((s) => s.locale === "de")?.filled).toBeUndefined();

    const off = partitionStaleTranslations(stale, false);
    expect(off.purge.map((e) => e.locale)).toEqual(["de"]);
    expect(off.retranslate).toEqual([]);
    expect(off.declined).toEqual([]);
  });

  it("changes nothing when no fill locales are given", () => {
    const stale = findStaleTranslations([translation({ locale: "fr" })], primary({ title: "Box" }), moved);
    expect(stale.map((s) => s.locale)).toEqual(["fr"]);
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
