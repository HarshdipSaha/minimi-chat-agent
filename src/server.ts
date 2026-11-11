import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { runTurn, type AgentDeps, type AgentEvent } from "./agent.ts";

export function validTz(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

export function createApp(deps: AgentDeps, defaultTz: string): Hono {
  const app = new Hono();
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  app.get("/", (c) => c.html(html));

  app.get("/api/turns", (c) => c.json(deps.store.recent(Math.min(Number(c.req.query("limit")) || 50, 200))));

  app.post("/api/chat", async (c) => {
    const body = await c.req.json<{ message?: unknown; tz?: unknown; at?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const text = typeof body.message === "string" ? body.message.trim() : "";
    if (!text) return c.json({ error: "message is required" }, 400);
    if (text.length > 4000) return c.json({ error: "message is too long (4000 characters max)" }, 400);
    const at = typeof body.at === "string" ? new Date(body.at) : undefined;
    if (at && Number.isNaN(at.getTime())) return c.json({ error: "at must be an ISO 8601 timestamp" }, 400);
    const tz = validTz(body.tz) ?? defaultTz;

    return streamSSE(c, async (sse) => {
      let chain = Promise.resolve();
      const emit = (e: AgentEvent) => { chain = chain.then(() => sse.writeSSE({ event: e.type, data: JSON.stringify(e) })); };
      try {
        await runTurn({ text, tz, at }, deps, emit);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      await chain;
    });
  });

  return app;
}
