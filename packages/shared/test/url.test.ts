import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/url';

describe('normalizeUrl', () => {
  it('lowercases scheme and host but keeps path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });
  it('drops the fragment and default ports', () => {
    expect(normalizeUrl('https://example.com:443/a#section')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });
  it('removes tracking params and sorts the rest', () => {
    expect(normalizeUrl('https://e.com/a?utm_source=x&b=2&a=1&gclid=z&fbclid=q&mc_cid=1&mc_eid=2')).toBe(
      'https://e.com/a?a=1&b=2',
    );
  });
  it('drops an empty query entirely', () => {
    expect(normalizeUrl('https://e.com/a?utm_medium=x')).toBe('https://e.com/a');
  });
  it('strips credentials', () => {
    expect(normalizeUrl('https://user:pw@e.com/a')).toBe('https://e.com/a');
  });
  it('converts IDN hosts to punycode', () => {
    expect(normalizeUrl('https://bücher.de/x')).toBe('https://xn--bcher-kva.de/x');
  });
  it('rejects non-http(s) and garbage', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://e.com/a')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
  it('is idempotent', () => {
    const once = normalizeUrl('https://E.com/a?b=2&a=1#x')!;
    expect(normalizeUrl(once)).toBe(once);
  });
});
