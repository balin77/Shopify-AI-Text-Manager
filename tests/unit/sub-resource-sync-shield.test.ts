/**
 * The product sync's translation-cache shields and the SYNC-ONLY key the
 * options & metafields card marks (translation-locks.shared.ts).
 *
 * An interactive sub-resource translate marks each sub-resource GID (which the
 * detached repairs watch) but used to mark nothing the product sync asks for,
 * so a `products/update` sync landing seconds later rewrote the option and
 * metafield translation cache from a Shopify read taken before the write. The
 * new key shields that rewrite -- and must NOT be the repair's lock, or one
 * translate button would abort a running re-translation of the whole group.
 * It also must NOT shield the product's own FIELD translations: an option
 * translate says nothing about them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  loggers: { translation: vi.fn(), seo: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  productTranslationCacheShielded,
  subResourceTranslationCacheShielded,
} from "~/services/product-sync.service";
import {
  altTextLockId,
  altTextSyncShieldId,
  marketLayerLockId,
  subResourceLockId,
  subResourceSyncShieldId,
} from "~/services/translations/translation-locks.shared";
import { isTranslationRecentlySaved, markTranslationSaved } from "~/utils/translation-save-lock.server";

let n = 0;
let product = "";
beforeEach(() => {
  // A fresh product per test: the lock map is module state.
  n += 1;
  product = `gid://shopify/Product/9${n}00`;
});

describe("productTranslationCacheShielded (the whole block)", () => {
  it("is off when nothing was written", () => {
    expect(productTranslationCacheShielded(product)).toBe(false);
    expect(subResourceTranslationCacheShielded(product)).toBe(false);
  });

  it("an interactive sub-resource write shields ONLY the sub-resource rewrite, not the product fields", () => {
    markTranslationSaved(subResourceSyncShieldId(product));
    expect(subResourceTranslationCacheShielded(product)).toBe(true);
    expect(productTranslationCacheShielded(product)).toBe(false);
  });

  it("the shield is NOT the repair's lock: a running re-translation does not see it", () => {
    markTranslationSaved(subResourceSyncShieldId(product));
    expect(isTranslationRecentlySaved(subResourceLockId(product))).toBe(false);
    expect(isTranslationRecentlySaved(product)).toBe(false);
    expect(subResourceSyncShieldId(product)).not.toBe(subResourceLockId(product));
    expect(subResourceSyncShieldId(product)).not.toBe(altTextSyncShieldId(product));
  });

  it("every key it asked for before the sync-only shield still shields the whole block", () => {
    for (const key of [
      product,
      subResourceLockId(product),
      marketLayerLockId(subResourceLockId(product)),
      altTextLockId(product),
      altTextSyncShieldId(product),
    ]) {
      n += 1;
      const p = `gid://shopify/Product/8${n}00`;
      markTranslationSaved(key.replace(product, p));
      expect(productTranslationCacheShielded(p)).toBe(true);
    }
  });

  it("the sub-resource guard asks for the repair lock (both layers) and the sync-only shield, nothing else", () => {
    for (const [key, expected] of [
      [subResourceSyncShieldId(product), true],
      [subResourceLockId(product), true],
      [marketLayerLockId(subResourceLockId(product)), true],
      [product, false],
      [altTextLockId(product), false],
      [altTextSyncShieldId(product), false],
    ] as const) {
      n += 1;
      const p = `gid://shopify/Product/7${n}00`;
      markTranslationSaved(key.replace(product, p));
      expect(subResourceTranslationCacheShielded(p)).toBe(expected);
    }
  });

  it("another product's shield does not shield this one", () => {
    markTranslationSaved(subResourceSyncShieldId(`${product}1`));
    expect(subResourceTranslationCacheShielded(product)).toBe(false);
    expect(productTranslationCacheShielded(product)).toBe(false);
  });
});
