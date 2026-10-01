/**
 * Every place that STARTS a detached re-translation hands its Task id back,
 * and every surface that can receive one watches it.
 *
 * This is a source-level check for the same reason `graphql-document-hygiene`
 * is: the rule spans a dozen files and holds only if all of them keep it, and
 * nothing else fails when one quietly stops. It has already been broken once —
 * a rebase dropped the single line in `useUnifiedContentEditor` that feeds the
 * watcher, and the ids of seven surfaces were collected on the server,
 * serialised onto the response and then thrown away, with typecheck, lint and
 * 4 000 tests all green.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf-8");

/** The save paths that call `reconcileAfterPrimarySave` and answer a page. */
const SAVE_PATHS = [
  "src/services/shopify-content.service.ts",
  "app/actions/product/update.actions.ts",
  "app/actions/content/sub-resources.action.ts",
  "app/actions/content/metaobject-update.action.ts",
  "app/actions/templates/templates-update.action.ts",
  "app/services/menu-tree.server.ts",
];

describe("the detached re-translation's Task id reaches the page", () => {
  it.each(SAVE_PATHS)("%s keeps the id instead of discarding the outcome", (path) => {
    const source = read(path);
    // It calls the repair…
    expect(source).toContain("reconcileAfterPrimarySave");
    // …keeps what it answered…
    expect(source).toMatch(/\.taskId\)?\s/);
    // …and puts it on the response under the one agreed name.
    expect(source).toContain("collectRetranslationTaskIds");
  });

  it("every `reconcileAfterPrimarySave` call in a save path is CAPTURED", () => {
    // An `await reconcileAfterPrimarySave(` with nothing on the left discards
    // the id — which is exactly how a second repair added to one of these files
    // would silently stop being waited for.
    for (const path of SAVE_PATHS) {
      const discarded = read(path).match(/^\s*await reconcileAfterPrimarySave\(/gm) ?? [];
      expect({ path, discarded: discarded.length }).toEqual({ path, discarded: 0 });
    }
  });

  it("the content editor feeds its own fetcher's responses to the watcher", () => {
    // The seven surfaces that share this hook have no other way in.
    const source = read("app/hooks/useUnifiedContentEditor.ts");
    expect(source).toContain("trackRetranslationTasks(fetcher.data)");
    expect(source).toContain("useBackgroundTaskRefresh(watchedTaskIds");
  });

  it("the product page feeds its SECOND fetcher in too", () => {
    // The sub-resource save runs on a fetcher of its own, deliberately — so it
    // would otherwise be the one surface nothing waits for.
    const source = read("app/routes/app.products.tsx");
    expect(source).toContain("onSaveResponse: editor.helpers.trackRetranslationTasks");
  });

  it("the menus page watches its own", () => {
    const source = read("app/routes/app.menus.tsx");
    expect(source).toContain("useBackgroundTaskRefresh(watchedTaskIds");
    expect(source).toContain("trackRetranslationTasks(tree)");
  });
});
