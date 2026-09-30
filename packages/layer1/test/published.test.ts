import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { findPublishedAt } from '../src/published';
import { buildContext as exportedBuild, scoreContext, scoreHtml } from '../src/index';
import { blogRecipe, page } from './fixtures';

const now = new Date('2026-09-30T00:00:00Z');
const at = (head: string, body = '<p>x</p>') => findPublishedAt(buildContext(page(head, body)).document, now);

describe('findPublishedAt', () => {
  it('reads article:published_time first', () => {
    expect(at(`<meta property="article:published_time" content="2024-01-10T08:00:00+05:30">
      <script type="application/ld+json">{"datePublished":"2020-01-01"}</script>`)).toEqual(new Date('2024-01-10T02:30:00Z'));
  });
  it('falls back to JSON-LD datePublished, searched recursively', () => {
    expect(at(`<script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2023-05-02"}]}</script>`)).toEqual(new Date('2023-05-02'));
  });
  it('then time[itemprop=datePublished], then meta name=date', () => {
    expect(at('', '<time itemprop="datePublished" datetime="2022-02-02">Feb 2</time>')).toEqual(new Date('2022-02-02'));
    expect(at('<meta name="date" content="2021-03-03">')).toEqual(new Date('2021-03-03'));
  });
  it('skips invalid and future dates, returning the next valid source or null', () => {
    expect(at(`<meta property="article:published_time" content="not a date"><meta name="date" content="2021-03-03">`)).toEqual(new Date('2021-03-03'));
    expect(at('<meta name="date" content="2026-10-05">')).toBeNull();
    expect(at('')).toBeNull();
  });
});

describe('findPublishedAt strictness (final review)', () => {
  it.each(['1', 'page 3', 'Draft 2', 'abc 7', '10/01/2024', 'Jan 10, 2024', '1970-01-01T00:00:00Z', '1994-12-31'])(
    'rejects non-ISO or implausible date %s', (junk) => {
      expect(at(`<meta name="date" content="${junk}">`)).toBeNull();
    },
  );
  it('treats ISO dates without an offset as UTC', () => {
    expect(at('<meta name="date" content="2024-01-10 10:00:00">')).toEqual(new Date('2024-01-10T10:00:00Z'));
    expect(at('<meta name="date" content="2024-01-10T10:00">')).toEqual(new Date('2024-01-10T10:00:00Z'));
  });
});

describe('scoreContext', () => {
  it('matches scoreHtml for the same page', () => {
    const t = new Date('2026-09-30T00:00:00Z');
    expect(scoreContext(exportedBuild(blogRecipe()), t)).toEqual(scoreHtml(blogRecipe(), t));
  });
});
