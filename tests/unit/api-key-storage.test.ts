/**
 * The stored AI keys are WRITE-ONLY (api-key-storage.shared.ts): the loader
 * reports only whether a key is stored, and a save leaves a key alone unless a
 * new value is typed or its removal is asked for explicitly.
 */
import { describe, it, expect } from "vitest";
import {
  API_KEY_FIELDS,
  apiKeyHint,
  apiKeyStatusMap,
  apiKeyUsable,
  parseRemoveApiKeys,
  planApiKeyWrites,
} from "../../app/utils/api-key-storage.shared";

const encrypt = (plain: string) => `enc(${plain})`;

describe("apiKeyStatusMap — what the loader may send", () => {
  const row = {
    claudeApiKey: "cipher-claude",
    openaiApiKey: "cipher-broken",
    geminiApiKey: "",
    grokApiKey: null,
  };
  const decrypt = (cipher: string) =>
    cipher === "cipher-claude"
      ? { value: "sk-ant-api03-SECRETVALUE-1a2b", corrupted: false }
      : { value: null, corrupted: true };

  it("never contains the key, only the stored flag and the last four characters", () => {
    const map = apiKeyStatusMap(row, decrypt, true);
    expect(JSON.stringify(map)).not.toContain("SECRETVALUE");
    expect(map.claudeApiKey).toEqual({ stored: true, hint: "1a2b", corrupted: false });
    expect(map.openaiApiKey).toEqual({ stored: true, hint: null, corrupted: true });
    expect(map.geminiApiKey.stored).toBe(false);
    expect(map.grokApiKey.stored).toBe(false);
    expect(apiKeyUsable(map.claudeApiKey)).toBe(true);
    expect(apiKeyUsable(map.openaiApiKey)).toBe(false);
  });

  it("decrypts nothing when the fields are withheld", () => {
    let calls = 0;
    const map = apiKeyStatusMap(row, (c) => (calls++, decrypt(c)), false);
    expect(calls).toBe(0);
    expect(map.claudeApiKey).toEqual({ stored: true, hint: null, corrupted: false });
  });

  it("gives a short key no hint", () => {
    expect(apiKeyHint("abcdefgh")).toBeNull();
    expect(apiKeyHint("  sk-1234567890abcd  ")).toBe("abcd");
  });
});

describe("planApiKeyWrites — what a save writes", () => {
  it("leaves every key untouched when no field was typed in", () => {
    const empty = Object.fromEntries(API_KEY_FIELDS.map((f) => [f, ""]));
    expect(planApiKeyWrites(empty, [], encrypt)).toEqual({});
    expect(planApiKeyWrites({}, [], encrypt)).toEqual({});
  });

  it("replaces only the typed key", () => {
    expect(planApiKeyWrites({ claudeApiKey: " sk-ant-new ", openaiApiKey: "" }, [], encrypt)).toEqual({
      claudeApiKey: "enc(sk-ant-new)",
    });
  });

  it("deletes only on an explicit removal, and a typed value wins over it", () => {
    expect(planApiKeyWrites({}, ["openaiApiKey"], encrypt)).toEqual({ openaiApiKey: null });
    expect(planApiKeyWrites({ openaiApiKey: "sk-x" }, ["openaiApiKey"], encrypt)).toEqual({
      openaiApiKey: "enc(sk-x)",
    });
  });

  it("parses the removal list defensively", () => {
    expect(parseRemoveApiKeys('["claudeApiKey","nope","claudeApiKey"]')).toEqual(["claudeApiKey"]);
    expect(parseRemoveApiKeys("not json")).toEqual([]);
    expect(parseRemoveApiKeys('{"claudeApiKey":true}')).toEqual([]);
    expect(parseRemoveApiKeys(null)).toEqual([]);
  });
});
