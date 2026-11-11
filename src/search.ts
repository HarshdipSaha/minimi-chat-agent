import type { SearchRecord, SearchResult } from "./store.ts";

export interface SearchArgs {
  query: string;
  /** Why the model is searching. Passed to Exa unchanged (Exa's recommended pattern for search-as-a-tool). */
  objective?: string | null;
  /** YYYY-MM-DD: only pages published on or after this date (a task-stated bounded window: rechecks). */
  since?: string | null;
  /** A deliberate token-budget decision: the free Groq tier allows ~8k tokens/min per key. */
  numResults?: number;
}
export type SearchFn = (args: SearchArgs) => Promise<SearchRecord>;

interface ExaResponse {
  results?: Array<{ url: string; title?: string | null; publishedDate?: string | null; highlights?: string[] }>;
}

const MAX_HIGHLIGHTS = 2;
const MAX_HIGHLIGHT_CHARS = 350;

export function makeExaSearch(opts: {
  apiKey: string;
  type: string;
  fetchFn?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}): SearchFn {
  const fetchFn = opts.fetchFn ?? fetch;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; rec: SearchRecord }>();

  return async ({ query, objective = null, since = null, numResults = 5 }) => {
    const key = JSON.stringify([query.trim().toLowerCase(), since, numResults]);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return { ...hit.rec, objective };

    const t0 = now();
    // Exa's recommended request: query + type + bare highlights. Everything else is added only for a stated reason.
    const body: Record<string, unknown> = {
      query,
      type: opts.type,
      numResults: Math.min(Math.max(numResults, 1), 10),
      contents: { highlights: true },
    };
    if (objective) body.objective = objective;
    if (since) body.startPublishedDate = new Date(`${since}T00:00:00.000Z`).toISOString();

    try {
      const res = await fetchFn("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as ExaResponse;
      const results: SearchResult[] = (json.results ?? []).map((r) => ({
        url: r.url,
        title: r.title || r.url,
        publishedDate: r.publishedDate ? r.publishedDate.slice(0, 10) : null,
        highlights: (r.highlights ?? []).slice(0, MAX_HIGHLIGHTS),
      }));
      const rec: SearchRecord = { query, objective, since, results, ms: now() - t0 };
      cache.set(key, { at: now(), rec });
      return rec;
    } catch (err) {
      return { query, objective, since, results: [], ms: now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Numbered results the model cites as [n]. Numbering is global across the turn. */
export function formatForModel(rec: SearchRecord, firstIndex: number): string {
  if (rec.error) return `Search failed: ${rec.error}. Tell the user you couldn't search; don't guess.`;
  if (!rec.results.length) return `No results for "${rec.query}"${rec.since ? ` published since ${rec.since}` : ""}.`;
  return rec.results
    .map((r, i) => [
      `[${firstIndex + i}] ${r.title}`,
      `url: ${r.url}`,
      `published: ${r.publishedDate ?? "unknown"}`,
      ...r.highlights.map((h) => `- ${clip(h.replace(/\s+/g, " "), MAX_HIGHLIGHT_CHARS)}`),
    ].join("\n"))
    .join("\n\n");
}
