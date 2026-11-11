import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSeed } from "../scripts/seed.ts";
import { Store, type NewTurn } from "../src/store.ts";

const mk = (userText: string, at: string, seed = false): NewTurn => ({ at, tz: "Asia/Kolkata", userText, answerText: "a", searches: [], seed, ttftMs: 1, totalMs: 1, model: "m" });

test("loadSeed replaces old seed rows, keeps real turns, forces seed=true", () => {
  const s = new Store(":memory:");
  s.insert(mk("real", "2026-11-05T00:00:00.000Z"));
  loadSeed(s, [mk("s1", "2026-11-01T00:00:00.000Z")]);
  loadSeed(s, [mk("s2", "2026-11-02T00:00:00.000Z")]);
  assert.deepEqual(s.recent(10).map((t) => [t.userText, t.seed]), [["s2", true], ["real", false]]);
});
