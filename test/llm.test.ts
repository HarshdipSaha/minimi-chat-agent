import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyRing, makeGroqStream } from "../src/llm.ts";

const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
const TEXT = sse(delta({ role: "assistant", content: "Hel" }), delta({ content: "lo" }), delta({}, "stop"), "[DONE]");
const TOOL = sse(
  delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"a",' } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '"objective":"b"}' } }] }),
  delta({}, "tool_calls"), "[DONE]",
);

function fakeFetch(responses: Array<() => Response>) {
  const calls: { key: string; body: any }[] = [];
  let i = 0;
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push({ key: String((init.headers as any).authorization).replace("Bearer ", ""), body: JSON.parse(String(init.body)) });
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = (body: string) => () => new Response(body, { status: 200 });
const err = (status: number, headers: Record<string, string> = {}, body = "{}") => () => new Response(body, { status, headers });
const base = { model: "openai/gpt-oss-120b", reasoningEffort: "low" };
const req = { messages: [{ role: "user" as const, content: "hi" }], allowTools: true };

test("KeyRing rotates round-robin and skips cooling keys", () => {
  let t = 0;
  const r = new KeyRing(["a", "b", "c"], () => t);
  assert.deepEqual([r.next(), r.next(), r.next(), r.next()], ["a", "b", "c", "a"]);
  r.cool("b", 1000);
  assert.deepEqual([r.next(), r.next(), r.next()], ["c", "a", "c"]);
  t = 1500;
  assert.ok(["a", "b", "c"].includes(r.next()!));
  r.cool("a", 5000); r.cool("b", 3000); r.cool("c", 9000);
  assert.equal(r.next(), null);
  assert.equal(r.waitMs(), 3000); // soonest is b, free at 4500; now is 1500
});

test("streams text deltas and sends the Groq request shape", async () => {
  const f = fakeFetch([ok(TEXT)]);
  const out: string[] = [];
  const res = await makeGroqStream({ ...base, keys: ["k1"], fetchFn: f.fn })(req, (d) => out.push(d));
  assert.deepEqual(out, ["Hel", "lo"]);
  assert.deepEqual(res, { text: "Hello", toolCalls: [], finishReason: "stop" });
  const b = f.calls[0].body;
  assert.equal(b.model, "openai/gpt-oss-120b");
  assert.equal(b.stream, true);
  assert.equal(b.tool_choice, "auto");
  assert.equal(b.reasoning_effort, "low");
  assert.equal(b.include_reasoning, false);
  assert.equal(b.tools[0].function.name, "web_search");
});

test("assembles tool calls streamed in fragments; allowTools=false sends tool_choice none", async () => {
  const f = fakeFetch([ok(TOOL)]);
  const res = await makeGroqStream({ ...base, keys: ["k1"], fetchFn: f.fn })({ ...req, allowTools: false }, () => {});
  assert.equal(res.finishReason, "tool_calls");
  assert.deepEqual(res.toolCalls, [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"a","objective":"b"}' } }]);
  assert.equal(f.calls[0].body.tool_choice, "none");
});

test("reasoning params are only sent to gpt-oss models", async () => {
  const f = fakeFetch([ok(TEXT)]);
  await makeGroqStream({ model: "qwen/qwen3.8-27b", reasoningEffort: "low", keys: ["k"], fetchFn: f.fn })(req, () => {});
  assert.equal("reasoning_effort" in f.calls[0].body, false);
});

test("successive requests use different keys (rotation)", async () => {
  const f = fakeFetch([ok(TEXT)]);
  const stream = makeGroqStream({ ...base, keys: ["k1", "k2", "k3"], fetchFn: f.fn });
  for (let i = 0; i < 4; i++) await stream(req, () => {});
  assert.deepEqual(f.calls.map((c) => c.key), ["k1", "k2", "k3", "k1"]);
});

test("a 429 moves to the next key and cools the limited one", async () => {
  const f = fakeFetch([err(429, { "retry-after": "20" }), ok(TEXT)]);
  const stream = makeGroqStream({ ...base, keys: ["k1", "k2"], fetchFn: f.fn });
  assert.equal((await stream(req, () => {})).text, "Hello");
  assert.deepEqual(f.calls.map((c) => c.key), ["k1", "k2"]);
  await stream(req, () => {});
  assert.equal(f.calls.at(-1)!.key, "k2"); // k1 is still cooling
});

test("a rejected key (401) is dropped for the hour", async () => {
  const f = fakeFetch([err(401), ok(TEXT)]);
  const stream = makeGroqStream({ ...base, keys: ["bad", "good"], fetchFn: f.fn });
  await stream(req, () => {});
  await stream(req, () => {});
  assert.deepEqual(f.calls.map((c) => c.key), ["bad", "good", "good"]);
});

test("malformed tool call (400 tool_use_failed) is retried", async () => {
  const f = fakeFetch([err(400, {}, '{"error":{"code":"tool_use_failed"}}'), ok(TEXT)]);
  const res = await makeGroqStream({ ...base, keys: ["k1", "k2"], fetchFn: f.fn })(req, () => {});
  assert.equal(res.text, "Hello");
});

test("when every key is rate limited: short waits are slept out, long ones become a clear error", async () => {
  let t = 0;
  const slept: number[] = [];
  const common = { ...base, now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; } };
  const f1 = fakeFetch([err(429, { "retry-after": "3" }), err(429, { "retry-after": "3" }), ok(TEXT)]);
  const res = await makeGroqStream({ ...common, keys: ["k1", "k2"], fetchFn: f1.fn })(req, () => {});
  assert.equal(res.text, "Hello");
  assert.deepEqual(slept, [3000]);

  const f2 = fakeFetch([err(429, { "retry-after": "60" })]);
  await assert.rejects(makeGroqStream({ ...common, keys: ["a", "b"], fetchFn: f2.fn })(req, () => {}), /All 2 Groq keys are rate limited.*60s/);
});

test("non-retryable errors surface immediately; 413 is explained", async () => {
  const f = fakeFetch([err(400, {}, '{"error":"bad request"}')]);
  await assert.rejects(makeGroqStream({ ...base, keys: ["k1", "k2"], fetchFn: f.fn })(req, () => {}), /Groq 400/);
  assert.equal(f.calls.length, 1);
  const f2 = fakeFetch([err(413)]);
  await assert.rejects(makeGroqStream({ ...base, keys: ["k1"], fetchFn: f2.fn })(req, () => {}), /too large/);
});

test("when every key is limited on the primary model, the fallback model takes over immediately", async () => {
  const calls: string[] = [];
  const fn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.model);
    return body.model === "big" ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : new Response(TEXT, { status: 200 });
  }) as unknown as typeof fetch;
  const stream = makeGroqStream({ model: "big", fallbackModel: "small", reasoningEffort: "low", keys: ["k1", "k2"], fetchFn: fn });
  assert.equal((await stream(req, () => {})).text, "Hello");
  assert.deepEqual(calls, ["big", "big", "small"]);
  await stream(req, () => {});
  assert.deepEqual(calls.slice(3), ["small"]); // primary keys are still cooling: no wasted attempts
});

test("forceTool sends tool_choice required", async () => {
  const f = fakeFetch([ok(TEXT)]);
  await makeGroqStream({ ...base, keys: ["k1"], fetchFn: f.fn })({ ...req, forceTool: true }, () => {});
  assert.equal(f.calls[0].body.tool_choice, "required");
});
