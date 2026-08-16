import { describe, it, expect } from "vitest";
import { toCsv, csvCell, csvFilename } from "~/services/seo/csv-export";

/** PLAN_SEO_CRAWL_EXPANSION §5.3 — the one CSV serializer for the SEO exports. */

const BOM = "﻿";

describe("csvCell", () => {
  it("always quotes, and doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("renders null/undefined as an empty cell, not the word 'null'", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("keeps a delimiter or newline inside a cell from shifting the column", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("defuses a formula — a crawled <title> is content this app did not author", () => {
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("-5")).toBe(`"'-5"`);
  });

  it("leaves an ordinary numeric value alone", () => {
    expect(csvCell(404)).toBe('"404"');
  });
});

describe("toCsv", () => {
  const rows = [
    { url: "/a", status: 200 },
    { url: "/b", status: 404 },
  ];
  const columns = [
    { header: "url", value: (r: (typeof rows)[number]) => r.url },
    { header: "status", value: (r: (typeof rows)[number]) => r.status },
  ];

  it("writes a BOM and semicolons by default — Excel in a DE locale needs both", () => {
    const csv = toCsv(rows, columns);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}"url";"status"\n"/a";"200"\n"/b";"404"\n`);
  });

  it("honours an explicit delimiter and no-BOM", () => {
    const csv = toCsv(rows, columns, { delimiter: ",", bom: false });
    expect(csv).toBe(`"url","status"\n"/a","200"\n"/b","404"\n`);
  });

  it("still emits the header row for an empty result", () => {
    expect(toCsv([], columns, { bom: false })).toBe(`"url";"status"\n`);
  });
});

describe("csvFilename", () => {
  it("strips the myshopify suffix and anything a filesystem would object to", () => {
    expect(csvFilename("crawl-broken", "my.shop@x.myshopify.com")).toBe("crawl-broken-my-shop-x.csv");
  });
});
