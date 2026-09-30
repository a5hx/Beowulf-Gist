import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { selectorConfigSchema } from '@gist/shared';
import { COUNT_ORGANIC_SRC } from './lib/countOrganic';

const QUERIES = ['chocolate chip cookie recipe', 'how to reset tp-link router', 'best running shoes'];
const cfg = selectorConfigSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('../data/selectors.json', import.meta.url)), 'utf8')));

// PW_CHANNEL=chrome uses an installed Chrome instead of Playwright's bundled Chromium.
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage({ locale: 'en-US' });
let broken = false;
try {
  for (const q of QUERIES) {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('consent.google')) {
      await page.getByRole('button', { name: /accept all/i }).click();
      await page.waitForLoadState('domcontentloaded');
    }
    if (page.url().includes('/sorry/')) {
      console.error('Google served a CAPTCHA: result inconclusive');
      process.exitCode = 2;
      break;
    }
    const n = (await page.evaluate(`(${COUNT_ORGANIC_SRC})(${JSON.stringify(cfg)})`)) as number;
    console.log(`${q}: ${n} organic results (selectors v${cfg.version})`);
    if (n < 3) broken = true;
  }
} finally {
  await browser.close();
}
if (broken) {
  console.error('Selectors matched fewer than 3 results on at least one query: update data/selectors.json');
  process.exitCode = 1;
}
