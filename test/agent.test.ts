import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { makeCiteNormalizer, runTurn, type AgentEvent } from "../src/agent.ts";
import type { ModelRequest, StreamFn } from "../src/llm.ts";
import type { SearchFn } from "../src/search.ts";

type One = { query: string; objective?: string; since?: string | null };
type Step = { text?: string; calls?: { id: string; searches?: One[]; raw?: string }[] };

function fakeModel(script: Step[]) {
  const calls: ModelRequest[] = [];
  let i = 0;
  const stream: StreamFn = async (req, onText) => {
    calls.push({ allowTools: req.allowTools, messages: structuredClone(req.messages) });
    const step = script[i++];
    if (step.text) onText(step.text);
    const toolCalls = (step.calls ?? []).map((c) => ({
      id: c.id, type: "function" as const,
      function: { name: "web_search", arguments: c.raw ?? JSON.stringify({ searches: (c.searches ?? []).map((s) => ({ objective: "o", ...s })) }) },
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

test("one batched call runs its searches in parallel, passes objective, numbers sources globally", async () => {
  const m = fakeModel([
    { calls: [{ id: "a", searches: [
      { query: "neon pricing", objective: "find plan prices" },
      { query: "supabase pricing", objective: "find plan prices" },
    ] }] },
    { text: "Neon is $19 [1]; Supabase is $25 [6]." },
  ]);
  const s = fakeSearch();
  const events: AgentEvent[] = [];
  const turn = await runTurn({ text: "neon vs supabase price", tz: "UTC" }, deps(m.stream, s.fn), (e) => events.push(e));
  assert.deepEqual(s.calls.map((c) => [c.query, c.objective]), [["neon pricing", "find plan prices"], ["supabase pricing", "find plan prices"]]);
  const toolMsgs = m.calls[1].messages.filter((x) => x.role === "tool") as { tool_call_id: string; content: string }[];
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].tool_call_id, "a");
  assert.match(toolMsgs[0].content, /## search: neon pricing \(current pages\)\n\[1\] neon 0/);
  assert.match(toolMsgs[0].content, /## search: supabase pricing \(current pages\)\n\[6\] supabase 0/);
  const assistant = m.calls[1].messages.find((x) => x.role === "assistant" && "tool_calls" in x) as any;
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(turn.searches.length, 2);
  const sources = events.find((e) => e.type === "sources") as Extract<AgentEvent, { type: "sources" }>;
  assert.deepEqual(sources.sources.map((x) => x.n), [1, 6]);
  assert.equal(events.filter((e) => e.type === "status").length, 2);
});

test("separate parallel tool calls in one step also work and answer each call id", async () => {
  const m = fakeModel([
    { calls: [{ id: "a", searches: [{ query: "alpha one" }] }, { id: "b", searches: [{ query: "beta two" }] }] },
    { text: "done [1] [6]" },
  ]);
  await runTurn({ text: "x", tz: "UTC" }, deps(m.stream, fakeSearch().fn), () => {});
  const toolMsgs = m.calls[1].messages.filter((x) => x.role === "tool") as { tool_call_id: string; content: string }[];
  assert.deepEqual(toolMsgs.map((x) => x.tool_call_id), ["a", "b"]);
  assert.match(toolMsgs[1].content, /\[6\] beta 0/);
});

test("invalid tool input returns an error message and does not search", async () => {
  const m = fakeModel([{ calls: [{ id: "a", raw: JSON.stringify({ searches: [{ query: "" }] }) }, { id: "b", raw: "not json" }, { id: "c", raw: JSON.stringify({ query: "old shape" }) }] }, { text: "Sorry." }]);
  const s = fakeSearch();
  await runTurn({ text: "x", tz: "UTC" }, deps(m.stream, s.fn), () => {});
  assert.equal(s.calls.length, 0);
  const tools = m.calls[1].messages.filter((x) => x.role === "tool") as { content: string }[];
  assert.equal(tools.length, 3);
  assert.match(tools[0].content, /^Error: invalid arguments/);
});

test("more than 3 searches in a step ask for fewer results each", async () => {
  const m = fakeModel([{ calls: [{ id: "t", searches: Array.from({ length: 5 }, (_, k) => ({ query: `crm${k} pricing` })) }] }, { text: "done" }]);
  const s = fakeSearch();
  await runTurn({ text: "compare 5 crms", tz: "UTC" }, deps(m.stream, s.fn), () => {});
  assert.equal(s.calls.length, 5);
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
  const loop = Array.from({ length: 3 }, (_, k) => ({ calls: [{ id: `t${k}`, searches: [{ query: `q${k}` }] }] }));
  const m = fakeModel([...loop, { text: "Here's what I found [1]." }]);
  const turn = await runTurn({ text: "x", tz: "UTC" }, deps(m.stream, fakeSearch().fn), () => {});
  assert.equal(m.calls.length, 4);
  assert.deepEqual(m.calls.map((c) => c.allowTools), [true, true, true, false]);
  assert.equal(turn.answerText, "Here's what I found [1].\n\nAs of 11 Nov 2026.");
});

test("an empty model answer becomes a polite fallback, still persisted", async () => {
  const m = fakeModel([{ text: "" }]);
  const d = deps(m.stream, fakeSearch().fn);
  const turn = await runTurn({ text: "x", tz: "UTC" }, d, () => {});
  assert.match(turn.answerText, /rephras/);
  assert.equal(d.store.count(), 1);
});

test("citation normalizer rewrites 【n†…】 to [n], even when split across chunks", () => {
  const n = makeCiteNormalizer();
  const out = ["Node is 26 ", "【1†L1", "-L2】 and ", "【2†L3】【3】.", " tail 【9"].map((d) => n.push(d)).join("") + n.flush();
  assert.equal(out, "Node is 26 [1] and [2][3]. tail 【9");
});

test("normalizer swaps narrow no-break spaces and non-breaking hyphens for plain ones", () => {
  const n = makeCiteNormalizer();
  assert.equal(n.push("as of Nov 3 pay‑as‑you‑go plan"), "as of Nov 3 pay-as-you-go plan");
});

test("the agent stores and emits normalized citations and detects the cited source", async () => {
  const m = fakeModel([
    { calls: [{ id: "a", searches: [{ query: "node release" }] }] },
    { text: "Node 26 is current 【1†L1-L2】." },
  ]);
  const events: AgentEvent[] = [];
  const turn = await runTurn({ text: "latest node?", tz: "UTC" }, deps(m.stream, fakeSearch().fn), (e) => events.push(e));
  assert.equal(turn.answerText, "Node 26 is current [1].\n\nAs of 11 Nov 2026.");
  const sources = events.find((e) => e.type === "sources") as Extract<AgentEvent, { type: "sources" }>;
  assert.deepEqual(sources.sources.map((x) => x.n), [1]);
});

test("a 'since' the model invented is dropped; one at or after a visible past turn is kept", async () => {
  // empty memory: any since is a guess
  const m1 = fakeModel([{ calls: [{ id: "a", searches: [{ query: "neon pricing", since: "2024-01-01" }] }] }, { text: "ok" }]);
  const s1 = fakeSearch();
  await runTurn({ text: "neon pricing?", tz: "UTC" }, deps(m1.stream, s1.fn), () => {});
  assert.equal(s1.calls[0].since, null);

  // memory has a turn on 3 Nov: since 2026-11-03 is a legitimate recheck window, 2024 still isn't
  const store = new Store(":memory:");
  await runTurn({ text: "neon pricing?", tz: "UTC", at: new Date("2026-11-03T05:00:00Z") }, deps(fakeModel([{ text: "$19" }]).stream, fakeSearch().fn, store), () => {});
  const m2 = fakeModel([{ calls: [{ id: "a", searches: [
    { query: "neon news", since: "2026-11-03" },
    { query: "neon old", since: "2024-01-01" },
  ] }] }, { text: "ok" }]);
  const s2 = fakeSearch();
  await runTurn({ text: "what did I ask on 3 November? still correct?", tz: "UTC" }, deps(m2.stream, s2.fn, store), () => {});
  assert.deepEqual(s2.calls.map((c) => c.since), ["2026-11-03", null]);
});

test("recheck: a since-less search gets a since-filtered twin (and vice versa), all in one tool message", async () => {
  // a past turn on 3 Nov that searched the web
  const store = new Store(":memory:");
  const seedModel = fakeModel([{ calls: [{ id: "a", searches: [{ query: "neon pricing" }] }] }, { text: "Neon is $19 [1]." }]);
  await runTurn({ text: "neon pricing?", tz: "UTC", at: new Date("2026-11-03T05:00:00Z") }, deps(seedModel.stream, fakeSearch().fn, store), () => {});

  const m = fakeModel([{ calls: [{ id: "a", searches: [{ query: "neon pricing now" }, { query: "supabase pricing now", since: "2026-11-03" }] }] }, { text: "ok" }]);
  const s = fakeSearch();
  const events: AgentEvent[] = [];
  const turn = await runTurn({ text: "What did I ask on 3 November? Still correct?", tz: "UTC" }, deps(m.stream, s.fn, store), (e) => events.push(e));
  assert.deepEqual(s.calls.map((c) => [c.query, c.since]), [
    ["neon pricing now", null], ["supabase pricing now", "2026-11-03"],
    ["neon pricing now", "2026-11-03"], ["supabase pricing now", null],
  ]);
  assert.equal(turn.searches.length, 4);
  const tools = m.calls[1].messages.filter((x) => x.role === "tool") as { content: string }[];
  assert.equal(tools.length, 1);
  assert.match(tools[0].content, /## search: neon pricing now \(current pages\)/);
  assert.match(tools[0].content, /## search: neon pricing now \(pages published since 2026-11-03\)/);
  assert.ok(events.some((e) => e.type === "status" && /Checking for changes since 2026-11-03/.test(e.text)));
});

test("no twins when the user did not point at a past turn that searched the web", async () => {
  const m = fakeModel([{ calls: [{ id: "a", searches: [{ query: "neon pricing" }] }] }, { text: "ok" }]);
  const s = fakeSearch();
  await runTurn({ text: "neon pricing?", tz: "UTC" }, deps(m.stream, s.fn), () => {});
  assert.equal(s.calls.length, 1);
});

test("answers that used search get an 'As of <date>' line added by code when the model omitted it", async () => {
  const m = fakeModel([{ calls: [{ id: "a", searches: [{ query: "node release" }] }] }, { text: "Node 26 is current [1]." }]);
  const turn = await runTurn({ text: "latest node?", tz: "Asia/Kolkata" }, deps(m.stream, fakeSearch().fn), () => {});
  assert.equal(turn.answerText, "Node 26 is current [1].\n\nAs of 11 Nov 2026.");
  const m2 = fakeModel([{ calls: [{ id: "a", searches: [{ query: "node release" }] }] }, { text: "Node 26 is current [1]. As of 11 Nov 2026." }]);
  const t2 = await runTurn({ text: "latest node?", tz: "Asia/Kolkata" }, deps(m2.stream, fakeSearch().fn), () => {});
  assert.equal(t2.answerText, "Node 26 is current [1]. As of 11 Nov 2026.");
  const m3 = fakeModel([{ text: "Hi!" }]);
  assert.equal((await runTurn({ text: "hi", tz: "UTC" }, deps(m3.stream, fakeSearch().fn), () => {})).answerText, "Hi!");
});

test("recheck adds a figure check comparing the earlier answer's figures with current pages", async () => {
  const store = new Store(":memory:");
  const seedModel = fakeModel([{ calls: [{ id: "a", searches: [{ query: "neon pricing" }] }] }, { text: "Neon Launch is $19 and Scale is $69 [1]." }]);
  await runTurn({ text: "neon pricing?", tz: "UTC", at: new Date("2026-11-03T05:00:00Z") }, deps(seedModel.stream, fakeSearch().fn, store), () => {});

  const m = fakeModel([{ calls: [{ id: "a", searches: [{ query: "neon pricing now" }] }] }, { text: "ok" }]);
  const search: SearchFn = async (args) => ({
    query: args.query, objective: null, since: args.since ?? null, ms: 1,
    results: args.since ? [] : [{ url: "https://neon.tech/pricing", title: "Neon pricing", publishedDate: null, highlights: ["Launch plan $19.00 per month"] }],
  });
  await runTurn({ text: "What did I ask on 3 November? Still correct?", tz: "UTC" }, deps(m.stream, search, store), () => {});
  const tool = (m.calls[1].messages.filter((x) => x.role === "tool") as { content: string }[])[0].content;
  assert.match(tool, /## figure check: figures from your answer on 2026-11-03/);
  assert.match(tool, /- \$19: found in current pages \[1\]/);
  assert.match(tool, /- \$69: NOT found/);
});
