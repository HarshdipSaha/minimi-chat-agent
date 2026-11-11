import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNode, loadConfig } from "../src/config.ts";

test("checkNode rejects Node older than 22.13", () => {
  assert.throws(() => checkNode("20.11.0"), /Node 20\.11\.0 is too old.*22\.13/);
  assert.throws(() => checkNode("22.12.0"), /too old/);
  assert.doesNotThrow(() => checkNode("22.13.0"));
  assert.doesNotThrow(() => checkNode("24.1.0"));
});

test("loadConfig names every missing key", () => {
  assert.throws(() => loadConfig({}), /Missing GROQ_API_KEYS, EXA_API_KEY.*\.env\.example/);
  assert.throws(() => loadConfig({ GROQ_API_KEYS: "a" }), /Missing EXA_API_KEY/);
});

test("GROQ_API_KEYS is a comma-separated list; GROQ_API_KEY also works", () => {
  const c = loadConfig({ GROQ_API_KEYS: " k1, k2 ,,k3", EXA_API_KEY: "e" });
  assert.deepEqual(c.groqKeys, ["k1", "k2", "k3"]);
  assert.deepEqual(loadConfig({ GROQ_API_KEY: "solo", EXA_API_KEY: "e" }).groqKeys, ["solo"]);
});

test("loadConfig applies defaults and overrides", () => {
  const c = loadConfig({ GROQ_API_KEYS: "a", EXA_API_KEY: "e", DEFAULT_TZ: "Asia/Kolkata" });
  assert.equal(c.model, "openai/gpt-oss-120b");
  assert.equal(c.reasoningEffort, "low");
  assert.equal(c.port, 3000);
  assert.equal(c.dbPath, "data/minimi.db");
  assert.equal(c.defaultTz, "Asia/Kolkata");
  assert.equal(c.exaType, "auto");
  const o = loadConfig({ GROQ_API_KEYS: "a", EXA_API_KEY: "e", REASONING_EFFORT: "high", PORT: "4000", MODEL: "openai/gpt-oss-20b" });
  assert.equal(o.reasoningEffort, "high");
  assert.equal(o.port, 4000);
  assert.equal(o.model, "openai/gpt-oss-20b");
});

test("loadConfig rejects an invalid REASONING_EFFORT", () => {
  assert.throws(() => loadConfig({ GROQ_API_KEYS: "a", EXA_API_KEY: "e", REASONING_EFFORT: "max" }), /REASONING_EFFORT must be low, medium or high/);
});

test("fallback model defaults to gpt-oss-20b and can be overridden", () => {
  assert.equal(loadConfig({ GROQ_API_KEYS: "a", EXA_API_KEY: "e" }).fallbackModel, "openai/gpt-oss-20b");
  assert.equal(loadConfig({ GROQ_API_KEYS: "a", EXA_API_KEY: "e", FALLBACK_MODEL: "x/y" }).fallbackModel, "x/y");
});
