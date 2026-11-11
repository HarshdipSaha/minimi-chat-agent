# minimi chat agent

A chat agent with one tool, web search. It answers fast, cites dated sources, and remembers what you asked and when. How and why it works: [DESIGN.md](DESIGN.md).

## Run

Requires Node 22.13+.

```bash
npm install
cp .env.example .env   # add EXA_API_KEY and GROQ_API_KEYS
npm run dev            # http://localhost:3000
```

- `EXA_API_KEY`: free credits at [dashboard.exa.ai](https://dashboard.exa.ai).
- `GROQ_API_KEYS`: one key from [console.groq.com/keys](https://console.groq.com/keys), or several separated by commas (used in rotation; helpful on the free tier's per-minute token limit).

Optional: `npm run seed` loads three real recorded exchanges (labelled **demo seed**, dated 3, 6 and 9 Nov 2026) so you can try cross-day questions straight away. If you run this long after those dates, pin the app clock with `NOW=2026-11-11T10:00:00+05:30` in `.env`.

## Try

- "What's the latest stable Node.js?" (cited, dated)
- "What was my first question?" (recall, no search)
- "What did I ask you on 3 November? Is your answer still correct today?" (after `npm run seed`: recalls the exchange and rechecks it; before: says it has no record)
- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing?" (asks which five, since it never saw the list)

## Replaying conversations across days

`POST /api/chat` takes `{ "message": "...", "tz": "Asia/Kolkata", "at": "2026-11-03T10:00:00+05:30" }` and answers as an SSE stream. `at` is optional and sets when the turn happened. `NOW=<ISO>` in `.env` starts the whole app's clock at a fake time.

## Scripts

| | |
|---|---|
| `npm test` | 86 unit tests, no network or keys needed |
| `npm run eval -- --runs=3` | 11 multi-day scenarios against the live APIs, repeated (uses API quota); results in `evals/results/` |
| `npm run typecheck` | TypeScript check |
| `npm run seed` / `seed:record` | load / re-record the demo history |

Decision records (options considered, the five-advisor review, the verdict): [`docs/decisions/`](docs/decisions/).

Layout: `src/` (agent loop, memory store, date resolution, Groq client with key rotation, Exa search, server), `public/index.html` (the whole UI), `test/`, `evals/`, `scripts/`.
