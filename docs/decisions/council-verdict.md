# Council verdict: minimi architecture (2026-11-11)

Inputs: framed-question.md, anonymized-responses.md, peer-reviews.md, mapping.md (A=Expansionist, B=Contrarian, C=Executor, D=Outsider, E=First Principles).
Peer votes, strongest: Contrarian ×2, Executor ×2, Outsider ×1. Biggest blind spot: Expansionist ×5.

**Decision:** C's loop on a provenance core. The verbatim turn log stores evidence and source dates. "Still correct?" replays the stored queries with a published-date filter and builds the then/now table at read time. There is no claim ledger, router or watchlist. The seed is a labelled week of real recorded searches. Fake-clock evals report measured p50 TTFT.

## IN
- One Hono process (SSE plus a bare chat page). One AI SDK agent loop with one `web_search` tool (Exa).
- TimeResolver: chrono-node, timezone from the browser, `NOW`/per-message `at` override.
- `node:sqlite` turn log: verbatim answer, queries run, cited URLs, source published dates, snippets, `answered_at`, timezone. SQL recall by date window.
- One heuristic flag: answer from memory vs. search fresh. Fan out only for comparisons.
- Every answer: "as of <date>" plus sources. Honest empty memory. Clarifying questions. No answering volatile facts from training data.

## "Still correct?" without phantom diffs
- Replay the stored queries with `startPublishedDate = answered_at`. The model compares the old answer against the new evidence and builds the then/now table at read time.
- Say "changed" only when a later-dated source states a different value, and cite it. Otherwise say "no newer evidence since X" or "couldn't confirm".

## Cold start
- `npm run seed` loads a week of real recorded searches, re-dated relative to NOW and tagged `[demo seed]`. The startup log prints hints.

## CUT (moved to DESIGN.md "another week")
- Bi-temporal claim ledger, volatility TTLs, user-fact extraction, watchlist, proactive nudge, speculative search, tiered router/planner.
- Frame these as the path to right-moment nudges once change detection is trustworthy.

## Also
- 6–8 fake-clock evals with pass rates and p50 TTFT.
- Real iterative commit history. `POST /chat` accepts an optional timestamp for scripted replay. Node ≥22.13 check. Fail loudly on a missing key. Two keys only.

## First step
Fix the turn-log schema. Ship the walking skeleton that writes to it. Prove that `npm install && npm run dev` works from a clean clone before writing anything else.
