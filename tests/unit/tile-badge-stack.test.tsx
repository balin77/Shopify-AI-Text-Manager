import React from "react";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SortableImageGrid, TILE_BADGE_STACK_STYLE, TILE_BADGE_STYLE } from "../../app/components/image-manager/SortableImageGrid";
import { I18nProvider } from "../../app/contexts/I18nContext";

// Layout is measured in a real browser (see the commit message); jsdom has no
// layout, so this pins the STRUCTURE that guarantees no overlap: alt, format and
// 3D badges live in ONE vertical flex stack and none positions itself.
function render(thumbSize: number, urls: string[], metas: any = {}) {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      <SortableImageGrid containerId="p" imageUrls={urls} imageMetas={metas} onReorder={() => {}} selectedUrls={new Set()} thumbSize={thumbSize} />
    </I18nProvider>,
  );
}

describe("tile badge stack", () => {
  it("stacks alt and format badges vertically in one container", () => {
    expect(TILE_BADGE_STACK_STYLE.display).toBe("flex");
    expect(TILE_BADGE_STACK_STYLE.flexDirection).toBe("column-reverse");
    expect(TILE_BADGE_STYLE.position).toBeUndefined();
    for (const size of [80, 120, 200]) {
      const html = render(size, ["https://cdn.example.com/a.webp"]);
      const stack = html.match(/<div data-tile-badge-stack[^>]*>(.*?)<\/div><\/div>(?=<)/s);
      expect(stack, `size ${size}`).toBeTruthy();
      expect((html.match(/data-tile-badge-stack/g) ?? []).length).toBe(1);
      const inner = html.slice(html.indexOf("data-tile-badge-stack"));
      expect(inner).toContain('data-tile-badge="alt"');
      expect(inner).toContain('data-tile-badge="format"');
      // no badge carries its own absolute position
      const badges = html.match(/<div data-tile-badge="[^"]+"[^>]*>/g) ?? [];
      expect(badges.length).toBe(2);
      for (const b of badges) expect(b).not.toContain("position:absolute");
    }
  });
});
