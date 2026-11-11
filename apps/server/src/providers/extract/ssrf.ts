import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Checks whether an IPv4 address belongs to a loopback, private, link-local,
 * broadcast, or multicast range.
 */
export function isPrivateOrLocalIpv4(ip: string): boolean {
  const parts = ip.split(".").map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // Malformed IPv4 is refused
  }
  const [a, b, c] = parts as [number, number, number, number];

  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (private: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (CGNAT / shared address space)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // Multicast (224.0.0.0/4), reserved (240.0.0.0/4), and broadcast (255.255.255.255)
  if (a >= 224) return true;

  return false;
}

function parseIpv6Hextets(ip: string): number[] | null {
  let workingIp = ip;
  let embeddedV4Hextets: number[] = [];

  const lastColon = workingIp.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterLastColon = workingIp.slice(lastColon + 1);
    if (afterLastColon.includes(".")) {
      const v4Parts = afterLastColon.split(".").map(Number);
      if (v4Parts.length !== 4 || v4Parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
        return null;
      }
      const [a, b, c, d] = v4Parts as [number, number, number, number];
      embeddedV4Hextets = [(a << 8) | b, (c << 8) | d];
      workingIp = workingIp.slice(0, lastColon);
    }
  }

  const parts = workingIp.split("::");
  if (parts.length > 2) return null;

  const targetLength = 8 - embeddedV4Hextets.length;

  if (parts.length === 1) {
    const rawHextets = parts[0]!.split(":");
    if (rawHextets.length !== targetLength) return null;
    const parsed = rawHextets.map((h) => parseInt(h, 16));
    if (parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
    return [...parsed, ...embeddedV4Hextets];
  }

  const leftRaw = parts[0] ? parts[0].split(":") : [];
  const rightRaw = parts[1] ? parts[1].split(":") : [];

  const left = leftRaw.map((h) => parseInt(h, 16));
  const right = rightRaw.map((h) => parseInt(h, 16));

  if ([...left, ...right].some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) {
    return null;
  }

  const missing = targetLength - (left.length + right.length);
  if (missing < 0) return null;

  const zeros = new Array<number>(missing).fill(0);
  return [...left, ...zeros, ...right, ...embeddedV4Hextets];
}

/**
 * Checks whether an IPv6 address belongs to loopback (::1), link-local (fe80::/10),
 * unique local / private (fc00::/7), multicast (ff00::/8), unspecified (::), or
 * IPv4-mapped private ranges.
 */
export function isPrivateOrLocalIpv6(ip: string): boolean {
  const clean = ip.split("%")[0]?.toLowerCase().trim() ?? "";
  if (!clean) return true;

  if (clean.startsWith("::ffff:")) {
    const rest = clean.slice(7);
    if (rest.includes(".")) {
      return isPrivateOrLocalIpv4(rest);
    }
  }

  const hextets = parseIpv6Hextets(clean);
  if (!hextets) return true; // Malformed IPv6

  // :: (unspecified)
  if (hextets.every((h) => h === 0)) return true;

  // ::1 (loopback)
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 1
  ) {
    return true;
  }

  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const a = (hextets[6]! >> 8) & 0xff;
    const b = hextets[6]! & 0xff;
    const c = (hextets[7]! >> 8) & 0xff;
    const d = hextets[7]! & 0xff;
    return isPrivateOrLocalIpv4(`${a}.${b}.${c}.${d}`);
  }

  const first = hextets[0]!;

  // fe80::/10 (link-local)
  if ((first & 0xffc0) === 0xfe80) return true;

  // fc00::/7 (unique local / private)
  if ((first & 0xfe00) === 0xfc00) return true;

  // ff00::/8 (multicast)
  if ((first & 0xff00) === 0xff00) return true;

  return false;
}

/** Returns true if the IP address is private, loopback, link-local, multicast, or malformed. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isPrivateOrLocalIpv4(ip);
  }
  if (family === 6) {
    return isPrivateOrLocalIpv6(ip);
  }
  return true;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Validates a target URL and its resolved host IP addresses against SSRF ranges.
 * Refuses non-http(s) schemes, localhost, and hosts that resolve to private,
 * loopback, or link-local ranges.
 */
export async function validateUrlForSsrf(
  urlStr: string,
  lookupFn: DnsLookupFn = dnsLookup,
): Promise<{ allowed: boolean; parsedUrl?: URL }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { allowed: false };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false };
  }

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  if (!hostname) {
    return { allowed: false };
  }

  if (hostname === "localhost" || hostname === "localhost." || hostname.endsWith(".localhost")) {
    return { allowed: false };
  }

  const ipType = isIP(hostname);
  if (ipType !== 0) {
    if (isBlockedIp(hostname)) {
      return { allowed: false };
    }
  }

  try {
    const addresses = await lookupFn(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { allowed: false };
    }
    for (const record of addresses) {
      if (isBlockedIp(record.address)) {
        return { allowed: false };
      }
    }
  } catch {
    return { allowed: false };
  }

  return { allowed: true, parsedUrl: parsed };
}
