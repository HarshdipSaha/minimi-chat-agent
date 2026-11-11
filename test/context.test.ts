import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type NewTurn } from "../src/store.ts";
import { buildContext } from "../src/context.ts";
import { SYSTEM_PROMPT, WEB_SEARCH_TOOL } from "../src/prompt.ts";

const NOW = new Date("2026-11-11T09:30:00Z");
const IST = "Asia/Kolkata";
const t = (at: string, userText: string, extra: Partial<NewTurn> = {}): NewTurn => ({
  at, tz: IST, userText, answerText: "Neon Launch is $19/mo [1].", searches: [], seed: false, ttftMs: 1, totalMs: 2, model: "m", ...extra,
});

test("empty memory is stated explicitly", () => {
  const { block, history } = buildContext("What did I ask you on 3 November?", NOW, new Store(":memory:"), IST);
  assert.match(block, /^<context>/);
  assert.match(block, /now: Wed.*11 Nov 2026.*15:00 \(Asia\/Kolkata\)/);
  assert.match(block, /memory_starts: no earlier conversations recorded/);
  assert.match(block, /user said "on 3 November" → 2026-11-03\n\s+no turns recorded on 2026-11-03\./);
  assert.deepEqual(history, []);
});

test("turns from a referenced day include answer, searches and dated sources", () => {
  const s = new Store(":memory:");
  s.insert(t("2026-11-10T05:00:00.000Z", "Postgres hosting prices?", {
    searches: [{ query: "neon pricing 2026", since: null, ms: 1, results: [{ url: "https://neon.tech/pricing", title: "Neon", publishedDate: "2026-10-30", highlights: [] }] }],
  }));
  const { block } = buildContext("Last Tuesday I asked about Postgres hosting. Changed?", NOW, s, IST);
  assert.match(block, /memory_starts: Tue.*10 Nov 2026/);
  assert.match(block, /→ 2026-11-10\n#1 Tue.*10 Nov 2026.*10:30/);
  assert.match(block, /user: Postgres hosting prices\?/);
  assert.match(block, /you answered: Neon Launch is \$19\/mo \[1\]\./);
  assert.match(block, /searches: "neon pricing 2026"/);
  assert.match(block, /https:\/\/neon\.tech\/pricing \(published 2026-10-30\)/);
});

test("keyword-related older turns appear when outside recent history; seed is labelled", () => {
  const s = new Store(":memory:");
  s.insert(t("2026-10-01T05:00:00.000Z", "CRM tools for a sales team", { seed: true }));
  const { block } = buildContext("which CRM tools did we look at?", NOW, s, IST, 0);
  assert.match(block, /related earlier turns \(keyword match\):\n#1 .*\[demo seed\]/);
});

test("history returns recent turns oldest-first and they are not repeated as related", () => {
  const s = new Store(":memory:");
  s.insert(t("2026-11-11T04:00:00.000Z", "tallest building in the world?"));
  const { block, history } = buildContext("what was the tallest building again?", NOW, s, IST);
  assert.equal(history.length, 1);
  assert.doesNotMatch(block, /related earlier turns/);
});

test("the tool follows Exa's guidance: every search has a query and a required objective with the recommended wording", () => {
  const p = WEB_SEARCH_TOOL.function.parameters;
  assert.deepEqual(p.required, ["searches"]);
  const item = p.properties.searches.items;
  assert.deepEqual(item.required, ["query", "objective"]);
  assert.equal(
    item.properties.objective.description,
    "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them.",
  );
  assert.match(WEB_SEARCH_TOOL.function.description, /Search the live web/);
  assert.match(SYSTEM_PROMPT, /objective/);
});

const answered = (at: string, userText: string, extra: Partial<NewTurn> = {}) =>
  t(at, userText, { searches: [{ query: "q", since: null, ms: 1, results: [] }], ...extra });

test("'last Tuesday' with nothing recorded that day falls back to the Tuesday a week earlier, and says so", () => {
  const s = new Store(":memory:");
  s.insert(answered("2026-11-03T05:00:00.000Z", "Postgres hosting prices?"));
  const { block, recheckSince } = buildContext("Last Tuesday I asked about Postgres hosting. Changed?", NOW, s, IST, 0);
  assert.match(block, /user said "Last Tuesday" → 2026-11-03/);
  assert.match(block, /note: .*most likely means 2026-11-10, but nothing was recorded that day.*2026-11-03/);
  assert.match(block, /#1 Tue.*3 Nov 2026/);
  assert.equal(recheckSince, "2026-11-03");
});

test("both Tuesdays have turns: the one that matches the topic wins, and the choice is stated", () => {
  const s = new Store(":memory:");
  s.insert(answered("2026-11-03T05:00:00.000Z", "Postgres hosting prices?"));
  s.insert(answered("2026-11-10T05:00:00.000Z", "Best pizza dough recipe?", { answerText: "Use 00 flour." }));
  const { block, recheckTurns } = buildContext("Last Tuesday I asked about Postgres hosting. Changed?", NOW, s, IST, 0);
  assert.match(block, /user said "Last Tuesday" → 2026-11-03\n/);
  assert.match(block, /Only 2026-11-03 has turns about this topic/);
  assert.doesNotMatch(block, /pizza/);
  assert.deepEqual(recheckTurns.map((x) => x.id), [1]);
});

test("both Tuesdays have turns and the topic cannot settle it: both are shown with a note", () => {
  const s = new Store(":memory:");
  s.insert(answered("2026-11-03T05:00:00.000Z", "Postgres hosting prices?"));
  s.insert(answered("2026-11-10T05:00:00.000Z", "Best pizza dough recipe?"));
  const { block } = buildContext("What did I ask you last Tuesday?", NOW, s, IST, 0);
  assert.match(block, /→ 2026-11-03 and 2026-11-10/);
  assert.match(block, /both have turns; both are shown/);
  assert.match(block, /2026-11-03:\n#1 [\s\S]*2026-11-10:\n#2 /);
});

test("an explicit date never gets a weekday fallback", () => {
  const s = new Store(":memory:");
  s.insert(answered("2026-11-03T05:00:00.000Z", "Postgres hosting prices?"));
  const { block } = buildContext("What did I ask on 10 November?", NOW, s, IST, 0);
  assert.match(block, /no turns recorded on 2026-11-10\./);
  assert.doesNotMatch(block, /note:/);
});
