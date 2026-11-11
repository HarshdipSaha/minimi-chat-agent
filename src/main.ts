import { serve } from "@hono/node-server";
import { checkNode, loadConfig, loadDotEnv } from "./config.ts";
import { systemClock } from "./clock.ts";
import { makeGroqStream } from "./llm.ts";
import { makeExaSearch } from "./search.ts";
import { createApp } from "./server.ts";
import { formatLocal } from "./time.ts";

async function main(): Promise<void> {
  checkNode();
  loadDotEnv();
  const config = loadConfig();
  // Imported only after checkNode(): a static import of node:sqlite would crash an old Node
  // with ERR_UNKNOWN_BUILTIN_MODULE before the friendly version message could print.
  const { Store } = await import("./store.ts");
  const clock = systemClock();
  const store = new Store(config.dbPath);
  const app = createApp({
    stream: makeGroqStream({
      keys: config.groqKeys, model: config.model, fallbackModel: config.fallbackModel, reasoningEffort: config.reasoningEffort,
      onMetrics: process.env.DEBUG_TIMING ? (m) => console.log(`[llm] key#${m.slot} first-byte ${m.ttfbMs}ms first-text ${m.firstTextMs ?? "-"}ms total ${m.totalMs}ms (${m.finishReason})`) : undefined,
    }),
    search: makeExaSearch({ apiKey: config.exaKey, type: config.exaType }),
    store, clock, config,
  }, config.defaultTz);

  const first = store.first();
  console.log(`minimi | ${config.model} on Groq (${config.groqKeys.length} key${config.groqKeys.length === 1 ? "" : "s"} in rotation) | search: Exa ${config.exaType}`);
  console.log(first
    ? `memory: ${store.count()} turns since ${formatLocal(new Date(first.at), config.defaultTz)}`
    : "memory: empty. Just chat, or run `npm run seed` to load labelled demo history.");
  if (process.env.NOW) console.log(`clock: fake, starting at ${process.env.NOW}`);

  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`open http://localhost:${info.port}`));
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
