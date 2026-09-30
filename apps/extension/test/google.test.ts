import { describe, expect, it } from 'vitest';
import { GOOGLE_MATCHES, isWebSearch } from '../src/google';

describe('google', () => {
  it('matches web search pages only', () => {
    expect(isWebSearch(new URL('https://www.google.com/search?q=x'))).toBe(true);
    expect(isWebSearch(new URL('https://www.google.com/search?q=x&udm=14'))).toBe(true);
    expect(isWebSearch(new URL('https://www.google.com/search?q=x&udm=2'))).toBe(false);
    expect(isWebSearch(new URL('https://www.google.com/search?q=x&tbm=isch'))).toBe(false);
    expect(isWebSearch(new URL('https://www.google.com/maps'))).toBe(false);
  });
  it('covers google.com and major country domains', () => {
    expect(GOOGLE_MATCHES).toContain('https://www.google.com/search*');
    expect(GOOGLE_MATCHES).toContain('https://www.google.co.in/search*');
  });
});
