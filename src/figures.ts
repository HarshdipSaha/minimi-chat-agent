/**
 * A deterministic comparison for rechecks: which money figures an earlier answer stated, and whether
 * each one still appears in the pages found today. "Unchanged" then rests on a check, not on the
 * model's reading of a snippet.
 */

const MONEY = /[$£€]\s?\d[\d,]*(?:\.\d+)?/g;

export interface Figure { raw: string; symbol: string; value: number }

export function extractFigures(text: string): Figure[] {
  const seen = new Set<string>();
  const out: Figure[] = [];
  for (const m of text.match(MONEY) ?? []) {
    const symbol = m[0];
    const value = Number(m.slice(1).replace(/[\s,]/g, ""));
    if (!Number.isFinite(value)) continue;
    const key = `${symbol}${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: `${symbol}${value}`, symbol, value });
  }
  return out;
}

export interface CurrentResult { n: number; text: string }
export interface FigureCheck { figure: string; foundIn: number[] }

export function checkFigures(figures: Figure[], current: CurrentResult[]): FigureCheck[] {
  const seenNow = current.map((r) => ({ n: r.n, keys: new Set(extractFigures(r.text).map((f) => `${f.symbol}${f.value}`)) }));
  return figures.map((f) => ({
    figure: f.raw,
    foundIn: seenNow.filter((r) => r.keys.has(`${f.symbol}${f.value}`)).map((r) => r.n),
  }));
}

export function formatFigureCheck(checks: FigureCheck[], sinceLabel: string): string {
  const lines = checks.map((c) =>
    c.foundIn.length
      ? `- ${c.figure}: found in current pages ${c.foundIn.slice(0, 4).map((n) => `[${n}]`).join(" ")}`
      : `- ${c.figure}: NOT found in any current page result (could not confirm; it may have changed)`);
  return `## figure check: figures from your answer on ${sinceLabel}, compared with the current pages\n${lines.join("\n")}`;
}
