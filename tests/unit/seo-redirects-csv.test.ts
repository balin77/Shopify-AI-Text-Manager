import { describe, it, expect } from "vitest";
import {
  parseRedirectsCsv,
  coerceSourcePath,
  coerceTargetPath,
} from "~/services/seo/redirects-csv";

/**
 * Parser coverage for the redirects CSV importer. The parser is intentionally
 * lenient about third-party export formats — Shopify's own export, Yoast /
 * Rank Math / SEOPress WordPress dumps, and German `;`-delimited Excel CSVs
 * all need to survive without hand-editing.
 */

describe("parseRedirectsCsv — the app's own format", () => {
  it("parses the standard `path,target` header + rows", () => {
    const csv = 'path,target\n/old,/new\n"/foo bar","/x"\n';
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { path: "/old", target: "/new", csvRow: 2 },
      { path: "/foo bar", target: "/x", csvRow: 3 },
    ]);
  });

  it("works without a header when the first cell already looks like a path", () => {
    const { rows } = parseRedirectsCsv("/old,/new\n/a,/b\n");
    expect(rows.map((r) => [r.path, r.target])).toEqual([
      ["/old", "/new"],
      ["/a", "/b"],
    ]);
  });
});

describe("parseRedirectsCsv — Shopify admin export", () => {
  it("recognizes `Redirect from,Redirect to` and skips that header row", () => {
    const csv = "Redirect from,Redirect to\n/old-product,/products/new\n/legacy,/pages/about\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { path: "/old-product", target: "/products/new", csvRow: 2 },
      { path: "/legacy", target: "/pages/about", csvRow: 3 },
    ]);
  });
});

describe("parseRedirectsCsv — WordPress SEO plugins", () => {
  it("Yoast: `Source URL,Target URL,Type` — Type column ignored, absolute URLs collapsed", () => {
    const csv =
      "Source URL,Target URL,Type\n" +
      "https://shop.example.com/old,https://shop.example.com/new,301\n" +
      "/foo?utm=x,/bar,301\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { path: "/old", target: "/new", csvRow: 2 },
      { path: "/foo", target: "/bar", csvRow: 3 },
    ]);
  });

  it("Rank Math regex rows are surfaced as unsupportedRegex, not silently kept", () => {
    const csv =
      "source,destination,type\n" +
      "/blog/.*,/blog,Regex\n" +
      "/old,/new,Redirect\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([
      { row: 2, path: "/blog/.*", error: "unsupportedRegex" },
    ]);
    expect(rows).toEqual([
      { path: "/old", target: "/new", csvRow: 3 },
    ]);
  });

  it("Rank Math matching=contains/start/end rows are flagged as unsupportedWildcard, not silently imported as exact", () => {
    const csv =
      "source,destination,matching,type\n" +
      "/foo,/bar,contains,301\n" +
      "/baz,/qux,startsWith,301\n" +
      "/exact,/target,exact,301\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([
      { row: 2, path: "/foo", error: "unsupportedWildcard" },
      { row: 3, path: "/baz", error: "unsupportedWildcard" },
    ]);
    expect(rows).toEqual([
      { path: "/exact", target: "/target", csvRow: 4 },
    ]);
  });

  it("Yoast Premium marks regex in the separate `Format` column, not `Type` — must be caught there too", () => {
    const csv =
      "Origin,Target,Type,Format\n" +
      "/blog/.*,/blog,301,regex\n" +
      "/old,/new,301,plain\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([
      { row: 2, path: "/blog/.*", error: "unsupportedRegex" },
    ]);
    expect(rows).toEqual([
      { path: "/old", target: "/new", csvRow: 3 },
    ]);
  });

  it("Redirection plugin: `regex` column is a boolean 0/1 flag, not a string marker", () => {
    const csv =
      "source URL,target URL,regex,http code\n" +
      "/old,/new,0,301\n" +
      "/api/.*,/api,1,301\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([
      { row: 3, path: "/api/.*", error: "unsupportedRegex" },
    ]);
    expect(rows).toEqual([
      { path: "/old", target: "/new", csvRow: 2 },
    ]);
  });
});

describe("parseRedirectsCsv — additional third-party headers", () => {
  it("SEOPress: `URL to match,URL to redirect,type,enable`", () => {
    const csv =
      "URL to match,URL to redirect,type,enable\n" +
      "/old,/new,301,1\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ path: "/old", target: "/new", csvRow: 2 }]);
  });

  it("Screaming Frog Redirect Report: `Address,Status Code,Redirect URL`", () => {
    const csv =
      "Address,Status Code,Status,Redirect URL\n" +
      "https://example.com/old,301,Moved Permanently,https://example.com/new\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ path: "/old", target: "/new", csvRow: 2 }]);
  });
});

describe("parseRedirectsCsv — delimiter autodetection", () => {
  it("handles German Excel `;`-delimited CSVs", () => {
    const csv = "path;target\n/old;/new\n/a;/b\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows.map((r) => [r.path, r.target])).toEqual([
      ["/old", "/new"],
      ["/a", "/b"],
    ]);
  });

  it("handles tab-separated exports", () => {
    const csv = "path\ttarget\n/old\t/new\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows).toEqual([{ path: "/old", target: "/new", csvRow: 2 }]);
  });

  it("ignores delimiters inside quoted fields when detecting", () => {
    // Header has one real comma; the quoted field's comma must not tip the
    // detector to `,` if the file is actually `;`-delimited.
    const csv = 'path;target;note\n/old;/new;"has, a comma"\n';
    const { rows } = parseRedirectsCsv(csv);
    expect(rows).toEqual([{ path: "/old", target: "/new", csvRow: 2 }]);
  });
});

describe("parseRedirectsCsv — URL and query normalization", () => {
  it("strips origin from absolute source URLs (any host — shop is implicit)", () => {
    const csv = "path,target\nhttps://any.example.com/foo,/bar\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows[0].path).toBe("/foo");
  });

  it("drops query and fragment on relative paths (Shopify's matcher ignores query anyway)", () => {
    const csv = "path,target\n/foo?utm=x#top,/bar?ref=y\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows[0]).toMatchObject({ path: "/foo", target: "/bar" });
  });
});

describe("parseRedirectsCsv — column-order tolerance", () => {
  it("respects header positions even when target comes before source", () => {
    const csv = "Target URL,Source URL\n/new,/old\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows[0]).toMatchObject({ path: "/old", target: "/new" });
  });

  it("ignores extra columns beyond the ones we recognize", () => {
    const csv = "path,target,notes,priority\n/old,/new,imported,high\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows).toEqual([{ path: "/old", target: "/new", csvRow: 2 }]);
  });
});

describe("parseRedirectsCsv — header/data collision (no silent loss)", () => {
  it("no known headers: first row is treated as data, not silently dropped as a guessed header", () => {
    // Critical: if a CSV happens to start with content that isn't a known
    // alias (no leading slash, no http://), the old heuristic used to skip
    // it as an "assumed header". Now it flows through to validation —
    // merchant sees a clear error on that row rather than losing the data.
    const csv = "somelabel,anotherlabel\n/foo,/bar\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    // Both rows come through; downstream validateRedirect will flag row 1
    // (pathLeadingSlash) but row 2 imports cleanly.
    expect(rows).toEqual([
      { path: "somelabel", target: "anotherlabel", csvRow: 1 },
      { path: "/foo", target: "/bar", csvRow: 2 },
    ]);
  });

  it("no known headers but data-looking first row still works", () => {
    // Same code path as the collision case above, just with actual data —
    // sanity check that removing the heuristic didn't regress this.
    const csv = "/old,/new\n/a,/b\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows).toEqual([
      { path: "/old", target: "/new", csvRow: 1 },
      { path: "/a", target: "/b", csvRow: 2 },
    ]);
  });
});

describe("parseRedirectsCsv — multiple meta markers in the same row", () => {
  it("first flagging column wins, row is still rejected exactly once", () => {
    // Yoast Premium can carry BOTH Type=Regex AND Format=regex on the same
    // row. We should surface the row once with a single error, not twice.
    const csv =
      "Origin,Target,Type,Format\n" +
      "/foo/.*,/foo,Regex,regex\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { row: 2, path: "/foo/.*", error: "unsupportedRegex" },
    ]);
  });
});

describe("parseRedirectsCsv — trailing slash preservation", () => {
  it("keeps /foo and /foo/ as distinct paths (Shopify treats them separately)", () => {
    const csv = "path,target\n/foo,/x\n/foo/,/y\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows.map((r) => r.path)).toEqual(["/foo", "/foo/"]);
  });

  it("does not auto-add or auto-strip trailing slashes on either side", () => {
    const csv = "path,target\n/a/,/b\n/c,/d/\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows.map((r) => [r.path, r.target])).toEqual([
      ["/a/", "/b"],
      ["/c", "/d/"],
    ]);
  });
});

describe("parseRedirectsCsv — SEOPress `enable` column", () => {
  it("imports rows regardless of the enable column value (merchant reviews after import)", () => {
    // Deliberate choice: skipping enable=0 rows silently would risk losing
    // "temporarily disabled" migrations the merchant DID want. Bringing
    // them in as active redirects is the safer default; the merchant can
    // delete unwanted ones after review.
    const csv =
      "URL to match,URL to redirect,type,enable\n" +
      "/foo,/bar,301,1\n" +
      "/baz,/qux,301,0\n";
    const { rows, errors } = parseRedirectsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { path: "/foo", target: "/bar", csvRow: 2 },
      { path: "/baz", target: "/qux", csvRow: 3 },
    ]);
  });
});

describe("parseRedirectsCsv — edge cases", () => {
  it("returns empty result on empty input without throwing", () => {
    expect(parseRedirectsCsv("")).toEqual({ rows: [], errors: [] });
  });

  it("skips fully empty rows", () => {
    const csv = "path,target\n/old,/new\n,\n/a,/b\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows.map((r) => r.path)).toEqual(["/old", "/a"]);
  });

  it("preserves 1-based csvRow numbering across skips (so error reports match what the user sees)", () => {
    const csv = "path,target\n/ok,/x\n,\n/also,/y\n";
    const { rows } = parseRedirectsCsv(csv);
    expect(rows.map((r) => r.csvRow)).toEqual([2, 4]);
  });

  it("handles CRLF and lone-CR line endings", () => {
    expect(parseRedirectsCsv("path,target\r\n/a,/b\r\n").rows).toHaveLength(1);
    expect(parseRedirectsCsv("path,target\r/a,/b\r").rows).toHaveLength(1);
  });

  it("keeps a malformed source verbatim so downstream validation can flag it (no silent auto-fix)", () => {
    const csv = "path,target\nfoo,/bar\n";
    const { rows } = parseRedirectsCsv(csv);
    // Left as "foo" — validateRedirect will surface pathLeadingSlash rather
    // than us prepending "/" and letting a broken input look successful.
    expect(rows[0].path).toBe("foo");
  });
});

describe("coerceSourcePath / coerceTargetPath", () => {
  it("collapses absolute URLs to pathname regardless of origin", () => {
    expect(coerceSourcePath("https://foo.com/x/y?a=1")).toBe("/x/y");
    expect(coerceTargetPath("http://bar.com/z")).toBe("/z");
  });

  it("returns '/' for a bare origin", () => {
    expect(coerceSourcePath("https://foo.com")).toBe("/");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(coerceSourcePath("   ")).toBe("");
  });
});
