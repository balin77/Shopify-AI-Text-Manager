/**
 * The product sync's translation-cache shield and the SYNC-ONLY key the
 * options & metafields card marks (translation-locks.shared.ts).
 *
 * An interactive sub-resource translate marks each sub-resource GID (which the
 * detached repairs watch) but used to mark nothing the product sync asks for,
 * so a `products/update` sync landing seconds later rewrote the option and
 * metafield translation cache from a Shopify read taken before the write. The
 * new key shields that rewrite -- and must NOT be the repair's lock, or one
 * translate button would abort a running re-translation of the whole group.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  loggers: { translation: vi.fn(), seo: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { productTranslationCacheShielded } from "~/services/product-sync.service";
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

describe("productTranslationCacheShielded", () => {
  it("is off when nothing was written", () => {
    expect(productTranslationCacheShielded(product)).toBe(false);
  });

  it("an interactive sub-resource write (the sync-only shield) shields the cache rewrite", () => {
    markTranslationSaved(subResourceSyncShieldId(product));
    expect(productTranslationCacheShielded(product)).toBe(true);
  });

  it("the shield is NOT the repair's lock: a running re-translation does not see it", () => {
    markTranslationSaved(subResourceSyncShieldId(product));
    expect(isTranslationRecentlySaved(subResourceLockId(product))).toBe(false);
    expect(isTranslationRecentlySaved(product)).toBe(false);
    expect(subResourceSyncShieldId(product)).not.toBe(subResourceLockId(product));
    expect(subResourceSyncShieldId(product)).not.toBe(altTextSyncShieldId(product));
  });

  it("every other key a write of ours marks still shields", () => {
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

  it("another product's shield does not shield this one", () => {
    markTranslationSaved(subResourceSyncShieldId(`${product}1`));
    expect(productTranslationCacheShielded(product)).toBe(false);
  });
});
