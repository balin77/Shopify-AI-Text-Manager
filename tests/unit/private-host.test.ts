import { describe, it, expect } from "vitest";
import { isPrivateOrLoopbackHost } from "~/utils/private-host";

/**
 * The lexical half of the SSRF guard. Every case here was a real bypass at some
 * point or is the standard way this kind of guard gets walked past, so each one
 * exists to stay failed rather than to document a preference.
 */

describe("isPrivateOrLoopbackHost — IPv4", () => {
  it("blocks the classic private ranges", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) {
      expect(isPrivateOrLoopbackHost(host)).toBe(true);
    }
  });

  it("blocks the cloud metadata endpoint", () => {
    expect(isPrivateOrLoopbackHost("169.254.169.254")).toBe(true);
  });

  it("blocks 0.0.0.0/8 — on Linux a connect there lands on loopback", () => {
    // The bypass that made every rule below reachable: `http://0.0.0.0:5432/`
    // talks to a local service.
    expect(isPrivateOrLoopbackHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopbackHost("0.1.2.3")).toBe(true);
  });

  it("blocks CGNAT and the IETF protocol block", () => {
    expect(isPrivateOrLoopbackHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("100.127.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.0.0.1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    for (const host of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "192.169.1.1"]) {
      expect(isPrivateOrLoopbackHost(host)).toBe(false);
    }
  });

  it("does not need to handle octal/hex/short forms — new URL() normalizes those first", () => {
    // Documented rather than defended: `new URL("http://0177.0.0.1/").hostname`
    // is already "127.0.0.1" by the time any caller asks.
    expect(new URL("http://0177.0.0.1/").hostname).toBe("127.0.0.1");
    expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
    expect(new URL("http://127.1/").hostname).toBe("127.0.0.1");
    expect(isPrivateOrLoopbackHost(new URL("http://0177.0.0.1/").hostname)).toBe(true);
  });
});

describe("isPrivateOrLoopbackHost — IPv6", () => {
  it("blocks loopback in every spelling", () => {
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("blocks the unspecified address", () => {
    expect(isPrivateOrLoopbackHost("::")).toBe(true);
    expect(isPrivateOrLoopbackHost("[::]")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 — the standard way past an IPv4-only guard", () => {
    expect(isPrivateOrLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    // What `new URL()` actually hands over for that host.
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    expect(isPrivateOrLoopbackHost("[::ffff:7f00:1]")).toBe(true);
    // The metadata endpoint wearing the same disguise.
    expect(isPrivateOrLoopbackHost("[::ffff:a9fe:a9fe]")).toBe(true);
    // …and a mapped PUBLIC address is still allowed.
    expect(isPrivateOrLoopbackHost("[::ffff:5db8:d822]")).toBe(false);
  });

  it("blocks unique-local and link-local", () => {
    expect(isPrivateOrLoopbackHost("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fd12:3456::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fe80::1%eth0")).toBe(true);
  });

  it("allows a public IPv6 address", () => {
    expect(isPrivateOrLoopbackHost("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    // `fd::1` expands to 00fd:… — the first BYTE is 0x00, so it is NOT ULA.
    expect(isPrivateOrLoopbackHost("fd::1")).toBe(false);
  });

  it("refuses an unparsable colon-bearing host rather than guessing", () => {
    expect(isPrivateOrLoopbackHost("::ffff::1")).toBe(true);
  });
});

describe("isPrivateOrLoopbackHost — names", () => {
  it("blocks localhost, including the fully-qualified spelling", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("localhost.")).toBe(true);
    expect(isPrivateOrLoopbackHost("LOCALHOST")).toBe(true);
    expect(isPrivateOrLoopbackHost("api.localhost")).toBe(true);
  });

  it("does NOT block an ordinary name — that is what the DNS check is for", () => {
    // A name resolving to a private address (e.g. *.railway.internal) passes
    // here by design; `isPublicHost` in external-links.server.ts resolves it.
    expect(isPrivateOrLoopbackHost("postgres.railway.internal")).toBe(false);
    expect(isPrivateOrLoopbackHost("example.com")).toBe(false);
  });
});
