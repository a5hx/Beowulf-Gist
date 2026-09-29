# Gist — Free-Tier Core: Design Spec

**Date:** 2026-09-29
**Source:** `Gist — Product Spec Anti-Slop Browser Extension.pdf` (product spec, same date)
**Status:** Draft for review

## 1. Purpose and context

Gist is a browser extension that marks low-value Google results based on how useful a page is, not on whether AI wrote it. This build is headed for a **real public launch** on the Chrome Web Store, measured against the product spec's day-60 targets (5,000 installs, ≥35% week-4 retention, <5% upheld appeals among dimmed domains).

The product spec covers several separate subsystems. This document covers only the first: the **free-tier core**. It has to work before anything else is worth building.

### In scope

- Chrome MV3 extension on Google web search: reads the results page, applies the score bands, and provides the nutrition label, the "Why?" panel, the flag button, and a toolbar popup
- Scoring backend: per-URL fetch, Layer 1 scoring and caching, domain-list and selector-config distribution, flag intake, fetch-failure logging
- Shared open-source `layer1` package and `combiner` package
- A seed domain list (farms plus verified humans), maintained by hand in the repo
- A labeled evaluation set and evaluation script

### Out of scope (each gets its own spec later)

1. Deep scan (Layer 3) and Pro testers, including the choice of LLM and the cost per scan
2. Cut to the answer
3. Trust weighting, anti-brigading, appeals (DNS TXT verification), admin review UI
4. Payments, the Pro tier, real sign-in
5. Growth features: Slop Index, weekly report, "Show me the humans", subscribable lists
6. Other platforms (Images, Pinterest, YouTube, Amazon) and the Firefox/Safari releases. WXT keeps a Firefox build possible, but it isn't shipped in this scope

## 2. Key decisions

| # | Decision | Reason |
|---|---|---|
| D1 | **Page content comes from a server fetch first, with an optional device fallback.** The server fetches each result URL once and caches the Layer 1 score for all users. If the server fetch fails and the user has granted the optional all-sites permission, the device scores that page locally, for that user only, and never uploads the result. | The install prompt stays minimal, each URL is scored once, and the privacy promise holds. The device fallback covers sites that block bots (Cloudflare) without letting clients poison the shared cache. |
| D2 | **Strict confidence rule at launch.** Layer 1 alone can produce at most a "Thin" verdict. Filler (dim) and Slop (collapse) require a domain-list match. | False positives are the product's biggest risk. Switching to "Layer 1 may dim but not collapse" is a single threshold change, made once the evaluation set shows an acceptable false-positive rate. |
| D3 | **The combiner runs on the device.** | Domain-list updates take effect without re-scoring, and the server never decides what a user sees. |
| D4 | **The search query never leaves the device.** | The product spec allows only result URLs to leave. Free-tier "information value" therefore measures how substantive a page is, not how well it answers the query. |
| D5 | **Stack:** TypeScript pnpm monorepo; WXT for the extension; Hono on Node with Postgres (Fly.io or Railway); `linkedom` for HTML parsing; Vitest. | MV3 service workers lack `DOMParser`, and linkedom lets the same Layer 1 code give identical results on server and device. A long-running Node process has no CPU time limits. |
| D6 | **Identity is an anonymous device key** generated at install and used only for flags. | Flags must be tied to an account. Real sign-in comes with payments. |

## 3. Architecture

```
┌─ Chrome extension (WXT, MV3) ─────────────────────────────┐
│ content script (google.*/search)                           │
│   ├─ SERP reader   → organic result elements + target URLs │
│   ├─ renderer      → badges, tags, dim, collapse, label    │
│   └─ messages ↔ background                                 │
│ background service worker                                  │
│   ├─ list store    → domain list + selector config (daily) │
│   ├─ score client  → POST /score, polls pending            │
│   ├─ combiner      → grade, verdict, confidence, action    │
│   ├─ flag client   → POST /flags, local overrides          │
│   └─ device fallback (optional permission) → layer1 local  │
└───────────────────────────┬────────────────────────────────┘
                            │ result URLs (anonymous), flags (device key)
┌─ Backend (Hono + Postgres) ────────────────────────────────┐
│ POST /score   cache hit → return; miss → queue fetch        │
│ GET  /lists   versioned bundle, ETag                        │
│ POST /devices register device key (hash stored)             │
│ POST /flags   store flag                                    │
│ fetch worker  queue → SSRF-safe fetch → layer1 → cache      │
└────────────────────────────────────────────────────────────┘
```

### Repository layout

```
apps/extension       WXT extension
apps/server          Hono API + fetch worker
packages/layer1      pure TS: (html, url) → Layer1Result
packages/combiner    pure TS: (Layer1Result?, ListEntry?, override?) → Verdict
packages/shared      types, URL normalization, domain matching (tldts)
data/domains/*.json  seed domain list (farm + human)
data/selectors.json  SERP selector config
eval/                labels.jsonl, html snapshots, eval script
```

`layer1` and `combiner` don't touch the network, the DOM, or the clock (time is passed in as an argument), so they can be tested and open-sourced on their own.

## 4. Scoring

### 4.1 Dimensions

| Dimension | Weight | MVP source | Signals |
|---|---|---|---|
| Information value | 30 | Layer 1 | Density of concrete details (numbers with units, dates, named entities, numbered steps); words before the first substantive paragraph; main content as a share of total page text |
| Originality | 25 | **Not scored** | Needs deep scan. The label shows "—, needs deep scan" |
| Human presence | 20 | Layer 1 + list | Named author (byline, `schema.org` author); checkable first-person details; a real comments section; varied non-stock images; verified-human list |
| Site behavior | 15 | List only | The list entry's `siteBehavior` value. Unscored for domains not on the list |
| Monetization pressure | 10 | Layer 1 | Ad network scripts and ad containers per 1,000 words; affiliate link density (known affiliate parameters and domains); interstitial/popup scripts |

Every dimension score is an integer from 0 to 100, where higher means better. Unscored dimensions are dropped and the remaining weights are rescaled to add up to 100. **Style tells** (stock AI phrases, uniform sentence rhythm) are a separate `styleAdjust` value in the range [-5, +5], added after weighting. Layer 1 works on raw HTML without running JavaScript, so it counts ad scripts and containers rather than rendered ads.

### 4.2 Types

```ts
type Signal = { id: string; label: string; effect: number }; // effect: signed points on its dimension

type Layer1Result = {
  layer1Version: string;
  dimensions: {
    info:         { score: number; signals: Signal[] };
    human:        { score: number; signals: Signal[] };
    monetization: { score: number; signals: Signal[] };
  };
  styleAdjust: number;       // [-5, +5]
  styleSignals: Signal[];    // explains styleAdjust in "Why?"
  fetchedAt: string;         // ISO 8601
};

type ListEntry = {
  match: string;                   // registrable domain, or host for platform entries
  matchLevel: 'domain' | 'host';
  kind: 'farm' | 'human';
  siteBehavior: number;            // 0–100, required so a list match always yields a grade
  reasons: string[];               // shown in "Why?"
  source: 'seed' | 'review';
};

type Confidence = 'high' | 'low' | 'none';
type VerdictName = 'Solid' | 'OK' | 'Thin' | 'Filler' | 'Slop';
type Action = 'none' | 'dot' | 'tag' | 'dim' | 'collapse';

type Verdict = {
  grade: number | null;      // null when confidence is 'none'
  verdict: VerdictName | null;
  confidence: Confidence;
  action: Action;
  dimensions: Record<'info'|'originality'|'human'|'siteBehavior'|'monetization', number | null>;
  reasons: Signal[];         // sorted by |effect| descending
  userOverride: 'slop' | 'fine' | null;
};
```

### 4.3 Domain matching

A URL matches a list entry by its registrable domain (public-suffix list via `tldts`). Entries with `matchLevel: 'host'` match only that exact host, so one blog on `medium.com` or `blogspot.com` doesn't mark the whole platform. If both a host-level and a domain-level entry match, the host-level entry wins.

### 4.4 Combiner algorithm

1. Take the scored dimensions from Layer 1 (if available) and `siteBehavior` from the list entry (if one matched).
2. If there are no scored dimensions → `confidence: 'none'`, grade and verdict `null`, action `none`.
3. `raw` = weighted mean of the scored dimensions with rescaled weights, plus `styleAdjust`, clamped to [0, 100] and rounded.
4. Confidence is `high` if a list entry matched. Otherwise it's `low`.
5. Guardrails, in this order:
   1. `kind: 'farm'` → `grade = min(grade, 25)`
   2. `kind: 'human'` → `grade = max(grade, 50)`
   3. Verdict from the bands: 80–100 Solid, 60–79 OK, 40–59 Thin, 20–39 Filler, 0–19 Slop.
   4. **Strict rule (D2):** if `confidence === 'low'` and the verdict is Filler or Slop, set the verdict to Thin. The grade isn't changed, and the label shows it with a "low confidence" badge.
6. Action: Solid → `dot` if the green-dot setting is on, else `none`; OK → `none`; Thin → `tag`; Filler → `dim`; Slop → `collapse`.
7. **User override:** if the user flagged this normalized URL, "fine" sets action `none` and "slop" sets action `dim` (a `collapse` stays `collapse`). The verdict shown in the label doesn't change, but the label notes "You marked this as …".

The strict rule is controlled by one exported constant, `LOW_CONFIDENCE_FLOOR: VerdictName = 'Thin'`. Changing to the looser rule later means setting it to `'Filler'`.

## 5. Extension

### 5.1 Permissions

- Required: `storage`, `alarms`, `activeTab` (lets the popup read the current tab's host, shows no install warning), host access to Google search domains and the API origin.
- Optional (requested at runtime from the popup or first-run page): `<all_urls>`, used only by the device fallback.

### 5.2 SERP reader

- Driven by the selector config: organic result container, link, title, and exclusion selectors (ads, People Also Ask, video/shopping/knowledge panels).
- Google redirect links (`/url?q=…`) are converted to the real target URL.
- A `MutationObserver` picks up results that load later and in-page navigation to a new search.
- Each result element is processed once, tracked with a `data-gist-id` attribute.

### 5.3 Flow per results page

1. Read the results and normalize their URLs.
2. Immediately run the combiner with only the list entry and render any high-confidence verdicts.
3. Send uncached URLs in one `POST /score`. Poll `pending` URLs at 1.5 s, 4 s and 8 s, after which they count as unscored.
4. For each `failed` URL: if the optional permission is granted, fetch it with `credentials: 'omit'` and run `layer1` locally (the result stays on the device, cached in `storage.local` for 14 days).
5. Re-run the combiner as each result arrives and update the rendering.

### 5.4 Rendering

Everything Gist adds to the page lives in a Shadow DOM.

| Action | Rendering |
|---|---|
| none | Badge only |
| dot | Badge + green dot |
| tag | Badge + "Thin" tag next to the URL |
| dim | Result at about 45% opacity + "Filler" tag. Still clickable |
| collapse | Result replaced by one line: "Collapsed by Gist: {top reason} · Show". Expanded state lasts for the session |

**Nutrition label:** hovering over the badge (300 ms delay) or focusing it with the keyboard opens a card showing the grade, verdict, confidence badge, five dimension bars (unscored ones show "—" with the reason), a **Why?** section listing `reasons`, and the flag controls. The card closes on Escape or when the mouse leaves.

**Flagging:** "Slop" and "Fine" buttons. "Slop" asks for a reason: filler, AI images, fake reviews, untested roundup, or other. Flags are stored on the device as a URL override right away, then sent to `/flags`. If sending fails, the flag is queued and retried when the next alarm fires.

### 5.5 Popup and first run

- Popup: global on/off switch, "Pause on this site", green-dot setting, "Enable full coverage" (requests the optional permission), and "N results dimmed today" (counted on the device only).
- First-run page: what Gist does, what leaves the device, and the optional-permission offer (can be skipped).

### 5.6 Syncing

A daily `alarms` job calls `GET /lists` with `If-None-Match`. The last good bundle is kept in `storage.local`, and a bundled copy is used on first install.

## 6. Backend

### 6.1 Endpoints

| Endpoint | Auth | Behavior |
|---|---|---|
| `POST /score` `{urls: string[]}` (max 20) | None. Rate-limited by IP | Returns `{results: {[url]: {status:'ready', layer1} \| {status:'pending'} \| {status:'failed', reason}}}`. Cache misses are queued |
| `GET /lists` | None | Versioned bundle `{version, domains: ListEntry[], selectors}` with ETag |
| `POST /devices` `{key}` | None. Rate-limited by IP | Stores `sha256(key)` and returns 201 |
| `POST /flags` `{url, verdict: 'slop'\|'fine', reason?}` | `Authorization: Device <key>` | Stores the flag. Limit 100 per key per day |
| `POST /events` `{configVersion, event: 'no_matches'}` | None. Rate-limited by IP | Increments a daily counter. Returns 204 |

`/score` requests carry no identifier. No endpoint accepts a search query.

### 6.2 Fetch worker

- In-process queue: at most 20 concurrent fetches, and 2 per registrable domain.
- Limits: 8 s timeout, 3 MB response body, 5 redirects, `http`/`https` only, `text/html` only.
- **SSRF guard:** resolve DNS and reject loopback, private, link-local and unique-local addresses (IPv4 and IPv6), both before connecting and after every redirect. Connect to the IP address that was checked, so a second DNS lookup can't point somewhere else.
- User agent: `GistBot/1.0 (+https://<domain>/bot)`.
- robots.txt: obey rules for `User-agent: GistBot` and ignore `User-agent: *` (fetches are triggered by a user's search, like a link previewer). robots.txt is cached per host for 24 h.
- URL normalization (shared package): lowercase scheme and host, drop the fragment and default ports, remove `utm_*`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`, and sort the remaining query parameters.
- Cache: key `(normalizedUrl, layer1Version)`. Scores stay valid for 14 days and failures for 1 day.
- Failure reasons: `timeout`, `network` (DNS/connection errors, too many redirects), `http_<status>`, `blocked_challenge` (a challenge page was detected), `robots`, `too_large`, `not_html`, `ssrf`, `parse`.

### 6.3 Data model (Postgres)

- `page_scores(url_norm, layer1_version, status, result jsonb, fail_reason, fetched_at, PRIMARY KEY (url_norm, layer1_version))`
- `fetch_failures(day, domain, reason, count, PRIMARY KEY (day, domain, reason))`
- `devices(key_hash PRIMARY KEY, created_at)`
- `flags(id, key_hash, url_norm, domain, verdict, reason, created_at)`
- `list_versions(version PRIMARY KEY, bundle jsonb, published_at)`
- `events(day, config_version, event, count, PRIMARY KEY (day, config_version, event))`

### 6.4 Operations

- `pnpm lists:publish` validates `data/domains/*.json` and `data/selectors.json` against their schemas and inserts a new `list_versions` row.
- `pnpm review` prints flags grouped by domain (counts by verdict and reason, and when they were first and last seen). Decisions go back into the JSON files through a PR.
- Server logs record the method, route, status and timing. **URLs are never logged.**

## 7. Failure handling

In every failure case Gist shows less, never more:

| Failure | Behavior |
|---|---|
| Backend unreachable | Domain-list verdicts still work. Other results show "Not scored yet" |
| Selectors match 0 results | Gist adds nothing. An anonymous `{configVersion, event:'no_matches'}` report is sent (at most once per day) |
| Layer 1 throws an error | That URL becomes `failed: parse` and the rest of the batch is unaffected |
| List sync fails | The last good bundle, or the bundled copy, is used |
| Flag send fails | Queued on the device and retried when the next alarm fires |

## 8. Privacy rules (each backed by a test)

1. `/score` requests have no cookies, device key or query.
2. The device key is stored only as a hash, and flags are never joined with score logs.
3. Server logs never contain URLs.
4. Device-fallback fetches use `credentials: 'omit'`.
5. The permissions requested at install are exactly those in §5.1.

## 9. Testing

- **`layer1`:** unit tests on saved HTML examples: clear farm pages, independent blogs, forum threads, recipe sites, and pages from non-native English writers (fairness check: these mustn't score below Thin because of style alone).
- **`combiner`:** one test per guardrail, tests of the guardrail order, tests of the strict rule, and weight rescaling with unscored dimensions.
- **`shared`:** URL normalization and domain matching, including host-level entries.
- **SERP reader:** tests against saved Google results pages (plain, with ads, with People Also Ask, continuous scroll).
- **Daily layout check:** a scheduled headless-Chrome job runs fixed searches and fails if the selectors return 0 organic results.
- **Backend:** integration tests on real Postgres (Testcontainers), covering the SSRF cases (redirect to `127.0.0.1`, `169.254.169.254`, `[::1]`, private-IP DNS results), cache behavior, rate limits and flag authentication.
- **Evaluation:** `eval/labels.jsonl` holds about 300 results labeled by hand as `slop|thin|ok|solid`, with the HTML snapshot saved at labeling time. `pnpm eval` reports precision and recall per band, plus the **false-positive rate on pages labeled ok or solid** that Layer 1 alone would dim. That number decides when to change `LOW_CONFIDENCE_FLOOR`.

## 10. Open questions carried from the product spec

- Is "Gist" available as a name (domain and trademark)? This affects the bot URL and the Store listing, but not the code.
- Should the launch start with Google search or Pinterest images? This spec assumes Google.
- Which LLM runs deep scans, and at what cost? That's deferred to the deep-scan spec.
