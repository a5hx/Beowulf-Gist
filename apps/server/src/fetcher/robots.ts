export type RobotsRules = { allow: string[]; disallow: string[] };

/**
 * Returns rules from groups naming GistBot, or null if none do. Groups for `*` are deliberately ignored:
 * fetches are triggered by a user's search, like a link preview (spec §6.2).
 */
export function parseRobotsForAgent(txt: string, agent = 'gistbot'): RobotsRules | null {
  const rules: RobotsRules = { allow: [], disallow: [] };
  let matched = false;
  let groupAgents: string[] = [];
  let inRules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const idx = line.indexOf(':');
    if (!line || idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (inRules) {
        groupAgents = [];
        inRules = false;
      }
      groupAgents.push(value.toLowerCase().split('/')[0]!.trim());
      if (groupAgents.includes(agent)) matched = true;
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (groupAgents.includes(agent) && value) (key === 'allow' ? rules.allow : rules.disallow).push(value);
    }
  }
  return matched ? rules : null;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = anchored ? p.slice(0, -1) : p;
  const escaped = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export function isPathAllowed(rules: RobotsRules | null, pathWithQuery: string): boolean {
  if (!rules) return true;
  let best: { len: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (!patternToRegex(p).test(pathWithQuery)) continue;
      if (!best || p.length > best.len || (p.length === best.len && allow)) best = { len: p.length, allow };
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best ? (best as { allow: boolean }).allow : true;
}

export function createRobotsChecker(deps: { fetchText: (url: string) => Promise<string | null>; now: () => number; ttlMs?: number }) {
  const ttl = deps.ttlMs ?? 24 * 60 * 60 * 1000;
  const cache = new Map<string, { at: number; rules: Promise<RobotsRules | null> }>();
  return async (url: string): Promise<boolean> => {
    const u = new URL(url);
    let hit = cache.get(u.origin);
    if (!hit || deps.now() - hit.at > ttl) {
      if (cache.size > 10_000) cache.clear();
      hit = { at: deps.now(), rules: deps.fetchText(`${u.origin}/robots.txt`).then((t) => (t ? parseRobotsForAgent(t) : null)) };
      cache.set(u.origin, hit);
    }
    return isPathAllowed(await hit.rules, u.pathname + u.search);
  };
}
