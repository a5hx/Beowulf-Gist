import { browser } from 'wxt/browser';
import { scoreHtml } from '@gist/layer1';
import { normalizeUrl, type ListBundle } from '@gist/shared';
import bundled from '../../../data/bundle.json';
import { createApi } from '../src/api';
import { API_BASE } from '../src/config';
import { addDimmed } from '../src/counter';
import { ensureDevice } from '../src/device';
import { createFallback } from '../src/fallback';
import { createFlagSender } from '../src/flagSender';
import { createListStore } from '../src/listStore';
import { PORT_NAME, type InitResponse, type PortIn, type PortOut, type RuntimeMessage } from '../src/messages';
import { createOrchestrator } from '../src/orchestrator';
import { getOverride, setOverride } from '../src/overrides';
import { browserKV as kv, fetchHtmlFromDevice, hasAllSitesPermission } from '../src/platform';
import { getSettings, isPaused } from '../src/settings';

const DAY = 24 * 60 * 60 * 1000;

export default defineBackground(() => {
  const api = createApi(API_BASE);
  const lists = createListStore({ kv, api, bundled: bundled as ListBundle, now: Date.now });
  const ready = lists.load().then(async () => {
    if (Date.now() - lists.lastSyncedAt() > DAY) await lists.sync();
  });
  const fallback = createFallback({ kv, hasPermission: hasAllSitesPermission, fetchHtml: fetchHtmlFromDevice, score: scoreHtml, now: Date.now });
  const orchestrator = createOrchestrator({
    api,
    match: (url) => lists.match(url),
    override: (url) => getOverride(kv, url),
    greenDot: async () => (await getSettings(kv)).greenDot,
    fallback,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const flags = createFlagSender({ kv, api });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    await browser.alarms.create('daily', { periodInMinutes: 24 * 60 });
    if (reason === 'install') {
      void ensureDevice(kv, api);
      await browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
    }
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'daily') return;
    await ready;
    await lists.sync();
    await flags.flush();
  });

  async function handle(msg: RuntimeMessage): Promise<unknown> {
    await ready;
    switch (msg.type) {
      case 'init': {
        const s = await getSettings(kv);
        return { enabled: s.enabled && !isPaused(s, msg.host), selectors: lists.current().selectors } satisfies InitResponse;
      }
      case 'flag': {
        const url = normalizeUrl(msg.url);
        if (!url) return { verdict: null };
        await setOverride(kv, url, msg.verdict);
        void flags.send({ url, verdict: msg.verdict, reason: msg.reason });
        return { verdict: await orchestrator.verdict(url) };
      }
      case 'dimmed':
        await addDimmed(kv, msg.n, new Date());
        return null;
      case 'noMatches': {
        const day = new Date().toISOString().slice(0, 10);
        if ((await kv.get<string>('noMatchesDay')) !== day) {
          await kv.set('noMatchesDay', day);
          await api.event({ configVersion: msg.configVersion, event: 'no_matches' }).catch(() => {});
        }
        return null;
      }
    }
  }

  browser.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    handle(msg).then(sendResponse, () => sendResponse(null));
    return true; // async response
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    port.onMessage.addListener(async (msg: PortIn) => {
      if (msg.type !== 'score') return;
      await ready;
      const urls = msg.urls.map(normalizeUrl).filter((u): u is string => u !== null);
      await orchestrator.run(urls, (verdicts) => port.postMessage({ type: 'verdicts', verdicts } satisfies PortOut));
    });
  });
});
