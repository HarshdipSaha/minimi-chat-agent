# Design

A chat agent with one tool, web search. It answers fast, cites dated sources, and remembers what you asked and when, including "is that still correct?".

## How it works

One Node process serves a chat page and streams each turn over SSE. A turn is:

1. **Dates are resolved in code.** chrono-node, in the browser's timezone, turns "last Tuesday" or "3 November" into an exact day window (exact on 23- and 25-hour DST days too). Models are unreliable at relative dates; code isn't. A bare weekday is ambiguous (the latest Tuesday, or the one before), so the record settles it: if nothing was recorded on the latest one, the earlier one is used and the model is told to say so; if both have turns, the one matching the topic wins, or both are shown.
2. **Memory is pulled, not asked for.** Every turn is stored in SQLite (`node:sqlite`, append-only) with its question, its verbatim answer, every query, and every result's URL and **published date**. Each turn builds a `<context>` block from that log: the current time, when memory begins, the turns from any date the user mentioned (or "no turns recorded on that date"), and keyword matches from older turns (FTS5).
3. **One model, one tool.** `openai/gpt-oss-120b` on Groq decides whether to search. `web_search` takes a batch of 1-5 searches that run in parallel against Exa (each with a query and an `objective`, as Exa recommends for search-as-a-tool). Results come back numbered `[n]` with dates; at most three rounds, then the model must answer.
4. **Rechecks are deterministic where it matters.** If the user points at a past turn that searched the web, the code (not the model's good intentions):
   - forces a search on the first step, so a recheck can never be answered from memory;
   - runs every search both ways: current pages, and pages published *since that date*;
   - drops any `since` filter the model invents;
   - adds a **figure check**: each price in the earlier answer is looked for in today's pages, marked found or NOT found.
   The model must say "unchanged" only for found figures and otherwise "couldn't confirm".
5. Code adds `Sources checked: [n]` if nothing was cited, adds `As of <date>.`, normalises the model's citation style to `[n]`, **removes any `[n]` that points at no retrieved source** (an invented citation never reaches the screen or the log), and stores the turn.

Search results are labelled untrusted on every tool message, and the prompt says page text is data, never instructions; an eval plants an injected instruction in every result to check it.

## Why this shape

- **The hard part is provenance, not search.** "What did I ask on 3 November, and is it still right?" is a lookup if the answer is stored with its evidence and timestamp. Search latency is a commodity.
- **Memory is infrastructure, not a tool.** The model sees exactly one tool. Recall is deterministic code I can test (86 unit tests, no network).
- **Honest beats confident.** On a fresh install there is no 3 November. The agent says so and says when its memory starts. `npm run seed` loads three real recorded exchanges, labelled "demo seed", to try cross-day behaviour.
- **Fast where it shows.** Streaming, parallel searches, a small reasoning budget, a 10-minute search cache, no router or planner calls. Five Groq keys rotate round-robin; a 429 moves to the next key, and if every key is limited on the main model, a second model (limits are per model) takes over.

## Measured

`npm run eval -- --runs=3` replays 11 multi-day conversations (a fake `at` timestamp per turn) against the live APIs, three times: empty memory, within-session recall, cross-day recheck, a missing referent ("the 5 CRM tools" it never saw), a 5-way CRM fan-out, a stable fact that must **not** be called changed, an ambiguous "last Tuesday" (the question was a week earlier than the latest Tuesday), a page carrying an injected instruction, chit-chat, a fresh fact, a timezone edge.

| | Checks | First word (no search / search) | Full answer (search) |
|---|---|---|---|
| Current build, 3 runs | 45/45 | 0.7 s / 3.9 s | 4.1 s |

On the first 9 scenarios, earlier builds scored 33/36 and 35/36 (the build before this one 36/36). Most misses were real: a recheck answered "unchanged" with no search at all, one answer with no citations, one that glossed over a changed date. Those became the forced first search, the `Sources checked` fallback, and the "flag small differences" rule. A few were my regexes being too strict (curly apostrophes, "recorded turn"), which I loosened. An earlier single-run comparison found reasoning `medium` slower (5 s) and no better, and Exa `lite` no faster. Batching searches into one tool call was the biggest speed-up (7.4 s to 3.2 s on a 3-item question), because the model otherwise searched one item at a time. Rechecks are the slowest path (up to 6 searches).

## Considered and rejected

Full notes and the five-advisor review that shaped this are in [`docs/decisions/`](docs/decisions/).

- **Structured claim ledger** (subject/attribute/value per fact). It rewrites my own record into a lossy schema. Pricing pages have tiers, billing periods and "starting at", so snippet diffs report changes that never happened. A false "it changed!" is worse than "I couldn't confirm." (The figure check is the narrow, safe version: exact money amounts only.)
- **Tiered router + speculative search.** Two classifiers in a row add latency and their own misroutes. Speculative search wastes calls on recall questions.
- **A background watchlist.** It spends credits while nobody is talking to it.
- **Vector memory.** The questions are anchored by date and named things; SQL windows plus FTS are exact and explainable.
- **The provider's built-in search tool.** It hides the search layer, which is what makes `since` rechecks possible.

## With another week

- Compare a vendor page then vs now directly with Exa Snapshot (`snapshotAsOf`), beyond price figures.
- Per-fact recheck timing (prices weekly, founding dates never): the start of "tell the user when something they relied on changed, and stay quiet otherwise".
- LLM-graded evals over 50+ conversations and p90 latency tracking; the current checks are regex-based.
- A stronger model for the final answer (gpt-oss-120b occasionally garbles a price cell), per-user memory scoping, export/delete.
