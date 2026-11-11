import { test } from "node:test";
import assert from "node:assert/strict";
import { tzOffsetMinutes, localDate, formatLocal, resolveDateRefs, weekEarlier } from "../src/time.ts";

const NOW = new Date("2026-11-11T09:30:00Z"); // Wed 11 Nov 2026, 15:00 IST
const IST = "Asia/Kolkata";

test("tzOffsetMinutes", () => {
  assert.equal(tzOffsetMinutes(IST, NOW), 330);
  assert.equal(tzOffsetMinutes("UTC", NOW), 0);
  assert.equal(tzOffsetMinutes("America/New_York", NOW), -300);
});

test("localDate and formatLocal respect the timezone", () => {
  const lateUtc = new Date("2026-11-10T20:00:00Z"); // 01:30 IST on the 11th
  assert.equal(localDate(lateUtc, IST), "2026-11-11");
  assert.equal(localDate(lateUtc, "UTC"), "2026-11-10");
  assert.match(formatLocal(NOW, IST), /Wed.*11 Nov 2026.*15:00/);
});

test("absolute date gives a full local day window", () => {
  const [r] = resolveDateRefs("What did I ask you on 3 November?", NOW, IST);
  assert.equal(r.label, "2026-11-03");
  assert.equal(r.start.toISOString(), "2026-11-02T18:30:00.000Z");
  assert.equal(r.end.toISOString(), "2026-11-03T18:30:00.000Z");
});

test("relative weekdays resolve to the most recent past day", () => {
  assert.equal(resolveDateRefs("Last Tuesday I asked you about Postgres hosting", NOW, IST)[0].label, "2026-11-10");
  assert.equal(resolveDateRefs("On Monday we shortlisted 5 CRM tools", NOW, IST)[0].label, "2026-11-09");
  assert.equal(resolveDateRefs("what did I ask yesterday?", NOW, IST)[0].label, "2026-11-10");
});

test("bare weekdays later in the week still resolve to the past", () => {
  const fri = new Date("2026-11-13T09:30:00Z");
  assert.equal(resolveDateRefs("On Monday we shortlisted 5 CRM tools", fri, IST)[0].label, "2026-11-09");
  assert.equal(resolveDateRefs("what did I ask on Friday?", NOW, IST)[0].label, "2026-11-06");
});

test("'this week' is the current Monday-Sunday window", () => {
  assert.equal(resolveDateRefs("what did we discuss this week?", NOW, IST)[0].label, "week of 2026-11-09");
});

test("'last week' becomes a Monday-Sunday window", () => {
  const [r] = resolveDateRefs("what did we discuss last week?", NOW, IST);
  assert.equal(r.label, "week of 2026-11-02");
  assert.equal(r.end.getTime() - r.start.getTime(), 7 * 86_400_000);
});

test("'today' depends on the user's timezone", () => {
  const lateUtc = new Date("2026-11-10T20:00:00Z");
  assert.equal(resolveDateRefs("what did I ask today?", lateUtc, IST)[0].label, "2026-11-11");
  assert.equal(resolveDateRefs("what did I ask today?", lateUtc, "UTC")[0].label, "2026-11-10");
});

test("no date words gives no refs; future dates are dropped", () => {
  assert.deepEqual(resolveDateRefs("thanks!", NOW, IST), []);
  assert.deepEqual(resolveDateRefs("remind me tomorrow", NOW, IST), []);
});

test("a bare weekday is flagged, explicit dates and weeks are not", () => {
  assert.equal(resolveDateRefs("Last Tuesday I asked", NOW, IST)[0].weekday, true);
  assert.equal(resolveDateRefs("on 3 November", NOW, IST)[0].weekday, false);
  assert.equal(resolveDateRefs("what happened last week", NOW, IST)[0].weekday, false);
});

test("weekEarlier gives the same weekday one week before as its own whole-day window", () => {
  const ref = resolveDateRefs("Last Tuesday I asked", NOW, IST)[0];
  const older = weekEarlier(ref, IST);
  assert.equal(older.label, "2026-11-03");
  assert.equal(older.start.toISOString(), "2026-11-02T18:30:00.000Z");
  assert.equal(older.end.toISOString(), "2026-11-03T18:30:00.000Z");
});

test("day windows are exact on a 25-hour DST day (New York, 1 Nov 2026) and a 23-hour one (8 Mar 2026)", () => {
  const ny = "America/New_York";
  const fall = resolveDateRefs("what did I ask on 1 November", new Date("2026-11-11T15:00:00Z"), ny)[0];
  assert.equal(fall.start.toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(fall.end.toISOString(), "2026-11-02T05:00:00.000Z");
  const spring = resolveDateRefs("what did I ask on 8 March", new Date("2026-03-20T15:00:00Z"), ny)[0];
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 3_600_000);
});
