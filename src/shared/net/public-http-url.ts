/** Returns whether an IPv4 address belongs to a public unicast range. */
function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first = 0, second = 0, third = 0] = parts;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

/** Returns whether a normalized IPv6 address belongs to public global unicast space. */
function isPublicIpv6(hostname: string): boolean {
  const firstSegment = Number.parseInt(hostname.split(':', 1)[0] ?? '', 16);
  if (!Number.isInteger(firstSegment) || (firstSegment & 0xe000) !== 0x2000) {
    return false;
  }
  return !hostname.toLowerCase().startsWith('2001:db8:');
}

/** Rejects hostnames reserved for a local resolver or non-public naming context. */
function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'local' ||
    normalized.endsWith('.local') ||
    normalized === 'internal' ||
    normalized.endsWith('.internal') ||
    normalized === 'home.arpa' ||
    normalized.endsWith('.home.arpa') ||
    normalized.endsWith('.invalid') ||
    normalized.endsWith('.test')
  );
}

/** Accepts only fully-qualified DNS hostnames with conventional host labels. */
function isPublicDnsHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (isLocalHostname(normalized) || !normalized.includes('.') || normalized.length > 253) {
    return false;
  }

  return normalized
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/**
 * Performs a syntactic allowability check for HTTP(S) URLs sent to a remote content provider.
 * This deliberately does not resolve DNS and must not be treated as a network-layer SSRF guard.
 */
export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0
  ) {
    return false;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname.includes(':')) {
    return isPublicIpv6(hostname);
  }
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    return isPublicIpv4(hostname);
  }
  return isPublicDnsHostname(hostname);
}
