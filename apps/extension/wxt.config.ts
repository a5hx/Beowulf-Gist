import { defineConfig } from 'wxt';
import { GOOGLE_MATCHES } from './src/google';

const API_BASE = process.env.WXT_API_BASE ?? 'http://localhost:8787';

export default defineConfig({
  manifest: {
    name: 'Gist',
    description: 'Dims low-value Google results and shows you why.',
    permissions: ['storage', 'alarms', 'activeTab'],
    host_permissions: [`${new URL(API_BASE).origin}/*`],
    optional_host_permissions: ['<all_urls>'],
  },
  vite: () => ({ server: { fs: { allow: ['../..'] } } }),
});

export { GOOGLE_MATCHES };
