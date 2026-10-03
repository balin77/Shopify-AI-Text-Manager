import { describe, it, expect } from "vitest";
import { keysSafeToInvalidate, unconfirmedPurgeKeys } from "../../app/services/translations/purge-warning.shared";

describe("unconfirmedPurgeKeys", () => {
  const byRes = new Map([["r1", ["a", "b"]], ["r2", ["c"]]]);
  it("maps unconfirmed resources to their keys", () => {
    expect(unconfirmedPurgeKeys(["r2"], byRes, ["a", "b", "c"])).toEqual(["c"]);
  });
  it("a locale or local failure covers every changed key", () => {
    expect(unconfirmedPurgeKeys(["locales"], byRes, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(unconfirmedPurgeKeys(["local"], byRes, ["a"])).toEqual(["a"]);
  });
});

describe("keysSafeToInvalidate", () => {
  it("drops everything changed when nothing is unconfirmed", () => {
    expect([...keysSafeToInvalidate(new Set(["a", "b"]), undefined)]).toEqual(["a", "b"]);
    expect([...keysSafeToInvalidate(new Set(["a"]), [])]).toEqual(["a"]);
  });
  it("keeps unconfirmed keys out of the invalidation", () => {
    expect([...keysSafeToInvalidate(new Set(["a", "b"]), ["b"])]).toEqual(["a"]);
  });
});
