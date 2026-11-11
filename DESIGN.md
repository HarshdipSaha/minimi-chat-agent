# Design

A chat agent with one tool, web search. It answers fast, cites dated sources, and remembers what you asked and when, including "is that still correct?".

## How it works

One Node process serves a chat page and streams each turn over SSE. A turn is:

1. **Dates are resolved in code.** chrono-node, in the browser's timezone, turns "last Tuesday" or "3 November" into an exact day window. Models are unreliable at relative dates; code isn't.
2. **Memory is pulled, not asked for.** Every turn is stored in SQLite (`node:sqlite`, append-only) with its question, its verbatim answer, every query, and every result's URL and **published date**. The turn builds a `<context>` block from that log: the current time, when memory begins, the turns from any date the user mentioned (or "no turns recorded on that date"), and keyword matches from older turns (FTS5).
3. **One model, one tool.** `openai/gpt-oss-120b` on Groq decides whether to search. `web_search` takes a batch of 1-5 searches that run in parallel against Exa (each with a query and an `objective`, as Exa recommends for search-as-a-tool). Results come back numbered `[n]` with dates; at most three rounds, then the model must answer.
4. **Rechecks are deterministic.** If the user points at a past turn that searched the web ("what did I ask on 3 November, is it still correct?"), the app runs every search both ways: current pages, and pages published *since that date*. The model compares the old answer with both and says "changed" only when a fresh source states a different value. The code, not the model, guarantees both searches happen, and drops any `since` filter the model invents.
5. Code adds `As of <date>.` to any answer that used search, normalises the model's citation style to `[n]`, and stores the turn.

## Why this shape

- **The hard part is provenance, not search.** "What did I ask on 3 November, and is it still right?" is a lookup if the answer is stored with its evidence and timestamp. Search latency is a commodity.
- **Memory is infrastructure, not a tool.** The model sees exactly one tool. Recall is deterministic code I can test (65 unit tests, no network).
- **Honest beats confident.** On a fresh install there is no 3 November. The agent says so and says when its memory starts. `npm run seed` loads three real recorded exchanges, labelled "demo seed", to try cross-day behaviour.
- **Fast where it shows.** Streaming, parallel searches, a small reasoning budget, a 10-minute search cache, and no extra router/planner calls. Five Groq keys rotate round-robin; a 429 moves to the next key, so the free tier's 8k tokens/min per key is not a wall.

## Measured

`npm run eval` replays 8 multi-day conversations (a fake `at` timestamp per turn) against the live APIs: empty memory, within-session recall, cross-day recheck, a missing referent ("the 5 CRM tools" I never saw), a 5-way CRM fan-out, chit-chat, a fresh fact, a timezone edge.

| Config | Checks | First word (no search / search) | Full answer (search) |
|---|---|---|---|
| reasoning low, Exa auto (default) | 10/10 | 0.55 s / 2.2 s | 2.6 s |
| reasoning low, Exa lite | 10/10 | 0.69 s / 2.7 s | 2.9 s |
| reasoning medium, Exa auto | 9/10 | 0.75 s / 5.1 s | 5.4 s |

Medium reasoning was slower and not better; Exa `lite` gave no gain here. One search round-trip per turn was the biggest win: the model would otherwise issue single searches one after another (7.4 s for a 3-item question before batching, 3.2 s after).

## Considered and rejected

- **Structured claim ledger** (subject/attribute/value per fact). It rewrites my own record into a lossy schema. Pricing pages have tiers, billing periods and "starting at", so snippet diffs report changes that never happened. A false "it changed!" is worse than "I couldn't confirm."
- **Tiered router + speculative search.** Two classifiers in a row add latency and their own misroutes. Speculative search wastes calls on recall questions.
- **A background watchlist.** It spends credits while nobody is talking to it.
- **Vector memory.** The questions are anchored by date and named things; SQL windows plus FTS are exact and explainable.
- **The provider's built-in search tool.** It hides the search layer, which is what makes `since` rechecks possible.

## With another week

- Typed diffs for fields that can be compared reliably (prices with explicit units), on top of the log.
- Per-fact recheck timing (prices weekly, founding dates never): the start of "tell the user when something they relied on changed, and stay quiet otherwise".
- Exa Snapshot (`snapshotAsOf`) to compare a vendor's page then vs now directly.
- LLM-graded evals over 50+ conversations, p90 latency tracking, per-user memory scoping and export/delete.
