import { describe, it, expect, vi } from "vitest";
import {
  runPerLocaleSaves,
  runPerLocaleSavesDetailed,
  PLAN_REFUSED,
  copyOutcomeMessage,
  saveAnswerFailed,
} from "../../app/services/editor/per-locale-saves.shared";
import {
  postJsonSave,
  rollbackSubResourceCopy,
} from "../../app/services/editor/sub-resource-copy.shared";
import { postContentEditorSave } from "../../app/services/editor/content-action-endpoint.shared";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("runPerLocaleSaves", () => {
  it("returns the locales whose save answered false or threw, not the unknowable ones", async () => {
    const failed = await runPerLocaleSaves(["de", "fr", "es", "it"], async (l) => {
      if (l === "fr") return false;
      if (l === "es") throw new Error("boom");
      if (l === "it") return null;
      return true;
    });
    expect(failed).toEqual(["fr", "es"]);
  });

  it("runs one request at a time, in order, when sequential", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    await runPerLocaleSaves(
      ["a", "b", "c"],
      async (l) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        order.push(l);
        inFlight--;
        return true;
      },
      { sequential: true },
    );
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("fires all at once by default", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPerLocaleSaves(["a", "b", "c"], async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return true;
    });
    expect(maxInFlight).toBe(3);
  });
});

describe("copyOutcomeMessage", () => {
  it("says copied when nothing failed", () => {
    expect(copyOutcomeMessage([], { copied: "Kopiert" })).toEqual({ text: "Kopiert", tone: "success" });
  });
  it("names the failed locales", () => {
    const out = copyOutcomeMessage(["fr", "es"], { copyFailedLocales: "Failed: {locales}." });
    expect(out).toEqual({ text: "Failed: FR, ES.", tone: "critical" });
  });
});

describe("saveAnswerFailed", () => {
  it("treats success:false, unreadable bodies and failed* lists as failures", () => {
    expect(saveAnswerFailed(null)).toBe(true);
    expect(saveAnswerFailed({ success: false })).toBe(true);
    expect(saveAnswerFailed({ success: true, failedAltTextIndices: [0] })).toBe(true);
    expect(saveAnswerFailed({ success: true, failedResources: ["gid://x"] })).toBe(true);
  });
  it("accepts a clean answer, including empty failed lists", () => {
    expect(saveAnswerFailed({ success: true })).toBe(false);
    expect(saveAnswerFailed({ success: true, failedResources: [], failedAltTextIndices: [] })).toBe(false);
  });
});

describe("postContentEditorSave (refused alt texts)", () => {
  it("reports false when the answer is success:true with failedAltTextIndices", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: true, failedAltTextIndices: [1] })));
    const fd = new FormData();
    expect(await postContentEditorSave(fd, { pathname: "/app/products", search: "" })).toBe(false);
    vi.unstubAllGlobals();
  });
  it("reports true for a clean answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: true })));
    expect(await postContentEditorSave(new FormData(), { pathname: "/app/products", search: "" })).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("postJsonSave (sub-resource copy)", () => {
  const post = (res: () => Response | Promise<Response>) =>
    postJsonSave("/x", new FormData(), (async () => res()) as unknown as typeof fetch);

  it("fails on HTTP errors, success:false, failedResources and network errors", async () => {
    expect(await post(() => jsonResponse({ success: true }, 500))).toBe(false);
    expect(await post(() => jsonResponse({ success: false, error: "x" }))).toBe(false);
    expect(await post(() => jsonResponse({ success: true, failedResources: ["r"] }))).toBe(false);
    expect(await post(() => { throw new Error("net"); })).toBe(false);
  });
  it("succeeds on a clean answer", async () => {
    expect(await post(() => jsonResponse({ success: true, savedResources: ["r"], failedResources: [] }))).toBe(true);
  });
});

describe("rollbackSubResourceCopy", () => {
  it("removes only entries still holding the copied value, for failed locales only", () => {
    const overlay = {
      fr: { r1: { name: "Rot" }, r2: { name: "typed since" } },
      es: { r1: { name: "Rot" } },
    };
    rollbackSubResourceCopy(overlay, ["fr"], [
      { resourceId: "r1", value: "Rot" },
      { resourceId: "r2", value: "Rot" },
    ]);
    expect(overlay).toEqual({ fr: { r2: { name: "typed since" } }, es: { r1: { name: "Rot" } } });
  });
  it("drops emptied buckets", () => {
    const overlay: Record<string, Record<string, Record<string, string>>> = { fr: { r1: { name: "Rot" } } };
    rollbackSubResourceCopy(overlay, ["fr"], [{ resourceId: "r1", value: "Rot" }]);
    expect(overlay).toEqual({});
  });
});

describe("a warning counts as not landed (copy to all)", () => {
  it("saveAnswerFailed treats a non-empty warning as failed", () => {
    expect(saveAnswerFailed({ success: true, warning: "saved locally only" })).toBe(true);
    expect(saveAnswerFailed({ success: true, warning: "  " })).toBe(false);
    expect(saveAnswerFailed({ success: true, warning: undefined })).toBe(false);
  });
});

describe("a plan refusal surfaces as the upgrade message", () => {
  const gate = () => jsonResponse({ success: false, error: "gated" }, 403);

  it("postContentEditorSave and postJsonSave report PLAN_REFUSED for a 403 gated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gate()));
    expect(await postContentEditorSave(new FormData(), { pathname: "/app/pages", search: "" })).toBe(PLAN_REFUSED);
    expect(await postJsonSave("/x", new FormData(), (async () => gate()) as unknown as typeof fetch)).toBe(PLAN_REFUSED);
    // Any other 403 / 500 stays a plain failure.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "nope" }, 403)));
    expect(await postContentEditorSave(new FormData(), { pathname: "/app/pages", search: "" })).toBe(false);
    vi.unstubAllGlobals();
  });

  it("runPerLocaleSavesDetailed flags gated locales as failed", async () => {
    const out = await runPerLocaleSavesDetailed(["fr", "es"], async (l) => (l === "fr" ? PLAN_REFUSED : true));
    expect(out).toEqual({ failed: ["fr"], gated: true });
    expect((await runPerLocaleSavesDetailed(["fr"], async () => false)).gated).toBe(false);
  });

  it("copyOutcomeMessage says upgrade required instead of naming locales", () => {
    expect(copyOutcomeMessage(["fr"], { upgradeRequired: "Upgrade erforderlich" }, true)).toEqual({
      text: "Upgrade erforderlich",
      tone: "critical",
    });
    expect(copyOutcomeMessage(["fr"], { copyFailedLocales: "Failed: {locales}" }, false).text).toBe("Failed: FR");
  });
});
