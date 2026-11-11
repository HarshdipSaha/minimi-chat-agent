import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftTurns, loadSeed } from "../scripts/seed.ts";
import { Store, type NewTurn } from "../src/store.ts";

const mk = (userText: string): NewTurn => ({ at: "2026-01-01T00:00:00.000Z", tz: "Asia/Kolkata", userText, answerText: "a", searches: [], seed: false, ttftMs: 1, totalMs: 1, model: "m" });

test("shiftTurns anchors each entry to now minus its daysAgo and marks it seed", () => {
  const out = shiftTurns([{ daysAgo: 8, turn: mk("a") }, { daysAgo: 2, turn: mk("b") }], new Date("2026-11-20T05:00:00Z"));
  assert.deepEqual(out.map((t) => t.at), ["2026-11-12T05:00:00.000Z", "2026-11-18T05:00:00.000Z"]);
  assert.ok(out.every((t) => t.seed));
});

test("loadSeed replaces old seed rows, keeps real turns, forces seed=true", () => {
  const s = new Store(":memory:");
  s.insert({ ...mk("real"), at: "2026-11-05T00:00:00.000Z" });
  loadSeed(s, [{ ...mk("s1"), at: "2026-11-01T00:00:00.000Z" }]);
  loadSeed(s, [{ ...mk("s2"), at: "2026-11-02T00:00:00.000Z" }]);
  assert.deepEqual(s.recent(10).map((t) => [t.userText, t.seed]), [["s2", true], ["real", false]]);
});
