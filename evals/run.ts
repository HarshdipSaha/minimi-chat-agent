import { mkdirSync, writeFileSync } from "node:fs";
import { runTurn, type AgentEvent } from "../src/agent.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { makeGroqStream } from "../src/llm.ts";
import { makeExaSearch } from "../src/search.ts";
import { Store } from "../src/store.ts";
import { CASES, type Expect } from "./cases.ts";

function check(answer: string, searches: number, cited: number, e: Expect = {}): string[] {
  const f: string[] = [];
  for (const r of e.match ?? []) if (!r.test(answer)) f.push(`missing ${r}`);
  for (const r of e.notMatch ?? []) if (r.test(answer)) f.push(`unexpected ${r}`);
  if (e.minSearches !== undefined && searches < e.minSearches) f.push(`searches ${searches} < ${e.minSearches}`);
  if (e.maxSearches !== undefined && searches > e.maxSearches) f.push(`searches ${searches} > ${e.maxSearches}`);
  if (e.cites && cited === 0) f.push("no citations");
  return f;
}
const p50 = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

// usage: npm run eval -- [case-name] [--runs=3]
const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 1);
const only = args.find((a) => !a.startsWith("--"));

loadDotEnv();
const config = loadConfig();
const stream = makeGroqStream({ keys: config.groqKeys, model: config.model, reasoningEffort: config.reasoningEffort });
const search = makeExaSearch({ apiKey: config.exaKey, type: config.exaType, ttlMs: 0 }); // no cache: every run hits the live web
const now = new Date();
interface Row { run: number; case: string; step: number; graded: boolean; pass: boolean; failures: string[]; ttftMs: number | null; totalMs: number; searches: number; answer: string }
const rows: Row[] = [];

for (let run = 1; run <= runs; run++) {
  for (const c of CASES.filter((c) => !only || c.name === only)) {
    const store = new Store(":memory:");
    for (const [i, step] of c.steps(now).entries()) {
      let cited = 0;
      const onEvent = (e: AgentEvent) => { if (e.type === "sources") cited = e.sources.length; };
      try {
        const turn = await runTurn({ text: step.message, tz: c.tz, at: step.at }, { stream, search, store, clock: { now: () => now }, config }, onEvent);
        const failures = step.expect ? check(turn.answerText, turn.searches.length, cited, step.expect) : [];
        rows.push({ run, case: c.name, step: i + 1, graded: !!step.expect, pass: failures.length === 0, failures, ttftMs: turn.ttftMs, totalMs: turn.totalMs ?? 0, searches: turn.searches.length, answer: turn.answerText });
        console.log(`${failures.length ? "✖" : "✔"} run${run} ${c.name}#${i + 1}  first word ${turn.ttftMs}ms  total ${turn.totalMs}ms  searches ${turn.searches.length}${failures.length ? "  → " + failures.join("; ") : ""}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({ run, case: c.name, step: i + 1, graded: !!step.expect, pass: false, failures: [`error: ${msg}`], ttftMs: null, totalMs: 0, searches: 0, answer: "" });
        console.log(`✖ run${run} ${c.name}#${i + 1}  ERROR ${msg}`);
      }
    }
  }
}

const graded = rows.filter((r) => r.graded);
const clean = rows.filter((r) => !r.failures.some((f) => f.startsWith("error")));
const noSearch = clean.filter((r) => r.searches === 0), withSearch = clean.filter((r) => r.searches > 0);
const perCase: Record<string, string> = {};
for (const name of [...new Set(graded.map((r) => r.case))]) {
  const g = graded.filter((r) => r.case === name);
  perCase[name] = `${g.filter((r) => r.pass).length}/${g.length}`;
}
const summary = {
  model: config.model, reasoningEffort: config.reasoningEffort, exaType: config.exaType, ranAt: now.toISOString(), runs,
  passed: graded.filter((r) => r.pass).length, graded: graded.length, perCase,
  p50FirstWordNoSearchMs: p50(noSearch.map((r) => r.ttftMs ?? NaN)), p50TotalNoSearchMs: p50(noSearch.map((r) => r.totalMs)),
  p50FirstWordWithSearchMs: p50(withSearch.map((r) => r.ttftMs ?? NaN)), p50TotalWithSearchMs: p50(withSearch.map((r) => r.totalMs)),
};
console.log("\n", summary);
mkdirSync("evals/results", { recursive: true });
writeFileSync(`evals/results/${now.toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify({ summary, rows }, null, 2));
