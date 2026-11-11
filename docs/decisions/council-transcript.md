# Council transcript

Five advisors with different thinking styles answered the same framed question independently, then five reviewers critiqued the anonymised answers, then a chairman wrote the verdict (`council-verdict.md`). The reviewers were unanimous that the Expansionist's answer (more scope) had the biggest blind spot.

## The question

 (council, 2026-11-11)

**Decision:** Which architecture for a hiring-challenge submission will minimi's team like MOST?

**The company (from the job post):** minimi is "AI that lives on your Mac and pings you at the right moment." Small team, Bengaluru, on-site SWE intern role. The work: "agents that read your day and catch the promises you'd otherwise forget"; "nudges that arrive at exactly the right moment, and stay quiet the rest of the time"; backend + frontend end to end, code ships to real users. They want people who "have built things you're proud of", "care how a system is designed", enjoy backend+frontend.

**The challenge:** "Build the best chat agent you can with one tool, web search. It should answer fast, get things right, and remember what you asked and when." JS/TS on Node, `npm install` then `npm run dev`, `.env.example` lists keys, any framework/model, AI coding tools OK but candidate must explain every decision. Deliver public GitHub repo + one-page DESIGN.md (how it works, why, what considered & rejected, what with another week). "The best architecture wins. Not the first submission, not the prettiest screen, not the most features." They will chat with it like a real user, read code, read DESIGN.md. Rolling review, no deadline but earlier gets reviewed first; "most people need a weekend; more hours won't win, better thinking will."

**Sample test-dataset prompts:**
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

**Research facts:** Exa instant search ~398ms/97.7% acc, Exa fast 652ms/99.3%, Brave ~600ms/94% (openbenchmarks Oct 2026). Zep/Graphiti bi-temporal memory (valid time vs learned time; contradicted facts closed out, not deleted). Relative-date queries degrade LLM accuracy 23-35%. Speculative tool execution gives ~20% latency cut. AI SDK 7 available. Candidate is a solo student builder with a weekend-ish budget.

**Candidate architectures:**
- **A. Claim Ledger** — deterministic TimeResolver (chrono-node, tz, NOW override) → SQL memory recall over a timestamped turn log → small-model planner (intent: chit-chat / recall-only / fresh-lookup / recheck-past / compare) → parallel web_search → streamed cited answer stamped "as of <date>" → async claim extraction {subject, attribute, value, source, observed_at} into a bi-temporal ledger. "Still correct?" = re-search stored claims and diff.
- **B. Tiered Cascade + speculative search** — router (<150ms) picks tier 0 (no search) / 1 (one instant search) / 2 (fan-out + strong model) / 3 (iterative); a speculative search on the raw message starts in parallel and is reused or cancelled.
- **C. Single strong agent loop** — one ToolLoopAgent, one tool, memory rendered into the prompt as a dated timeline; minimal scaffolding.
- **D. Watchlist** — subjects user asked about are re-searched in background; dated snapshots + precomputed diffs make "what changed since Monday" instant.
- **Current recommendation: A+B hybrid** (cascade front, ledger core, lazy re-check from D, compact timeline from C) + an evals/ folder replaying ~20 multi-day conversations with a fake clock.

**Stakes:** It's a hiring signal for an internship at a company whose product is literally temporal memory + right-moment proactivity. Being judged on design thinking. Picking an architecture that's over-engineered, under-engineered, or misses what this specific team cares about costs the job.

## Advisor responses (reviewers saw them as anonymous letters A-E)

### Response A: The Expansionist
The Claim Ledger is more than a memory layer. It is minimi's product in miniature, and the current plan treats it as plumbing. "Catch the promises you'd otherwise forget" and "nudges that arrive at exactly the right moment, and stay quiet the rest of the time" are their whole job description. The challenge's "remember what you asked and when" plus "is your answer still correct?" is the same loop in a smaller form. Build it so they can see it.
Three upgrades:
1. **Treat every answer as a promise the agent made.** "Neon is $19, as of Nov 3" is a commitment with a shelf life. Give each claim an attribute-level volatility class: pricing and release news change quickly, founding dates and headquarters don't. That class sets a recheck TTL (how long before the claim needs checking again). This turns D's watchlist into a principled timing rule: "when does this fact deserve attention again?" That question is minimi's core problem, and you would have answered it in a chat toy.
2. **Ship one in-session nudge.** When a user comes back, or mentions a remembered subject, and a cheap lazy recheck finds a stale claim, open with one line: "Since you asked on Tuesday, Supabase raised Pro to $30." Stay silent otherwise, and make the silence threshold explicit in code. No other candidate will show proactivity with restraint, and that restraint is literally what they sell.
3. **Make the fake clock the demo, not just the evals.** On first run, offer `npm run dev -- --seed=week` to preload a backdated week. Judges then ask "what did I ask on 3 November?" in minute one and get a real diff. The cold-start weakness becomes the strongest moment of the demo.
Also extract the user's own stated facts ("we're a 20-person sales team", "we shortlisted these 5") into the ledger with valid time, not just web claims. That covers the promises users make, and it's minimi's roadmap.
DESIGN.md's "another week" section should end with: "This ledger is the substrate for a Mac agent that pings at the right moment." You're not applying with a chatbot. You're showing a first draft of their backend.

### Response B: The Contrarian
The A+B hybrid is the trap. The brief says "not the most features," and stapling four architectures together is a feature pile dressed up as design. A one-page DESIGN.md can't justify a router, a planner, speculative search, a claim extractor, a bi-temporal ledger and a lazy watchlist. You also have to "explain every decision" in an interview. Each extra component is one more question where you might sound like you just accepted what the AI tool generated.
Specific failure points:
1. **Claim diffing will produce false "it changed!" answers.** Pulling {subject, attribute, value} out of CRM pricing pages is lossy: tiers, annual vs monthly billing, currencies, "starting at" prices. Two searches a week apart return different snippets even when nothing changed, so the diff will report changes that never happened. Confidently telling the user something changed when it didn't fails "get things right" worse than saying "I'm not sure."
2. **The reviewers can't travel in time.** They'll chat for 20 minutes, not across a week. "What did I ask you on 3 November?" most likely hits an empty memory. The answer that wins is an honest "I have no record of that," not a hallucinated one. Same for "we shortlisted 5 CRMs on Monday": the agent never saw that list, so it has to ask which five. Neither the ledger nor the watchlist helps there. What you actually need is a visible way to show multi-day behaviour, like a fake clock or seeded history the reviewers can trigger. Nobody has designed for that yet.
3. **The router and the planner are two classifiers in a row.** Each one adds latency and its own misroutes. A misroute gives a wrong answer quickly.
4. **Speculative search on the raw message is wasted work** for recall questions and for pronoun-heavy follow-ups. The 20% latency figure comes from someone else's workload, not yours.
5. **The background watchlist quietly spends the reviewer's API credits.** That's the opposite of a product built to "stay quiet the rest of the time."
6. **Native SQLite builds can break `npm run dev`.** Use `node:sqlite` or a JSON file.
This team ships restraint. My recommendation: start from C, then add only a deterministic TimeResolver and a persistent, timestamped log of turns and answers, each answer stamped with its as-of date and sources. Handle "still correct?" by re-running the stored question and letting the model compare the two cited answers side by side. Spend the remaining time on evals and on handling missing memory honestly.

### Response C: The Executor
The A+B hybrid is the right final shape and the wrong place to start. If you build it as specced, Sunday night you'll have five half-wired stages and no agent you can chat with. Build in this order and keep every stage shippable.
**Saturday AM:** Get C running end to end. One Hono server, SSE, a bare chat page served by the same process (no separate Vite dev server, because running two processes through `npm run dev` on a Windows judge box is asking for trouble). One `web_search` tool on Exa, today's date and timezone injected. Make sure `npm install && npm run dev` passes on a clean clone before you write anything else.
**Saturday PM:** Add A's deterministic core: an append-only turn log in `node:sqlite`, chrono-node with a `NOW=` override, and SQL recall by date window fed into the prompt. Verify FTS5 actually works in `node:sqlite` right away, and set `"engines": {"node": ">=22.13"}` plus a startup version check, because a judge on Node 20 crashes on the first line.
**Sunday AM:** Claim extraction after the stream finishes, and the recheck intent (load the claims, re-search each one in parallel, diff). This is the piece that matches minimi's product. Spend the most care here.
**Sunday PM:** 6–8 fake-clock eval conversations (not 20), then DESIGN.md.
**Cut:**
- **Speculative search.** Cancellation races and wasted Exa calls for about 20% latency. That goes under "another week".
- **Model-based router.** Use regex/heuristics for tier 0 (chit-chat and recall-only) and let the planner handle the rest.
- **Watchlist refresher.** The judges' process won't stay up long enough for it to fire.
**Non-negotiable:** `npm run seed`. On a fresh install, "What did I ask you on 3 November?" finds nothing, and the judge's first impression is that the agent is broken. Ship a seeded multi-day history and print a one-line hint at startup. Fail loudly with a clear message when a key is missing.
The strongest architecture signal is a small, deterministic, tested core you can explain line by line, not the number of boxes in the diagram.

### Response D: The Outsider
Picture the reviewer: they clone the repo, run `npm install && npm run dev`, and type "What did I ask you on 3 November?" **The agent has no memory at all.** It's a fresh install. Every sample prompt assumes days of history the reviewer's copy will never have. The framing skips this, and it may be the biggest risk here. If the agent answers that first question with a confident made-up recap, nothing else in the design gets read. The first thing to get right is the empty-memory case: "I have no record of you asking anything on 3 November." After that, give the reviewer a one-command way to see the memory working across days. That means a seeded demo or `npm run demo` driven by the fake clock. The evals/fake-clock idea is the strongest thing in the plan, and it should be how the reviewer sees the product, not something tucked in a folder.
Second: the "A+B hybrid" is really A+B+C+D. It has a router, a planner, a cascade, speculative search, a bi-temporal ledger, a watchlist and a timeline. That won't fit in a one-page DESIGN.md. The prompt says "not the most features," and a cold reader will count the moving parts and call it over-engineered. Words like "bi-temporal ledger" and "TimeResolver" mean nothing to someone coming in cold until they see them change an answer. A reviewer won't notice speculative search or tier routing. They only notice whether answers come back fast.
What they *will* notice:
- Answers that carry a date and a source.
- An honest "I don't know / you never asked."
- "Still correct?" showing an actual diff: then X, now Y, with a source.
Build A's core and make those three things solid. Cover B in one sentence: one fast search by default, fan out only for comparisons. Put D in "with another week," where it's the obvious next step for a company that sends nudges.
Also count the API keys. Each one in `.env.example` beyond a model key and a search key is a place where the reviewer's setup can fail before they ever chat with it.

### Response E: The First Principles Thinker
"Which architecture will minimi like MOST?" is the wrong question. Picking a design to please the reviewers produces exactly what they said won't win: more features. Ask a different question: what is the smallest data model that turns "What did I ask you on 3 November, and is it still correct?" into a lookup instead of a guess?
Strip it down and the challenge is a provenance problem, not a search problem. All three sample prompts have the same shape: "a past moment, what you told me then, has the world moved since?" To answer that, the agent needs three things stored together: what the user asked, what the agent answered, and the evidence and timestamp it answered from. Search speed and model routing are commodity parts. Every candidate will reach about 600ms with Exa. Nobody will separate on latency.
So:
- **Keep:** a deterministic TimeResolver with an injectable NOW and the user's timezone. Relative dates are where LLMs fail, and "last Tuesday" has to resolve the same way every time.
- **Keep:** an append-only turn log that stores each answer verbatim with its cited URLs, the search queries used, and `answered_at`. "Still correct?" then means: replay those queries today and compare the new results against the stored answer.
- **Cut:** async claim extraction into a bi-temporal ledger. It's an LLM rewriting your own record into a lossy schema, so it adds a way to fail exactly where you need fidelity. The real unit of truth is the answer plus its evidence. Graphiti-style ledgers solve multi-source fact merging, which this task doesn't have.
- **Cut:** the four-tier cascade. One flag for "needs fresh search vs. answerable from memory" covers about 90% of it. Spending ~20% of build effort on a ~20% latency cut is a bad trade.
- **Elevate:** the fake-clock evals. That is the design argument. It proves the temporal claims instead of asserting them, and it's the thing a team building "right moment" software will respect most.
Watchlist (D) is minimi's actual product shape, but in a chat challenge it burns API calls on nothing. Put it in "with another week" and tie it to their nudges.
What they're really testing: do you know which problem you're solving?

## Peer reviews (anonymized letters: A=Expansionist, B=Contrarian, C=Executor, D=Outsider, E=First Principles)

## Review 1 (correctness/speed lens)
1. Strongest: B — only response naming concrete failure modes that produce wrong answers: claim-diffing pricing pages yields phantom "it changed!" (tiers, monthly/annual, "starting at"); reviewers can't time-travel so empty memory must say "no record"; native SQLite builds break npm run dev. Its prescription (C + TimeResolver + timestamped answer log with as-of dates) is defensible line by line. D and E converge but B argues it most concretely.
2. Biggest blind spot: A — piles volatility TTLs and proactive nudges onto the ledger without addressing false change detection. A confidently wrong unsolicited nudge ("Supabase raised Pro to $30") is the worst possible hallucination for this product. Also ignores latency cost of lazy rechecks on return.
3. All missed: (a) date-filtered search — "changed since Monday" is better answered by searching news/pages published after that date (Exa startPublishedDate) than by diffing snippets; cuts false diffs. (b) Recheck fan-out latency — 5 CRMs × N searches + strong-model compare breaks "answers fast"; no TTFT budget or streaming partial results. (c) Seeded history is fabricated — diffing against fake past answers demonstrates nothing; seeds need real archived search results. (d) Parametric staleness — no-search answers can leak training-data facts; no rule against it.

## Review 2 (senior startup engineer lens)
1. Strongest: C — reads like someone who has shipped. Sequences work so every stage is runnable, preserves the deterministic core, cuts speculative search/model router/watchlist with concrete reasons, and catches real reviewer-killers: dual dev processes on Windows, node:sqlite needing Node ≥22.13, FTS5 verification, missing-key failures, empty memory on fresh install. Weakness: keeps claim extraction, which B and E correctly flag as a lossy schema generating false "it changed" diffs.
2. Biggest blind spot: A — scope expansion (volatility TTLs, in-session nudge, user-fact extraction, "first draft of their backend" pitch) while ignoring B's point that diffs from noisy snippets will be wrong. A wrong proactive nudge is worse than silence — minimi sells restraint. Silent on latency, cost, and npm run dev risk.
3. All missed: (a) Source-date provenance — "changed since Monday" depends on when the evidence was published/updated, not when we searched. Stale SEO pages and cached pricing make diffs meaningless; store and show source dates, and only claim change when the newer source is dated later. (b) Git history and unit tests — one giant AI-generated commit undermines "explain every decision." (c) Measured latency — nobody proposed instrumenting p50 TTFT to back "answers fast."

## Review 3 (conversational quality lens)
1. Strongest: D — only one written from the judge's chair. Names the first-impression killer (fresh install, confident fabricated recap) and the three things a chatting user notices: date+source on answers, honest "you never asked," real then-vs-now diff. Pair with C's build order (Node check, single process, npm run seed).
2. Biggest blind spot: A — more machinery, ignores B's phantom-diff warning. An unprompted wrong nudge is the worst thing a judge can hit in chat; breaks "get things right" and "stay quiet" in one sentence. Silent on latency.
3. All missed: (a) Within-session recall — judges will mostly test "what was my first question?" / "earlier you said…", not real past days. Pronouns, corrections, follow-ups across turns matter more than seeded weeks. (b) Clarifying questions — only B touches "which five CRMs?" (c) Answer shape — lead with the answer, brevity, fast streamed first token. (d) Judge's timezone/clock — IST vs server time decides "last Tuesday." (e) Seeded history must be visibly labeled or it reads as faked memory.

## Review 4 (interview / AI-tool-saturated field lens)
1. Strongest: B — only one treating the follow-up interview as part of the test: every extra component is another place to sound like you accepted what the AI generated. Most concrete correctness risk (phantom diffs) plus a practical fix (node:sqlite). C second: best build order, seed as non-negotiable.
2. Biggest blind spot: A — adds parts without asking whether the candidate can defend each. Assumes nobody else pitches "this is your product" — many AI-assisted candidates will paste the job post into their prompt and land on exactly that framing. "A first draft of their backend" may read presumptuous to a small team.
3. All missed: (a) Proof of human judgment — every AI tool converges on the same Exa+AI SDK+SQLite+chrono stack. Differentiation is evidence of thinking: measured p50 latency and eval pass rates, data-backed rejected options, commit history showing iteration not one generated dump. (b) Live modification — interviewer will likely ask for a change on the spot; core must be small enough to change live. (c) Dataset ingestion — nobody asked whether reviewers replay the test set via script; that needs a scriptable endpoint accepting per-message timestamps, and seeded dates anchored relative to NOW, not hardcoded.

## Review 5 (general)
1. Strongest: C — only one that converts the debate into a runnable-at-every-stage weekend plan. Right engineering details: single process, node:sqlite FTS5 check, engines ≥22.13 guard, npm run seed, loud missing-key failure. Cuts well argued; keeps the recheck loop that mirrors minimi's product. Weakness: keeps claim diffing without answering B/E's false-change risk.
2. Biggest blind spot: A — scope on top of an already crowded hybrid, against "not the most features" and a weekend budget. Never confronts lossy claim extraction; an unprompted nudge built on a false diff is the worst "get things right" failure and violates the restraint it claims to showcase.
3. All missed: (a) Seed data must be real — invented prices rechecked against live search produce fake diffs; record seeds from real runs or label them. (b) Memory scope — session vs user scoping, what survives restart, whose timezone (reviewer's IST vs server). (c) Model choice dominates "fast" — TTFT is mostly the LLM, not search; nobody named a model.
