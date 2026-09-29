# Domain lists

Entries here are the only thing that can dim or collapse a result at launch (spec D2), so every entry needs evidence.

Each entry: `{ "match", "matchLevel": "domain"|"host", "kind": "farm"|"human", "siteBehavior": 0–100, "reasons": [...], "source": "seed"|"review" }`.

## Adding a farm (`farms.json`)
Add a domain only when **at least two** of these are true and written in `reasons` (reasons are shown to users in "Why?"):
- Publishes many articles per day across unrelated topics (topic sprawl).
- Output jumped sharply after 2022, or the domain changed owners and its topic (expired-domain takeover).
- Pages sampled (5+) consistently bury the answer under 500+ words of filler.
- No named authors, or author profiles that cannot be verified.
Set `siteBehavior` 0–19 for egregious farms (these collapse), 20–39 otherwise (these dim).

## Adding a verified human site (`humans.json`)
Named person or small team, posting history over years, first-hand work (original photos, tested results). `siteBehavior` 70–100.

Use `"matchLevel": "host"` for one blog on a shared platform (e.g. `someone.blogspot.com`, `someone.substack.com`).

Run `pnpm lists:build` after editing; it validates and regenerates `data/bundle.json`.
