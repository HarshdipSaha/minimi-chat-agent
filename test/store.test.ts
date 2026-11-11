import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type NewTurn } from "../src/store.ts";

function turn(at: string, userText: string, answerText = "answer", extra: Partial<NewTurn> = {}): NewTurn {
  return { at, tz: "Asia/Kolkata", userText, answerText, searches: [], seed: false, ttftMs: 100, totalMs: 900, model: "m", ...extra };
}

test("insert and read back with searches round-tripped", () => {
  const s = new Store(":memory:");
  const id = s.insert(turn("2026-11-03T05:00:00.000Z", "Postgres hosting prices?", "Neon $19 [1]", {
    searches: [{ query: "neon pricing", objective: "find the plan prices", since: null, ms: 400, results: [{ url: "https://neon.tech/pricing", title: "Neon", publishedDate: "2026-10-30", highlights: ["Launch $19/mo"] }] }],
  }));
  const [t] = s.recent(10);
  assert.equal(t.id, id);
  assert.equal(t.searches[0].results[0].publishedDate, "2026-10-30");
  assert.equal(t.searches[0].objective, "find the plan prices");
  assert.equal(t.seed, false);
});

test("recent returns the last N in chronological order", () => {
  const s = new Store(":memory:");
  s.insert(turn("2026-11-01T00:00:00.000Z", "a"));
  s.insert(turn("2026-11-02T00:00:00.000Z", "b"));
  s.insert(turn("2026-11-03T00:00:00.000Z", "c"));
  assert.deepEqual(s.recent(2).map((t) => t.userText), ["b", "c"]);
});

test("between is half-open [start, end)", () => {
  const s = new Store(":memory:");
  s.insert(turn("2026-11-02T18:29:59.000Z", "before"));
  s.insert(turn("2026-11-02T18:30:00.000Z", "start"));
  s.insert(turn("2026-11-03T18:29:59.000Z", "inside"));
  s.insert(turn("2026-11-03T18:30:00.000Z", "end"));
  const got = s.between(new Date("2026-11-02T18:30:00Z"), new Date("2026-11-03T18:30:00Z"));
  assert.deepEqual(got.map((t) => t.userText), ["start", "inside"]);
});

test("search matches topic words and ignores date/filler words", () => {
  const s = new Store(":memory:");
  s.insert(turn("2026-11-03T05:00:00.000Z", "Postgres hosting prices for a startup?"));
  s.insert(turn("2026-11-04T05:00:00.000Z", "best pizza in Bengaluru"));
  const hits = s.search("Last Tuesday I asked you about Postgres hosting. Has any pricing changed?");
  assert.deepEqual(hits.map((t) => t.userText), ["Postgres hosting prices for a startup?"]);
  assert.deepEqual(s.search("what did I ask on Monday?"), []);
  assert.deepEqual(s.search("\"); DROP TABLE turns; --"), []);
});

test("first, count, and deleteSeed (only seed rows)", () => {
  const s = new Store(":memory:");
  assert.equal(s.first(), null);
  s.insert(turn("2026-11-01T00:00:00.000Z", "seeded", "x", { seed: true }));
  s.insert(turn("2026-11-02T00:00:00.000Z", "real"));
  assert.equal(s.first()!.userText, "seeded");
  assert.equal(s.count(), 2);
  s.deleteSeed();
  assert.equal(s.count(), 1);
  assert.equal(s.search("seeded").length, 0);
});
