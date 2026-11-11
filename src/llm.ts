import { WEB_SEARCH_TOOL } from "./prompt.ts";

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelRequest { messages: ChatMessage[]; allowTools: boolean }
export interface ModelResult { text: string; toolCalls: ToolCall[]; finishReason: string }
/** One model call: stream text deltas to `onText`, resolve with the full result. */
export type StreamFn = (req: ModelRequest, onText: (delta: string) => void) => Promise<ModelResult>;

/** Round-robin over several API keys; a key that is rate limited (or rejected) sits out for a while. */
export class KeyRing {
  private i = 0;
  private until = new Map<string, number>();
  constructor(private keys: string[], private now: () => number = Date.now) {
    if (!keys.length) throw new Error("KeyRing needs at least one key");
  }
  get size(): number { return this.keys.length; }
  next(): string | null {
    for (let n = 0; n < this.keys.length; n++) {
      const key = this.keys[(this.i + n) % this.keys.length];
      if ((this.until.get(key) ?? 0) <= this.now()) {
        this.i = (this.i + n + 1) % this.keys.length;
        return key;
      }
    }
    return null;
  }
  cool(key: string, ms: number): void { this.until.set(key, this.now() + ms); }
  /** Milliseconds until the soonest key is usable again (0 if one is usable now). */
  waitMs(): number {
    return Math.max(0, Math.min(...this.keys.map((k) => (this.until.get(k) ?? 0) - this.now())));
  }
}

/** A failure worth retrying on another key, before anything was streamed to the user. */
class Retryable extends Error {}

export function makeGroqStream(opts: {
  keys: string[];
  model: string;
  reasoningEffort: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  /** Used when every key is rate limited on `model` (limits are per model). */
  fallbackModel?: string;
  /** Optional per-call timing hook (set DEBUG_TIMING=1 in the app to print these). */
  onMetrics?: (m: { slot: number; ttfbMs: number; firstTextMs: number | null; totalMs: number; finishReason: string }) => void;
}): StreamFn {
  const fetchFn = opts.fetchFn ?? fetch;
  const ring = new KeyRing(opts.keys, opts.now);
  // Groq rate limits are per model, so a second model is extra capacity when every key is limited on the first.
  const fallbackRing = opts.fallbackModel && opts.fallbackModel !== opts.model ? new KeyRing(opts.keys, opts.now) : null;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = opts.maxWaitMs ?? 8_000;

  async function once(model: string, ring: KeyRing, key: string, req: ModelRequest, onText: (d: string) => void): Promise<ModelResult> {
    const isGptOss = model.startsWith("openai/gpt-oss");
    const t0 = performance.now();
    let ttfbMs = 0;
    let firstTextMs: number | null = null;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: req.messages,
      tools: [WEB_SEARCH_TOOL],
      tool_choice: req.allowTools ? "auto" : "none",
      temperature: 0.2,
      max_completion_tokens: 1500,
      ...(isGptOss ? { reasoning_effort: opts.reasoningEffort, include_reasoning: false } : {}),
    };
    let res: Response;
    try {
      res = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      ring.cool(key, 2_000);
      throw new Retryable(`network error: ${err instanceof Error ? err.message : String(err)}`);
    }
    ttfbMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        ring.cool(key, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15) * 1000);
        throw new Retryable(`rate limited: ${detail}`);
      }
      if (res.status === 401 || res.status === 403) { ring.cool(key, 3_600_000); throw new Retryable(`key rejected (${res.status})`); }
      if (res.status >= 500) { ring.cool(key, 2_000); throw new Retryable(`Groq ${res.status}`); }
      if (res.status === 400 && /tool_use_failed|failed_generation/.test(detail)) throw new Retryable("model produced a malformed tool call");
      if (res.status === 413) throw new Error("The request was too large for the model's token limit.");
      throw new Error(`Groq ${res.status}: ${detail}`);
    }

    let text = "";
    let finishReason = "stop";
    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      const choice = (JSON.parse(data) as { choices?: Array<{ delta?: any; finish_reason?: string | null }> }).choices?.[0];
      if (!choice) return;
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        firstTextMs ??= Math.round(performance.now() - t0);
        text += d.content;
        onText(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const cur = calls.get(tc.index ?? 0) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(tc.index ?? 0, cur);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i).trimEnd()); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) handle(buf.trim());
    } catch (err) {
      if (!text && !calls.size) throw new Retryable(`stream error: ${err instanceof Error ? err.message : String(err)}`);
      throw err; // partial output was already shown: don't silently restart
    }
    opts.onMetrics?.({ slot: opts.keys.indexOf(key) + 1, ttfbMs, firstTextMs, totalMs: Math.round(performance.now() - t0), finishReason });
    return { text, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c), finishReason };
  }

  return async (req, onText) => {
    let streamed = false;
    const guarded = (d: string) => { streamed = true; onText(d); };
    let lastError = "";
    for (let attempt = 0; attempt < ring.size * (fallbackRing ? 4 : 2) + 2; attempt++) {
      let model = opts.model;
      let active = ring;
      let key = ring.next();
      if (!key && fallbackRing) {
        key = fallbackRing.next();
        if (key) { model = opts.fallbackModel!; active = fallbackRing; }
      }
      if (!key) {
        const wait = Math.min(ring.waitMs(), fallbackRing?.waitMs() ?? Infinity);
        if (wait > maxWait) throw new Error(`All ${ring.size} Groq keys are rate limited right now. Try again in about ${Math.ceil(wait / 1000)}s.`);
        await sleep(wait);
        continue;
      }
      try {
        return await once(model, active, key, req, guarded);
      } catch (err) {
        if (err instanceof Retryable && !streamed) { lastError = err.message; continue; }
        throw err;
      }
    }
    throw new Error(`The model API kept failing (${lastError || "unknown error"}).`);
  };
}
