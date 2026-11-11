import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { createApp } from "../src/server.ts";
import type { StreamFn } from "../src/llm.ts";

const stream: StreamFn = async (_req, onText) => {
  onText("Hi there.");
  return { text: "Hi there.", toolCalls: [], finishReason: "stop" };
};
const mkApp = (s: StreamFn = stream) => {
  const store = new Store(":memory:");
  const app = createApp({
    stream: s, store, search: async () => ({ query: "", since: null, results: [], ms: 0 }),
    clock: { now: () => new Date("2026-11-11T09:30:00Z") }, config: { model: "m" },
  }, "Asia/Kolkata");
  return { app, store };
};
const post = (app: ReturnType<typeof mkApp>["app"], body: unknown) =>
  app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET / serves the UI", async () => {
  const res = await mkApp().app.request("/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /minimi/);
});

test("POST /api/chat validates input", async () => {
  const { app } = mkApp();
  assert.equal((await post(app, {})).status, 400);
  assert.equal((await post(app, { message: "hi", at: "nope" })).status, 400);
  assert.equal((await post(app, { message: "x".repeat(4001) })).status, 400);
});

test("POST /api/chat streams SSE and persists; 'at' and tz are honoured", async () => {
  const { app, store } = mkApp();
  const res = await post(app, { message: "hello", tz: "Not/AZone", at: "2026-11-03T05:00:00Z" });
  assert.equal(res.headers.get("content-type")?.startsWith("text/event-stream"), true);
  const body = await res.text();
  assert.match(body, /event: text\ndata: \{"type":"text","text":"Hi there\."\}/);
  assert.match(body, /event: done/);
  const [t] = store.recent(1);
  assert.equal(t.at, "2026-11-03T05:00:00.000Z");
  assert.equal(t.tz, "Asia/Kolkata"); // invalid tz falls back to the default
});

test("a failing model call becomes an SSE error event, not a crash", async () => {
  const { app, store } = mkApp(async () => { throw new Error("All 5 Groq keys are rate limited right now."); });
  const body = await (await post(app, { message: "hello" })).text();
  assert.match(body, /event: error\ndata: .*rate limited/);
  assert.equal(store.count(), 0);
});

test("GET /api/turns lists history and tolerates a bad limit", async () => {
  const { app } = mkApp();
  await post(app, { message: "hello" });
  const turns = await (await app.request("/api/turns?limit=abc")).json() as any[];
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userText, "hello");
});
