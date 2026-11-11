import type { Store, Turn } from "./store.ts";
import { formatLocal, localDate, resolveDateRefs } from "./time.ts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function summarizeTurn(t: Turn, tz: string): string {
  const queries = t.searches.map((s) => `"${s.query}"${s.since ? ` (since ${s.since})` : ""}`).join(", ") || "none";
  const sources = t.searches.flatMap((s) => s.results).slice(0, 4)
    .map((r) => `${r.url} (published ${r.publishedDate ?? "unknown"})`).join("; ") || "none";
  return [
    `#${t.id} ${formatLocal(new Date(t.at), tz)}${t.seed ? " [demo seed]" : ""}`,
    `  user: ${clip(t.userText, 300)}`,
    `  you answered: ${clip(t.answerText, 600)}`,
    `  searches: ${queries}`,
    `  sources: ${sources}`,
  ].join("\n");
}

export interface TurnContext {
  block: string; // goes in front of the user's message
  history: Turn[]; // recent turns, sent as real conversation messages
  /** Local dates (YYYY-MM-DD) of every past turn the model can see. A `since` filter earlier than all of them is invented. */
  pastDates: string[];
}

/** Everything the model needs to know about time and memory for this turn, assembled in code. */
export function buildContext(text: string, now: Date, store: Store, tz: string, historyTurns = 6): TurnContext {
  const history = historyTurns > 0 ? store.recent(historyTurns) : [];
  const inHistory = new Set(history.map((t) => t.id));
  const first = store.first();
  const pastDates = new Set(history.map((t) => localDate(new Date(t.at), tz)));
  const lines = [
    `now: ${formatLocal(now, tz)} (${tz})`,
    `memory_starts: ${first ? formatLocal(new Date(first.at), tz) : "no earlier conversations recorded; this is the first one"}`,
  ];

  for (const ref of resolveDateRefs(text, now, tz)) {
    const turns = store.between(ref.start, ref.end).slice(-6);
    for (const t of turns) pastDates.add(localDate(new Date(t.at), tz));
    lines.push(`\nuser said "${ref.text}" → ${ref.label}`);
    lines.push(turns.length ? turns.map((t) => summarizeTurn(t, tz)).join("\n") : `  no turns recorded on ${ref.label}.`);
  }

  const related = store.search(text, 3).filter((t) => !inHistory.has(t.id));
  for (const t of related) pastDates.add(localDate(new Date(t.at), tz));
  if (related.length) {
    lines.push(`\nrelated earlier turns (keyword match):\n${related.map((t) => summarizeTurn(t, tz)).join("\n")}`);
  }

  return { block: `<context>\n${lines.join("\n")}\n</context>`, history, pastDates: [...pastDates].sort() };
}
