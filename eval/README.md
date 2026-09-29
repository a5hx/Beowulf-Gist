# Layer 1 evaluation

Goal (spec §9): ~300 hand-labeled Google results, so we know when Layer 1 alone is safe to dim (switch `LOW_CONFIDENCE_FLOOR` to `'Filler'`).

- Label: `pnpm eval:snapshot <slop|thin|ok|solid> <url>`. Label by reading the page, not by guessing from the domain. Aim for a spread of topics (recipes, tech how-to, product reviews, health, travel) and roughly equal ok/solid vs thin/slop.
- Run: `pnpm eval`. The number that matters is **False-positive rate if Layer 1 alone could dim**. Agree a threshold (e.g. under 2%) before flipping the constant.
- Snapshots are git-ignored (they are third-party pages); keep them locally or in private storage.
