import { db } from "./db";
import { isPrivateAddress } from "./llm-config";

/** USD per 1M tokens [input, output]. Public list prices, used only for an estimate; Settings can override them. */
const PRICES: Array<[RegExp, [number, number]]> = [
  [/opus/i, [15, 75]],
  [/sonnet/i, [3, 15]],
  [/haiku[-\s]?(4|3[-.]?5)/i, [1, 5]],
  [/haiku/i, [0.25, 1.25]],
  [/gpt-4\.1-nano/i, [0.1, 0.4]],
  [/gpt-4\.1-mini/i, [0.4, 1.6]],
  [/gpt-4\.1/i, [2, 8]],
  [/gpt-4o-mini/i, [0.15, 0.6]],
  [/gpt-4o/i, [2.5, 10]],
];

function isLocalUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || isPrivateAddress(h);
  } catch {
    return false;
  }
}

/** [in, out] USD per 1M tokens, or null when the price is unknown (cost then stays unknown, not zero). */
export function priceFor(cfg: { model: string; baseUrl: string; priceIn?: number | null; priceOut?: number | null }): [number, number] | null {
  if (cfg.priceIn != null || cfg.priceOut != null) return [cfg.priceIn ?? 0, cfg.priceOut ?? 0];
  if (isLocalUrl(cfg.baseUrl)) return [0, 0]; // local models cost nothing
  for (const [re, p] of PRICES) if (re.test(cfg.model)) return p;
  return null;
}

/** Anthropic prompt caching: a cache read costs 10% of the input price, writing the cache 125%. `input` is the uncached part only. */
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;

export function costOf(price: [number, number] | null, input: number, output: number, cacheRead = 0, cacheWrite = 0): number | null {
  return price ? (input * price[0] + cacheRead * price[0] * CACHE_READ_FACTOR + cacheWrite * price[0] * CACHE_WRITE_FACTOR + output * price[1]) / 1_000_000 : null;
}

export function recordUsage(uid: string, model: string, u: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }, cost: number | null): void {
  try {
    db()
      .prepare("INSERT INTO usage (user_id, model, input, output, cache_read, cache_write, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uid, model, u.inputTokens, u.outputTokens, u.cacheRead ?? 0, u.cacheWrite ?? 0, cost, Date.now());
  } catch {
    /* usage accounting must never break a chat */
  }
}

/** `input` counts every input token (fresh + cache read + cache write); `cacheRead` is the part served from the cache. */
export type UsageTotals = { input: number; output: number; cacheRead: number; calls: number; cost: number; unpricedCalls: number };

export function totals(uid: string, since = 0): UsageTotals {
  const r = db()
    .prepare("SELECT COALESCE(SUM(input + cache_read + cache_write),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cache_read),0) AS cacheRead, COUNT(*) AS calls, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END),0) AS unpricedCalls FROM usage WHERE user_id = ? AND created_at >= ?")
    .get(uid, since) as UsageTotals;
  return r;
}

export function perModel(uid: string): Array<{ model: string; input: number; output: number; cost: number }> {
  return db()
    .prepare("SELECT model, SUM(input + cache_read + cache_write) AS input, SUM(output) AS output, COALESCE(SUM(cost),0) AS cost FROM usage WHERE user_id = ? GROUP BY model ORDER BY (SUM(input + cache_read + cache_write)+SUM(output)) DESC LIMIT 10")
    .all(uid) as Array<{ model: string; input: number; output: number; cost: number }>;
}
