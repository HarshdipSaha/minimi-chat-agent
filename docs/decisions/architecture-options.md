> **Historical note.** This is the options analysis I wrote *before* the council review. It recommended an A+B hybrid; the council rejected that as a feature pile (see `council-verdict.md`). The shipped design is option C on a provenance core. Kept as the record of what was considered.

# minimi chat agent: approach options (research pass, 2026-11-11)

Status: **options for decision. Nothing is built.**

## 1. What the brief actually tests (read between the lines)

| Brief says | What it really means | Design consequence |
|---|---|---|
| "One tool: web search" | Judges will check for tool sprawl | The model sees exactly **one** tool, `web_search`. Memory, dates and caching live in code, not as extra tools. |
| "answers fast" | Time to first useful token, not total time | Stream everything. Skip search when it isn't needed. Run searches in parallel. Send snippets to the model, not whole pages. |
| "gets things right" | Fresh, sourced, dated facts | Every factual claim carries a URL and an "as of" date. Use date-filtered search. Say so when evidence is missing. |
| "remember what you asked **and when**" | Memory with timestamps, not a similarity search over old chats | An append-only, timestamped log of turns, queried by date range in SQL. |
| Example: "What did I ask you on 3 November? Is your answer still correct today?" | Recall by date, then **check the old answer again** | Store each answer as **claims plus sources plus observed_at**. "Still correct?" means re-searching those claims and diffing. |
| Example: "Last Tuesday … Postgres hosting … has pricing changed?" | Relative dates and change detection | Resolve dates **in code** (timezone-aware), not by the model. Diff old prices against new ones. |
| Example: "On Monday we shortlisted 5 CRM tools …" | Recall entities the user never names in this turn, then do one search per entity | Pull the entity list from memory, then run one search per entity in parallel. |
| "Best architecture wins … read your code" | They grade the reasoning behind the design | Small, deep modules. An eval harness with a fake clock. A DESIGN.md that names the trade-offs. |
| `npm install && npm run dev` | Judges run it on their own machines (Windows? Mac?) | Avoid native builds. Use the `node:sqlite` module that ships with Node. Ask for two keys at most. Have a fallback when keys are missing. |

**Hidden risk:** on a fresh install the agent has no history, so "what did I ask on 3 Nov?" has nothing to recall. Mitigations: (a) say so honestly ("my first record of you is X"), (b) a `NOW=` clock override plus a seed/import script so date tests can be replayed, (c) persist history across restarts.

## 2. What the research found (Nov 2026)

- **Search API latency vs. accuracy** ([openbenchmarks, Oct 2026](https://openbenchmarks.com/web-search/best-web-search-api-for-llm-apps), 300 company-news questions):

  | Provider | Accuracy | Mean latency | Price per 1k |
  |---|---|---|---|
  | Exa instant | 97.7% | 398 ms | $7 |
  | Exa fast | 99.3% | 652 ms | $7 |
  | Brave | ~94% | ~600 ms | $5 |
  | SERP (Google) | 96% | 751 ms | $3 |
  | Tavily basic | 87.7% | 1.88 s | $8 |

  Parallel turbo is the fastest (348 ms) but scored only 71% on lookups ([Parallel's own comparison](https://parallel.ai/articles/the-honest-2026-comparison-web-search-apis-for-ai-agents)). **Exa instant/fast is the best primary choice; Brave is the fallback.** Exa returns highlights (key sentences) inside the search call, so one call gives the model snippets and no fetch step is needed ([Exa highlights](https://exa.ai/blog/highlights-for-agents), [changelog](https://exa.ai/docs/changelog.md)).
- **Answer engines send snippets, not pages.** Perplexity-style pipelines extract 1–3 sentence passages, rerank them and cite inline ([ByteByteGo](https://blog.bytebytego.com/p/how-perplexity-built-an-ai-google)). Their stated problem is "identify the *current* value rather than a historical one" ([Perplexity Search API post](https://hub-prod.perplexity.ai/hub/blog/search-api-better-extraction-dynamic-benchmarks)).
- **Temporal memory: Zep/Graphiti bi-temporal model** ([paper 2501.13956](https://arxiv.org/abs/2501.13956), [two-timelines post, Oct 2026](https://www.getzep.com/blog/context-graphs-two-timelines-every-fact/)). Each fact stores `valid_at`/`invalid_at` (when it was true in the world) and `created_at`/`expired_at` (when the system learned it). `reference_time` resolves "last week". When a newer fact contradicts an old one, the old one is closed out, not deleted. This maps directly onto "what did you tell me then, and is it still true?"
- **Relative dates are a known weak spot.** Reported accuracy drops of 23–35% on relative-date queries ([tianpan, 2026](https://tianpan.co/blog/2026-04-19-ai-feature-ages-out-knowledge-cutoff-temporal-grounding)). The tool's date setting changes agent results ([2503.04188](https://arxiv.org/abs/2503.04188)). → Resolve dates deterministically and inject today's date and the user's timezone.
- **Latency tricks:** speculative actions (a fast model guesses the next tool call and runs it in parallel) gave up to 20% latency reduction ([2510.04371](https://arxiv.org/abs/2510.04371)). Latency/quality routing across equivalent search providers ([2605.14241](https://arxiv.org/abs/2605.14241)). Search agents waste turns on redundant steps ([2505.12065](https://arxiv.org/abs/2505.12065)). Accumulated retrieved context makes answers worse ([2608.10743](https://arxiv.org/abs/2608.10743)).
- **Grounding:** the main open gap is checking claim → citation → passage ([survey 2608.05179](https://arxiv.org/pdf/2608.05179)). The cheap check: verify each cited sentence against its snippet with token/entity overlap, and call an LLM only when that's ambiguous.
- **Stack:** AI SDK 7 (June 2026; `ToolLoopAgent`, `prepareStep`, typed `runtimeContext`; ESM only) ([migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)). Server-side web search tools exist from Anthropic (dynamic filtering, `web_search_20260318`) and OpenAI (`web_search` in the Responses API). They're convenient, but they hide the search layer, which is the part the judges want to see.

## 3. Four candidate architectures

### A. Claim Ledger: bi-temporal memory plus a re-verification pipeline
*The memory and correctness approach.*

```
user msg ─► TimeResolver (chrono-node + tz + NOW override)  ── code, ~1ms
         ─► MemoryRecall (SQL: turns/claims in resolved window, + FTS) ── code, ~5ms
         ─► Planner (small fast model, structured output):
               intent ∈ {chit-chat, recall-only, fresh-lookup, recheck-past, compare}
               queries[] (+ date filters), entities[]
         ─► web_search × N in parallel (Exa, highlights, published-date filter, cache)
         ─► Answerer (stronger model, streamed) — cites [n], stamps "as of <date>"
         ─► ClaimExtractor (async, after stream): {subject, attribute, value, source, observed_at}
         ─► Ledger.write  (turn log + claims; old claims closed out on contradiction)
```
- **Recheck path:** "Is that still correct?" → load the claims from that turn → one targeted search per claim → diff the values → answer "Neon Launch: $19 → $24 (changed 2026-11-07, source)".
- **Strengths:** handles all three dataset examples by construction. The bi-temporal model gives the DESIGN.md a principled story. Output is deterministic and testable.
- **Weaknesses:** more moving parts, and claim extraction can be noisy. Simple questions need a fast path, or they pay the planner's latency too.

### B. Tiered Cascade with speculative search
*The latency approach.*

```
user msg ──┬─► Router (tiny model / heuristics, <150ms) ─► tier
           └─► speculative web_search(raw msg) starts immediately (cancel if tier 0)
Tier 0  no search (chit-chat, recall-only)       → small model, TTFT ≈ 300ms
Tier 1  one instant search, reuse speculative hit → small model, ≈ 1–1.5s
Tier 2  fan-out 3–6 searches + rerank             → strong model, ≈ 3–5s
Tier 3  iterative (≤3 rounds, gap-tracking)       → strong model, streamed progress
```
- **Strengths:** the fastest perceived speed, measurable per tier, and an easy-to-show latency table.
- **Weaknesses:** a wrong route costs correctness. On its own it has no memory story, so it needs A's ledger.

### C. One strong agent loop with context engineering
*The "let the model drive" approach (Anthropic and Claude Code style).*

- One `ToolLoopAgent`, one `web_search` tool, a strong model. Memory is rendered into the system prompt as a compact dated timeline ("2026-11-03 14:02: asked about Postgres hosting → answered Neon $19, Supabase $25 …"), with older entries summarized. Today's date and timezone are injected every turn. The prompt carries rules for dates, citations and "as of".
- **Strengths:** the least code, flexible, and good conversation quality. It improves automatically as models improve.
- **Weaknesses:** slower (sequential tool calls), and date recall is only as good as the model's in-context reading. Judges may read it as a thin wrapper. It's hard to show architectural thinking in it.

### D. Watchlist with proactive snapshots
*The "it already knows what changed" approach.*

- Entities the user asks about (CRM tools, Postgres hosts) become **watched subjects**. A refresher re-searches them in the background, stores dated snapshots and precomputes diffs. "Has anything changed since Monday?" is answered from the diffs in about 1s, then confirmed live.
- **Strengths:** impressive, and the change-detection answer is very fast.
- **Weaknesses:** judges won't leave `npm run dev` running for days, so the refresher rarely fires. It adds cost and complexity, and it reads as scope creep. It works better as a lazy refresh-when-a-subject-comes-up (a feature of A) than as a separate architecture.

## 4. Scoring against the judging criteria

| | Fast | Right | Memory + when | Good to talk to | Architecture signal | Build risk (weekend) |
|---|---|---|---|---|---|---|
| A Claim Ledger | ◐ | ● | ● | ● | ● | ◐ |
| B Tiered Cascade | ● | ◐ | ○ | ◐ | ● | ● low |
| C Single loop | ○ | ◐ | ◐ | ● | ○ | ● low |
| D Watchlist | ●(diffs) | ● | ● | ◐ | ◐ | ○ high |

## 5. Recommendation: **A + B hybrid** ("Ledger core, cascade front")

- **Front:** B's router and speculative search, so trivial and recall-only turns never pay for search or the planner.
- **Core:** A's timestamped turn log, claim ledger and code-side date resolution. The recheck path is a first-class intent.
- **From D:** lazy refresh. When a remembered subject comes up again, re-search only its claims.
- **From C:** a compact dated memory timeline in the prompt so conversation stays fluid.
- **Proof:** an `evals/` folder of about 20 scripted multi-day conversations replayed with a fake clock (`NOW=2026-11-03T10:00` … `NOW=2026-11-10`). It reports latency per tier, citation-overlap pass rate, and date-recall accuracy. The DESIGN.md quotes those numbers.

**Stack sketch:** Node 24 + TypeScript, AI SDK 7 (models via provider strings, so a different model is a one-line `.env` change), Hono server with SSE streaming, a minimal chat UI (Vite), `node:sqlite` built into Node (no native build) with FTS5, `chrono-node` for dates, Exa as primary search with a Brave adapter. Keys: one LLM key and `EXA_API_KEY` (with `BRAVE_API_KEY` optional).

## 6. Open decisions for you

1. Which architecture: A+B hybrid (recommended), or another mix?
2. LLM provider and model pair (fast router/planner + strong answerer). To be verified against current docs in the build phase.
3. UI: minimal web chat (recommended, since judges "chat like a real user") or CLI-only?
4. Search provider: Exa primary + Brave fallback (recommended), or one only?
