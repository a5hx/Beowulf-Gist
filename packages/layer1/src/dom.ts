import { parseHTML } from 'linkedom';

const STRIP_ALWAYS = 'script,style,noscript,template,svg';
const STRIP_CHROME = 'nav,header,footer,aside,form,iframe';
const BLOCKS = 'p,li,pre,blockquote,h2,h3,h4';

export type PageContext = {
  document: Document;
  main: Element;
  mainText: string;
  mainWords: number;
  bodyWords: number;
  blocks: Element[];
};

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function buildContext(html: string): PageContext {
  // A space after every tag keeps words in adjacent blocks from merging ("<p>a</p><p>b</p>" → "a b").
  // NUL characters are stripped because they are never meaningful in HTML text.
  const spaced = html.replace(/\u0000/g, '').replace(/>(?=\S)/g, '> ');
  const source = /<html[\s>]/i.test(spaced) ? spaced : `<!doctype html><html><head></head><body>${spaced}</body></html>`;
  const { document } = parseHTML(source) as unknown as { document: Document };
  const body: Element = document.body ?? document.documentElement;

  const bodyClone = body.cloneNode(true) as Element;
  bodyClone.querySelectorAll(STRIP_ALWAYS).forEach((e) => e.remove());
  const bodyWords = wordCount(textOf(bodyClone));

  let chosen: Element | null = null;
  for (const sel of ['article', 'main', '[role="main"]']) {
    const els = [...document.querySelectorAll(sel)];
    if (els.length) {
      chosen = els.reduce((a, b) => (textOf(b).length > textOf(a).length ? b : a));
      break;
    }
  }
  const main = (chosen ?? body).cloneNode(true) as Element;
  main.querySelectorAll(`${STRIP_ALWAYS},${STRIP_CHROME}`).forEach((e) => e.remove());
  const mainText = textOf(main);
  const blocks = [...main.querySelectorAll(BLOCKS)].filter((el) => !el.parentElement?.closest('p,li,pre,blockquote'));
  return { document, main, mainText, mainWords: wordCount(mainText), bodyWords, blocks };
}
