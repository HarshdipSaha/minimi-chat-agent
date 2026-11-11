import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { runTurn, type AgentEvent } from "../src/agent.ts";
import type { ModelRequest, StreamFn } from "../src/llm.ts";
import type { SearchFn } from "../src/search.ts";

type Step = { text?: string; tools?: { id: string; input: unknown }[] };

function fakeModel(script: Step[]) {
  const calls: ModelRequest[] = [];
  let i = 0;
  const stream: StreamFn = async (req, onText) => {
    calls.push({ allowTools: req.allowTools, messages: structuredClone(req.messages) });
    const step = script[i++];
    if (step.text) onText(step.text);
    const toolCalls = (step.tools ?? []).map((t) => ({
      id: t.id, type: "function" as const,
      function: { name: "web_search", arguments: typeof t.input === "string" ? t.input : JSON.stringify(t.input) },
    }));
    return { text: step.text ?? "", toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop" };
  };
  return { stream, calls };
}

const results = (q: string) => Array.from({ length: 5 }, (_, k) => ({ url: `https://${q}.com/${k}`, title: `${q} ${k}`, publishedDate: "2026-11-01", highlights: [`${q} fact ${k}`] }));
function fakeSearch() {
  const calls: any[] = [];
  const fn: SearchFn = async (args) => { calls.push(args); return { query: args.query, objective: args.objective ?? null, since: args.since ?? null, ms: 5, results: results(args.query.split(" ")[0]) }; };
  return { fn, calls };
}

const deps = (stream: StreamFn, search: SearchFn, store = new Store(":memory:")) => ({
  stream, search, store, clock: { now: () => new Date("2026-11-11T09:30:00Z") }, config: { model: "test-model" },
});

test("answer without tools: streams text, persists the turn", async () => {
  const m = fakeModel([{ text: "You're welcome!" }]);
  const s = fakeSearch();
  const events: AgentEvent[] = [];
  const d = deps(m.stream, s.fn);
  const turn = await runTurn({ text: "thanks", tz: "Asia/Kolkata" }, d, (e) => events.push(e));
  assert.equal(turn.answerText, "You're welcome!");
  assert.equal(s.calls.length, 0);
  assert.equal(d.store.count(), 1);
  assert.deepEqual(events.map((e) => e.type), ["text", "sources", "done"]);
  const msgs = m.calls[0].messages;
  assert.equal(msgs[0].role, "system");
  const last = msgs.at(-1) as { content: string };
  assert.match(last.content, /^<context>[\s\S]*<\/context>\n\nthanks$/);
});

test("parallel searches pass objective, get global [n] numbering; only cited sources are emitted", async () => {
  const m = fakeModel([
    { tools: [
      { id: "a", input: { query: "neon pricing", objective: "find plan prices", since: null } },
      { id: "b", input: { query: "supabase pricing", objective: "find plan prices", since: "2026-11-03" } },
    ] },
    { text: "Neon is $19 [1]; Supabase is $25 [6]." },
  ]);
  const s = fakeSearch();
  const events: AgentEvent[] = [];
  const turn = await runTurn({ text: "neon vs supabase price", tz: "UTC" }, deps(m.stream, s.fn), (e) => events.push(e));
  assert.deepEqual(s.calls.map((c) => [c.query, c.objective, c.since]), [["neon pricing", "find plan prices", null], ["supabase pricing", "find plan prices", null]]); // since dropped: empty memory
  const toolMsgs = m.calls[1].messages.filter((x) => x.role === "tool") as { tool_call_id: string; content: string }[];
  assert.deepEqual(toolMsgs.map((x) => x.tool_call_id), ["a", "b"]);
  assert.match(toolMsgs[0].content, /^\[1\] neon 0/);
  assert.match(toolMsgs[1].content, /^\[6\] supabase 0/);
  const assistant = m.calls[1].messages.find((x) => x.role === "assistant" && "tool_calls" in x) as any;
  assert.equal(assistant.tool_calls.length, 2);
  assert.equal(turn.searches.length, 2);
  const sources = events.find((e) => e.type === "sources") as Extract<AgentEvent, { type: "sources" }>;
  assert.deepEqual(sources.sources.map((x) => x.n), [1, 6]);
  assert.equal(events.filter((e) => e.type === "status").length, 2);
});

test("invalid tool input returns an error message and does not search", async () => {
  const m = fakeModel([{ tools: [{ id: "a", input: { query: "", since: "yesterday" } }, { id: "b", input: "not json" }] }, { text: "Sorry." }]);
  const s = fakeSearch();
  await runTurn({ text: "x", tz: "UTC" }, deps(m.stream, s.fn), () => {});
  assert.equal(s.calls.length, 0);
  const tools = m.calls[1].messages.filter((x) => x.role === "tool") as { content: string }[];
  assert.equal(tools.length, 2);
  assert.match(tools[0].content, /^Error: invalid arguments/);
});

test("more than 3 parallel searches ask for fewer results each", async () => {
  const tools = Array.from({ length: 5 }, (_, k) => ({ id: `t${k}`, input: { query: `crm${k} pricing`, objective: "o" } }));
  const m = fakeModel([{ tools }, { text: "done" }]);
  const s = fakeSearch();
  await runTurn({ text: "compare 5 crms", tz: "UTC" }, deps(m.stream, s.fn), () => {});
  assert.ok(s.calls.every((c) => c.numResults === 3));
});

test("'at' override sets the turn time; history is sent with local timestamps", async () => {
  const store = new Store(":memory:");
  const m1 = fakeModel([{ text: "Canberra." }]);
  await runTurn({ text: "capital of Australia?", tz: "Asia/Kolkata", at: new Date("2026-11-03T05:00:00Z") }, deps(m1.stream, fakeSearch().fn, store), () => {});
  const m2 = fakeModel([{ text: "You asked about the capital of Australia." }]);
  await runTurn({ text: "what did I ask on 3 November?", tz: "Asia/Kolkata" }, deps(m2.stream, fakeSearch().fn, store), () => {});
  const msgs = m2.calls[0].messages as { role: string; content: string }[];
  assert.match(msgs[1].content, /^\[Tue.*3 Nov 2026.*10:30\] capital of Australia\?$/);
  assert.equal(msgs[2].content, "Canberra.");
  assert.match(msgs[3].content, /→ 2026-11-03\n#1 /);
  assert.equal(store.recent(1)[0].at, "2026-11-11T09:30:00.000Z");
});

test("last step disables tools so the loop always ends with an answer", async () => {
  const loop = Array.from({ length: 3 }, (_, k) => ({ tools: [{ id: `t${k}`, input: { query: `q${k}`, objective: "o" } }] }));
  const m = fakeModel([...loop, { text: "Here's what I found [1]." }]);
  const turn = await runTurn({ text: "x", tz: "UTC" }, deps(m.stream, fakeSearch().fn), () => {});
  assert.equal(m.calls.length, 4);
  assert.deepEqual(m.calls.map((c) => c.allowTools), [true, true, true, false]);
  assert.equal(turn.answerText, "Here's what I found [1].");
});

test("an empty model answer becomes a polite fallback, still persisted", async () => {
  const m = fakeModel([{ text: "" }]);
  const d = deps(m.stream, fakeSearch().fn);
  const turn = await runTurn({ text: "x", tz: "UTC" }, d, () => {});
  assert.match(turn.answerText, /rephras/);
  assert.equal(d.store.count(), 1);
});

import { makeCiteNormalizer } from "../src/agent.ts";

test("citation normalizer rewrites 【n†…】 to [n], even when split across chunks", () => {
  const n = makeCiteNormalizer();
  const out = ["Node is 26 ", "【1†L1", "-L2】 and ", "【2†L3】【3】.", " tail 【9"].map((d) => n.push(d)).join("") + n.flush();
  assert.equal(out, "Node is 26 [1] and [2][3]. tail 【9");
});

test("the agent stores and emits normalized citations and detects the cited source", async () => {
  const m = fakeModel([
    { tools: [{ id: "a", input: { query: "node release", objective: "o" } }] },
    { text: "Node 26 is current 【1†L1-L2】." },
  ]);
  const events: AgentEvent[] = [];
  const turn = await runTurn({ text: "latest node?", tz: "UTC" }, deps(m.stream, fakeSearch().fn), (e) => events.push(e));
  assert.equal(turn.answerText, "Node 26 is current [1].");
  const sources = events.find((e) => e.type === "sources") as Extract<AgentEvent, { type: "sources" }>;
  assert.deepEqual(sources.sources.map((x) => x.n), [1]);
});

test("normalizer swaps narrow no-break spaces and non-breaking hyphens for plain ones", () => {
  const n = makeCiteNormalizer();
  assert.equal(n.push("as of\u202fNov\u202f3 pay\u2011as\u2011you\u2011go\u00a0plan"), "as of Nov 3 pay-as-you-go plan");
});

test("a 'since' the model invented is dropped; one at or after a visible past turn is kept", async () => {
  // empty memory: any since is a guess
  const m1 = fakeModel([{ tools: [{ id: "a", input: { query: "neon pricing", objective: "o", since: "2024-01-01" } }] }, { text: "ok" }]);
  const s1 = fakeSearch();
  await runTurn({ text: "neon pricing?", tz: "UTC" }, deps(m1.stream, s1.fn), () => {});
  assert.equal(s1.calls[0].since, null);

  // memory has a turn on 3 Nov: since 2026-11-03 is a legitimate recheck window, 2024 still isn't
  const store = new Store(":memory:");
  await runTurn({ text: "neon pricing?", tz: "UTC", at: new Date("2026-11-03T05:00:00Z") }, deps(fakeModel([{ text: "$19" }]).stream, fakeSearch().fn, store), () => {});
  const m2 = fakeModel([{ tools: [
    { id: "a", input: { query: "neon news", objective: "o", since: "2026-11-03" } },
    { id: "b", input: { query: "neon old", objective: "o", since: "2024-01-01" } },
  ] }, { text: "ok" }]);
  const s2 = fakeSearch();
  await runTurn({ text: "what did I ask on 3 November? still correct?", tz: "UTC" }, deps(m2.stream, s2.fn, store), () => {});
  assert.deepEqual(s2.calls.map((c) => c.since), ["2026-11-03", null]);
});
