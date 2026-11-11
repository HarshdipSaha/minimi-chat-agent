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

test("the tool follows Exa's guidance: query + required objective with the recommended wording", () => {
  const p = WEB_SEARCH_TOOL.function.parameters;
  assert.deepEqual(p.required, ["query", "objective"]);
  assert.equal(
    p.properties.objective.description,
    "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them.",
  );
  assert.match(WEB_SEARCH_TOOL.function.description, /Search the live web/);
  assert.match(SYSTEM_PROMPT, /objective/);
});
