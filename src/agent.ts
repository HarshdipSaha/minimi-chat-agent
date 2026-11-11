import { z } from "zod";
import type { Clock } from "./clock.ts";
import { buildContext } from "./context.ts";
import type { ChatMessage, StreamFn } from "./llm.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { formatForModel, type SearchFn } from "./search.ts";
import type { SearchRecord, Store, Turn } from "./store.ts";
import { formatLocal } from "./time.ts";

export interface Source { n: number; url: string; title: string; publishedDate: string | null }

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; turnId: number; ttftMs: number | null; totalMs: number; searches: number }
  | { type: "error"; message: string };

export interface AgentDeps {
  stream: StreamFn;
  search: SearchFn;
  store: Store;
  clock: Clock;
  config: { model: string };
}

export interface TurnInput { text: string; tz: string; at?: Date }

const SearchInput = z.object({
  query: z.string().min(1),
  objective: z.string().nullish().transform((v) => v ?? null),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().transform((v) => v ?? null),
});

/**
 * gpt-oss was trained to cite as 【1†L1-L2】 and likes narrow no-break spaces and non-breaking hyphens.
 * Rewrite to plain [1], spaces and hyphens as the text streams, holding back a half-received marker
 * until its closing bracket arrives.
 */
export function makeCiteNormalizer(): { push(delta: string): string; flush(): string } {
  let pending = "";
  return {
    push(delta) {
      let s = pending + delta;
      pending = "";
      const open = s.lastIndexOf("【");
      if (open >= 0 && s.indexOf("】", open) < 0) { pending = s.slice(open); s = s.slice(0, open); }
      return s.replace(/【(\d+)[^】]*】/g, "[$1]").replace(/[\u202f\u00a0]/g, " ").replace(/\u2011/g, "-");
    },
    flush() { const p = pending; pending = ""; return p; },
  };
}

const MAX_STEPS = 4; // up to 3 rounds of searching, then a forced answer
const HISTORY_ANSWER_CHARS = 700;

export async function runTurn(input: TurnInput, deps: AgentDeps, emit: (e: AgentEvent) => void): Promise<Turn> {
  const now = input.at ?? deps.clock.now();
  const t0 = performance.now();
  let ttftMs: number | null = null;

  const { block, history, pastDates } = buildContext(input.text, now, deps.store, input.tz);
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const h of history) {
    messages.push({ role: "user", content: `[${formatLocal(new Date(h.at), input.tz)}] ${h.userText}` });
    messages.push({ role: "assistant", content: (h.answerText || "(no answer recorded)").slice(0, HISTORY_ANSWER_CHARS) });
  }
  messages.push({ role: "user", content: `${block}\n\n${input.text}` });

  const searches: SearchRecord[] = [];
  const sources: Source[] = [];
  let answer = "";
  let needsBreak = false;

  const norm = makeCiteNormalizer();
  const write = (piece: string): void => {
    if (!piece) return;
    if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
    const text = needsBreak ? `\n\n${piece}` : piece;
    needsBreak = false;
    answer += text;
    emit({ type: "text", text });
  };
  const onText = (delta: string): void => write(norm.push(delta));

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await deps.stream({ messages, allowTools: step < MAX_STEPS - 1 }, onText);
    write(norm.flush());
    if (res.finishReason !== "tool_calls" || res.toolCalls.length === 0) break;

    messages.push({ role: "assistant", content: res.text || null, tool_calls: res.toolCalls });
    const parsed = res.toolCalls.map((tc) => {
      let raw: unknown = null;
      try { raw = JSON.parse(tc.function.arguments || "{}"); } catch { /* handled by the schema check below */ }
      return { tc, args: tc.function.name === "web_search" ? SearchInput.safeParse(raw) : null };
    });
    for (const { args } of parsed) if (args?.success) emit({ type: "status", text: `Searching: ${args.data.query}` });

    // `since` is only meaningful for rechecking something the model can see in memory. A date earlier than
    // every visible past turn (or any date at all in an empty memory) is the model guessing: drop it.
    const sinceOk = (d: string | null): string | null => (d && pastDates.length && d >= pastDates[0] ? d : null);
    const numResults = parsed.length > 3 ? 3 : 5; // keep the per-request token total under the free-tier limit
    const records = await Promise.all(parsed.map(({ args }) =>
      args?.success ? deps.search({ query: args.data.query, objective: args.data.objective, since: sinceOk(args.data.since), numResults }) : Promise.resolve(null)));

    parsed.forEach(({ tc, args }, i) => {
      const rec = records[i];
      if (!args?.success || !rec) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: invalid arguments for ${tc.function.name}. Use web_search with a non-empty query and since as YYYY-MM-DD or omitted.` });
        return;
      }
      const firstIndex = sources.length + 1;
      rec.results.forEach((r, k) => sources.push({ n: firstIndex + k, url: r.url, title: r.title, publishedDate: r.publishedDate }));
      searches.push(rec);
      messages.push({ role: "tool", tool_call_id: tc.id, content: formatForModel(rec, firstIndex) });
    });
    if (answer && !answer.endsWith("\n")) needsBreak = true;
  }

  if (!answer.trim()) {
    answer = "I couldn't put an answer together for that. Could you try rephrasing it?";
    emit({ type: "text", text: answer });
  }

  const totalMs = Math.round(performance.now() - t0);
  const cited = sources.filter((s) => answer.includes(`[${s.n}]`));
  emit({ type: "sources", sources: cited });

  const turn: Omit<Turn, "id"> = {
    at: now.toISOString(), tz: input.tz, userText: input.text, answerText: answer,
    searches, seed: false, ttftMs, totalMs, model: deps.config.model,
  };
  const id = deps.store.insert(turn);
  emit({ type: "done", turnId: id, ttftMs, totalMs, searches: searches.length });
  return { id, ...turn };
}
