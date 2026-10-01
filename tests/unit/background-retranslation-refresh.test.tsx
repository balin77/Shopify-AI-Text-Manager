/**
 * The reload that follows a DETACHED re-translation, against the five overlay
 * refs it has to survive.
 *
 * A primary save with `autoTranslateExternalChanges` on hands the foreign
 * languages to a Task-tracked AI run that finishes minutes after the response.
 * The page now waits for it and re-reads the loader once — and `resolve()` sits
 * between that fresh data and the merchant, reading overlays that deliberately
 * OUTLIVE a revalidation. Three questions, and getting any of them wrong is
 * worse than not reloading at all:
 *
 *   (a) a field the merchant is typing in, unsaved → stays, always;
 *   (b) a language they cleared and saved in this session → stays empty;
 *   (c) a language they never touched and the AI has just filled → becomes
 *       visible, instead of disappearing behind a stale overlay entry.
 *
 * (c) is the one that was broken before this change, and in two different ways
 * at once — see its test.
 */

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  useUiDataLoader,
  preserveUnsavedEdits,
  type UseUiDataLoaderReturn,
} from "~/hooks/useUiDataLoader";
import type {
  ContentEditorConfig,
  FieldDefinition,
  TranslatableContentItem,
} from "~/types/content-editor.types";

const PRIMARY = "de";
const FOREIGN = "fr";

const TITLE: FieldDefinition = {
  key: "title",
  translationKey: "title",
  type: "text",
  labelKey: "title",
} as unknown as FieldDefinition;

const config = { contentType: "product" } as unknown as ContentEditorConfig;

/** The item as the loader hands it over, with whatever translations the server
 *  currently holds. */
function itemWith(translations: Array<{ key: string; locale: string; value: string }>) {
  return {
    id: "gid://shopify/Product/1",
    title: "Neuer Titel",
    handle: "neuer-titel",
    translations,
  } as unknown as TranslatableContentItem;
}

function loader() {
  return renderHook(() => useUiDataLoader({ config, primaryLocale: PRIMARY }));
}

function foreignValue(api: UseUiDataLoaderReturn, item: TranslatableContentItem) {
  return api.resolve(item, "title", "title", FOREIGN).value;
}

describe("(a) unsaved input survives the background reload", () => {
  it("keeps what the merchant typed and takes the server's value everywhere else", () => {
    const resolved = { title: "Neuer Titel vom Server", body: "Server-Text" };
    const current = { title: "was ich gerade tippe", body: "Server-Text" };
    const previousBaseline = { title: "Alter Titel", body: "Server-Text" };

    const { values, preservedKeys } = preserveUnsavedEdits(resolved, current, previousBaseline);

    expect(values.title).toBe("was ich gerade tippe");
    expect(values.body).toBe("Server-Text");
    expect(preservedKeys).toEqual(["title"]);
  });

  it("keeps an unsaved CLEAR — an emptied field is input too", () => {
    const { values, preservedKeys } = preserveUnsavedEdits(
      { title: "Server-Titel" },
      { title: "" },
      { title: "Alter Titel" },
    );
    expect(values.title).toBe("");
    expect(preservedKeys).toEqual(["title"]);
  });

  it("compares against the baseline the input is dirty AGAINST, never the new one", () => {
    // The trap: `onDataLoaded` installs the resolved values as the new
    // baseline. Comparing against THAT would find the typed title clean
    // (it differs from the new baseline, but so does everything) — or, the
    // other way round, would make every refreshed field look edited and freeze
    // the page on stale text. Passing the PREVIOUS baseline is what makes the
    // answer "only the field they touched".
    const resolved = { title: "AI-Titel", body: "AI-Text" };
    const previousBaseline = { title: "Alter Titel", body: "Alter Text" };
    // Nothing typed: the editor still shows what it loaded.
    const untouched = { ...previousBaseline };

    const { values, preservedKeys } = preserveUnsavedEdits(resolved, untouched, previousBaseline);

    expect(preservedKeys).toEqual([]);
    expect(values).toEqual(resolved);
  });
});

describe("(b) a language cleared and saved in this session stays empty", () => {
  it("shows nothing, because the server holds nothing and no overlay invents one", () => {
    const { result } = loader();

    // The merchant cleared the French title and saved it. `handleClearField`
    // marks the key deleted before the submit; the save response retires both
    // the mark and the overlay, because the server is now the truth.
    act(() => {
      result.current.refs.deletedTranslationKeysRef.current.add("title");
      result.current.onSaveComplete(FOREIGN, { title: "" }, [TITLE]);
    });

    // The reload arrives. The server really has no French title.
    act(() => {
      result.current.onBackgroundRetranslation();
    });

    expect(foreignValue(result.current, itemWith([]))).toBe("");
  });

  it("does not resurrect it from an overlay the reload was supposed to retire", () => {
    const { result } = loader();

    // The mirror image of (c): here the overlay is GONE (the clear removed it)
    // and the server holds nothing, so the reload must not find a value
    // anywhere. If `onBackgroundRetranslation` ever started seeding overlays
    // from the item instead of dropping them, this is what would break.
    act(() => {
      result.current.onSaveComplete(FOREIGN, { title: "" }, [TITLE]);
      result.current.onBackgroundRetranslation();
    });

    expect(result.current.refs.localTranslationsRef.current.title?.[FOREIGN]).toBeUndefined();
    expect(foreignValue(result.current, itemWith([]))).toBe("");
  });
});

describe("(c) a language the AI just filled becomes visible", () => {
  it("was hidden by the deleted-keys mark, and is not any more", () => {
    const { result } = loader();

    // A primary save marks every changed field's translation key as deleted —
    // right, while the server is purging those translations. The moment the AI
    // writes new ones it is exactly wrong: the language the run just filled
    // keeps rendering empty, which is the complaint this whole mechanism
    // answers.
    act(() => {
      result.current.refs.deletedTranslationKeysRef.current.add("title");
    });
    const fresh = itemWith([{ key: "title", locale: FOREIGN, value: "Nouveau titre" }]);
    expect(foreignValue(result.current, fresh)).toBe("");

    act(() => {
      result.current.onBackgroundRetranslation();
    });
    expect(foreignValue(result.current, fresh)).toBe("Nouveau titre");
  });

  it("was hidden by a stale local override, and is not any more", () => {
    const { result } = loader();

    // The second way it disappeared: `localTranslationsRef` wins over
    // `item.translations` in the priority chain, so a value staged earlier in
    // the session — a translate-to-all-locales run, a foreign save — kept being
    // shown over the text the AI had just written, and the next save would have
    // written the old one straight back.
    act(() => {
      result.current.refs.localTranslationsRef.current.title = { [FOREIGN]: "Ancien titre" };
    });
    const fresh = itemWith([{ key: "title", locale: FOREIGN, value: "Nouveau titre" }]);
    expect(foreignValue(result.current, fresh)).toBe("Ancien titre");

    act(() => {
      result.current.onBackgroundRetranslation();
    });
    expect(foreignValue(result.current, fresh)).toBe("Nouveau titre");
  });

  it("leaves the PRIMARY cache alone — the AI never writes it", () => {
    const { result } = loader();
    const item = itemWith([]);

    // What the merchant saved a moment ago, which the loader may not carry yet.
    act(() => {
      result.current.refs.savedPrimaryValuesRef.current[item.id] = { title: "Gerade gespeichert" };
      result.current.onBackgroundRetranslation();
    });

    expect(result.current.resolve(item, "title", "title", PRIMARY).value).toBe("Gerade gespeichert");
  });
});
