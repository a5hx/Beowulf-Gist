import { describe, expect, it } from 'vitest';
import { createMatcher, registrableDomain } from '../src/domain';
import type { ListEntry } from '../src/types';

const entry = (match: string, matchLevel: 'domain' | 'host', kind: 'farm' | 'human'): ListEntry => ({
  match, matchLevel, kind, siteBehavior: kind === 'farm' ? 10 : 90, reasons: ['r'], source: 'seed',
});

describe('registrableDomain', () => {
  it('uses the public suffix list', () => {
    expect(registrableDomain('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(registrableDomain('https://a.b.example.com/')).toBe('example.com');
  });
  it('returns null for invalid input', () => {
    expect(registrableDomain('nope')).toBeNull();
  });
});

describe('createMatcher', () => {
  const match = createMatcher([
    entry('farm.com', 'domain', 'farm'),
    entry('blogspot.com', 'domain', 'farm'),
    entry('goodcook.blogspot.com', 'host', 'human'),
  ]);

  it('matches a domain entry on any subdomain', () => {
    expect(match('https://www.farm.com/x')?.match).toBe('farm.com');
    expect(match('https://recipes.farm.com/x')?.match).toBe('farm.com');
  });
  it('prefers a host entry over a domain entry', () => {
    expect(match('https://goodcook.blogspot.com/p')?.kind).toBe('human');
  });
  it('host entries do not leak to other hosts on the platform', () => {
    expect(match('https://other.blogspot.com/p')?.kind).toBe('farm');
  });
  it('returns null when nothing matches or input is invalid', () => {
    expect(match('https://unknown.org/')).toBeNull();
    expect(match('garbage')).toBeNull();
  });
});
