import { describe, it, expect } from "vitest";
import { fileTilesByUrl } from "~/components/image-manager/url-gid";

const MEDIA = "gid://shopify/MediaImage/1";

describe("variant gallery tiles resolve to the product medium's replacement", () => {
  const tileOf = (gid: string) => (gid === MEDIA ? { src: "repl.jpg" } : null);

  it("keys the entry by the variant tile's url (fileUrlMap), also when it differs from the product gallery's by ?v=", () => {
    const fileUrlMap = {
      [MEDIA]: "https://cdn.shopify.com/a.jpg?v=2",
      "gid://shopify/MediaImage/77": "https://cdn.shopify.com/library-only.jpg",
    };
    const urlToGid = { "https://cdn.shopify.com/a.jpg?v=1": MEDIA };
    const out = fileTilesByUrl(fileUrlMap, urlToGid, tileOf);
    expect(out["https://cdn.shopify.com/a.jpg?v=2"]).toEqual({ src: "repl.jpg" });
    expect(out["https://cdn.shopify.com/library-only.jpg"]).toBeUndefined();
  });

  it("the product gallery's url->gid wins over the fileUrlMap inverse for the same url", () => {
    const url = "https://cdn.shopify.com/a.jpg";
    const out = fileTilesByUrl({ "gid://shopify/MediaImage/5": url }, { [url]: MEDIA }, tileOf);
    expect(out[url]).toEqual({ src: "repl.jpg" });
  });

  it("ignores a fileUrlMap key that is not a GID (an unsaved upload's staging url)", () => {
    const out = fileTilesByUrl({ "https://staging/x": "blob:x" }, {}, () => ({ src: "y" }));
    expect(out).toEqual({});
  });
});
