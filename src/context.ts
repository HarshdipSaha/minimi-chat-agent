import type { Store, Turn } from "./store.ts";
import { formatLocal, localDate, resolveDateRefs, weekEarlier, type DateRef } from "./time.ts";

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
  /**
   * Set when the user pointed at a past date whose turns searched the web: the earliest such local date.
   * That is a recheck ("is it still correct?"), and the agent then makes sure both the current pages and
   * the pages published since that date are searched, instead of trusting the model to remember to.
   */
  recheckSince: string | null;
  /** The past turns (with web searches) the user pointed at: what a recheck compares against. */
  recheckTurns: Turn[];
}

/** Everything the model needs to know about time and memory for this turn, assembled in code. */
export function buildContext(text: string, now: Date, store: Store, tz: string, historyTurns = 6): TurnContext {
  const history = historyTurns > 0 ? store.recent(historyTurns) : [];
  const inHistory = new Set(history.map((t) => t.id));
  const first = store.first();
  const pastDates = new Set(history.map((t) => localDate(new Date(t.at), tz)));
  let recheckSince: string | null = null;
  const recheckTurns: Turn[] = [];
  const lines = [
    `now: ${formatLocal(now, tz)} (${tz})`,
    `memory_starts: ${first ? formatLocal(new Date(first.at), tz) : "no earlier conversations recorded; this is the first one"}`,
  ];

  for (const ref of resolveDateRefs(text, now, tz)) {
    const window = (r: DateRef) => store.between(r.start, r.end).slice(-6);
    let days: { ref: DateRef; turns: Turn[] }[] = [{ ref, turns: window(ref) }];
    let note: string | null = null;

    // "last Tuesday" can mean the most recent Tuesday or the one a week before. Let the record settle it.
    if (ref.weekday) {
      const older = weekEarlier(ref, tz);
      const olderTurns = window(older);
      const recentTurns = days[0].turns;
      if (olderTurns.length) {
        const related = new Set(store.search(text, 8).map((t) => t.id));
        const recentFits = recentTurns.some((t) => related.has(t.id));
        const olderFits = olderTurns.some((t) => related.has(t.id));
        const said = `"${ref.text}"`;
        if (!recentTurns.length) {
          days = [{ ref: older, turns: olderTurns }];
          note = `${said} most likely means ${ref.label}, but nothing was recorded that day. The same weekday a week earlier (${older.label}) has turns, so those are shown. Say so in your answer.`;
        } else if (olderFits && !recentFits) {
          days = [{ ref: older, turns: olderTurns }];
          note = `${said} could mean ${ref.label} or ${older.label}. Only ${older.label} has turns about this topic, so those are shown. Say which day you used.`;
        } else if (!(recentFits && !olderFits)) {
          days = [{ ref: older, turns: olderTurns }, { ref, turns: recentTurns }];
          note = `${said} could mean ${older.label} or ${ref.label}, and both have turns; both are shown. If the user's topic does not settle it, say which day you used or ask.`;
        }
      }
    }

    lines.push(`\nuser said "${ref.text}" → ${days.map((x) => x.ref.label).join(" and ")}`);
    if (note) lines.push(`  note: ${note}`);
    for (const { ref: r, turns } of days) {
      for (const t of turns) {
        const d = localDate(new Date(t.at), tz);
        pastDates.add(d);
        if (t.searches.length) {
          recheckTurns.push(t);
          if (recheckSince === null || d < recheckSince) recheckSince = d;
        }
      }
      if (days.length > 1) lines.push(`  ${r.label}:`);
      lines.push(turns.length ? turns.map((t) => summarizeTurn(t, tz)).join("\n") : `  no turns recorded on ${r.label}.`);
    }
  }

  const related = store.search(text, 3).filter((t) => !inHistory.has(t.id));
  for (const t of related) pastDates.add(localDate(new Date(t.at), tz));
  if (related.length) {
    lines.push(`\nrelated earlier turns (keyword match):\n${related.map((t) => summarizeTurn(t, tz)).join("\n")}`);
  }

  return { block: `<context>\n${lines.join("\n")}\n</context>`, history, pastDates: [...pastDates].sort(), recheckSince, recheckTurns };
}
