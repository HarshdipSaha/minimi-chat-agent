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

loadDotEnv();
const config = loadConfig();
const stream = makeGroqStream({ keys: config.groqKeys, model: config.model, reasoningEffort: config.reasoningEffort });
const search = makeExaSearch({ apiKey: config.exaKey, type: config.exaType });
const only = process.argv[2];
const now = new Date();
const rows: { case: string; step: number; graded: boolean; pass: boolean; failures: string[]; ttftMs: number | null; totalMs: number; searches: number; answer: string }[] = [];

for (const c of CASES.filter((c) => !only || c.name === only)) {
  const store = new Store(":memory:");
  for (const [i, step] of c.steps(now).entries()) {
    let cited = 0;
    const onEvent = (e: AgentEvent) => { if (e.type === "sources") cited = e.sources.length; };
    let turn;
    try {
      turn = await runTurn({ text: step.message, tz: c.tz, at: step.at }, { stream, search, store, clock: { now: () => now }, config }, onEvent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({ case: c.name, step: i + 1, graded: !!step.expect, pass: false, failures: [`error: ${msg}`], ttftMs: null, totalMs: 0, searches: 0, answer: "" });
      console.log(`✖ ${c.name}#${i + 1}  ERROR ${msg}`);
      continue;
    }
    const failures = step.expect ? check(turn.answerText, turn.searches.length, cited, step.expect) : [];
    rows.push({ case: c.name, step: i + 1, graded: !!step.expect, pass: failures.length === 0, failures, ttftMs: turn.ttftMs, totalMs: turn.totalMs ?? 0, searches: turn.searches.length, answer: turn.answerText });
    console.log(`${failures.length ? "✖" : "✔"} ${c.name}#${i + 1}  first word ${turn.ttftMs}ms  total ${turn.totalMs}ms  searches ${turn.searches.length}${failures.length ? "  → " + failures.join("; ") : ""}`);
  }
}

const graded = rows.filter((r) => r.graded);
const noSearch = rows.filter((r) => r.searches === 0 && !r.failures.some((f) => f.startsWith("error")));
const withSearch = rows.filter((r) => r.searches > 0);
const summary = {
  model: config.model, reasoningEffort: config.reasoningEffort, exaType: config.exaType, ranAt: now.toISOString(),
  passed: graded.filter((r) => r.pass).length, graded: graded.length,
  p50FirstWordNoSearchMs: p50(noSearch.map((r) => r.ttftMs ?? NaN)), p50TotalNoSearchMs: p50(noSearch.map((r) => r.totalMs)),
  p50FirstWordWithSearchMs: p50(withSearch.map((r) => r.ttftMs ?? NaN)), p50TotalWithSearchMs: p50(withSearch.map((r) => r.totalMs)),
};
console.log("\n", summary);
mkdirSync("evals/results", { recursive: true });
writeFileSync(`evals/results/${now.toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify({ summary, rows }, null, 2));
