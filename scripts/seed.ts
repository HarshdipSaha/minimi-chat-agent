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

/** A turn recorded from a real run, plus how many days before "now" it should appear to have happened. */
export interface SeedEntry { daysAgo: number; turn: NewTurn }

/** Re-date entries relative to `now`, so a seeded "6 days ago" is always 6 days before whenever you load it. */
export function shiftTurns(entries: SeedEntry[], now: Date): NewTurn[] {
  return entries.map((e) => ({ ...e.turn, at: new Date(now.getTime() - e.daysAgo * DAY).toISOString(), seed: true }));
}

export function loadSeed(store: Store, turns: NewTurn[]): void {
  store.deleteSeed();
  for (const t of turns) store.insert({ ...t, seed: true });
}

/** Run each question through the real agent (real search, real model) and save the exchange. */
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
  const entries: SeedEntry[] = [];
  for (const { daysAgo, q } of questions) {
    console.log(`recording (${daysAgo}d ago): ${q}`);
    const { id: _id, ...turn } = await runTurn({ text: q, tz: config.defaultTz }, deps, () => {});
    entries.push({ daysAgo, turn: { ...turn, seed: true } });
  }
  writeFileSync(SEED_FILE, JSON.stringify(entries, null, 2));
  console.log(`saved ${entries.length} real exchanges to ${SEED_FILE}`);
}

function load(): void {
  loadDotEnv();
  if (!existsSync(SEED_FILE)) throw new Error(`${SEED_FILE} not found. Run \`npm run seed:record\` first (needs API keys).`);
  const entries = JSON.parse(readFileSync(SEED_FILE, "utf8")) as SeedEntry[];
  const turns = shiftTurns(entries, systemClock().now());
  const store = new Store(process.env.DB_PATH ?? "data/minimi.db");
  loadSeed(store, turns);
  store.close();
  console.log(`loaded ${turns.length} demo turns (real answers, re-dated relative to now, tagged "demo seed"):`);
  for (const t of turns) console.log(`  ${t.at.slice(0, 10)}  ${t.userText.slice(0, 80)}`);
  console.log("Try: \"What did I ask you last week? Is your answer still correct?\"");
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
