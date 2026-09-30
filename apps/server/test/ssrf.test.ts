import { describe, expect, it } from 'vitest';
import { createSafeLookup, hostIsIpLiteral, isPublicAddress } from '../src/fetcher/ssrf';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('hostIsIpLiteral', () => {
  it('detects v4 and bracketed v6 literals', () => {
    expect(hostIsIpLiteral('127.0.0.1')).toBe('127.0.0.1');
    expect(hostIsIpLiteral('[::1]')).toBe('::1');
    expect(hostIsIpLiteral('example.com')).toBeNull();
  });
});

describe('createSafeLookup', () => {
  it('rejects hostnames resolving to private addresses', async () => {
    const lookup = createSafeLookup(isPublicAddress);
    const err = await new Promise<unknown>((resolve) => lookup('localhost', {}, (e: unknown) => resolve(e)));
    expect((err as { code?: string }).code).toBe('ESSRF');
  });
});
