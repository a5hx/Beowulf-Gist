import { randomWords } from '@gist/layer3/testing';

/** Article prose rich in concrete details (so honest pages score well on Layer 1), deterministic per seed. */
export function articleText(sentences: number, seed: number): string {
  const w = randomWords(sentences * 9, seed);
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const [a, b, c, d, e, f, g, h, k] = w.slice(i * 9, i * 9 + 9);
    out.push(`<p>In ${2000 + (i % 24)} the ${a} ${b} team measured ${10 + i} kg of ${c} across ${3 + (i % 9)} sites near ${d}, while ${e} ${f} reported ${g} ${h} ${k} gains.</p>`);
  }
  return out.join('\n');
}

export const original = (body: string) => `<!doctype html><html><head>
  <meta name="author" content="Dana Whitfield"><meta property="article:published_time" content="2024-01-10T00:00:00Z">
  </head><body><article><h1>Field notes</h1><p>I spent 14 days on this survey and my notes follow.</p>${body}</article></body></html>`;

export const farm = (copied: string, fillerSeed: number, date: string | null) => `<!doctype html><html><head>
  <meta name="author" content="admin">${date ? `<meta property="article:published_time" content="${date}">` : ''}
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
  <script src="https://a.omappapi.com/app/js/api.min.js"></script>
  </head><body><article><h1>Best guide ever</h1>
  ${Array.from({ length: 12 }, () => '<div class="ad-container"></div>').join('')}
  <p>${randomWords(300, fillerSeed).join(' ')}.</p>${copied}
  <img src="https://www.shutterstock.com/a.jpg"><img src="https://www.shutterstock.com/b.jpg">
  <p><a href="https://amzn.to/1">x</a> <a href="https://amzn.to/2">y</a> <a href="/about">about</a></p>
  </article></body></html>`;

/** Wire-style syndication: named author, clean page, dated after the original, carries most of the original. */
export const wire = (copied: string, date: string) => `<!doctype html><html><head><meta name="author" content="Staff Reporter Lee Park"><meta property="article:published_time" content="${date}"></head>
  <body><article><h1>Survey findings</h1>${copied}</article></body></html>`;
