/**
 * Shopify's `seo` input is a UNIT — and there is ONE place that knows it.
 *
 * `seo: { title }` without a description CLEARS the description on
 * productUpdate and collectionUpdate alike. CLAUDE.md states the rule ("Always
 * send both halves or preserve the untouched value"), `update.actions.ts` has
 * honoured it since long before this test, and `buildPreservedSeo` is the
 * merge — including the part that is easy to re-derive wrongly: when the
 * lookup FAILS, the missing side is dropped rather than sent as `""`.
 *
 * The SEO tab's "Fix with AI" had its own answer and shipped the bug live: it
 * writes exactly one field per finding, so it was always the partial case, and
 * `fixAllForItem` issues two single-sided writes in a row where only the last
 * survives — both reported to the merchant as successes.
 *
 * This is a source-shape guard rather than a behaviour test because the
 * handler is a 2,000-line task runner behind a plan gate and an AI call; what
 * has to stay true is structural, and a structural claim is what a grep can
 * actually keep true.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('partial SEO writes go through the one merge', () => {
  it('the bulk-fix handler builds no `seo` object of its own', () => {
    const src = read('app/routes/api-ai-handlers/seo-bulk-fix.handler.ts');

    // The two shapes that shipped the bug, in their exact historic spelling
    // and in the obvious variations of it.
    expect(src).not.toMatch(/seoInput\[[^\]]*\]\s*=/);
    expect(src).not.toMatch(/field === "seoTitle"\s*\?\s*\{\s*title:/);
    expect(src).not.toMatch(/\{\s*seo:\s*\{\s*(title|description):[^}]*\}\s*\}/);
  });

  it('...and builds none at all: both partial writes ride the editor\'s own save paths', () => {
    const src = read('app/routes/api-ai-handlers/seo-bulk-fix.handler.ts');
    // Products go through the product editor's update (partial `seo` merge,
    // echo check, cache mirror, translation repair) and collections / pages /
    // articles through the content service's `updateContent`, which owns the
    // same merge for collections. A direct merge here would be a second copy.
    expect(src).not.toMatch(/contentService\.buildPreservedSeo\(/);
    expect(src).toMatch(/handleUpdateProduct\(/);
    expect(src).toMatch(/editorService\.updateContent\(/);
  });

  it('the merge itself is reachable — a private helper cannot be the shared one', () => {
    const src = read('src/services/shopify-content.service.ts');
    expect(src).toMatch(/\n  async buildPreservedSeo\(/);
    expect(src).not.toMatch(/private async buildPreservedSeo\(/);
  });

  it('and it still refuses to send "" for a side it could not read', () => {
    const src = read('src/services/shopify-content.service.ts');
    const body = src.slice(src.indexOf('async buildPreservedSeo('));
    const failure = body.slice(body.indexOf('catch'), body.indexOf('return seo;'));
    // `undefined` is dropped by JSON.stringify and leaves Shopify's value
    // alone; `''` would clear it.
    expect(failure).toMatch(/seo\.title = undefined/);
    expect(failure).toMatch(/seo\.description = undefined/);
  });
});
