# Gist — Originality Engine (Layer 3a): Design Spec

**Date:** 2026-09-30
**Builds on:** `docs/superpowers/specs/2026-09-29-gist-free-tier-core-design.md` (free-tier core, merged)
**Source:** product spec PDF, "Detection architecture" (Layer 3) and "Scoring rubric" (Originality)
**Status:** Draft for review

## 1. Purpose

Fill the empty **Originality** dimension (25% weight) with a page-level signal that **costs nothing per scan** (no LLM credits), so Gist can judge individual pages instead of relying only on hand-curated domain lists.

This replaces the product spec's "LLM deep scan for Pro testers" as the next sub-project. An LLM judge can be added later, funded by Pro revenue, through the `method` field on Layer 3 results (§4.1).

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| O1 | **The query never leaves the device** (same as D4). Originality is judged without the query. | Keeps one cached verdict per URL for everyone, and keeps the privacy promise. |
| O2 | **No LLM.** Originality comes from text fingerprints: winnowed hashes of 8-word sequences. | No capital for API credits. Deterministic, explainable, can be open-sourced. |
| O3 | **Runs for all users.** It isn't limited to Pro. | It's free to run. The Pro-only limit in the product spec existed because of LLM cost. |
| O4 | **Compared against a global fingerprint index** of every page Gist has fetched, not only the current results page's co-results. | A stable verdict per URL, and it catches copying across different queries. |
| O5 | **Copy evidence may dim, never collapse**, and only when Layer 1 also rates the page thin. | Copying is concrete evidence, so it can carry weight. The thin-Layer-1 requirement protects syndicated and mirrored content that's otherwise good. |
| O6 | **A match counts against a page only when the other page is not provably newer.** | Stops copies from making the original look unoriginal. |
| O7 | **Copy evidence overrides the verified-human floor**, as the product spec's guardrail says ("unless a page-level deep scan disagrees"). | Follows the spec literally. |

## 3. Architecture

```
fetch worker (existing)
  html → layer1.buildContext → ctx ─┬→ scoreHtml (Layer 1)                    → page_scores
                                    ├→ layer1.findPublishedAt(ctx.document)
                                    └→ layer3.fingerprint(ctx.mainText) ──────→ fingerprints
POST /score (existing)
  ready URL → originality memo (6 h) ─ miss → repo.fingerprintMatches(url) → layer3.originality(...)
  → ScoreItem { status:'ready', layer1, layer3? }
extension: orchestrator caches { layer1, layer3 } → combine(..., layer3) → label shows the Originality bar
```

### Package layout (new and changed)

```
packages/layer3/       NEW pure TS (no DOM, no network): fingerprint(), originality(), LAYER3_VERSION
packages/layer1/       + findPublishedAt(document): Date | null (exported)
packages/shared/       + Layer3Result type; ScoreItem ready gains optional layer3
packages/combiner/     + layer3 input, copy-evidence confidence path
apps/server/           + fingerprints, originality_memo tables; write in fetch job; compute on /score; daily retention
apps/extension/        orchestrator/fallback carry layer3; label text for a null originality
eval/                  in-memory index over labeled snapshots; originality in the report
```

## 4. Layer 3 package

### 4.1 Types (in `@gist/shared`)

```ts
type Layer3Result = {
  layer3Version: string;
  method: 'fingerprint';                // 'llm' reserved for a future Pro judge
  evidence: 'enough' | 'insufficient';
  originality: DimensionResult | null;  // null when evidence is insufficient
  coverage: number;                     // 0..1, share of own fingerprints matched on other domains
  otherDomains: string[];               // matched domains, most matches first, max 5
  computedAt: string;                   // ISO 8601
};

type ScoreItem =
  | { status: 'ready'; layer1: Layer1Result; layer3?: Layer3Result }
  | { status: 'pending' }
  | { status: 'failed'; reason: FailReason };
```

### 4.2 `fingerprint(mainText): number[]`

1. Normalize: lowercase, convert Unicode to NFKC, replace any run of characters that aren't letters or digits with a single space, and split into words.
2. Take 8-word sequences ("shingles"). Hash each with **cyrb53**, a 53-bit hash that fits exactly in a JS number and is stored as `bigint`.
3. **Winnowing** with window `w = 39`: in each window of 39 consecutive shingle hashes, keep the minimum (the rightmost one on ties), and don't record the same position twice. Expected density is about 2/(w+1), roughly 1 fingerprint per 20 words. Any shared passage of **46 or more words** (`w + k − 1`) is guaranteed to produce a shared fingerprint.
4. Return the unique hashes, in the order they were first seen.

A text with fewer than 8 words returns `[]`.

### 4.3 `originality(input): Layer3Result`

```ts
type OriginalityInput = {
  own: { count: number; domain: string; publishedAt: Date | null };
  matches: { hash: number; domain: string; publishedAt: Date | null }[]; // excludes own domain and boilerplate hashes (repo filters those)
  now: Date;
};
```

- A match **counts** unless both dates are known and `match.publishedAt > own.publishedAt` (the other page is provably newer, so it copied this one).
- `coverage` = number of distinct own hashes with at least one counting match, divided by `own.count`.
- `otherDomains` = the domains of counting matches, ordered by match count (descending), at most 5.
- **Evidence is enough** when `own.count >= 40` and there are counting matches on 2 or more distinct domains. Otherwise `evidence: 'insufficient'` and `originality: null`.
- Score = `lerpScore(coverage, 0.7, 0.1)`: coverage of 10% or less scores 100, 70% or more scores 0, linear in between.
- Signals:
  - When coverage ≥ 0.1: `{id:'orig.copied', label:'<pct>% of this text also appears on <n> other sites: <d1>, <d2>, <d3>', effect: score − 50}`
  - When coverage < 0.1: `{id:'orig.unique', label:'Most of this text appears nowhere else Gist has seen', effect: +25}`
- `LAYER3_VERSION = '1.0.0'`.

## 5. Layer 1 addition

`findPublishedAt(document): Date | null`. It checks, in order:
1. `meta[property="article:published_time"]`
2. JSON-LD `datePublished` (searched recursively, as for the author)
3. `time[datetime][itemprop="datePublished"]`
4. `meta[name="date"]`

It returns the first value that parses as a valid date and isn't later than now + 1 day, otherwise null. `LAYER1_VERSION` doesn't change, because Layer 1's scores don't change.

## 6. Server

### 6.1 Migration `002_originality.sql`

```sql
CREATE TABLE IF NOT EXISTS fingerprints (
  url_norm text NOT NULL, hash bigint NOT NULL, domain text NOT NULL,
  published_at timestamptz, fetched_at timestamptz NOT NULL,
  PRIMARY KEY (url_norm, hash));
CREATE INDEX IF NOT EXISTS fingerprints_hash_idx ON fingerprints (hash);
CREATE INDEX IF NOT EXISTS fingerprints_fetched_idx ON fingerprints (fetched_at);
CREATE TABLE IF NOT EXISTS originality_memo (
  url_norm text NOT NULL, layer3_version text NOT NULL, result jsonb NOT NULL, computed_at timestamptz NOT NULL,
  PRIMARY KEY (url_norm, layer3_version));
```

### 6.2 Repository additions

- `replaceFingerprints(urlNorm, domain, publishedAt, hashes, fetchedAt)` deletes the URL's old rows and inserts the new ones, in one transaction.
- `fingerprintMatches(urlNorm)` returns `{ own: {count, domain, publishedAt} | null, matches: [...] }`. It excludes:
  - the page's own registrable domain
  - **boilerplate hashes**, meaning any hash seen on more than **50** distinct domains
- `getOriginalityMemo(urls, version, maxAgeMs)` / `putOriginalityMemo(urlNorm, version, result)`.
- `pruneFingerprints(olderThanDays)` deletes rows with `fetched_at` older than the cutoff, plus memo rows older than the same cutoff.

### 6.3 Fetch job

After a successful fetch the job runs `buildContext` once. It passes the HTML to `scoreHtml`, as before, and also fingerprints `ctx.mainText` and calls `replaceFingerprints`. A fingerprinting failure is logged as `error layer3 <name>` and never fails the Layer 1 result.

### 6.4 `/score`

For URLs that are `ready`, read the memo in one batched query (max age 6 h). On a miss, call `fingerprintMatches` and then `originality`, and attach `layer3`. **Only results with `evidence: 'enough'` are memoized.** 'Insufficient' results are recomputed on every read (cheap), so a page scored before its siblings were indexed picks up the evidence on the next read instead of staying neutral for 6 hours. If Layer 3 throws for a URL, leave `layer3` off for that URL; `/score` never fails because of Layer 3.

### 6.5 Retention

At boot and every 24 h (`setInterval`, `unref`'d), run `pruneFingerprints(90)`.

## 7. Combiner

`CombineInput` gains `layer3: Layer3Result | null`.

- **Originality dimension** = `layer3.originality.score` when `layer3?.evidence === 'enough'`, otherwise null. Layer 3 signals join `reasons`.
- **`layer1Grade`** = the weighted mean of Layer 1's dimensions only (info, human, monetization) plus `styleAdjust`, clamped to 0–100.
- **`copyEvidence`** = `layer3?.evidence === 'enough' && layer3.coverage >= 0.6 && layer3.otherDomains.length >= 2 && layer1Grade < 60`.
- **Confidence:** `high` if there's a list entry **or** `copyEvidence`, otherwise `low`.
- **Guardrails, in this order:**
  1. Farm cap 25 (list).
  2. Human floor 50 (list), **skipped when `copyEvidence`**.
  3. Bands.
  4. **Copy-only cap:** if `copyEvidence` holds, there's no list entry, and the verdict is Slop, set the verdict to Filler (dim, never collapse).
  5. The existing low-confidence floor (Thin).
- When copy evidence applies, add the reason `{id:'guard.copy_evidence', label:'Copied text plus thin content: page-level evidence', effect:-30}`.

## 8. Extension

- **Orchestrator:** the per-URL cache holds `{ layer1, layer3 }`, and `verdict()` passes `layer3` to `combine`. Device-fallback results have `layer3: null`, since the device has no index.
- **Label:** when Originality is null, the tooltip reads **"Not enough comparisons yet"**, replacing "Needs deep scan (Pro)".
- No change to permissions, messages or UI structure.

## 9. Evaluation

`run-eval` fingerprints every labeled snapshot into an in-memory index (same filters: same-domain exclusion, the more-than-50-domains boilerplate filter, the date rule), computes `Layer3Result` per row, and grades with `combine(..., layer3)`. The report adds:
- how many rows had enough originality evidence
- how many were dimmed through copy evidence, broken down by label

## 10. Failure handling

| Failure | Behavior |
|---|---|
| Fingerprinting throws in the fetch job | Logged; Layer 1 result stored as usual; no fingerprints for that URL |
| Originality computation throws | `layer3` left out for that URL; Originality shows "—" |
| Memo read/write fails | Compute fresh; continue |
| Old extension version | Ignores `layer3` |
| Index sparse (early days) | `evidence: 'insufficient'`, so no effect on the verdict |

## 11. Testing

- **`@gist/layer3`:**
  - Determinism, and the normalization cases.
  - A copied 50-word passage embedded in different surrounding text always shares a fingerprint.
  - A fully reworded passage shares none (documents the limitation).
  - Density is roughly 1 per 20 words on long text.
  - Coverage math.
  - Evidence thresholds at exactly 40 fingerprints and at 2 domains.
  - The newer-date rule.
  - Signal wording.
- **`@gist/layer1`:** `findPublishedAt` for each source, invalid and future dates, and precedence.
- **Server (Postgres, Testcontainers):**
  - `replaceFingerprints` replaces old rows.
  - Matches exclude the page's own domain.
  - The more-than-50-domains boilerplate filter.
  - Memo max-age.
  - Pruning.
  - A `/score` integration test showing `layer3` present, and absent when Layer 3 throws.
- **Combiner:**
  - Copy evidence dims only when Layer 1 is thin.
  - Slop is capped at Filler without a list entry.
  - A farm list entry can still collapse.
  - Copy evidence skips the human floor.
  - Insufficient evidence leaves Originality null.
- **End-to-end fixture** (score service + real Postgres):
  - One dated original article, three farm pages on three different domains (later dates) that each copy about 70% of it and add filler, and one wire-style syndicated page with strong Layer 1 scores.
  - Expected: all three farms have `copyEvidence` and are dimmed, the original is not dimmed (date rule), and the syndicated page is not dimmed (good Layer 1).

## 12. Out of scope

- The LLM judge (reserved as `method: 'llm'`).
- Detecting AI-generated or stock images beyond what Layer 1 already does.
- Embedding-based detection of reworded copies (add later if the evaluation shows the need).
- Pro gating.
