import { describe, expect, it, vi } from 'vitest';
import { createRobotsChecker, isPathAllowed, parseRobotsForAgent } from '../src/fetcher/robots';

describe('parseRobotsForAgent', () => {
  it('ignores rules aimed only at *', () => {
    expect(parseRobotsForAgent('User-agent: *\nDisallow: /')).toBeNull();
  });
  it('collects GistBot rules case-insensitively, including multi-agent groups', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Foo\nUser-agent: gistbot\nDisallow: /private\nAllow: /private/ok\n# comment\n';
    expect(parseRobotsForAgent(txt)).toEqual({ allow: ['/private/ok'], disallow: ['/private'] });
  });
  it('treats "GistBot/1.0" as GistBot', () => {
    expect(parseRobotsForAgent('User-agent: GistBot/1.0\nDisallow: /x')).toEqual({ allow: [], disallow: ['/x'] });
  });
  it('empty Disallow means allow everything', () => {
    expect(parseRobotsForAgent('User-agent: GistBot\nDisallow:')).toEqual({ allow: [], disallow: [] });
  });
});

describe('isPathAllowed', () => {
  const rules = { allow: ['/private/ok', '/*.html$'], disallow: ['/private', '/tmp*'] };
  it('applies longest match, allow wins ties', () => {
    expect(isPathAllowed(rules, '/private/secret')).toBe(false);
    expect(isPathAllowed(rules, '/private/ok/page')).toBe(true);
    expect(isPathAllowed(rules, '/tmpfile')).toBe(false);
    expect(isPathAllowed(rules, '/public')).toBe(true);
  });
  it('supports $ anchoring', () => {
    expect(isPathAllowed({ allow: [], disallow: ['/*.pdf$'] }, '/a.pdf')).toBe(false);
    expect(isPathAllowed({ allow: [], disallow: ['/*.pdf$'] }, '/a.pdf?x=1')).toBe(true);
  });
  it('null rules allow everything', () => {
    expect(isPathAllowed(null, '/anything')).toBe(true);
  });
});

describe('createRobotsChecker', () => {
  it('fetches robots.txt once per origin within the TTL, then refreshes', async () => {
    let t = 0;
    const fetchText = vi.fn(async () => 'User-agent: GistBot\nDisallow: /no');
    const check = createRobotsChecker({ fetchText, now: () => t, ttlMs: 1000 });
    expect(await check('https://a.com/yes')).toBe(true);
    expect(await check('https://a.com/no')).toBe(false);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith('https://a.com/robots.txt');
    t = 2000;
    await check('https://a.com/yes');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
  it('treats a missing robots.txt as allow', async () => {
    const check = createRobotsChecker({ fetchText: async () => null, now: () => 0 });
    expect(await check('https://b.com/x')).toBe(true);
  });
});
