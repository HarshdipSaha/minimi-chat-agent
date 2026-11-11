import { test } from "node:test";
import assert from "node:assert/strict";
import { makeExaSearch, formatForModel } from "../src/search.ts";

function fakeFetch(payload: unknown, status = 200) {
  const calls: { url: string; body: any; headers: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const EXA_OK = { results: [
  { url: "https://neon.tech/pricing", title: "Neon pricing", publishedDate: "2026-10-30T00:00:00.000Z", highlights: ["Launch $19/mo", "Scale $69/mo", "third"] },
  { url: "https://example.com/x", title: null, highlights: [] },
] };

test("sends Exa's recommended request plus objective, and since as startPublishedDate", async () => {
  const f = fakeFetch(EXA_OK);
  const search = makeExaSearch({ apiKey: "k", type: "auto", fetchFn: f.fn });
  const rec = await search({ query: "neon pricing", objective: "find current plan prices", since: "2026-11-03" });
  assert.equal(f.calls[0].url, "https://api.exa.ai/search");
  assert.equal(f.calls[0].headers["x-api-key"], "k");
  assert.deepEqual(f.calls[0].body, {
    query: "neon pricing", type: "auto", numResults: 5, contents: { highlights: true },
    objective: "find current plan prices", startPublishedDate: "2026-11-03T00:00:00.000Z",
  });
  assert.equal(rec.objective, "find current plan prices");
  assert.equal(rec.results[0].publishedDate, "2026-10-30");
  assert.equal(rec.results[0].highlights.length, 2);
  assert.equal(rec.results[1].title, "https://example.com/x");
  assert.equal(rec.results[1].publishedDate, null);
});

test("omits objective and date filter when not given", async () => {
  const f = fakeFetch(EXA_OK);
  await makeExaSearch({ apiKey: "k", type: "lite", fetchFn: f.fn })({ query: "q" });
  assert.deepEqual(f.calls[0].body, { query: "q", type: "lite", numResults: 5, contents: { highlights: true } });
});

test("caches identical searches within the TTL", async () => {
  const f = fakeFetch(EXA_OK);
  let t = 0;
  const search = makeExaSearch({ apiKey: "k", type: "auto", fetchFn: f.fn, ttlMs: 1000, now: () => t });
  await search({ query: "Neon Pricing" });
  await search({ query: "neon pricing " });
  assert.equal(f.calls.length, 1);
  t = 2000;
  await search({ query: "neon pricing" });
  assert.equal(f.calls.length, 2);
});

test("HTTP errors become an error record, not a throw", async () => {
  const f = fakeFetch({ error: "bad key" }, 401);
  const rec = await makeExaSearch({ apiKey: "k", type: "auto", fetchFn: f.fn })({ query: "x" });
  assert.match(rec.error!, /Exa 401/);
  assert.deepEqual(rec.results, []);
});

test("formatForModel numbers results from firstIndex and shows unknown dates", () => {
  const out = formatForModel({ query: "q", since: null, ms: 1, results: [
    { url: "https://a", title: "A", publishedDate: "2026-11-01", highlights: ["h1"] },
    { url: "https://b", title: "B", publishedDate: null, highlights: [] },
  ] }, 6);
  assert.match(out, /^\[6\] A\nurl: https:\/\/a\npublished: 2026-11-01\n- h1/);
  assert.match(out, /\[7\] B\nurl: https:\/\/b\npublished: unknown/);
  assert.match(formatForModel({ query: "q", since: "2026-11-03", ms: 1, results: [] }, 1), /No results for "q" published since 2026-11-03/);
  assert.match(formatForModel({ query: "q", since: null, ms: 1, results: [], error: "Exa 500" }, 1), /Search failed: Exa 500.*don't guess/);
});

test("formatForModel clips long highlights to protect the token budget", () => {
  const out = formatForModel({ query: "q", since: null, ms: 1, results: [{ url: "https://a", title: "A", publishedDate: null, highlights: ["x".repeat(2000)] }] }, 1);
  assert.ok(out.length < 600);
  assert.match(out, /…$/);
});
