import { browser } from 'wxt/browser';
import { hasAllSitesPermission } from '../../src/platform';

const grant = document.getElementById('grant')!;
const granted = document.getElementById('granted')!;

async function render() {
  const ok = await hasAllSitesPermission();
  grant.hidden = ok;
  granted.hidden = !ok;
}

grant.addEventListener('click', async () => {
  await browser.permissions.request({ origins: ['<all_urls>'] });
  await render();
});
void render();
