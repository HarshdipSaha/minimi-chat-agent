import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

test("node:sqlite has FTS5", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES ('postgres hosting pricing');");
  assert.equal(db.prepare("SELECT x FROM t WHERE t MATCH 'postgres'").all().length, 1);
});
