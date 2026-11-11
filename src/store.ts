import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SearchResult { url: string; title: string; publishedDate: string | null; highlights: string[] }
export interface SearchRecord {
  query: string;
  objective?: string | null; // why the model ran this search (passed to Exa unchanged)
  since: string | null;
  results: SearchResult[];
  ms: number;
  error?: string;
}

/** One exchange, stored verbatim with the evidence it was answered from. */
export interface Turn {
  id: number;
  at: string; // ISO UTC, always Date.toISOString() so string order = time order
  tz: string;
  userText: string;
  answerText: string;
  searches: SearchRecord[];
  seed: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  model: string;
}
export type NewTurn = Omit<Turn, "id">;

const STOPWORDS = new Set(("what did ask asked you your the and for has have had any since about that this with are were was " +
  "today yesterday tomorrow still correct answer answered last next week month year monday tuesday wednesday thursday friday " +
  "saturday sunday january february march april may june july august september october november december changed change " +
  "anything something shipped big tell show please can could would should does doing done from into them they their there " +
  "then than when where which who how why our ours").split(" "));

interface Row {
  id: number; at: string; tz: string; user_text: string; answer_text: string; searches: string;
  seed: number; ttft_ms: number | null; total_ms: number | null; model: string;
}

const toTurn = (r: Row): Turn => ({
  id: r.id, at: r.at, tz: r.tz, userText: r.user_text, answerText: r.answer_text,
  searches: JSON.parse(r.searches) as SearchRecord[], seed: r.seed === 1,
  ttftMs: r.ttft_ms, totalMs: r.total_ms, model: r.model,
});

/** Append-only log. No update method exists on purpose: memory is a record, not a mutable summary. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        tz TEXT NOT NULL,
        user_text TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        searches TEXT NOT NULL DEFAULT '[]',
        seed INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER,
        total_ms INTEGER,
        model TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS turns_at ON turns(at);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(user_text, answer_text, content='turns', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, user_text, answer_text) VALUES (new.id, new.user_text, new.answer_text);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, user_text, answer_text) VALUES ('delete', old.id, old.user_text, old.answer_text);
      END;
    `);
  }

  insert(t: NewTurn): number {
    const res = this.db.prepare(
      `INSERT INTO turns (at, tz, user_text, answer_text, searches, seed, ttft_ms, total_ms, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.at, t.tz, t.userText, t.answerText, JSON.stringify(t.searches), t.seed ? 1 : 0, t.ttftMs, t.totalMs, t.model);
    return Number(res.lastInsertRowid);
  }

  recent(limit: number): Turn[] {
    const rows = this.db.prepare("SELECT * FROM turns ORDER BY at DESC, id DESC LIMIT ?").all(limit) as unknown as Row[];
    return rows.map(toTurn).reverse();
  }

  between(start: Date, end: Date): Turn[] {
    const rows = this.db.prepare("SELECT * FROM turns WHERE at >= ? AND at < ? ORDER BY at, id")
      .all(start.toISOString(), end.toISOString()) as unknown as Row[];
    return rows.map(toTurn);
  }

  /** Keyword recall over past questions and answers. Date and filler words are dropped first. */
  search(text: string, limit = 5): Turn[] {
    const words = [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)))];
    if (!words.length) return [];
    const match = words.map((w) => `"${w}"*`).join(" OR ");
    const rows = this.db.prepare(
      "SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid WHERE turns_fts MATCH ? ORDER BY rank LIMIT ?",
    ).all(match, limit) as unknown as Row[];
    return rows.map(toTurn);
  }

  first(): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns ORDER BY at, id LIMIT 1").get() as unknown as Row | undefined;
    return row ? toTurn(row) : null;
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n);
  }

  /** The only delete: lets `npm run seed` be re-run without duplicating demo turns. */
  deleteSeed(): void {
    this.db.exec("DELETE FROM turns WHERE seed = 1");
  }

  close(): void {
    this.db.close();
  }
}
