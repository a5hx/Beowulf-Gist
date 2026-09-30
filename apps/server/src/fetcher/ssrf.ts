import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

export type AddressPolicy = (ip: string) => boolean;

/** Only globally routable unicast addresses. IPv4-mapped IPv6 is unwrapped first. */
export const isPublicAddress: AddressPolicy = (ip) => {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() === 'unicast';
};

export function hostIsIpLiteral(hostname: string): string | null {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return ipaddr.isValid(h) ? h : null;
}

export class SsrfError extends Error {
  readonly code = 'ESSRF';
}

type LookupCallback = (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * dns.lookup replacement used by the socket itself. The address we validate is the address we connect to,
 * which closes the DNS-rebinding gap between "check" and "connect".
 */
export function createSafeLookup(policy: AddressPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => !policy(a.address))) {
        return callback(new SsrfError(`blocked address for ${hostname}`));
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export function createSafeAgent(policy: AddressPolicy): Agent {
  return new Agent({ connect: { lookup: createSafeLookup(policy) as never }, connections: 50 });
}
