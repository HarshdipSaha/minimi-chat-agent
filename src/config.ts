import { existsSync } from "node:fs";

export type ReasoningEffort = "low" | "medium" | "high";

export interface Config {
  groqKeys: string[];
  exaKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  port: number;
  dbPath: string;
  defaultTz: string;
  exaType: string;
}

export function checkNode(version: string = process.versions.node): void {
  const [major, minor] = version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node ${version} is too old: minimi needs Node >= 22.13 (it uses the built-in node:sqlite).`);
  }
}

export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const groqKeys = (env.GROQ_API_KEYS ?? env.GROQ_API_KEY ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const missing = [...(groqKeys.length ? [] : ["GROQ_API_KEYS"]), ...(env.EXA_API_KEY ? [] : ["EXA_API_KEY"])];
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  }
  const reasoningEffort = (env.REASONING_EFFORT ?? "low") as ReasoningEffort;
  if (!["low", "medium", "high"].includes(reasoningEffort)) throw new Error("REASONING_EFFORT must be low, medium or high");
  return {
    groqKeys,
    exaKey: env.EXA_API_KEY!,
    model: env.MODEL ?? "openai/gpt-oss-120b",
    reasoningEffort,
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? "data/minimi.db",
    defaultTz: env.DEFAULT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    exaType: env.EXA_SEARCH_TYPE ?? "auto",
  };
}
