import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/** Behind a proxy (e.g. Fly's `fly-client-ip`), pass the header name; otherwise the socket address is used. */
export function createClientIp(header: string | undefined) {
  return (c: Context): string => {
    const fromHeader = header ? c.req.header(header)?.split(',')[0]?.trim() : undefined;
    return fromHeader || getConnInfo(c).remote.address || 'unknown';
  };
}
