/**
 * The private/loopback host guard, shared by every outbound fetch this app
 * makes on someone else's behalf.
 *
 * It lived in `crawl.service.ts` and moved here when the external-link checker
 * (PLAN_SEO_CRAWL_EXPANSION §6.2) needed it too: an SSRF guard is the last
 * thing that should exist in two copies, and importing it back out of
 * crawl.service would have created a module cycle. `crawl.service` re-exports
 * it, so every existing import site (and its tests) is unchanged.
 */

/**
 * True when `hostname` is a literal IP in a private/loopback/link-local
 * range — checked in ADDITION to any same-origin host check, since a
 * same-origin-looking redirect could in theory still resolve to one of these
 * via a bare IP `Location` header.
 *
 * Deliberately conservative/pattern-based: no DNS resolution happens here
 * (that happens inside `fetch` itself, which this guard cannot see).
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  // IPv6 loopback / unique-local.
  if (h === "::1") return true;
  const stripped = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (stripped === "::1") return true;
  if (/^fc[0-9a-f]{2}:/.test(stripped) || /^fd[0-9a-f]{2}:/.test(stripped)) return true; // fc00::/7
  if (/^fe80:/.test(stripped)) return true; // link-local

  // IPv4 literal ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (incl. cloud metadata)
  return false;
}
