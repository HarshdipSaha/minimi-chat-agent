import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runTurn } from "../src/agent.ts";
import { systemClock } from "../src/clock.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { makeGroqStream } from "../src/llm.ts";
import { makeExaSearch } from "../src/search.ts";
import { Store, type NewTurn } from "../src/store.ts";

const SEED_FILE = "data/seed.json";
const DAY = 86_400_000;

export function loadSeed(store: Store, turns: NewTurn[]): void {
  store.deleteSeed();
  for (const t of turns) store.insert({ ...t, seed: true });
}

/**
 * Run each question through the real agent (real search, real model) and save the exchange. Each turn is
 * recorded "as of" daysAgo before now (via the per-turn `at` override), so its own "As of <date>" line and
 * its timestamp agree. Dates stay absolute: it is a recorded history, not a moving one.
 */
async function record(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const questions = JSON.parse(readFileSync("scripts/seed-questions.json", "utf8")) as { daysAgo: number; q: string }[];
  const scratch = new Store(":memory:");
  const deps = {
    stream: makeGroqStream({ keys: config.groqKeys, model: config.model, reasoningEffort: config.reasoningEffort }),
    search: makeExaSearch({ apiKey: config.exaKey, type: config.exaType }),
    store: scratch, clock: systemClock(), config,
  };
  const entries: NewTurn[] = [];
  const base = Date.now();
  for (const { daysAgo, q } of questions) {
    console.log(`recording (as of ${daysAgo}d ago): ${q}`);
    const { id: _id, ...turn } = await runTurn({ text: q, tz: config.defaultTz, at: new Date(base - daysAgo * DAY) }, deps, () => {});
    entries.push({ ...turn, seed: true });
  }
  writeFileSync(SEED_FILE, JSON.stringify(entries, null, 2));
  console.log(`saved ${entries.length} real exchanges to ${SEED_FILE}`);
}

function load(): void {
  loadDotEnv();
  if (!existsSync(SEED_FILE)) throw new Error(`${SEED_FILE} not found. Run \`npm run seed:record\` first (needs API keys).`);
  const turns = JSON.parse(readFileSync(SEED_FILE, "utf8")) as NewTurn[];
  const store = new Store(process.env.DB_PATH ?? "data/minimi.db");
  loadSeed(store, turns);
  store.close();
  console.log(`loaded ${turns.length} demo turns (real recorded answers, tagged "demo seed"):`);
  for (const t of turns) console.log(`  ${t.at.slice(0, 10)}  ${t.userText.slice(0, 80)}`);
  const first = turns[0] ? new Date(turns[0].at).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: turns[0].tz }) : "";
  console.log(`Try: "What did I ask you on ${first}? Is your answer still correct today?"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cmd = process.argv[2];
    if (cmd === "record") await record();
    else if (cmd === "load") load();
    else throw new Error("usage: seed.ts record | load");
  } catch (err) {
    console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
