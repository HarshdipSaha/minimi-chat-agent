import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFigures, extractFigures, formatFigureCheck } from "../src/figures.ts";

test("extractFigures finds money amounts, normalises commas/spaces, drops duplicates", () => {
  const f = extractFigures("Neon is $0.106 per CU-hour [1]; Pro is $ 25 /month, also $25.00 and $1,200/yr; UK £9.");
  assert.deepEqual(f.map((x) => x.raw), ["$0.106", "$25", "$1200", "£9"]);
});

test("extractFigures ignores citations and plain numbers", () => {
  assert.deepEqual(extractFigures("Node 26.13 [1][2] released 28 Oct, 20 seats"), []);
});

test("checkFigures matches numerically ($25 = $25.00) and by currency symbol", () => {
  const checks = checkFigures(extractFigures("Pro $25, Team $599, Rate $0.106, UK £25"), [
    { n: 10, text: "Pro plan: $25.00 / month. Launch $0.106 per CU-hour." },
    { n: 11, text: "Team plan now $629 per month. UK pricing £25." },
  ]);
  assert.deepEqual(checks, [
    { figure: "$25", foundIn: [10] },
    { figure: "$599", foundIn: [] },
    { figure: "$0.106", foundIn: [10] },
    { figure: "£25", foundIn: [11] },
  ]);
});

test("formatFigureCheck says found / NOT found plainly", () => {
  const out = formatFigureCheck([{ figure: "$25", foundIn: [10, 12] }, { figure: "$599", foundIn: [] }], "3 Nov");
  assert.match(out, /figures from your answer on 3 Nov/);
  assert.match(out, /- \$25: found in current pages \[10\] \[12\]/);
  assert.match(out, /- \$599: NOT found in any current page result/);
});
