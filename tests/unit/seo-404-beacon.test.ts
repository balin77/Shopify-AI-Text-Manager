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
const FROZEN = join(__dirname, '..', 'fixtures', 'liquid', 'seo-404-beacon.a8da7d1.frozen.js');

/** Runs a beacon script against a stubbed browser and records what it sent. */
async function run(js: string, opts: { beacon: boolean; throws?: boolean }) {
  const calls: unknown[] = [];
  class FakeBlob {
    constructor(public parts: string[], public options: unknown) {}
  }
  const win = { location: { pathname: '/missing/page', search: '?a=1&b=2' } };
  const doc = { referrer: 'https://ref.example/x' };
  const nav: Record<string, unknown> = opts.beacon
    ? { sendBeacon: (...a: unknown[]) => { if (opts.throws) throw new Error('boom'); calls.push(['beacon', ...a]); return true; } }
    : {};
  const fetchStub = (...a: unknown[]) => { calls.push(['fetch', ...a]); return Promise.resolve({}); };
  new Function('window', 'document', 'navigator', 'Blob', 'fetch', js)(win, doc, nav, FakeBlob, fetchStub);
  return JSON.parse(JSON.stringify(calls));
}

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

  it('sends exactly what the frozen inline beacon sent (beacon, fetch fallback, and a throwing beacon)', async () => {
    const frozen = readFileSync(FROZEN, 'utf8');
    const asset = readFileSync(ASSET, 'utf8');
    for (const opts of [{ beacon: true }, { beacon: false }, { beacon: true, throws: true }]) {
      const before = await run(frozen, opts);
      const after = await run(asset, opts);
      expect(after).toEqual(before);
    }
    // the control: the stub really records a payload with both keys
    const sent = await run(asset, { beacon: true });
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('beacon');
    expect(sent[0][1]).toBe('/apps/contentpilot/seo-404');
    expect(JSON.parse(sent[0][2].parts[0])).toEqual({ path: '/missing/page?a=1&b=2', referrer: 'https://ref.example/x' });
    const viaFetch = await run(asset, { beacon: false });
    expect(viaFetch[0][0]).toBe('fetch');
    expect(viaFetch[0][2]).toMatchObject({ method: 'POST', keepalive: true });
  });

  it('renders the script tag on a 404 page and nothing on other pages', async () => {
    const engine = makeEngine('source');
    const render = (page_type: string) =>
      engine.parseAndRender(forLiquidjs(block), { request: { page_type, path: '/x', locale: { iso_code: 'de' } }, shop: {}, block: { id: 'b', settings: {} } });
    expect(await render('404')).toContain('<script src="https://cdn.example/assets/seo-404.js" defer></script>');
    expect(await render('index')).not.toContain('seo-404.js');
  });
});
