import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NetworkReadMode, NetworkReadPolicy } from '@littlesheep/types';
import { webError } from '../errors.js';

export interface UrlValidationOptions {
  readonly policy?: Pick<NetworkReadPolicy, 'mode' | 'allowDomains' | 'blockDomains'>;
  readonly resolveHost?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
  readonly signal?: AbortSignal;
}

export interface ValidatedPublicUrl {
  readonly url: URL;
  readonly hostname: string;
  readonly addresses: readonly string[];
  /** First checked address. HTTP clients must pin the connection to this value. */
  readonly address: string;
}

const DEFAULT_POLICY: Pick<NetworkReadPolicy, 'mode' | 'allowDomains' | 'blockDomains'> = {
  mode: 'public_anonymous',
  allowDomains: [],
  blockDomains: [],
};

/** Normalize an input URL without performing DNS or network access. */
export function canonicalizeHttpUrl(raw: string): URL {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw webError('web_url_invalid', 'web_fetch requires a non-empty URL', { retryable: false });
  }
  const value = raw.trim();
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw webError('web_url_invalid', 'web_fetch URL contains whitespace or control characters', { retryable: false });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw webError('web_url_invalid', 'web_fetch URL is not a valid absolute URL', { retryable: false });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw webError('web_scheme_blocked', `web_fetch scheme is blocked: ${parsed.protocol}`, { retryable: false });
  }
  if (parsed.username || parsed.password) {
    throw webError('web_url_invalid', 'web_fetch URL credentials are blocked', { retryable: false });
  }
  if (!parsed.hostname || parsed.hostname.length > 253) {
    throw webError('web_url_invalid', 'web_fetch URL hostname is invalid', { retryable: false });
  }
  // Fragments are client-side state and are never sent over HTTP. Removing it
  // also keeps citation/cache identity stable for equivalent requests.
  parsed.hash = '';
  return parsed;
}

/** Validate syntax, domain policy and all resolved addresses before a request. */
export async function validatePublicUrl(
  raw: string,
  options: UrlValidationOptions = {},
): Promise<ValidatedPublicUrl> {
  const url = canonicalizeHttpUrl(raw);
  const policy = options.policy ?? DEFAULT_POLICY;
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw webError('web_ssrf_blocked', 'web_fetch target hostname is blocked', { retryable: false });
  }
  if (matchesDomain(hostname, policy.blockDomains)) {
    throw webError('web_ssrf_blocked', 'web_fetch target is blocked by the network domain policy', { retryable: false });
  }
  if (policy.mode === 'disabled') {
    throw webError('web_disabled', 'public network retrieval is disabled', { retryable: false });
  }
  if (policy.mode === 'configured_allowlist' && !matchesDomain(hostname, policy.allowDomains)) {
    throw webError('web_ssrf_blocked', 'web_fetch target is outside the configured domain allowlist', { retryable: false });
  }

  const literal = normalizeIpLiteral(hostname);
  let addresses: readonly string[];
  try {
    addresses = literal ? [literal] : await resolveAddresses(hostname, options.resolveHost, options.signal);
  } catch {
    throw webError('web_dns_check_failed', 'web_fetch target DNS resolution failed', { retryable: true });
  }
  if (addresses.length === 0) {
    throw webError('web_dns_check_failed', 'web_fetch target DNS returned no addresses', { retryable: true });
  }
  const normalizedAddresses = [...new Set(addresses.map(normalizeIpLiteral).filter((value): value is string => Boolean(value)))];
  if (normalizedAddresses.length !== addresses.length) {
    throw webError('web_dns_check_failed', 'web_fetch target DNS returned an invalid address', { retryable: false });
  }
  if (normalizedAddresses.length === 0 || normalizedAddresses.some(isBlockedIp)) {
    throw webError('web_ssrf_blocked', 'web_fetch resolved address is not public', { retryable: false });
  }
  return {
    url,
    hostname,
    addresses: normalizedAddresses,
    address: normalizedAddresses[0]!,
  };
}

/** Re-run the same checks for every redirect target. */
export async function validateRedirectUrl(
  current: URL,
  location: string,
  options: UrlValidationOptions = {},
): Promise<ValidatedPublicUrl> {
  if (!location.trim()) {
    throw webError('web_redirect_blocked', 'redirect location is empty', { retryable: false });
  }
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw webError('web_redirect_blocked', 'redirect location is invalid', { retryable: false });
  }
  return validatePublicUrl(next.toString(), options);
}

export function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  const candidate = normalizeHostname(hostname);
  return domains.some((domain) => {
    const normalized = normalizeHostname(domain).replace(/^\.+/u, '');
    return normalized.length > 0 && (candidate === normalized || candidate.endsWith(`.${normalized}`));
  });
}

export function isBlockedIp(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  if (!normalized) return true;
  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
}

export function hasSensitiveUrlParameters(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (isSensitiveUrlParameterName(name)) return true;
  }
  return false;
}

export function isSensitiveUrlParameterName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return compact === 'key'
    || compact === 'password'
    || compact === 'secret'
    || compact.endsWith('apikey')
    || compact.endsWith('accesstoken')
    || compact.endsWith('securitytoken')
    || compact.endsWith('authorization')
    || compact.endsWith('credential')
    || compact.endsWith('signature')
    || compact === 'sig'
    || compact === 'token';
}

function resolveAddresses(
  hostname: string,
  resolver?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (resolver) return signal ? resolver(hostname, signal) : resolver(hostname);
  return dnsLookup(hostname, { all: true, verbatim: true }).then((records) => records.map((record) => record.address));
}

function normalizeIpLiteral(hostname: string): string | undefined {
  const value = normalizeHostname(hostname);
  return isIP(value) ? value : undefined;
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan') || hostname.endsWith('.home.arpa')) return true;
  if (hostname === 'metadata' || hostname === 'metadata.google.internal' || hostname.endsWith('.metadata.google.internal')) return true;
  if (hostname === 'instance-data.ec2.internal' || hostname.endsWith('.instance-data.ec2.internal')) return true;
  return false;
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 0 || b === 2 || b === 168)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113
    || a >= 224;
}

function isBlockedIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === undefined) return true;
  const zero = 0n;
  if (value === zero || value === 1n) return true;
  if (inIpv6Range(value, 'fc00::', 7) || inIpv6Range(value, 'fe80::', 10) || inIpv6Range(value, 'fec0::', 10) || inIpv6Range(value, 'ff00::', 8)) return true;
  if (inIpv6Range(value, '100::', 64)
    || inIpv6Range(value, '2001::', 32)
    || inIpv6Range(value, '2001:2::', 48)
    || inIpv6Range(value, '2001:10::', 28)
    || inIpv6Range(value, '2001:20::', 28)
    || inIpv6Range(value, '2001:db8::', 32)
    || inIpv6Range(value, '3fff::', 20)) return true;
  // IPv4-mapped and IPv4-compatible addresses must inherit IPv4 blocking.
  if (inIpv6Range(value, '::ffff:0:0', 96) || inIpv6Range(value, '::', 96)) {
    const mapped = Number(value & 0xffffffffn);
    const ipv4 = `${mapped >>> 24}.${mapped >>> 16 & 255}.${mapped >>> 8 & 255}.${mapped & 255}`;
    return isBlockedIpv4(ipv4);
  }
  return !inIpv6Range(value, '2000::', 3);
}

function inIpv6Range(value: bigint, baseAddress: string, prefixLength: number): boolean {
  const base = ipv6ToBigInt(baseAddress);
  if (base === undefined) return false;
  const shift = 128 - prefixLength;
  return (value >> BigInt(shift)) === (base >> BigInt(shift));
}

function ipv6ToBigInt(address: string): bigint | undefined {
  let value = address.toLowerCase().replace(/^\[|\]$/gu, '');
  if (value.includes('%')) return undefined;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0) return undefined;
    const ipv4 = value.slice(lastColon + 1);
    const octets = ipv4.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8) return undefined;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

export function networkModeAllowsPublicRead(mode: NetworkReadMode): boolean {
  return mode === 'public_anonymous' || mode === 'configured_allowlist';
}
