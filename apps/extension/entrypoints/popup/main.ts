import { browser } from 'wxt/browser';
import { getDimmed } from '../../src/counter';
import { browserKV as kv, hasAllSitesPermission } from '../../src/platform';
import { getSettings, isPaused, togglePause, updateSettings } from '../../src/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const s = await getSettings(kv);
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('greenDot').checked = s.greenDot;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = tab?.url ? new URL(tab.url).hostname : null;
  const pause = $<HTMLButtonElement>('pause');
  pause.hidden = !host || !/^www\.google\./.test(host);
  if (host) pause.textContent = isPaused(s, host) ? `Resume on ${host}` : `Pause on ${host}`;

  const n = await getDimmed(kv, new Date());
  $('count').textContent = `${n} result${n === 1 ? '' : 's'} dimmed today`;

  const granted = await hasAllSitesPermission();
  $('grant').hidden = granted;
  $('granted').hidden = !granted;
  return host;
}

let host: string | null = null;
render().then((h) => (host = h));

$<HTMLInputElement>('enabled').addEventListener('change', async (e) => {
  await updateSettings(kv, { enabled: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('greenDot').addEventListener('change', async (e) => {
  await updateSettings(kv, { greenDot: (e.target as HTMLInputElement).checked });
});
$('pause').addEventListener('click', async () => {
  if (host) await togglePause(kv, host);
  await render();
});
$('grant').addEventListener('click', async () => {
  await browser.permissions.request({ origins: ['<all_urls>'] });
  await render();
});
