/** trackActivity has ONE hook point (enhancedAuthenticate.admin) and receives the request; lastAuthAt is set in afterAuth (plan 3.2). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("activity tracking hook point", () => {
  const shopify = read("app/shopify.server.ts");

  it("is called once, from the authenticate.admin wrapper, with the request", () => {
    expect(shopify.match(/trackActivity\(/g)).toHaveLength(1);
    expect(shopify).toContain("trackActivity(session.shop, request)");
  });

  it("no route or component calls it", () => {
    for (const rel of ["app/routes/app.tsx", "app/routes/app.products.tsx", "app/utils/loader-factory.server.ts"]) {
      expect(read(rel)).not.toContain("trackActivity(");
    }
  });

  it("afterAuth stamps lastAuthAt on create and update", () => {
    expect(shopify).toMatch(/create: \{[^}]*lastAuthAt: authAt/);
    expect(shopify).toMatch(/update: \{[^}]*lastAuthAt: authAt/);
  });
});
