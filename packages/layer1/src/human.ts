import type { DimensionResult, Signal } from '@gist/shared';
import { type PageContext, textOf } from './dom';
import { clamp, signal } from './signals';

const GENERIC_AUTHORS = /^(admin|administrator|staff|editor|editors|editorial( team)?|team|guest|author|webmaster|contributor|user)$/i;
const STOCK_IMG = /shutterstock|istockphoto|gettyimages|stock\.adobe|adobestock|dreamstime|depositphotos|pexels|unsplash|pixabay|123rf/i;
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|my|me|mine|we|we've|our)\b/gi;

function findLdAuthor(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findLdAuthor(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const a = obj.author;
  if (typeof a === 'string' && a.trim()) return a.trim();
  if (a && typeof a === 'object') {
    for (const x of Array.isArray(a) ? a : [a]) {
      const name = (x as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  for (const v of Object.values(obj)) {
    const r = findLdAuthor(v, depth + 1);
    if (r) return r;
  }
  return null;
}

export function findAuthor(document: Document): string | null {
  const meta = document
    .querySelector('meta[name="author"], meta[name="Author"], meta[property="article:author"]')
    ?.getAttribute('content')
    ?.trim();
  if (meta && !/^https?:/i.test(meta)) return meta;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const name = findLdAuthor(JSON.parse(s.textContent ?? ''));
      if (name) return name;
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  const byline = textOf(
    document.querySelector('[rel="author"], [itemprop="author"], .author, .byline, .post-author, .entry-author, .author-name'),
  ).replace(/^by\s+/i, '');
  return byline && byline.length <= 80 ? byline : null;
}

function countComments(document: Document): number {
  let max = 0;
  for (const c of document.querySelectorAll('#comments, .comments, .comment-list, .commentlist, .comments-area, [itemtype*="Comment"]')) {
    max = Math.max(max, c.querySelectorAll('.comment, [itemtype*="Comment"], li, article').length);
  }
  return max;
}

export function scoreHuman(ctx: PageContext): DimensionResult {
  const signals: Signal[] = [];
  let score = 20;

  const author = findAuthor(ctx.document);
  if (author && !GENERIC_AUTHORS.test(author)) {
    score += 35;
    signals.push(signal('human.author', `Named author: ${author}`, 35));
  } else if (author) {
    signals.push(signal('human.generic_author', `Author listed only as "${author}"`, -35));
  } else {
    signals.push(signal('human.no_author', 'No named author', -35));
  }

  const text = ctx.mainText.replace(/’/g, "'");
  const fp = text.match(FIRST_PERSON)?.length ?? 0;
  if (ctx.mainWords && (fp / ctx.mainWords) * 100 >= 0.5) {
    score += 20;
    signals.push(signal('human.first_person', 'Written from first-hand experience', 20));
  } else {
    signals.push(signal('human.no_first_person', 'No first-hand voice', -20));
  }

  const comments = countComments(ctx.document);
  if (comments >= 2) {
    score += 15;
    signals.push(signal('human.comments', `${comments} reader comments`, 15));
  }

  const srcs = new Set(
    [...ctx.main.querySelectorAll('img')].map((i) => i.getAttribute('src') || i.getAttribute('data-src') || '').filter(Boolean),
  );
  const stock = [...srcs].filter((s) => STOCK_IMG.test(s)).length;
  const original = srcs.size - stock;
  if (original >= 3) {
    score += 10;
    signals.push(signal('human.images', `${original} original images`, 10));
  }
  if (stock >= 2 && stock >= srcs.size / 2) {
    score -= 10;
    signals.push(signal('human.stock_images', `${stock} stock images`, -10));
  }
  return { score: clamp(score), signals };
}
