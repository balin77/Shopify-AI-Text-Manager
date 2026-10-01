import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadToStagedTarget } from "../../app/utils/staged-upload.client";

class FakeXhr {
  static last: FakeXhr;
  status = 200;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  static mode: "ok" | "abort" | "timeout" = "ok";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  static nextStatus = 200;
  static fail = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      if (FakeXhr.mode === "abort") return this.onabort?.();
      if (FakeXhr.mode === "timeout") return this.ontimeout?.();
      if (FakeXhr.fail) return this.onerror?.();
      this.status = FakeXhr.nextStatus;
      this.onload?.();
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.nextStatus = 200;
  FakeXhr.fail = false;
  FakeXhr.mode = "ok";
});

describe("uploadToStagedTarget", () => {
  const file = new File(["x"], "a.png", { type: "image/png" });

  it("PUTs the raw file for an image target and resolves on 2xx", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    await uploadToStagedTarget({ url: "https://s/u", httpMethod: "PUT" }, file, (p) => progress.push(p));
    expect(FakeXhr.last.method).toBe("PUT");
    expect(FakeXhr.last.headers["Content-Type"]).toBe("image/png");
    expect(progress).toEqual([50]);
  });

  it("POSTs multipart with the parameters before the file", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    await uploadToStagedTarget(
      { url: "https://s/u", httpMethod: "POST", parameters: [{ name: "key", value: "k1" }] },
      file,
    );
    expect(FakeXhr.last.method).toBe("POST");
    const keys = Array.from((FakeXhr.last.body as FormData).keys());
    expect(keys).toEqual(["key", "file"]);
  });

  it("rejects on a non-2xx answer", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    FakeXhr.nextStatus = 403;
    await expect(uploadToStagedTarget({ url: "https://s/u" }, file)).rejects.toThrow("HTTP 403");
  });

  it("rejects on a network error", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    FakeXhr.fail = true;
    await expect(uploadToStagedTarget({ url: "https://s/u" }, file)).rejects.toThrow("network");
  });

  it("rejects on abort and on timeout", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    FakeXhr.mode = "abort";
    await expect(uploadToStagedTarget({ url: "https://s/u", httpMethod: "PUT" }, file)).rejects.toThrow(/abort/i);
    FakeXhr.mode = "timeout";
    await expect(uploadToStagedTarget({ url: "https://s/u", httpMethod: "PUT" }, file)).rejects.toThrow(/timed out/i);
  });
});
