import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateAddress } from "./llm-config";

/**
 * Web search for the assistant when the bundled NetLogo reference is not enough.
 * Providers (no API key needed): DuckDuckGo HTML + Stack Exchange API (NetLogo tag). Optional: SEARXNG_URL.
 * Result pages are fetched only from an allow-list of NetLogo-related hosts, over https, never from private addresses,
 * and all returned text is truncated and marked as untrusted data.
 */

export type WebResult = { title: string; url: string; snippet: string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/** Hosts whose pages the assistant may open. Search results from other hosts are listed but cannot be fetched. */
export const FETCH_ALLOW = [
  "docs.netlogo.org", "ccl.northwestern.edu", "netlogoweb.org", "bind.netlogo.org", "stackoverflow.com", "stackexchange.com",
  "github.com", "raw.githubusercontent.com", "netlogo.org", "modelingcommons.org", "ocw.mit.edu",
];

export const SEARCH_CACHE = new Map<string, { t: number; v: unknown }>();
const CACHE_MS = 10 * 60_000;
function cached<T>(key: string): T | null {
  const e = SEARCH_CACHE.get(key);
  if (e && Date.now() - e.t < CACHE_MS) return e.v as T;
  return null;
}
function remember(key: string, v: unknown) {
  SEARCH_CACHE.set(key, { t: Date.now(), v });
  if (SEARCH_CACHE.size > 300) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value as string);
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

async function ddg(query: string): Promise<WebResult[]> {
  const r = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`DuckDuckGo HTTP ${r.status}`);
  const html = await r.text();
  if (/anomaly|captcha/i.test(html.slice(0, 4000))) throw new Error("DuckDuckGo asked for a captcha");
  const out: WebResult[] = [];
  const blocks = html.split(/<div class="result[ "]/).slice(1);
  for (const b of blocks) {
    const a = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let url = decodeEntities(a[1]!);
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]!);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    out.push({ title: stripTags(a[2]!), url, snippet: sn ? stripTags(sn[1]!) : "" });
    if (out.length >= 8) break;
  }
  return out;
}

async function stackExchange(query: string): Promise<WebResult[]> {
  const u = new URL("https://api.stackexchange.com/2.3/search/advanced");
  u.search = new URLSearchParams({ order: "desc", sort: "relevance", q: query, tagged: "netlogo", site: "stackoverflow", pagesize: "5", filter: "withbody" }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`Stack Exchange HTTP ${r.status}`);
  const j = (await r.json()) as { items?: Array<{ title: string; link: string; is_answered?: boolean; accepted_answer_id?: number; body?: string; score?: number }> };
  return (j.items ?? []).map((i) => ({
    title: decodeEntities(i.title) + (i.accepted_answer_id ? " [accepted answer]" : i.is_answered ? " [answered]" : ""),
    url: i.link,
    snippet: stripTags(i.body ?? "").slice(0, 300),
  }));
}

async function searxng(query: string): Promise<WebResult[]> {
  const base = process.env.SEARXNG_URL;
  if (!base) return [];
  const r = await fetch(`${base.replace(/\/$/, "")}/search?${new URLSearchParams({ q: query, format: "json" })}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
  const j = (await r.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (j.results ?? []).slice(0, 8).map((x) => ({ title: x.title, url: x.url, snippet: (x.content ?? "").slice(0, 300) }));
}

export async function webSearch(query: string): Promise<{ results: WebResult[]; errors: string[] }> {
  const q = query.trim().slice(0, 200);
  const key = "s:" + q.toLowerCase();
  const hit = cached<{ results: WebResult[]; errors: string[] }>(key);
  if (hit) return hit;
  const errors: string[] = [];
  const withNl = /netlogo/i.test(q) ? q : `netlogo ${q}`;
  const settled = await Promise.allSettled([ddg(withNl), stackExchange(q.replace(/netlogo/gi, "").trim() || q), searxng(withNl)]);
  const names = ["DuckDuckGo", "Stack Overflow", "SearXNG"];
  const merged: WebResult[] = [];
  const seen = new Set<string>();
  settled.forEach((s, i) => {
    if (s.status === "rejected") { if (i < 2 || process.env.SEARXNG_URL) errors.push(`${names[i]}: ${(s.reason as Error).message}`); return; }
    for (const r of s.value) {
      const k = r.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
    }
  });
  // official docs first, then Q&A, then the rest
  const rank = (u: string) => (/docs\.netlogo\.org|ccl\.northwestern\.edu/.test(u) ? 0 : /stackoverflow|stackexchange/.test(u) ? 1 : /bind\.netlogo|netlogoweb|github/.test(u) ? 2 : 3);
  merged.sort((a, b) => rank(a.url) - rank(b.url));
  const res = { results: merged.slice(0, 8), errors };
  if (merged.length) remember(key, res);
  return res;
}

// ---- fetching a page --------------------------------------------------------------------------------------------

export function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return FETCH_ALLOW.some((a) => h === a || h.endsWith("." + a));
}

async function assertPublic(host: string) {
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateAddress)) throw new Error("address not allowed");
}

function htmlToText(html: string): string {
  let h = html.replace(/<(script|style|nav|header|footer|svg|noscript)[\s\S]*?<\/\1>/gi, " ");
  const main = /<(main|article)[\s\S]*?<\/\1>/i.exec(h) ?? /<div[^>]+id="(?:question|mainbar|content|main)"[\s\S]*$/i.exec(h);
  if (main) h = main[0];
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => "\n```\n" + decodeEntities(c.replace(/<[^>]*>/g, "")) + "\n```\n")
    .replace(/<h[1-6][^>]*>/gi, "\n## ").replace(/<(p|div|li|tr|br)[^>]*>/gi, "\n");
  return decodeEntities(h.replace(/<[^>]*>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

export async function fetchPage(rawUrl: string, maxChars = 6000): Promise<{ ok: true; url: string; text: string } | { ok: false; error: string }> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, error: "invalid URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "only https URLs can be opened" };
  if (!hostAllowed(u.hostname)) return { ok: false, error: `host ${u.hostname} is not on the allow-list (${FETCH_ALLOW.slice(0, 6).join(", ")}, ...). Use the search snippet instead.` };
  const key = "p:" + u.toString();
  const hit = cached<{ url: string; text: string }>(key);
  if (hit) return { ok: true, ...hit, text: hit.text.slice(0, maxChars) };
  try {
    let cur = u;
    for (let hop = 0; hop < 3; hop++) {
      await assertPublic(cur.hostname);
      const r = await fetch(cur, { headers: { "User-Agent": UA, Accept: "text/html,text/plain,text/markdown" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        cur = new URL(r.headers.get("location")!, cur);
        if (cur.protocol !== "https:" || !hostAllowed(cur.hostname)) return { ok: false, error: `redirected to ${cur.hostname}, which is not allowed` };
        continue;
      }
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const ct = r.headers.get("content-type") ?? "";
      if (!/text|html|json|xml|markdown/i.test(ct)) return { ok: false, error: `unsupported content type ${ct}` };
      const buf = (await r.text()).slice(0, 600_000);
      const text = /html/i.test(ct) ? htmlToText(buf) : buf;
      remember(key, { url: cur.toString(), text });
      return { ok: true, url: cur.toString(), text: text.slice(0, maxChars) };
    }
    return { ok: false, error: "too many redirects" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
