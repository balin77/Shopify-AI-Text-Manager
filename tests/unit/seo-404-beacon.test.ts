import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../scripts/minify-liquid-blocks.mjs';
import { makeEngine, forLiquidjs, read } from './helpers/liquid-engine';

/**
 * The 404 beacon lives in assets/seo-404.js (assets do not count against the
 * 100 KiB Liquid budget); structured-data.liquid only includes it on 404 pages.
 */
const BLOCK = join(EXTENSION_DIR, 'blocks', 'structured-data.liquid');
const ASSET = join(EXTENSION_DIR, 'assets', 'seo-404.js');

describe('404 beacon', () => {
  const block = read(BLOCK);

  it('the block loads the asset deferred, only on 404 pages, and carries no inline beacon', () => {
    expect(block).toContain(
      "{%- if request.page_type == '404' -%}\n<script src=\"{{ 'seo-404.js' | asset_url }}\" defer></script>\n{%- endif -%}",
    );
    expect(block).not.toContain('navigator.sendBeacon');
    expect(block).not.toContain('new Blob');
    expect(block).not.toContain('/apps/contentpilot/seo-404');
  });

  it('the asset posts path + referrer to the collector, beacon first and fetch as fallback, never throwing', () => {
    const js = readFileSync(ASSET, 'utf8');
    expect(js).toContain("'/apps/contentpilot/seo-404'");
    expect(js).toContain('window.location.pathname + window.location.search');
    expect(js).toContain("document.referrer || ''");
    expect(js).toContain('navigator.sendBeacon');
    expect(js).toContain('keepalive: true');
    expect(js).toMatch(/try \{[\s\S]*\} catch \(e\)/);
    expect(() => new Function(js)).not.toThrow();
  });

  it('renders the script tag on a 404 page and nothing on other pages', async () => {
    const engine = makeEngine('source');
    const render = (page_type: string) =>
      engine.parseAndRender(forLiquidjs(block), { request: { page_type, path: '/x', locale: { iso_code: 'de' } }, shop: {}, block: { id: 'b', settings: {} } });
    expect(await render('404')).toContain('<script src="https://cdn.example/assets/seo-404.js" defer></script>');
    expect(await render('index')).not.toContain('seo-404.js');
  });
});
