import { test } from "node:test";
import assert from "node:assert/strict";
import { systemClock } from "../src/clock.ts";

test("without NOW the clock is real time", () => {
  let t = 1_000;
  const c = systemClock({}, () => t);
  assert.equal(c.now().getTime(), 1_000);
  t = 5_000;
  assert.equal(c.now().getTime(), 5_000);
});

test("NOW starts the clock at a fake instant and keeps it moving", () => {
  let t = 1_000;
  const c = systemClock({ NOW: "2026-11-03T10:00:00Z" }, () => t);
  assert.equal(c.now().toISOString(), "2026-11-03T10:00:00.000Z");
  t += 60_000;
  assert.equal(c.now().toISOString(), "2026-11-03T10:01:00.000Z");
});

test("invalid NOW fails loudly", () => {
  assert.throws(() => systemClock({ NOW: "tuesday" }), /NOW="tuesday" is not an ISO date/);
});
