import { serve } from '@hono/node-server';
import { LAYER1_VERSION } from '@gist/layer1';
import { analyzePage } from './analyze';
import { createApp } from './app';
import { createClientIp } from './clientIp';
import { connect, migrate } from './db';
import { readEnv } from './env';
import { fetchPage, fetchText } from './fetcher/fetchPage';
import { createRobotsChecker } from './fetcher/robots';
import { createSafeAgent, isPublicAddress } from './fetcher/ssrf';
import { FetchQueue } from './queue';
import { createRateLimiter } from './rateLimit';
import { createRepo } from './repo';
import { createOriginalityService } from './originalityService';
import { createScoreService } from './scoreService';

const env = readEnv(process.env);
const sql = connect(env.databaseUrl);
await migrate(sql);
const repo = createRepo(sql);

const dispatcher = createSafeAgent(isPublicAddress);
const userAgent = `GistBot/1.0 (+${env.botInfoUrl})`;
const robotsAllowed = createRobotsChecker({
  fetchText: (url) => fetchText(url, { dispatcher, userAgent, policy: isPublicAddress }),
  now: Date.now,
});

const scores = createScoreService({
  repo,
  queue: new FetchQueue({ global: 20, perDomain: 2 }),
  fetchPage: (url) => fetchPage(url, { dispatcher, userAgent, policy: isPublicAddress, robotsAllowed }),
  analyze: (html, at, pageUrl) => analyzePage(html, at, { log: (line) => console.log(line) }, pageUrl),
  originality: createOriginalityService({ repo, now: () => new Date() }),
  now: () => new Date(),
  version: LAYER1_VERSION,
});

// Retention (spec §6.5): fingerprints and memos older than 90 days, at boot and daily.
const prune = () =>
  repo
    .pruneFingerprints(90)
    .then((r) => console.log(`pruned ${r.fingerprints} fingerprints, ${r.memos} memos`))
    .catch((err: Error) => console.log(`error prune ${err.name}`));
void prune();
setInterval(prune, 24 * 3600 * 1000).unref();

const app = createApp({
  scores,
  repo,
  limiter: createRateLimiter(),
  clientIp: createClientIp(env.clientIpHeader),
  log: (line) => console.log(line),
});

serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`gist server on :${info.port} (layer1 ${LAYER1_VERSION})`));
