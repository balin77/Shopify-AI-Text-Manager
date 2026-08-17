/**
 * The private/loopback host guard, shared by every outbound fetch this app
 * makes on someone else's behalf.
 *
 * It lived in `crawl.service.ts` and moved here when the external-link checker
 * (PLAN_SEO_CRAWL_EXPANSION §6.2) needed it too: an SSRF guard is the last
 * thing that should exist in two copies, and importing it back out of
 * crawl.service would have created a module cycle. `crawl.service` re-exports
 * it, so every existing import site (and its tests) is unchanged.
 *
 * SCOPE — read this before trusting it. This is a LEXICAL check on a hostname.
 * It cannot see what a NAME resolves to, so `postgres.railway.internal` or any
 * other host whose A/AAAA record points inside the network passes it. Callers
 * that fetch genuinely arbitrary URLs (the external-link checker; NOT the
 * same-origin crawl) must additionally resolve the host and re-check the
 * addresses — see `assertPublicHost` in external-links.server.ts.
 */

/** Expand an IPv6 address (compressed or not) to its 8 numeric groups, or null
 *  when it isn't parsable as one. */
function expandIpv6(raw: string): number[] | null {
  let text = raw;
  // A zone id (`fe80::1%eth0`) is not part of the address.
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(text)) return null;

  // An IPv4 tail (`::ffff:127.0.0.1`) becomes two hex groups.
  const v4 = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const bytes = [1, 2, 3, 4].map((i) => parseInt(v4[i], 10));
    if (bytes.some((b) => !Number.isFinite(b) || b > 255)) return null;
    text =
      text.slice(0, v4.index) +
      ((bytes[0] << 8) | bytes[1]).toString(16) +
      ":" +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (group === "" || group.length > 4) return null;
      const value = parseInt(group, 16);
      if (!Number.isFinite(value)) return null;
      out.push(value);
    }
    return out;
  };

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** True when the four octets fall in a range that never belongs on the public
 *  internet. Split out so the IPv4-mapped IPv6 forms run the SAME rules. */
function isPrivateIpv4(a: number, b: number): boolean {
  // 0.0.0.0/8 — "this network". NOT a harmless placeholder: on Linux a connect
  // to 0.0.0.0 lands on loopback, so `http://0.0.0.0:5432/` reaches a local
  // service. Missing this was a real bypass of everything below.
  if (a === 0) return true;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  return false;
}

/**
 * True when `hostname` is a literal IP in a private/loopback/link-local range,
 * or a loopback NAME — checked in ADDITION to any same-origin host check, since
 * a same-origin-looking redirect could in theory still resolve to one of these
 * via a bare IP `Location` header.
 *
 * Every IPv6 spelling of an IPv4 address runs the IPv4 rules
 * (`[::ffff:127.0.0.1]`, which `new URL()` normalizes to `::ffff:7f00:1`, is
 * the standard way this kind of guard gets walked past). Octal/hex/short IPv4
 * forms (`0177.0.0.1`, `2130706433`, `127.1`) need no handling here: `new URL()`
 * already normalizes them to dotted-quad before a caller sees the hostname.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  // A trailing dot is a fully-qualified name and resolves identically.
  if (h.endsWith(".") && h.length > 1) h = h.slice(0, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const stripped = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;

  const dotted = stripped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = [1, 2, 3, 4].map((i) => parseInt(dotted[i], 10));
    if (octets.some((o) => o > 255)) return false; // not an IP at all
    return isPrivateIpv4(octets[0], octets[1]);
  }

  if (stripped.includes(":")) {
    const groups = expandIpv6(stripped);
    // Unparsable but colon-bearing: refuse rather than guess.
    if (!groups) return true;
    // :: (unspecified) and ::1 (loopback).
    if (groups.every((g) => g === 0)) return true;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
    // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 spelling.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return isPrivateIpv4(groups[6] >> 8, groups[6] & 0xff);
    }
    const highByte = groups[0] >> 8;
    if (highByte === 0xfc || highByte === 0xfd) return true; // fc00::/7 unique-local
    if (highByte === 0xfe && (groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    return false;
  }

  return false;
}
