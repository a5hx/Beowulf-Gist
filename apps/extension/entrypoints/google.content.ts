import { browser } from 'wxt/browser';
import { GOOGLE_MATCHES, isWebSearch } from '../src/google';
import type { FlagResponse, InitResponse, RuntimeMessage } from '../src/messages';
import { createSerpController } from '../src/serp/controller';
import { createExpandedSet } from '../src/serp/expanded';
import { createReconnectingPort } from '../src/serp/port';

const send = <T>(msg: RuntimeMessage) => browser.runtime.sendMessage(msg) as Promise<T>;

export default defineContentScript({
  matches: GOOGLE_MATCHES,
  runAt: 'document_idle',
  async main() {
    if (!isWebSearch(new URL(location.href))) return;
    const init = await send<InitResponse | null>({ type: 'init', host: location.hostname });
    if (!init?.enabled) return;
    createSerpController({
      root: document,
      selectors: init.selectors,
      base: location.href,
      port: createReconnectingPort(),
      flag: async (url, verdict, reason) => (await send<FlagResponse | null>({ type: 'flag', url, verdict, reason }))?.verdict ?? null,
      reportDimmed: (n) => void send({ type: 'dimmed', n }),
      reportNoMatches: (configVersion) => void send({ type: 'noMatches', configVersion }),
      expanded: createExpandedSet(window.sessionStorage),
    }).start();
  },
});
