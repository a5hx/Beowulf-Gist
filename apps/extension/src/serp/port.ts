import { browser } from 'wxt/browser';
import { PORT_NAME, type PortIn, type PortOut } from '../messages';

/** The MV3 service worker can go away; reconnect lazily on the next post. */
export function createReconnectingPort() {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  const listeners: ((m: PortOut) => void)[] = [];
  const connect = () => {
    const p = browser.runtime.connect({ name: PORT_NAME });
    p.onMessage.addListener((m: unknown) => listeners.forEach((l) => l(m as PortOut)));
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
    });
    port = p;
    return p;
  };
  return {
    post(msg: PortIn) {
      (port ?? connect()).postMessage(msg);
    },
    onMessage(cb: (m: PortOut) => void) {
      listeners.push(cb);
      if (!port) connect();
    },
  };
}
